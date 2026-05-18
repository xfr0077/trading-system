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
      { apiKey: 'test-key', env: 'testnet' as any, symbols: ['BTC_USDT_Perp'] },
      mockRedis as any
    );
  });

  test('should parse ticker data correctly', () => {
    const rawData = {
      instrument: 'BTC_USDT_Perp',
      last_price: '98500.50',
      best_bid_price: '98499.00',
      best_ask_price: '98501.00',
      volume_24h: '1234.56',
      event_time: '1716000000000000000',
    };
    const parsed = (stream as any).parseTickerData(rawData);
    expect(parsed).toEqual({
      symbol: 'BTC_USDT_Perp',
      lastPrice: 98500.50,
      bidPrice: 98499.00,
      askPrice: 98501.00,
      volume24h: 1234.56,
      timestamp: 1716000000000,
    });
  });

  test('should convert nanoseconds to milliseconds', () => {
    const parsed = (stream as any).parseTickerData({ event_time: '1716000000000000000' });
    expect(parsed.timestamp).toBe(1716000000000);
  });

  test('should update in-memory price cache', () => {
    const rawData = {
      instrument: 'BTC_USDT_Perp',
      last_price: '98500.50',
      best_bid_price: '98499.00',
      best_ask_price: '98501.00',
      volume_24h: '1234.56',
      event_time: '1716000000000000000',
    };
    stream.handleTickerData(rawData);
    const cached = stream.getLatestPriceInMemory('BTC_USDT_Perp');
    expect(cached).not.toBeNull();
    expect(cached?.lastPrice).toBe(98500.50);
  });
});
