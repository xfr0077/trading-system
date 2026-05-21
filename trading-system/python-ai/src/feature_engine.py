import numpy as np
from typing import List
from src.redis_reader import MarketData

class FeatureEngine:
    """
    P0 Fix: Stationary features for robust ML inference.
    
    All features are normalized ratios/percentages, not raw values.
    This ensures the model works across different price levels and time periods.
    
    Features (12 total for new models, 10 for legacy compatibility):
    1-3: Price/SMA ratio - 1 (5, 10, 20 periods)
    4: RSI centered (RSI/50 - 1)
    5: MACD histogram (MACD - signal line) / price
    6: Bollinger %B = (price - lower) / (upper - lower)
    7: Bollinger width = (upper - lower) / mid (volatility proxy)
    8: 5-tick price momentum
    9: 10-tick price momentum
    10: Realized volatility (std of returns over 20 ticks)
    11: Volume ratio (current vs 10-tick average)
    12: Price acceleration (change in momentum)
    
    Legacy mode (use_legacy_features=True) produces 10 features compatible
    with existing trained models.
    """
    
    def __init__(self, window_size: int = 100, use_legacy_features: bool = False):
        self._window_size = window_size
        self._use_legacy = use_legacy_features

    def _calculate_ma(self, prices: List[float], period: int) -> float:
        if len(prices) < period:
            return prices[-1] if prices else 0.0
        return np.mean(prices[-period:])

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

    def _calculate_ema(self, prices: List[float], period: int) -> float:
        if len(prices) < period:
            return prices[-1] if prices else 0.0
        k = 2.0 / (period + 1)
        result = sum(prices[:period]) / period
        for price in prices[period:]:
            result = price * k + result * (1 - k)
        return result

    def _calculate_macd_histogram(self, prices: List[float]) -> float:
        """MACD histogram normalized by price for stationarity"""
        if len(prices) < 26:
            return 0.0
        ema_fast = self._calculate_ema(prices[-60:], 12)
        ema_slow = self._calculate_ema(prices[-60:], 26)
        macd = ema_fast - ema_slow
        
        # Signal line (9-period EMA of MACD)
        # Approximate with recent MACD values
        macd_values = []
        for i in range(max(0, len(prices) - 35), len(prices)):
            if i >= 26:
                ef = self._calculate_ema(prices[max(0, i-60):i+1], 12)
                es = self._calculate_ema(prices[max(0, i-60):i+1], 26)
                macd_values.append(ef - es)
        
        if len(macd_values) >= 9:
            signal = self._calculate_ema(macd_values[-18:], 9)
        else:
            signal = macd
        
        histogram = macd - signal
        # Normalize by price for stationarity
        return histogram / prices[-1] if prices[-1] > 0 else 0.0

    def _calculate_bollinger_pctb(self, prices: List[float], period: int = 20, num_std: float = 2.0) -> float:
        """Bollinger %B: where price is within the bands (0=lower, 1=upper)"""
        if len(prices) < period:
            return 0.5
        ma = np.mean(prices[-period:])
        std = np.std(prices[-period:])
        if std == 0:
            return 0.5
        lower = ma - num_std * std
        upper = ma + num_std * std
        return (prices[-1] - lower) / (upper - lower)

    def _calculate_bollinger_width(self, prices: List[float], period: int = 20, num_std: float = 2.0) -> float:
        """Bollinger width as % of mid price (volatility proxy)"""
        if len(prices) < period:
            return 0.0
        ma = np.mean(prices[-period:])
        std = np.std(prices[-period:])
        return (2 * num_std * std) / ma if ma > 0 else 0.0

    def _calculate_momentum(self, prices: List[float], period: int) -> float:
        """Price momentum: (price[t] - price[t-period]) / price[t-period]"""
        if len(prices) <= period:
            return 0.0
        return (prices[-1] - prices[-period - 1]) / prices[-period - 1]

    def _calculate_realized_vol(self, prices: List[float], period: int = 20) -> float:
        """Realized volatility: std of log returns"""
        if len(prices) < period + 1:
            return 0.0
        returns = np.diff(np.log(prices[-period - 1:]))
        return float(np.std(returns))

    def _calculate_volume_ratio(self, market_data: List[MarketData], period: int = 10) -> float:
        """Current volume vs rolling average volume"""
        if len(market_data) < period + 1:
            return 1.0
        current_vol = market_data[-1].volume24h
        avg_vol = np.mean([d.volume24h for d in market_data[-period - 1:-1]])
        return current_vol / avg_vol if avg_vol > 0 else 1.0

    def _calculate_acceleration(self, prices: List[float], short_period: int = 5, long_period: int = 10) -> float:
        """Price acceleration: change in momentum"""
        mom_short = self._calculate_momentum(prices, short_period)
        mom_long = self._calculate_momentum(prices, long_period)
        return mom_short - mom_long

    def compute(self, market_data: List[MarketData]) -> np.ndarray:
        price_values = [p.lastPrice for p in market_data[-self._window_size:]]
        current_price = price_values[-1] if price_values else 0.0

        # Legacy mode: produce 10 features compatible with existing models
        if self._use_legacy:
            return self._compute_legacy(market_data, price_values, current_price)

        features = []

        # 1-3: Price/SMA ratio - 1 (stationary, centered around 0)
        for period in [5, 10, 20]:
            ma = self._calculate_ma(price_values, period)
            features.append((current_price / ma - 1) if ma > 0 else 0.0)

        # 4: RSI centered (RSI/50 - 1, ranges from -1 to +1)
        rsi = self._calculate_rsi(price_values)
        features.append(rsi / 50.0 - 1.0)

        # 5: MACD histogram / price (stationary)
        features.append(self._calculate_macd_histogram(price_values))

        # 6: Bollinger %B (0 to 1 range)
        features.append(self._calculate_bollinger_pctb(price_values))

        # 7: Bollinger width / mid (volatility proxy, percentage)
        features.append(self._calculate_bollinger_width(price_values))

        # 8-9: Multi-period momentum (stationary)
        features.append(self._calculate_momentum(price_values, 5))
        features.append(self._calculate_momentum(price_values, 10))

        # 10: Realized volatility (std of log returns)
        features.append(self._calculate_realized_vol(price_values))

        # 11: Volume ratio (current vs average)
        features.append(self._calculate_volume_ratio(market_data))

        # 12: Price acceleration (change in momentum)
        features.append(self._calculate_acceleration(price_values))

        # P0 Fix: Remove Z-Score normalization at inference time.
        # Features are already stationary and bounded.
        # The model should have been trained with these same feature definitions.
        # If the model expects normalized features, bake normalization into training.
        
        return np.array(features).reshape(1, -1)

    def _compute_legacy(self, market_data: List[MarketData], price_values: List[float], current_price: float) -> np.ndarray:
        """Legacy 10-feature mode for compatibility with existing trained models."""
        features = []

        # 1-3: Price/SMA ratio - 1 (stationary)
        for period in [5, 10, 20]:
            ma = self._calculate_ma(price_values, period)
            features.append((current_price / ma - 1) if ma > 0 else 0.0)

        # 4: RSI centered
        rsi = self._calculate_rsi(price_values)
        features.append(rsi / 50.0 - 1.0)

        # 5: MACD histogram / price
        features.append(self._calculate_macd_histogram(price_values))

        # 6-7: Bollinger %B and width
        features.append(self._calculate_bollinger_pctb(price_values))
        features.append(self._calculate_bollinger_width(price_values))

        # 8: Volume change rate (legacy)
        if len(market_data) >= 2:
            vol_change = (market_data[-1].volume24h - market_data[-2].volume24h) / max(market_data[-2].volume24h, 1e-9)
            features.append(vol_change)
        else:
            features.append(0.0)

        # 9: Price change rate (1-tick)
        if len(price_values) >= 2:
            price_change = (price_values[-1] - price_values[-2]) / price_values[-2]
            features.append(price_change)
        else:
            features.append(0.0)

        # 10: Z-Score normalization (legacy behavior)
        features_array = np.array(features).reshape(1, -1)
        mean = np.mean(features_array)
        std = np.std(features_array)
        if std > 1e-9:
            features_array = (features_array - mean) / std

        return features_array
