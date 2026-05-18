import Redis from 'ioredis';
import { GrvtEnv, WebSocketTransport, buildTickerFeed } from '@wezzcoetzee/grvt';

export interface MarketData {
  symbol: string;
  lastPrice: number;
  bidPrice: number;
  askPrice: number;
  volume24h: number;
  timestamp: number;
}

export interface MarketDataConfig {
  apiKey: string;
  env: GrvtEnv;
  symbols: string[];
}

export class MarketDataStream {
  private redis: Redis;
  private ws: WebSocketTransport | null = null;
  private config: MarketDataConfig;
  private latestPrices = new Map<string, MarketData>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private subscriptions: Array<{ unsubscribe: () => Promise<void> }> = [];
  private priceCallbacks: Array<(data: MarketData) => void> = [];

  constructor(config: MarketDataConfig, redis: Redis) {
    this.config = config;
    this.redis = redis;
  }

  async connect(): Promise<void> {
    try {
      this.ws = new WebSocketTransport({
        env: this.config.env,
      });
      await this.ws.ready();

      this.ws.socket.addEventListener('close', () => {
        console.log('[MarketData] WebSocket closed, scheduling reconnect');
        this.scheduleReconnect();
      });

      await this.subscribeToTickers();

      console.log('[MarketData] Connected');
    } catch (err) {
      console.error('[MarketData] WebSocket connection failed:', err);
    }
  }

  private async subscribeToTickers(): Promise<void> {
    if (!this.ws) return;

    this.subscriptions = [];

    for (const symbol of this.config.symbols) {
      const sub = await this.ws.subscribe(
        'ticker.s',
        buildTickerFeed(symbol, '500'),
        (data: any) => {
          this.handleTickerData(data);
        }
      );
      this.subscriptions.push(sub);
    }

    console.log(`[MarketData] Subscribed to tickers: ${this.config.symbols.join(', ')}`);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[MarketData] Max reconnect attempts reached');
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        this.reconnectAttempts = 0;
      } catch (err) {
        this.scheduleReconnect();
      }
    }, delay);
  }

  handleTickerData(rawData: any): void {
    const data = this.parseTickerData(rawData);
    this.latestPrices.set(data.symbol, data);
    this.writeToRedis(data);
    for (const cb of this.priceCallbacks) {
      cb(data);
    }
  }

  onPriceUpdate(callback: (data: MarketData) => void): void {
    this.priceCallbacks.push(callback);
  }

  parseTickerData(raw: any): MarketData {
    return {
      symbol: raw.instrument || 'UNKNOWN',
      lastPrice: parseFloat(raw.last_price || '0'),
      bidPrice: parseFloat(raw.best_bid_price || '0'),
      askPrice: parseFloat(raw.best_ask_price || '0'),
      volume24h: parseFloat(raw.volume_24h || raw.volume || '0'),
      timestamp: raw.event_time ? Math.floor(parseInt(raw.event_time, 10) / 1_000_000) : Date.now(),
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

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const sub of this.subscriptions) {
      await sub.unsubscribe().catch(() => {});
    }
    this.subscriptions = [];
    if (this.ws) {
      await this.ws.close().catch(() => {});
      this.ws = null;
    }
    this.redis.disconnect();
  }
}
