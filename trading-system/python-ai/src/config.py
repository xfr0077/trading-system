import os
from pydantic import BaseModel, Field, field_validator
from typing import List

class AIConfig(BaseModel):
    ts_engine_grpc_url: str = Field(default="localhost:50051")
    redis_url: str = Field(default="redis://localhost:6379")
    model_path: str = Field(default="models/model.onnx")

    model_config = {'protected_namespaces': ()}
    feature_window: int = Field(default=100)
    confidence_threshold: float = Field(default=70.0)
    symbols: List[str] = Field(default=["BTC_USDT_Perp"])
    stop_loss_pct: float = Field(default=0.98)
    take_profit_pct: float = Field(default=1.02)
    position_size: float = Field(default=0.01)
    max_slippage_bps: int = Field(default=10)
    use_legacy_features: bool = Field(default=True)  # P0: Set to False after retraining model with 12 features

    @field_validator("ts_engine_grpc_url")
    @classmethod
    def validate_grpc_url(cls, v: str) -> str:
        if not v:
            raise ValueError("ts_engine_grpc_url must not be empty")
        return v

    @field_validator("confidence_threshold")
    @classmethod
    def validate_confidence(cls, v: float) -> float:
        if not (0.0 <= v <= 100.0):
            raise ValueError(f"confidence_threshold must be between 0 and 100, got {v}")
        return v

    @classmethod
    def from_env(cls) -> "AIConfig":
        return cls(
            ts_engine_grpc_url=os.getenv("TS_ENGINE_GRPC_URL", cls.model_fields["ts_engine_grpc_url"].default),
            redis_url=os.getenv("REDIS_URL", cls.model_fields["redis_url"].default),
            model_path=os.getenv("MODEL_PATH", cls.model_fields["model_path"].default),
            feature_window=int(os.getenv("FEATURE_WINDOW", str(cls.model_fields["feature_window"].default))),
            confidence_threshold=float(os.getenv("CONFIDENCE_THRESHOLD", str(cls.model_fields["confidence_threshold"].default))),
            symbols=os.getenv("SYMBOLS", ",".join(cls.model_fields["symbols"].default)).split(","),
            stop_loss_pct=float(os.getenv("STOP_LOSS_PCT", str(cls.model_fields["stop_loss_pct"].default))),
            take_profit_pct=float(os.getenv("TAKE_PROFIT_PCT", str(cls.model_fields["take_profit_pct"].default))),
            position_size=float(os.getenv("POSITION_SIZE", str(cls.model_fields["position_size"].default))),
            max_slippage_bps=int(os.getenv("MAX_SLIPPAGE_BPS", str(cls.model_fields["max_slippage_bps"].default))),
            use_legacy_features=os.getenv("USE_LEGACY_FEATURES", "true").lower() == "true",
        )
