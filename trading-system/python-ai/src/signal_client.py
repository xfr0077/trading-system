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


class SignalClient:
    def __init__(self, stub: Optional[signal_pb2_grpc.SignalServiceStub] = None, target: str = "localhost:50051"):
        if stub:
            self.stub = stub
        else:
            channel = grpc.insecure_channel(target)
            self.stub = signal_pb2_grpc.SignalServiceStub(channel)

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

        response = self.stub.SendSignal(request)
        return SignalAck(accepted=response.accepted, reason=response.reason)

    def health_check(self) -> bool:
        try:
            response = self.stub.HealthCheck(signal_pb2.HealthRequest())
            return response.healthy
        except Exception:
            return False
