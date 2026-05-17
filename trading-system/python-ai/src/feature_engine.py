import numpy as np
from typing import List
from src.redis_reader import MarketData

class FeatureEngine:
    def __init__(self, window_size: int = 100):
        self._window_size = window_size

    def _calculate_ma(self, prices: List[float], period: int) -> List[float]:
        return [np.mean(prices[max(0, i - period + 1):i + 1]) for i in range(len(prices))]

    def _calculate_rsi(self, prices: List[float], period: int = 14) -> float:
        if len(prices) < period + 1:
            return 50.0
        deltas = np.diff(prices[-period - 1:])
        gains = np.where(deltas > 0, deltas, 0).mean()
        losses = np.where(deltas < 0, -deltas, 0).mean()
        if losses == 0:
            return 100.0
        rs = gains / losses
        return 100.0 - (100.0 / (1.0 + rs))

    def _calculate_macd(self, prices: List[float], fast: int = 12, slow: int = 26, signal: int = 9) -> float:
        if len(prices) < slow:
            return 0.0
        ema_fast = np.mean(prices[-fast:])
        ema_slow = np.mean(prices[-slow:])
        return ema_fast - ema_slow

    def _calculate_bollinger_bands(self, prices: List[float], period: int = 20, num_std: int = 2) -> tuple:
        if len(prices) < period:
            return (0.0, 0.0)
        ma = np.mean(prices[-period:])
        std = np.std(prices[-period:])
        return (ma - num_std * std, ma + num_std * std)

    def compute(self, prices: List[MarketData]) -> np.ndarray:
        price_values = [p.lastPrice for p in prices[-self._window_size:]]

        features = []

        # 移动平均线
        for period in [5, 10, 20]:
            ma = self._calculate_ma(price_values, period)
            features.append(ma[-1] if ma else 0.0)

        # RSI
        features.append(self._calculate_rsi(price_values))

        # MACD
        features.append(self._calculate_macd(price_values))

        # 布林带
        lower, upper = self._calculate_bollinger_bands(price_values)
        features.append(lower)
        features.append(upper)

        # 成交量变化率
        if len(prices) >= 2:
            vol_change = (prices[-1].volume24h - prices[-2].volume24h) / max(prices[-2].volume24h, 1e-9)
            features.append(vol_change)
        else:
            features.append(0.0)

        # 价格变化率
        if len(price_values) >= 2:
            price_change = (price_values[-1] - price_values[-2]) / price_values[-2]
            features.append(price_change)
        else:
            features.append(0.0)

        # Z-Score 标准化
        features_array = np.array(features).reshape(1, -1)
        mean = np.mean(features_array)
        std = np.std(features_array)
        if std > 1e-9:
            features_array = (features_array - mean) / std

        return features_array
