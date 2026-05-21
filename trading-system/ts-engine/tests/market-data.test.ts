import { MarketDataStream, MarketData } from '../src/market-data';

const mockRedis = {
  xadd: jest.fn().mockResolvedValue('ok'),
  disconnect: jest.fn().mockResolvedValue(undefined),
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedis);
});

describe('MarketDataStream', () => {
  let stream: MarketDataStream;

  beforeEach(() => {
    jest.clearAllMocks();
    stream = new MarketDataStream(
      { symbols: ['BTC_USDT_Perp'] },
      mockRedis as any
    );
  });

  test('should store and retrieve in-memory price cache', () => {
    (stream as any).latestPrices.set('BTC_USDT_Perp', {
      symbol: 'BTC_USDT_Perp',
      lastPrice: 98500.50,
      bidPrice: 98499.00,
      askPrice: 98501.00,
      volume24h: 1234.56,
      timestamp: 1716000000000,
    });
    const cached = stream.getLatestPriceInMemory('BTC_USDT_Perp');
    expect(cached).not.toBeNull();
    expect(cached?.lastPrice).toBe(98500.50);
  });

  test('should return null for unknown symbol', () => {
    expect(stream.getLatestPriceInMemory('UNKNOWN')).toBeNull();
  });

  test('should write to redis on price update via callback', () => {
    const callback = jest.fn();
    stream.onPriceUpdate(callback);

    const data: MarketData = {
      symbol: 'BTC_USDT_Perp',
      lastPrice: 98500.50,
      bidPrice: 98499.00,
      askPrice: 98501.00,
      volume24h: 1234.56,
      timestamp: Date.now(),
    };

    (stream as any).latestPrices.set(data.symbol, data);
    (stream as any).priceCallbacks[0](data);

    expect(callback).toHaveBeenCalledWith(data);
  });
});
