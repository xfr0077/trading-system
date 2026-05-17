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
    _BACKLOG_THRESHOLD_MS = 1000  # 积压阈值：超过 1 秒则跳尾

    def __init__(self, redis_url: str, symbols: List[str]):
        self._redis_url = redis_url
        self._symbols = symbols
        self._redis: Optional[aioredis.Redis] = None
        self._last_ids: dict[str, str] = {s: "$" for s in symbols}

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
                        if now_ms - data.timestamp > self._BACKLOG_THRESHOLD_MS:
                            # 积压严重，跳到流尾部
                            self._last_ids[symbol] = "$"
                            await asyncio.sleep(0)  # yield to event loop
                            continue

                        self._last_ids[symbol] = msg_id.decode()
                        yield data

            except aioredis.ConnectionError:
                # 断线后重连，重置到最新
                for symbol in self._symbols:
                    self._last_ids[symbol] = "$"
                await asyncio.sleep(1)
                self._redis = None
                await self._connect()
