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

# -- Basic shape/sanity tests --

def test_compute_returns_correct_shape(sample_prices):
    engine = FeatureEngine(window_size=100)
    features = engine.compute(sample_prices)
    assert features.shape[0] == 1
    assert features.shape[1] > 0

def test_compute_new_mode_returns_12_features(sample_prices):
    engine = FeatureEngine(window_size=100, use_legacy_features=False)
    features = engine.compute(sample_prices)
    assert features.shape == (1, 12)

def test_compute_legacy_mode_returns_9_features(sample_prices):
    engine = FeatureEngine(window_size=100, use_legacy_features=True)
    features = engine.compute(sample_prices)
    assert features.shape == (1, 9)

def test_feature_vector_is_finite(sample_prices):
    engine = FeatureEngine(window_size=100)
    features = engine.compute(sample_prices)
    assert np.all(np.isfinite(features))

def test_compute_with_insufficient_data_does_not_crash():
    engine = FeatureEngine(window_size=10)
    now = int(time.time() * 1000)
    prices = [MarketData(symbol="BTC", lastPrice=100.0, bidPrice=99.0, askPrice=101.0, volume24h=1000.0, timestamp=now)]
    features = engine.compute(prices)
    assert np.all(np.isfinite(features))

def test_compute_with_constant_prices():
    engine = FeatureEngine(window_size=20, use_legacy_features=False)
    now = int(time.time() * 1000)
    prices = [MarketData(symbol="BTC", lastPrice=100.0, bidPrice=99.0, askPrice=101.0, volume24h=1000.0, timestamp=now + i) for i in range(30)]
    features = engine.compute(prices)
    assert features.shape == (1, 12)
    assert np.all(np.isfinite(features))

# -- Individual feature method tests --

def test_calculate_ma_returns_float():
    engine = FeatureEngine(window_size=10)
    prices = [10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0]
    ma = engine._calculate_ma(prices, 5)
    assert isinstance(ma, (float, np.floating))
    assert ma == pytest.approx(17.0)

def test_calculate_ma_with_insufficient_data():
    engine = FeatureEngine(window_size=10)
    ma = engine._calculate_ma([100.0], 5)
    assert ma == 100.0

def test_rsi_returns_centered_value():
    engine = FeatureEngine(window_size=20)
    prices = list(range(100, 120))
    rsi = engine._calculate_rsi(prices, 14)
    assert 0.0 <= rsi <= 100.0

def test_rsi_with_insufficient_data():
    engine = FeatureEngine(window_size=20)
    rsi = engine._calculate_rsi([100.0], 14)
    assert rsi == 50.0

def test_macd_histogram_normalized():
    engine = FeatureEngine(window_size=60)
    prices = [100.0 + i * 0.1 for i in range(30)]
    hist = engine._calculate_macd_histogram(prices)
    assert isinstance(hist, float)
    assert np.isfinite(hist)

def test_macd_histogram_with_short_data():
    engine = FeatureEngine(window_size=60)
    hist = engine._calculate_macd_histogram([100.0, 101.0])
    assert hist == 0.0

def test_bollinger_pctb_in_range():
    engine = FeatureEngine(window_size=30)
    prices = [100.0 + i * 0.5 for i in range(25)]
    pctb = engine._calculate_bollinger_pctb(prices)
    assert 0.0 <= pctb <= 1.0

def test_bollinger_pctb_with_constant_prices():
    engine = FeatureEngine(window_size=30)
    prices = [100.0] * 25
    pctb = engine._calculate_bollinger_pctb(prices)
    assert pctb == 0.5

def test_momentum_positive():
    engine = FeatureEngine(window_size=30)
    prices = [100.0 + i for i in range(15)]
    mom = engine._calculate_momentum(prices, 5)
    assert mom > 0.0

def test_momentum_negative():
    engine = FeatureEngine(window_size=30)
    prices = [100.0 - i * 0.5 for i in range(15)]
    mom = engine._calculate_momentum(prices, 5)
    assert mom < 0.0

def test_realized_vol_non_negative():
    engine = FeatureEngine(window_size=30)
    prices = [100.0 + np.random.randn() * 2 for _ in range(25)]
    vol = engine._calculate_realized_vol(prices)
    assert vol >= 0.0
    assert np.isfinite(vol)

def test_realized_vol_with_constant_prices():
    engine = FeatureEngine(window_size=30)
    prices = [100.0] * 25
    vol = engine._calculate_realized_vol(prices)
    assert vol == 0.0

def test_volume_ratio_default():
    engine = FeatureEngine(window_size=20)
    now = int(time.time() * 1000)
    md = [MarketData("BTC", 100.0, 99.0, 101.0, 1000.0, now + i) for i in range(15)]
    ratio = engine._calculate_volume_ratio(md)
    assert ratio == pytest.approx(1.0, abs=0.5)

def test_acceleration_basic():
    engine = FeatureEngine(window_size=30)
    prices = [100.0 + i * 0.1 for i in range(15)]
    accel = engine._calculate_acceleration(prices)
    assert isinstance(accel, float)

# -- Legacy feature mode tests --

def test_legacy_mode_produces_9_stationary_features():
    engine = FeatureEngine(window_size=60, use_legacy_features=True)
    now = int(time.time() * 1000)
    prices = [MarketData("BTC", 100.0 + i, 99.0 + i, 101.0 + i, 1000.0, now + i) for i in range(80)]
    features = engine.compute(prices)
    assert features.shape == (1, 9)
    assert np.all(np.isfinite(features))

# -- Feature stability tests --

def test_feature_values_are_reasonable(sample_prices):
    engine = FeatureEngine(window_size=100, use_legacy_features=False)
    features = engine.compute(sample_prices)
    f = features[0]
    assert abs(f[0]) < 1.0  # Price/SMA5 - 1 should be small
    assert abs(f[1]) < 1.0  # Price/SMA10 - 1 should be small
    assert abs(f[2]) < 1.0  # Price/SMA20 - 1 should be small
    assert -1.0 <= f[3] <= 1.0  # RSI centered
    assert 0.0 <= f[5] <= 1.0  # Bollinger %B

def test_uptrend_features():
    """上升趋势: momentum 正, MACD 正"""
    engine = FeatureEngine(window_size=60, use_legacy_features=False)
    now = int(time.time() * 1000)
    prices = [MarketData("BTC", 100.0 + i * 0.3, 99.0 + i * 0.3, 101.0 + i * 0.3, 1000.0, now + i) for i in range(80)]
    features = engine.compute(prices)
    f = features[0]
    assert f[7] > 0.0  # 5-tick momentum
    assert f[8] > 0.0  # 10-tick momentum

def test_downtrend_features():
    """下降趋势: momentum 负, MACD 负"""
    engine = FeatureEngine(window_size=60, use_legacy_features=False)
    now = int(time.time() * 1000)
    prices = [MarketData("BTC", 100.0 - i * 0.3, 99.0 - i * 0.3, 101.0 - i * 0.3, 1000.0, now + i) for i in range(80)]
    features = engine.compute(prices)
    f = features[0]
    assert f[7] < 0.0  # 5-tick momentum
    assert f[8] < 0.0  # 10-tick momentum
