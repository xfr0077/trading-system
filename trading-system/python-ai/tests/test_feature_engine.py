import numpy as np
import pytest
from src.feature_engine import FeatureEngine
from src.redis_reader import MarketData
import time

@pytest.fixture
def sample_prices():
    now = int(time.time() * 1000)
    return [
        MarketData(symbol="BTC", lastPrice=100.0 + i, bidPrice=99.0 + i, askPrice=101.0 + i, volume24h=1000.0, timestamp=now + i)
        for i in range(100)
    ]

def test_compute_returns_correct_shape(sample_prices):
    engine = FeatureEngine(window_size=100)
    features = engine.compute(sample_prices)
    assert features.shape[0] == 1  # 单样本
    assert features.shape[1] > 0   # 有特征维度

def test_ma_calculation():
    engine = FeatureEngine(window_size=10)
    prices = [10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0]
    ma = engine._calculate_ma(prices, 5)
    assert len(ma) > 0
    assert ma[-1] == pytest.approx(17.0)  # MA5 of [15,16,17,18,19]

def test_feature_vector_is_finite(sample_prices):
    engine = FeatureEngine(window_size=100)
    features = engine.compute(sample_prices)
    # 验证特征值在合理范围内（Z-Score 标准化后应接近 0）
    assert np.all(np.isfinite(features))
