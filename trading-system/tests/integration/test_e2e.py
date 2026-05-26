import pytest
from signal_client import SignalClient, SignalError


@pytest.mark.asyncio
async def test_send_signal_accepted(client):
    result = await client.send_signal(
        symbol="BTC_USDT_Perp",
        action="long",
        stop_loss=97000.0,
        take_profit=100000.0,
        confidence=75.0,
        position_size=0.01,
        signal_price=98500.0,
        max_slippage_bps=10,
    )

    assert result.accepted is True


@pytest.mark.asyncio
async def test_send_signal_duplicate_rejected(client):
    result1 = await client.send_signal(
        symbol="ETH_USDT_Perp",
        action="short",
        stop_loss=3500.0,
        take_profit=3200.0,
        confidence=80.0,
        position_size=0.1,
        signal_price=3400.0,
        max_slippage_bps=15,
    )

    assert result1.accepted is True

    result2 = await client.send_signal(
        symbol="ETH_USDT_Perp",
        action="short",
        stop_loss=3500.0,
        take_profit=3200.0,
        confidence=80.0,
        position_size=0.1,
        signal_price=3400.0,
        max_slippage_bps=15,
    )

    assert result2.accepted is True


@pytest.mark.asyncio
async def test_health_check(client):
    assert await client.health_check() is True


@pytest.mark.asyncio
async def test_invalid_signal_empty_symbol(client):
    with pytest.raises(ValueError, match="symbol must not be empty"):
        await client.send_signal(
            symbol="",
            action="long",
            stop_loss=97000.0,
            take_profit=100000.0,
            confidence=75.0,
            position_size=0.01,
            signal_price=98500.0,
        )


@pytest.mark.asyncio
async def test_invalid_signal_bad_action(client):
    with pytest.raises(ValueError, match="action must be"):
        await client.send_signal(
            symbol="BTC_USDT_Perp",
            action="hold",
            stop_loss=97000.0,
            take_profit=100000.0,
            confidence=75.0,
            position_size=0.01,
            signal_price=98500.0,
        )


@pytest.mark.asyncio
async def test_invalid_signal_confidence_out_of_range(client):
    with pytest.raises(ValueError, match="confidence must be between 0 and 100"):
        await client.send_signal(
            symbol="BTC_USDT_Perp",
            action="long",
            stop_loss=97000.0,
            take_profit=100000.0,
            confidence=150.0,
            position_size=0.01,
            signal_price=98500.0,
        )


@pytest.mark.asyncio
async def test_invalid_signal_negative_position_size(client):
    with pytest.raises(ValueError, match="position_size must be positive"):
        await client.send_signal(
            symbol="BTC_USDT_Perp",
            action="long",
            stop_loss=97000.0,
            take_profit=100000.0,
            confidence=75.0,
            position_size=-0.01,
            signal_price=98500.0,
        )


@pytest.mark.asyncio
async def test_send_close_action(client):
    result = await client.send_signal(
        symbol="SOL_USDT_Perp",
        action="close",
        stop_loss=190.0,
        take_profit=210.0,
        confidence=90.0,
        position_size=5.0,
        signal_price=200.0,
        max_slippage_bps=5,
    )

    assert result.accepted is True
