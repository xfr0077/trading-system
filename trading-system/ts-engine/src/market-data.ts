import Redis from 'ioredis';
import { IDexAdapter } from './dex';

export interface MarketData {
  symbol: string;
  lastPrice: number;
  bidPrice: number;
  askPrice: number;
  volume24h: number;
  timestamp: number;
}

export interface MarketDataConfig {
  symbols: string[];
}

export class MarketDataStream {
  private redis: Redis;
  private config: MarketDataConfig;
  private latestPrices = new Map<string, MarketData>();
  private pollingInterval: NodeJS.Timeout | null = null;
  private priceCallbacks: Array<(data: MarketData) => void> = [];
  private _lastSuccessfulPoll: number = 0;
  private dexAdapter: IDexAdapter | null = null;

  constructor(config: MarketDataConfig, redis: Redis, dexAdapter?: IDexAdapter) {
    this.config = config;
    this.redis = redis;
    this.dexAdapter = dexAdapter || null;
  }

  async connect(): Promise<void> {
    await this.pollAllMids();
    this.pollingInterval = setInterval(() => this.pollAllMids(), 3000);
    this.pollingInterval.unref();
    console.log(`[MarketData] Started polling for symbols: ${this.config.symbols.join(', ')}`);
  }

  private async pollAllMids(): Promise<void> {
    for (const symbol of this.config.symbols) {
      try {
        const marketData = await this.fetchLighterPrice(symbol);
        if (!marketData) continue;

        this.latestPrices.set(symbol, marketData);
        this.writeToRedis(marketData);
        for (const cb of this.priceCallbacks) {
          cb(marketData);
        }
      } catch (err) {
        console.error(`[MarketData] Poll failed for ${symbol}:`, err);
      }
    }
    this._lastSuccessfulPoll = Date.now();
  }

  private async fetchLighterPrice(symbol: string): Promise<MarketData | null> {
    if (!this.dexAdapter || !this.dexAdapter.getMidPrice) return null;
    try {
      const priceData = await this.dexAdapter.getMidPrice(symbol);
      if (priceData && priceData.midPrice > 0) {
        return {
          symbol,
          lastPrice: priceData.midPrice,
          bidPrice: priceData.bestBid,
          askPrice: priceData.bestAsk,
          volume24h: 0,
          timestamp: Date.now(),
        };
      }
    } catch (err) {
      console.warn(`[MarketData] Lighter price fetch failed for ${symbol}:`, (err as Error).message);
    }
    return null;
  }

  onPriceUpdate(callback: (data: MarketData) => void): void {
    this.priceCallbacks.push(callback);
  }

  private async writeToRedis(data: MarketData): Promise<void> {
    try {
      await this.redis.xadd(
        `market:${data.symbol}`,
        'MAXLEN', '~', '10000', '*',
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

  public getConnectionStatus(): string {
    const elapsed = Date.now() - this._lastSuccessfulPoll;
    return elapsed < 15000 ? 'connected' : 'disconnected';
  }

  async disconnect(): Promise<void> {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.redis.disconnect();
  }
}
