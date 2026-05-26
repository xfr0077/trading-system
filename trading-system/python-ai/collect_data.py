"""Collect OHLCV data from Hyperliquid API for model retraining.

Usage:
  python collect_data.py                     # Default: BTC, ETH, 60 days
  python collect_data.py --coins BTC,ETH,CHIP --days 90 --interval 5m

Output: training_data.pkl with keys 'X' (features) and 'y' (labels)
"""
import argparse, json, os, pickle, sys, time
import numpy as np
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from feature_engine import FeatureEngine

WINDOW = 100
LOOK_AHEAD = 15
THRESHOLD = 0.001


def fetch_candles(coin, days=60, interval="5m"):
    """Fetch OHLCV candles from Hyperliquid info API.
    
    Uses raw HTTP to avoid SDK issues.
    Returns list of {t, o, h, l, c, v} dicts.
    """
    # Map interval to seconds
    interval_sec = {"5m": 300, "15m": 900, "1h": 3600}[interval]
    
    # Calculate time range
    end_time = int(time.time() * 1000)
    start_time = end_time - days * 24 * 3600 * 1000
    
    all_candles = []
    current_start = start_time
    
    while current_start < end_time:
        req_data = {
            "type": "candleSnapshot",
            "req": {
                "coin": coin,
                "interval": interval,
                "startTime": current_start,
                "endTime": min(current_start + 200 * interval_sec * 1000, end_time),
            }
        }
        
        req = urllib.request.Request(
            "https://api.hyperliquid.xyz/info",
            data=json.dumps(req_data).encode(),
            headers={"Content-Type": "application/json"},
        )
        
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                candles = json.loads(resp.read().decode())
        except Exception as e:
            print(f"  Error fetching {coin}: {e}")
            break
        
        if not candles:
            break
        
        all_candles.extend(candles)
        print(f"  Fetched {len(candles)} candles for {coin} (total: {len(all_candles)})")
        
        if len(candles) < 200:
            break
        
        current_start = candles[-1]["t"] + interval_sec * 1000
        time.sleep(0.5)
    
    return all_candles


def candles_to_marketdata(candles):
    """Convert candle dicts to MarketData-like objects for FeatureEngine."""
    class MockMD:
        def __init__(self, price, vol, ts):
            self.lastPrice = price
            self.bidPrice = price * 0.9999
            self.askPrice = price * 1.0001
            self.volume24h = vol
            self.timestamp = ts
    
    return [MockMD(c["c"], c.get("v", 0), c.get("t", 0)) for c in candles]


def generate_labels(candles, window, look_ahead, threshold):
    """Generate labels from candle close prices.
    
    0 = long (price up > threshold), 1 = short (price down < -threshold), 2 = close
    """
    prices = [c["c"] for c in candles]
    labels = []
    
    for i in range(window, len(prices) - look_ahead):
        future = (prices[i + look_ahead] - prices[i]) / prices[i]
        if future > threshold:
            labels.append(0)
        elif future < -threshold:
            labels.append(1)
        else:
            labels.append(2)
    
    return np.array(labels, dtype=np.int64)


def main():
    parser = argparse.ArgumentParser(description="Collect training data from Hyperliquid API")
    parser.add_argument("--coins", default="BTC,ETH", help="Comma-separated coin symbols")
    parser.add_argument("--days", type=int, default=60, help="Days of history")
    parser.add_argument("--interval", default="5m", choices=["5m", "15m", "1h"], help="Candle interval")
    parser.add_argument("--output", default="training_data.pkl", help="Output path")
    args = parser.parse_args()
    
    coins = [c.strip() for c in args.coins.split(",")]
    
    engine = FeatureEngine(window_size=WINDOW, use_legacy_features=False)
    
    all_X, all_y = [], []
    
    for coin in coins:
        print(f"\nFetching {args.days} days of {args.interval} candles for {coin}...")
        candles = fetch_candles(coin, days=args.days, interval=args.interval)
        
        if len(candles) < WINDOW + LOOK_AHEAD + 10:
            print(f"  Not enough candles for {coin} ({len(candles)}), skipping")
            continue
        
        print(f"  Got {len(candles)} candles for {coin}")
        
        md = candles_to_marketdata(candles)
        labels = generate_labels(candles, WINDOW, LOOK_AHEAD, THRESHOLD)
        
        X_list = []
        for i in range(WINDOW, len(candles) - LOOK_AHEAD):
            feats = engine.compute(md[i - WINDOW : i]).flatten()
            X_list.append(feats)
        
        X_coin = np.array(X_list, dtype=np.float32)
        print(f"  Generated {len(X_coin)} feature vectors for {coin}")
        print(f"  Label dist: long={np.sum(labels==0)}, short={np.sum(labels==1)}, close={np.sum(labels==2)}")
        
        all_X.append(X_coin)
        all_y.append(labels)
    
    if not all_X:
        print("No data collected!")
        sys.exit(1)
    
    X = np.concatenate(all_X, axis=0)
    y = np.concatenate(all_y, axis=0)
    
    X = np.nan_to_num(X, nan=0.0, posinf=1.0, neginf=-1.0)
    
    print(f"\nTotal dataset: {len(X)} samples, {X.shape[1]} features")
    print(f"Overall dist: long={np.sum(y==0)}, short={np.sum(y==1)}, close={np.sum(y==2)}")
    
    with open(args.output, "wb") as f:
        pickle.dump({"X": X, "y": y}, f)
    
    print(f"Saved to {args.output}")
    print(f"\nNext: python train_model.py")


if __name__ == "__main__":
    main()
