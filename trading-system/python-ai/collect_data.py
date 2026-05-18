import sys, os, asyncio, pickle, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + '/src')

import redis.asyncio as aioredis
import numpy as np
from feature_engine import FeatureEngine
from redis_reader import MarketData

TARGET_SAMPLES = 5000
WINDOW = 100
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), 'training_data.pkl')

class MD:
    def __init__(self, symbol, lastPrice, bidPrice, askPrice, volume24h, timestamp):
        self.symbol = symbol
        self.lastPrice = lastPrice
        self.bidPrice = bidPrice
        self.askPrice = askPrice
        self.volume24h = volume24h
        self.timestamp = timestamp

async def collect():
    r = await aioredis.from_url('redis://redis:6379', decode_responses=False).__aenter__()
    engine = FeatureEngine(window_size=WINDOW)

    # Read all existing data from stream
    collected = {s: [] for s in ['BTC_USDT_Perp', 'ETH_USDT_Perp']}
    last_ids = {s: '0' for s in collected}

    print('Reading historical data from Redis...')
    for symbol in collected:
        stream_name = f'market:{symbol}'.encode()
        count = 0
        while count < 10000:
            result = await r.xread({stream_name: last_ids[symbol]}, count=1000)
            if not result:
                break
            for stream, msgs in result:
                for msg_id, data in msgs:
                    last_ids[symbol] = msg_id
                    d = {k.decode(): v.decode() for k, v in data.items()}
                    collected[symbol].append(MD(
                        d['symbol'], float(d['lastPrice']), float(d['bidPrice']),
                        float(d['askPrice']), float(d['volume24h']), int(d['timestamp'])
                    ))
                    count += 1
        print(f'  {symbol}: {len(collected[symbol])} samples')

    await r.aclose()

    print(f'Total collected: BTC={len(collected["BTC_USDT_Perp"])}, ETH={len(collected["ETH_USDT_Perp"])}')

    # Compute features for each symbol
    features_list = []
    labels_list = []
    symbols_list = []

    LOOK_AHEAD = 5
    THRESHOLD = 0.002

    for symbol in ['BTC_USDT_Perp', 'ETH_USDT_Perp']:
        data = collected[symbol]
        if len(data) < WINDOW + LOOK_AHEAD + 1:
            print(f'  {symbol}: not enough data ({len(data)}), skipping')
            continue

        prices = np.array([d.lastPrice for d in data])
        for i in range(len(data) - WINDOW - LOOK_AHEAD):
            window = data[i:i + WINDOW]
            feats = engine.compute(window).flatten()

            future_ret = (prices[i + WINDOW + LOOK_AHEAD] - prices[i + WINDOW]) / prices[i + WINDOW]
            if future_ret > THRESHOLD:
                label = 0
            elif future_ret < -THRESHOLD:
                label = 1
            else:
                label = 2

            features_list.append(feats)
            labels_list.append(label)
            symbols_list.append(symbol)

    X = np.array(features_list, dtype=np.float32)
    y = np.array(labels_list, dtype=np.int64)

    print(f'Features shape: {X.shape}')
    print(f'Label dist: long={np.sum(y==0)}, short={np.sum(y==1)}, close={np.sum(y==2)}')

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'wb') as f:
        pickle.dump({'X': X, 'y': y, 'symbols': symbols_list}, f)
    print(f'Saved to {OUTPUT_PATH}')

if __name__ == '__main__':
    asyncio.run(collect())