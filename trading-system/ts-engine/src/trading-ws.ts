import { GrvtClient, GrvtRawClient, GrvtEnv, WebSocketTransport, buildTickerFeed, buildOrderbookFeed, buildTradeFeed } from '@wezzcoetzee/grvt';
import { OrderUpdate } from './types';
import { Order } from './sqlite-store';

export interface GrvtConfig {
  apiKey: string;
  privateKey: string;
  tradingAccountId?: string;
  env: GrvtEnv;
}

export class TradingWebSocket {
  private client: GrvtClient | null = null;
  private rawClient: GrvtRawClient | null = null;
  private ws: WebSocketTransport | null = null;
  private orderCallbacks: Array<(update: OrderUpdate) => void> = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private config: GrvtConfig | null = null;
  private tradingAccountId: string | null = null;

  async connect(config: GrvtConfig): Promise<void> {
    this.config = config;

    // 初始化 RawClient（用于行情查询）
    this.rawClient = new GrvtRawClient({
      env: config.env,
      apiKey: config.apiKey,
    });

    // 初始化 GrvtClient（用于交易）
    if (config.tradingAccountId) {
      this.client = new GrvtClient({
        env: config.env,
        apiKey: config.apiKey,
        tradingAccountId: config.tradingAccountId,
        privateKey: config.privateKey,
      });
      await this.client.loadMarkets();
      this.tradingAccountId = config.tradingAccountId;
    } else {
      console.log('[TradingWS] No tradingAccountId provided, read-only mode');
    }

    // 初始化 WebSocket（订单状态推送）
    try {
      this.ws = new WebSocketTransport({
        env: config.env,
      });
      await this.ws.ready();

      this.ws.onClose(() => {
        console.log('[TradingWS] WebSocket closed, scheduling reconnect');
        this.scheduleReconnect();
      });

      if (this.tradingAccountId) {
        this.subscribeToOrderUpdates();
      }

      console.log('[TradingWS] Connected');
    } catch (err) {
      console.error('[TradingWS] WebSocket connection failed:', err);
    }
  }

  private subscribeToOrderUpdates(): void {
    if (!this.ws || !this.tradingAccountId) return;

    // 订阅订单更新
    this.ws.subscribe(
      'order',
      { account_id: this.tradingAccountId },
      (data: any) => {
        const update = this.parseOrderUpdate(data);
        if (update) {
          for (const cb of this.orderCallbacks) {
            cb(update);
          }
        }
      }
    );

    // 订阅成交回报
    this.ws.subscribe(
      'fill',
      { account_id: this.tradingAccountId },
      (data: any) => {
        const update = this.parseFillUpdate(data);
        if (update) {
          for (const cb of this.orderCallbacks) {
            cb(update);
          }
        }
      }
    );

    console.log('[TradingWS] Subscribed to order and fill updates');
  }

  private parseOrderUpdate(data: any): OrderUpdate | null {
    if (!data || !data.client_order_id) return null;
    return {
      clientOrderId: data.client_order_id,
      orderId: data.order_id || '',
      status: this.mapGrvtStatus(data.status),
      fee: String(data.fee || '0'),
    };
  }

  private parseFillUpdate(data: any): OrderUpdate | null {
    if (!data || !data.client_order_id) return null;
    return {
      clientOrderId: data.client_order_id,
      orderId: data.order_id || '',
      status: 'partially_filled',
      fee: String(data.fee || '0'),
    };
  }

  private scheduleReconnect(): void {
    if (!this.config) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[TradingWS] Max reconnect attempts reached');
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect(this.config!);
      } catch (err) {
        this.scheduleReconnect();
      }
    }, delay);
  }

  async submitOrder(order: Order): Promise<string> {
    if (!this.client) throw new Error('TradingWS not connected (no trading account)');

    const isMarket = order.orderType === 'market';

    console.log(`[TradingWS] Submitting order: ${order.clientOrderId} (${order.side} ${order.size} ${order.symbol} @ ${order.limitPrice})`);

    const result = await this.client.createOrder(
      order.symbol,
      isMarket ? 'market' : 'limit',
      order.side,
      parseFloat(order.size),
      isMarket ? undefined : parseFloat(order.limitPrice),
      {
        clientOrderId: order.clientOrderId,
        timeInForce: isMarket ? 'IOC' : 'GTT',
      }
    );

    return result.id || order.clientOrderId;
  }

  async cancelOrder(exchangeOrderId: string): Promise<void> {
    if (!this.client) throw new Error('TradingWS not connected (no trading account)');

    try {
      await this.client.cancelOrder(exchangeOrderId);
      console.log(`[TradingWS] Cancelled order: ${exchangeOrderId}`);
    } catch (err: any) {
      if (err.message?.includes('already') || err.message?.includes('not found')) {
        console.log(`[TradingWS] Order ${exchangeOrderId} already completed, skip cancel`);
        return;
      }
      throw err;
    }
  }

  async getOpenOrders(): Promise<any[]> {
    if (!this.client) throw new Error('TradingWS not connected (no trading account)');
    const orders = await this.client.fetchOpenOrders();
    return orders || [];
  }

  async getTicker(symbol: string): Promise<any> {
    if (!this.rawClient) throw new Error('TradingWS not connected');
    const ticker = await this.rawClient.getTicker({ instrument: symbol });
    return ticker.result;
  }

  onOrderUpdate(callback: (update: OrderUpdate) => void): void {
    this.orderCallbacks.push(callback);
  }

  emitTestUpdate(update: OrderUpdate): void {
    for (const cb of this.orderCallbacks) {
      cb(update);
    }
  }

  mapGrvtStatus(grvtStatus: string): OrderUpdate['status'] {
    const statusMap: Record<string, OrderUpdate['status']> = {
      'FILLED': 'filled',
      'CANCELLED': 'cancelled',
      'REJECTED': 'rejected',
      'PENDING': 'pending',
      'PARTIALLY_FILLED': 'partially_filled',
      'SUBMITTED': 'submitted',
    };
    return statusMap[grvtStatus] || 'pending';
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close().catch(() => {});
      this.ws = null;
    }
  }
}
