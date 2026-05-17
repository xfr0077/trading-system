import pytest
import grpc
from unittest.mock import MagicMock, patch
from src.signal_client import SignalClient, SignalAck, SignalError


class _FakeRpcError(grpc.RpcError):
    def __init__(self, code, details):
        super().__init__()
        self._code = code
        self._details = details

    def code(self):
        return self._code

    def details(self):
        return self._details


@pytest.fixture
def mock_stub():
    return MagicMock()


class TestSendSignal:
    def test_send_signal_accepted(self, mock_stub):
        mock_stub.SendSignal.return_value = MagicMock(accepted=True, reason="")

        client = SignalClient(stub=mock_stub)
        result = client.send_signal(
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
        mock_stub.SendSignal.assert_called_once()

    def test_send_signal_rejected(self, mock_stub):
        mock_stub.SendSignal.return_value = MagicMock(accepted=False, reason="RISK_LIMIT_EXCEEDED")

        client = SignalClient(stub=mock_stub)
        result = client.send_signal(
            symbol="BTC_USDT_Perp",
            action="long",
            stop_loss=97000.0,
            take_profit=100000.0,
            confidence=75.0,
            position_size=0.01,
            signal_price=98500.0,
            max_slippage_bps=10,
        )

        assert result.accepted is False
        assert result.reason == "RISK_LIMIT_EXCEEDED"


class TestSendSignalValidation:
    def test_empty_symbol_raises_error(self, mock_stub):
        client = SignalClient(stub=mock_stub)
        with pytest.raises(ValueError, match="symbol must not be empty"):
            client.send_signal(
                symbol="",
                action="long",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=75.0,
                position_size=0.01,
                signal_price=98500.0,
            )

    def test_invalid_action_raises_error(self, mock_stub):
        client = SignalClient(stub=mock_stub)
        with pytest.raises(ValueError, match="action must be"):
            client.send_signal(
                symbol="BTC_USDT_Perp",
                action="hold",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=75.0,
                position_size=0.01,
                signal_price=98500.0,
            )

    def test_confidence_out_of_range_raises_error(self, mock_stub):
        client = SignalClient(stub=mock_stub)
        with pytest.raises(ValueError, match="confidence must be between 0 and 100"):
            client.send_signal(
                symbol="BTC_USDT_Perp",
                action="long",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=150.0,
                position_size=0.01,
                signal_price=98500.0,
            )

    def test_negative_confidence_raises_error(self, mock_stub):
        client = SignalClient(stub=mock_stub)
        with pytest.raises(ValueError, match="confidence must be between 0 and 100"):
            client.send_signal(
                symbol="BTC_USDT_Perp",
                action="long",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=-5.0,
                position_size=0.01,
                signal_price=98500.0,
            )

    def test_zero_position_size_raises_error(self, mock_stub):
        client = SignalClient(stub=mock_stub)
        with pytest.raises(ValueError, match="position_size must be positive"):
            client.send_signal(
                symbol="BTC_USDT_Perp",
                action="long",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=75.0,
                position_size=0,
                signal_price=98500.0,
            )

    def test_negative_stop_loss_raises_error(self, mock_stub):
        client = SignalClient(stub=mock_stub)
        with pytest.raises(ValueError, match="stop_loss must be positive"):
            client.send_signal(
                symbol="BTC_USDT_Perp",
                action="long",
                stop_loss=-100.0,
                take_profit=100000.0,
                confidence=75.0,
                position_size=0.01,
                signal_price=98500.0,
            )


class TestSendSignalGrpcErrors:
    def _make_rpc_error(self, code, details):
        return _FakeRpcError(code, details)

    def test_unavailable_raises_signal_error(self, mock_stub):
        mock_stub.SendSignal.side_effect = self._make_rpc_error(
            grpc.StatusCode.UNAVAILABLE, "service unreachable"
        )
        client = SignalClient(stub=mock_stub)
        with pytest.raises(SignalError, match="Signal service unavailable"):
            client.send_signal(
                symbol="BTC_USDT_Perp",
                action="long",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=75.0,
                position_size=0.01,
                signal_price=98500.0,
            )

    def test_deadline_exceeded_raises_signal_error(self, mock_stub):
        mock_stub.SendSignal.side_effect = self._make_rpc_error(
            grpc.StatusCode.DEADLINE_EXCEEDED, "timeout"
        )
        client = SignalClient(stub=mock_stub)
        with pytest.raises(SignalError, match="Signal service timeout"):
            client.send_signal(
                symbol="BTC_USDT_Perp",
                action="long",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=75.0,
                position_size=0.01,
                signal_price=98500.0,
            )

    def test_invalid_argument_raises_signal_error(self, mock_stub):
        mock_stub.SendSignal.side_effect = self._make_rpc_error(
            grpc.StatusCode.INVALID_ARGUMENT, "bad field"
        )
        client = SignalClient(stub=mock_stub)
        with pytest.raises(SignalError, match="Invalid signal argument"):
            client.send_signal(
                symbol="BTC_USDT_Perp",
                action="long",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=75.0,
                position_size=0.01,
                signal_price=98500.0,
            )

    def test_unknown_grpc_error_raises_signal_error(self, mock_stub):
        mock_stub.SendSignal.side_effect = self._make_rpc_error(
            grpc.StatusCode.INTERNAL, "internal failure"
        )
        client = SignalClient(stub=mock_stub)
        with pytest.raises(SignalError, match="gRPC error"):
            client.send_signal(
                symbol="BTC_USDT_Perp",
                action="long",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=75.0,
                position_size=0.01,
                signal_price=98500.0,
            )


class TestHealthCheck:
    def test_health_check_healthy(self, mock_stub):
        mock_stub.HealthCheck.return_value = MagicMock(healthy=True, version="1.0.0")
        client = SignalClient(stub=mock_stub)
        assert client.health_check() is True

    def test_health_check_unhealthy(self, mock_stub):
        mock_stub.HealthCheck.return_value = MagicMock(healthy=False, version="1.0.0")
        client = SignalClient(stub=mock_stub)
        assert client.health_check() is False

    def test_health_check_grpc_error_returns_false(self, mock_stub):
        mock_stub.HealthCheck.side_effect = _FakeRpcError(grpc.StatusCode.UNAVAILABLE, "unavailable")
        client = SignalClient(stub=mock_stub)
        assert client.health_check() is False

    def test_health_check_generic_exception_returns_false(self, mock_stub):
        mock_stub.HealthCheck.side_effect = RuntimeError("unexpected")
        client = SignalClient(stub=mock_stub)
        assert client.health_check() is False


class TestChannelManagement:
    def test_client_with_stub_does_not_own_channel(self, mock_stub):
        client = SignalClient(stub=mock_stub)
        assert client.channel is None

    def test_close_does_nothing_when_not_owning_channel(self, mock_stub):
        client = SignalClient(stub=mock_stub)
        client.close()
        assert client.channel is None

    @patch("grpc.insecure_channel")
    def test_close_closes_owned_channel(self, mock_channel_factory):
        mock_channel = MagicMock()
        mock_channel_factory.return_value = mock_channel

        client = SignalClient(target="localhost:50051")
        client.close()
        mock_channel.close.assert_called_once()
        assert client.channel is None

    @patch("grpc.insecure_channel")
    def test_context_manager_closes_channel(self, mock_channel_factory):
        mock_channel = MagicMock()
        mock_channel_factory.return_value = mock_channel

        with SignalClient(target="localhost:50051") as client:
            assert client.channel is not None

        mock_channel.close.assert_called_once()

    @patch("grpc.insecure_channel")
    def test_channel_options_passed(self, mock_channel_factory):
        mock_channel = MagicMock()
        mock_channel_factory.return_value = mock_channel

        custom_options = [("grpc.keepalive_timeout_ms", 5000)]
        SignalClient(target="localhost:50051", channel_options=custom_options)

        mock_channel_factory.assert_called_once()
        call_args = mock_channel_factory.call_args
        assert call_args[0][0] == "localhost:50051"
        assert call_args[1]["options"] == custom_options
