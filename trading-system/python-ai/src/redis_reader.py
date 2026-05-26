import asyncio
import time
from dataclasses import dataclass
from typing import AsyncIterator, List, Optional
import redis.asyncio as aioredis

@dataclass
class MarketData:
    symbol: str
    lastPrice: float
    bidPrice: float
    askPrice: float
    volume24h: float
    timestamp: int  # Unix 毫秒

class RedisMarketReader:
    _BACKLOG_THRESHOLD_MS = 1000  # Maximum acceptable age (ms) for market data messages
    _MAX_RECONNECT_DELAY = 60.0
    _BASE_RECONNECT_DELAY = 1.0

    def __init__(self, redis_url: str, symbols: List[str]):
        self._redis_url = redis_url
        self._symbols = symbols
        self._redis: Optional[aioredis.Redis] = None
        self._last_ids: dict[str, str] = {s: "$" for s in symbols}
        self._reconnect_attempt = 0

    async def _connect(self):
        if self._redis is None:
            self._redis = aioredis.from_url(self._redis_url, decode_responses=False)

    def _parse_market_data(self, raw: dict) -> MarketData:
        return MarketData(
            symbol=raw[b"symbol"].decode(),
            lastPrice=float(raw[b"lastPrice"]),
            bidPrice=float(raw[b"bidPrice"]),
            askPrice=float(raw[b"askPrice"]),
            volume24h=float(raw[b"volume24h"]),
            timestamp=int(raw[b"timestamp"]),
        )

    async def stream(self) -> AsyncIterator[MarketData]:
        await self._connect()

        while True:
            try:
                streams = [f"market:{s}".encode() for s in self._symbols]
                result = await self._redis.xread(
                    {s: self._last_ids.get(s.decode().replace("market:", ""), "$").encode() for s in streams},
                    block=5000,
                    count=100,
                )

                if not result:
                    continue

                for stream_name, messages in result:
                    symbol = stream_name.decode().replace("market:", "")
                    for msg_id, raw in messages:
                        data = self._parse_market_data(raw)

                        # 跳尾机制：检查积压程度
                        now_ms = int(time.time() * 1000)
                        age = now_ms - data.timestamp
                        if abs(age) > self._BACKLOG_THRESHOLD_MS:
                            # 积压严重，跳到流尾部
                            self._last_ids[symbol] = "$"
                            await asyncio.sleep(0)  # yield to event loop
                            continue

                        self._last_ids[symbol] = msg_id.decode()
                        yield data

            except (aioredis.ConnectionError, aioredis.TimeoutError, aioredis.ResponseError) as redis_err:
                # 断线后重连，指数退避
                self._reconnect_attempt += 1
                delay = min(self._BASE_RECONNECT_DELAY * (2 ** (self._reconnect_attempt - 1)), self._MAX_RECONNECT_DELAY)
                logger = __import__('logging').getLogger(__name__)
                logger.warning(f"[RedisReader] {type(redis_err).__name__}, retrying in {delay:.1f}s (attempt {self._reconnect_attempt})")
                await asyncio.sleep(delay)
                for symbol in self._symbols:
                    self._last_ids[symbol] = "$"
                self._redis = None
                await self._connect()
