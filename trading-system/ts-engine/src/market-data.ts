import Redis from 'ioredis';

export interface MarketData {
  symbol: string;
  lastPrice: number;
  bidPrice: number;
  askPrice: number;
  volume24h: number;
  timestamp: number;
}

export interface GrvtConfig {
  wsUrl: string;
  apiKey: string;
}

export class MarketDataStream {
  private redis: Redis;
  private symbols: string[];
  private config: GrvtConfig;
  private latestPrices = new Map<string, MarketData>();

  constructor(config: GrvtConfig, redis: Redis, symbols: string[]) {
    this.config = config;
    this.redis = redis;
    this.symbols = symbols;
  }

  async connect(): Promise<void> {
    console.log(`[MarketData] Connecting to ${this.config.wsUrl} for ${this.symbols.join(', ')}`);
  }

  async disconnect(): Promise<void> {
    this.redis.disconnect();
  }

  handleTickerData(rawData: any): void {
    const data = this.parseTickerData(rawData);
    this.latestPrices.set(data.symbol, data);
    this.writeToRedis(data);
  }

  parseTickerData(raw: any): MarketData {
    return {
      symbol: raw.symbol,
      lastPrice: parseFloat(raw.last_price),
      bidPrice: parseFloat(raw.bid_price),
      askPrice: parseFloat(raw.ask_price),
      volume24h: parseFloat(raw.volume_24h || '0'),
      timestamp: Math.floor(parseInt(raw.event_time, 10) / 1_000_000),
    };
  }

  private async writeToRedis(data: MarketData): Promise<void> {
    try {
      await this.redis.xadd(
        `market:${data.symbol}`,
        'MAXLEN',
        '~',
        '10000',
        '*',
        'symbol', data.symbol,
        'lastPrice', String(data.lastPrice),
        'bidPrice', String(data.bidPrice),
        'askPrice', String(data.askPrice),
        'volume24h', String(data.volume24h),
        'timestamp', String(data.timestamp)
      );
    } catch (err) {
      console.error(`[MarketData] Failed to write to Redis for ${data.symbol}:`, err);
    }
  }

  async getLatestPrice(symbol: string): Promise<MarketData | null> {
    return this.latestPrices.get(symbol) || null;
  }

  getLatestPriceInMemory(symbol: string): MarketData | null {
    return this.latestPrices.get(symbol) || null;
  }
}
