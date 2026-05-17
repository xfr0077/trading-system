import { OrderUpdate } from './types';
import { Order } from './sqlite-store';

export interface GrvtConfig {
  tradingWsUrl: string;
  apiKey: string;
}

export class TradingWebSocket {
  private orderCallbacks: Array<(update: OrderUpdate) => void> = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private config: GrvtConfig | null = null;

  async connect(config: GrvtConfig): Promise<void> {
    this.config = config;
    // TODO: 使用 @grvt/sdk 的 GrvtWsClient 实际连接
    // this.client = new GrvtWsClient({ wsUrl: config.tradingWsUrl, apiKey: config.apiKey });
    // await this.client.connect();
    // this.client.subscribeOrderUpdates((order) => { ... });
    // this.client.onDisconnect(() => { this.scheduleReconnect(config); });
    console.log(`[TradingWS] Connecting to ${config.tradingWsUrl}`);
    this.reconnectAttempts = 0;
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
        // 重连后同步未完成订单（需注入 sqliteStore 和 orderManager）
        // await this.syncPendingOrders();
      } catch (err) {
        this.scheduleReconnect();
      }
    }, delay);
  }

  async submitOrder(order: Order): Promise<string> {
    // TODO: 使用 @grvt/sdk 提交订单
    // const grvtOrder = this.buildGrvtOrder(order);
    // const response = await this.client.createOrder(grvtOrder);
    // return response.order_id;
    console.log(`[TradingWS] Submitting order: ${order.clientOrderId}`);
    return `exchange-${order.clientOrderId}`;
  }

  async cancelOrder(exchangeOrderId: string): Promise<void> {
    try {
      // TODO: await this.client.cancelOrder(exchangeOrderId);
      console.log(`[TradingWS] Cancelling order: ${exchangeOrderId}`);
    } catch (err: any) {
      if (err.code === 400 || err.message?.includes('already')) {
        console.log(`[TradingWS] Order ${exchangeOrderId} already completed, skip cancel`);
        return;
      }
      throw err;
    }
  }

  onOrderUpdate(callback: (update: OrderUpdate) => void): void {
    this.orderCallbacks.push(callback);
  }

  // 测试用
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
    };
    return statusMap[grvtStatus] || 'pending';
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
