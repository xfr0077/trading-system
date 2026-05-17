import os
import pytest
from src.config import AIConfig

def test_default_config():
    config = AIConfig()
    assert config.ts_engine_grpc_url == "localhost:50051"
    assert config.redis_url == "redis://localhost:6379"
    assert config.model_path == "models/model.onnx"
    assert config.feature_window == 100
    assert config.confidence_threshold == 70.0
    assert config.symbols == ["BTC_USDT_Perp"]

def test_config_from_env(monkeypatch):
    monkeypatch.setenv("TS_ENGINE_GRPC_URL", "100.1.2.3:50051")
    monkeypatch.setenv("REDIS_URL", "redis://vps:6379")
    monkeypatch.setenv("CONFIDENCE_THRESHOLD", "80.0")

    config = AIConfig.from_env()
    assert config.ts_engine_grpc_url == "100.1.2.3:50051"
    assert config.redis_url == "redis://vps:6379"
    assert config.confidence_threshold == 80.0

def test_invalid_grpc_url():
    with pytest.raises(ValueError):
        AIConfig(ts_engine_grpc_url="")

def test_invalid_confidence_threshold():
    with pytest.raises(ValueError):
        AIConfig(confidence_threshold=150.0)
