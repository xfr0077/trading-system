import uuid
import time
import grpc
from typing import Optional
from dataclasses import dataclass

from proto import signal_pb2
from proto import signal_pb2_grpc


@dataclass
class SignalAck:
    accepted: bool
    reason: str


class SignalError(Exception):
    pass


class SignalClient:
    _DEFAULT_CHANNEL_OPTIONS = [
        ("grpc.keepalive_timeout_ms", 10000),
        ("grpc.keepalive_time_ms", 30000),
        ("grpc.keepalive_permit_without_calls", 1),
        ("grpc.http2.max_pings_without_data", 0),
    ]

    _RPC_TIMEOUT = 15.0

    def __init__(
        self,
        stub: Optional[signal_pb2_grpc.SignalServiceStub] = None,
        target: str = "localhost:50051",
        channel_options: Optional[list] = None,
    ):
        self._owns_channel = stub is None
        if stub:
            self.stub = stub
            self.channel = None
        else:
            options = channel_options if channel_options is not None else self._DEFAULT_CHANNEL_OPTIONS
            self.channel = grpc.insecure_channel(target, options=options)
            self.stub = signal_pb2_grpc.SignalServiceStub(self.channel)

    def _validate_signal(
        self,
        symbol: str,
        action: str,
        stop_loss: float,
        take_profit: float,
        confidence: float,
        position_size: float,
        signal_price: float,
    ) -> None:
        if not symbol:
            raise ValueError("symbol must not be empty")
        if action not in ("long", "short", "close"):
            raise ValueError(f"action must be 'long', 'short', or 'close', got '{action}'")
        if not (0.0 <= confidence <= 100.0):
            raise ValueError(f"confidence must be between 0 and 100, got {confidence}")
        if position_size <= 0:
            raise ValueError(f"position_size must be positive, got {position_size}")
        if stop_loss <= 0:
            raise ValueError(f"stop_loss must be positive, got {stop_loss}")
        if take_profit <= 0:
            raise ValueError(f"take_profit must be positive, got {take_profit}")
        if signal_price <= 0:
            raise ValueError(f"signal_price must be positive, got {signal_price}")

    def send_signal(
        self,
        symbol: str,
        action: str,
        stop_loss: float,
        take_profit: float,
        confidence: float,
        position_size: float,
        signal_price: float,
        max_slippage_bps: int = 10,
    ) -> SignalAck:
        self._validate_signal(symbol, action, stop_loss, take_profit, confidence, position_size, signal_price)

        request = signal_pb2.TradingSignal(
            signal_id=str(uuid.uuid4()),
            symbol=symbol,
            action=action,
            stop_loss=stop_loss,
            take_profit=take_profit,
            confidence=confidence,
            position_size=position_size,
            timestamp=int(time.time() * 1000),
            signal_price=signal_price,
            max_slippage_bps=max_slippage_bps,
        )

        try:
            response = self.stub.SendSignal(request, timeout=self._RPC_TIMEOUT)
            return SignalAck(accepted=response.accepted, reason=response.reason)
        except grpc.RpcError as e:
            status_code = e.code()
            details = e.details() if hasattr(e, "details") else str(e)
            if status_code == grpc.StatusCode.UNAVAILABLE:
                raise SignalError(f"Signal service unavailable: {details}") from e
            elif status_code == grpc.StatusCode.DEADLINE_EXCEEDED:
                raise SignalError(f"Signal service timeout: {details}") from e
            elif status_code == grpc.StatusCode.INVALID_ARGUMENT:
                raise SignalError(f"Invalid signal argument: {details}") from e
            else:
                raise SignalError(f"gRPC error ({status_code}): {details}") from e

    def health_check(self) -> bool:
        try:
            response = self.stub.HealthCheck(signal_pb2.HealthRequest(), timeout=self._RPC_TIMEOUT)
            return response.healthy
        except grpc.RpcError:
            return False
        except Exception:
            return False

    def close(self) -> None:
        if self._owns_channel and self.channel is not None:
            self.channel.close()
            self.channel = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False
