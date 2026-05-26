"""
Feature engine backed by `ta` (Technical Analysis Library, bukosabino/ta).

All stationary features for robust ML inference:
  1-3: Price/SMA ratio - 1 (5, 10, 20 periods)
  4:   RSI centered (RSI/50 - 1)
  5:   MACD histogram / price
  6:   Bollinger %B
  7:   Bollinger width (volatility proxy)
  8-9: Price momentum (5 & 10 ticks)
  10:  Realized volatility (std of log returns)
  11:  Volume ratio (current vs 10-tick average)
  12:  Price acceleration (change in momentum)

Legacy mode (use_legacy_features=True): 9 features + z-score normalization.
"""

import numpy as np
import pandas as pd
import ta
from typing import List

from src.redis_reader import MarketData


class FeatureEngine:
    def __init__(self, window_size: int = 100, use_legacy_features: bool = False):
        self._window_size = window_size
        self._use_legacy = use_legacy_features

    # ----------------------------------------------------------------
    #  Public API
    # ----------------------------------------------------------------

    def compute(self, market_data: List[MarketData]) -> np.ndarray:
        price_values = [p.lastPrice for p in market_data[-self._window_size:]]
        current_price = price_values[-1] if price_values else 0.0

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

        return np.array(features).reshape(1, -1)

    # ----------------------------------------------------------------
    #  Legacy compute (9 features + z-score, for old model compat)
    # ----------------------------------------------------------------

    def _compute_legacy(
        self,
        market_data: List[MarketData],
        price_values: List[float],
        current_price: float,
    ) -> np.ndarray:
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
            vol_change = (market_data[-1].volume24h - market_data[-2].volume24h) / max(
                market_data[-2].volume24h, 1e-9
            )
            features.append(vol_change)
        else:
            features.append(0.0)

        # 9: Price change rate (1-tick)
        if len(price_values) >= 2:
            price_change = (price_values[-1] - price_values[-2]) / price_values[-2]
            features.append(price_change)
        else:
            features.append(0.0)

        # Legacy: z-score normalize the feature vector
        features_array = np.array(features).reshape(1, -1)
        mean = np.mean(features_array)
        std = np.std(features_array)
        if std > 1e-9:
            features_array = (features_array - mean) / std

        return features_array

    # ----------------------------------------------------------------
    #  Delegated to `ta` library
    # ----------------------------------------------------------------

    @staticmethod
    def _to_series(prices: List[float]) -> pd.Series:
        return pd.Series(prices, dtype=float)

    def _calculate_ma(self, prices: List[float], period: int) -> float:
        if len(prices) < period:
            return float(prices[-1]) if prices else 0.0
        s = self._to_series(prices)
        result = ta.trend.sma_indicator(s, window=period)
        last = float(result.iloc[-1])
        return last if not pd.isna(last) else 0.0

    def _calculate_ema(self, prices: List[float], period: int) -> float:
        if len(prices) < period:
            return float(prices[-1]) if prices else 0.0
        s = self._to_series(prices)
        result = ta.trend.ema_indicator(s, window=period)
        last = float(result.iloc[-1])
        return last if not pd.isna(last) else 0.0

    def _calculate_rsi(self, prices: List[float], period: int = 14) -> float:
        if len(prices) < period + 1:
            return 50.0
        s = self._to_series(prices)
        result = ta.momentum.rsi(s, window=period)
        last = float(result.iloc[-1])
        if pd.isna(last):
            return 50.0
        return max(0.0, min(100.0, last))

    def _calculate_macd_histogram(self, prices: List[float]) -> float:
        """MACD histogram normalized by price for stationarity."""
        if len(prices) < 26:
            return 0.0
        s = self._to_series(prices)
        hist = ta.trend.macd_diff(s, window_slow=26, window_fast=12, window_sign=9)
        last = float(hist.iloc[-1])
        if pd.isna(last):
            return 0.0
        # Normalize by current price
        return last / prices[-1] if prices[-1] > 0 else 0.0

    def _calculate_bollinger_pctb(self, prices: List[float], period: int = 20, num_std: float = 2.0) -> float:
        """Bollinger %B: where price is within the bands (0=lower, 1=upper)."""
        if len(prices) < period:
            return 0.5
        s = self._to_series(prices)
        result = ta.volatility.bollinger_pband(s, window=period, window_dev=int(num_std))
        last = float(result.iloc[-1])
        if pd.isna(last):
            return 0.5
        return max(0.0, min(1.0, last))

    def _calculate_bollinger_width(self, prices: List[float], period: int = 20, num_std: float = 2.0) -> float:
        """Bollinger width as % of mid price (volatility proxy)."""
        if len(prices) < period:
            return 0.0
        s = self._to_series(prices)
        result = ta.volatility.bollinger_wband(s, window=period, window_dev=int(num_std))
        last = float(result.iloc[-1])
        return last if not pd.isna(last) else 0.0

    # ----------------------------------------------------------------
    #  Custom calculations (not in `ta`)
    # ----------------------------------------------------------------

    def _calculate_momentum(self, prices: List[float], period: int) -> float:
        """Price momentum: (price[t] - price[t-period]) / price[t-period]."""
        if len(prices) <= period:
            return 0.0
        return (prices[-1] - prices[-period - 1]) / prices[-period - 1]

    def _calculate_realized_vol(self, prices: List[float], period: int = 20) -> float:
        """Realized volatility: std of log returns."""
        if len(prices) < period + 1:
            return 0.0
        log_prices = np.log(np.array(prices[-period - 1:], dtype=float))
        returns = np.diff(log_prices)
        return float(np.std(returns))

    def _calculate_volume_ratio(self, market_data: List[MarketData], period: int = 10) -> float:
        """Current volume vs rolling average volume."""
        if len(market_data) < period + 1:
            return 1.0
        current_vol = market_data[-1].volume24h
        avg_vol = float(np.mean([d.volume24h for d in market_data[-period - 1:-1]]))
        return current_vol / avg_vol if avg_vol > 0 else 1.0

    def _calculate_acceleration(self, prices: List[float], short_period: int = 5, long_period: int = 10) -> float:
        """Price acceleration: change in momentum."""
        mom_short = self._calculate_momentum(prices, short_period)
        mom_long = self._calculate_momentum(prices, long_period)
        return mom_short - mom_long
