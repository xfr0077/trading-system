import pytest
import grpc
from unittest.mock import AsyncMock, MagicMock, patch
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
    @pytest.mark.asyncio
    async def test_send_signal_accepted(self, mock_stub):
        mock_stub.SendSignal = AsyncMock(return_value=MagicMock(accepted=True, reason=""))

        client = SignalClient(stub=mock_stub)
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
        mock_stub.SendSignal.assert_called_once()

    @pytest.mark.asyncio
    async def test_send_signal_rejected(self, mock_stub):
        mock_stub.SendSignal = AsyncMock(return_value=MagicMock(accepted=False, reason="RISK_LIMIT_EXCEEDED"))

        client = SignalClient(stub=mock_stub)
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

        assert result.accepted is False
        assert result.reason == "RISK_LIMIT_EXCEEDED"


class TestSendSignalValidation:
    @pytest.mark.asyncio
    async def test_empty_symbol_raises_error(self, mock_stub):
        client = SignalClient(stub=mock_stub)
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
    async def test_invalid_action_raises_error(self, mock_stub):
        client = SignalClient(stub=mock_stub)
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
    async def test_confidence_out_of_range_raises_error(self, mock_stub):
        client = SignalClient(stub=mock_stub)
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
    async def test_negative_confidence_raises_error(self, mock_stub):
        client = SignalClient(stub=mock_stub)
        with pytest.raises(ValueError, match="confidence must be between 0 and 100"):
            await client.send_signal(
                symbol="BTC_USDT_Perp",
                action="long",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=-5.0,
                position_size=0.01,
                signal_price=98500.0,
            )

    @pytest.mark.asyncio
    async def test_zero_position_size_raises_error(self, mock_stub):
        client = SignalClient(stub=mock_stub)
        with pytest.raises(ValueError, match="position_size must be positive"):
            await client.send_signal(
                symbol="BTC_USDT_Perp",
                action="long",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=75.0,
                position_size=0,
                signal_price=98500.0,
            )

    @pytest.mark.asyncio
    async def test_negative_stop_loss_raises_error(self, mock_stub):
        client = SignalClient(stub=mock_stub)
        with pytest.raises(ValueError, match="stop_loss must be non-negative"):
            await client.send_signal(
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

    @pytest.mark.asyncio
    async def test_unavailable_raises_signal_error(self, mock_stub):
        mock_stub.SendSignal = AsyncMock(side_effect=self._make_rpc_error(
            grpc.StatusCode.UNAVAILABLE, "service unreachable"
        ))
        client = SignalClient(stub=mock_stub)
        with pytest.raises(SignalError, match="Signal service unavailable"):
            await client.send_signal(
                symbol="BTC_USDT_Perp",
                action="long",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=75.0,
                position_size=0.01,
                signal_price=98500.0,
            )

    @pytest.mark.asyncio
    async def test_deadline_exceeded_raises_signal_error(self, mock_stub):
        mock_stub.SendSignal = AsyncMock(side_effect=self._make_rpc_error(
            grpc.StatusCode.DEADLINE_EXCEEDED, "timeout"
        ))
        client = SignalClient(stub=mock_stub)
        with pytest.raises(SignalError, match="Signal service timeout"):
            await client.send_signal(
                symbol="BTC_USDT_Perp",
                action="long",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=75.0,
                position_size=0.01,
                signal_price=98500.0,
            )

    @pytest.mark.asyncio
    async def test_invalid_argument_raises_signal_error(self, mock_stub):
        mock_stub.SendSignal = AsyncMock(side_effect=self._make_rpc_error(
            grpc.StatusCode.INVALID_ARGUMENT, "bad field"
        ))
        client = SignalClient(stub=mock_stub)
        with pytest.raises(SignalError, match="Invalid signal argument"):
            await client.send_signal(
                symbol="BTC_USDT_Perp",
                action="long",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=75.0,
                position_size=0.01,
                signal_price=98500.0,
            )

    @pytest.mark.asyncio
    async def test_unknown_grpc_error_raises_signal_error(self, mock_stub):
        mock_stub.SendSignal = AsyncMock(side_effect=self._make_rpc_error(
            grpc.StatusCode.INTERNAL, "internal failure"
        ))
        client = SignalClient(stub=mock_stub)
        with pytest.raises(SignalError, match="gRPC error"):
            await client.send_signal(
                symbol="BTC_USDT_Perp",
                action="long",
                stop_loss=97000.0,
                take_profit=100000.0,
                confidence=75.0,
                position_size=0.01,
                signal_price=98500.0,
            )


class TestHealthCheck:
    @pytest.mark.asyncio
    async def test_health_check_healthy(self, mock_stub):
        mock_stub.HealthCheck = AsyncMock(return_value=MagicMock(healthy=True, version="1.0.0"))
        client = SignalClient(stub=mock_stub)
        assert await client.health_check() is True

    @pytest.mark.asyncio
    async def test_health_check_unhealthy(self, mock_stub):
        mock_stub.HealthCheck = AsyncMock(return_value=MagicMock(healthy=False, version="1.0.0"))
        client = SignalClient(stub=mock_stub)
        assert await client.health_check() is False

    @pytest.mark.asyncio
    async def test_health_check_grpc_error_returns_false(self, mock_stub):
        mock_stub.HealthCheck = AsyncMock(side_effect=_FakeRpcError(grpc.StatusCode.UNAVAILABLE, "unavailable"))
        client = SignalClient(stub=mock_stub)
        assert await client.health_check() is False

    @pytest.mark.asyncio
    async def test_health_check_generic_exception_returns_false(self, mock_stub):
        mock_stub.HealthCheck = AsyncMock(side_effect=RuntimeError("unexpected"))
        client = SignalClient(stub=mock_stub)
        assert await client.health_check() is False


class TestChannelManagement:
    def test_client_with_stub_does_not_own_channel(self, mock_stub):
        client = SignalClient(stub=mock_stub)
        assert client.channel is None

    @pytest.mark.asyncio
    async def test_close_does_nothing_when_not_owning_channel(self, mock_stub):
        client = SignalClient(stub=mock_stub)
        await client.close()
        assert client.channel is None

    @patch("grpc.aio.insecure_channel")
    @pytest.mark.asyncio
    async def test_close_closes_owned_channel(self, mock_channel_factory):
        mock_channel = AsyncMock()
        mock_channel_factory.return_value = mock_channel

        client = SignalClient(target="localhost:50051")
        await client.close()
        mock_channel.close.assert_called_once()
        assert client.channel is None

    @patch("grpc.aio.insecure_channel")
    @pytest.mark.asyncio
    async def test_async_context_manager_closes_channel(self, mock_channel_factory):
        mock_channel = AsyncMock()
        mock_channel_factory.return_value = mock_channel

        async with SignalClient(target="localhost:50051") as client:
            assert client.channel is not None

        mock_channel.close.assert_called_once()

    @patch("grpc.aio.insecure_channel")
    def test_channel_options_passed(self, mock_channel_factory):
        mock_channel = MagicMock()
        mock_channel_factory.return_value = mock_channel

        custom_options = [("grpc.keepalive_timeout_ms", 5000)]
        SignalClient(target="localhost:50051", channel_options=custom_options)

        mock_channel_factory.assert_called_once()
        call_args = mock_channel_factory.call_args
        assert call_args[0][0] == "localhost:50051"
        assert call_args[1]["options"] == custom_options
