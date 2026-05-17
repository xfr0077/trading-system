import pytest
from unittest.mock import MagicMock, patch
from src.signal_client import SignalClient


@pytest.fixture
def mock_stub():
    return MagicMock()


def test_send_signal_accepted(mock_stub):
    mock_stub.SendSignal.return_value = MagicMock(accepted=True, reason='')

    client = SignalClient(stub=mock_stub)
    result = client.send_signal(
        symbol="BTC_USDT_Perp",
        action="long",
        stop_loss=97000.0,
        take_profit=100000.0,
        confidence=75.0,
        position_size=0.01,
        signal_price=98500.0,
        max_slippage_bps=10
    )

    assert result.accepted is True
    mock_stub.SendSignal.assert_called_once()


def test_send_signal_rejected(mock_stub):
    mock_stub.SendSignal.return_value = MagicMock(accepted=False, reason='RISK_LIMIT_EXCEEDED')

    client = SignalClient(stub=mock_stub)
    result = client.send_signal(
        symbol="BTC_USDT_Perp",
        action="long",
        stop_loss=97000.0,
        take_profit=100000.0,
        confidence=75.0,
        position_size=0.01,
        signal_price=98500.0,
        max_slippage_bps=10
    )

    assert result.accepted is False
    assert result.reason == 'RISK_LIMIT_EXCEEDED'
