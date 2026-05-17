import pytest
import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch
from src.redis_reader import RedisMarketReader, MarketData

@pytest.fixture
def mock_redis():
    redis = AsyncMock()
    redis.xread = AsyncMock(return_value=[
        (b"market:BTC_USDT_Perp", [
            (b"1716000000000-0", {
                b"symbol": b"BTC_USDT_Perp",
                b"lastPrice": b"98500.50",
                b"bidPrice": b"98499.00",
                b"askPrice": b"98501.00",
                b"volume24h": b"1234.56",
                b"timestamp": str(int(time.time() * 1000)).encode(),
            })
        ])
    ])
    return redis

@pytest.mark.asyncio
async def test_parse_market_data(mock_redis):
    reader = RedisMarketReader("redis://localhost:6379", ["BTC_USDT_Perp"])
    reader._redis = mock_redis

    data_points = []
    async for data in reader.stream():
        data_points.append(data)
        if len(data_points) >= 1:
            break

    assert len(data_points) == 1
    assert data_points[0].symbol == "BTC_USDT_Perp"
    assert data_points[0].lastPrice == 98500.50

@pytest.mark.asyncio
async def test_skip_backlog_on_reconnect():
    """测试断线重连后跳过积压数据"""
    old_timestamp = int(time.time() * 1000) - 5000  # 5 秒前
    reader = RedisMarketReader("redis://localhost:6379", ["BTC_USDT_Perp"])

    mock_redis = AsyncMock()
    mock_redis.xread = AsyncMock(return_value=[
        (b"market:BTC_USDT_Perp", [
            (b"1716000000000-0", {
                b"symbol": b"BTC_USDT_Perp",
                b"lastPrice": b"98500.50",
                b"bidPrice": b"98499.00",
                b"askPrice": b"98501.00",
                b"volume24h": b"1234.56",
                b"timestamp": str(old_timestamp).encode(),
            })
        ])
    ])
    reader._redis = mock_redis

    # 积压超过 1 秒，应跳过
    # 使用 wait_for 超时验证没有数据被 yield
    stream = reader.stream()
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(stream.__anext__(), timeout=0.5)
