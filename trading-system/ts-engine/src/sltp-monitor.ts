import { OrderUpdate } from './types';

export interface SLTPOrder {
  orderId: string;
  clientOrderId: string;
  symbol: string;
  side: 'long' | 'short';
  size: number;
  stopLoss?: number;
  takeProfit?: number;
  entryPrice: number;
  status: 'active' | 'triggered' | 'cancelled';
  createdAt: number;
}

export interface PriceLevel {
  symbol: string;
  side: 'long' | 'short';
  stopLoss?: number;
  takeProfit?: number;
  size: number;
}

export class SLTPMonitor {
  private activeOrders = new Map<string, SLTPOrder>();
  private listeners: Array<(trigger: { symbol: string; type: 'stop_loss' | 'take_profit'; price: number; order: SLTPOrder }) => void> = [];

  addOrder(order: SLTPOrder): void {
    this.activeOrders.set(order.clientOrderId, order);
  }

  removeOrder(clientOrderId: string): void {
    this.activeOrders.delete(clientOrderId);
  }

  getActiveOrders(symbol?: string): SLTPOrder[] {
    const orders = Array.from(this.activeOrders.values());
    if (symbol) {
      return orders.filter(o => o.symbol === symbol && o.status === 'active');
    }
    return orders.filter(o => o.status === 'active');
  }

  onTrigger(callback: (trigger: { symbol: string; type: 'stop_loss' | 'take_profit'; price: number; order: SLTPOrder }) => void): void {
    this.listeners.push(callback);
  }

  checkPrice(symbol: string, lastPrice: number, bidPrice: number, askPrice: number): SLTPOrder[] {
    const triggered: SLTPOrder[] = [];

    for (const order of this.activeOrders.values()) {
      if (order.symbol !== symbol || order.status !== 'active') continue;

      const triggerPrice = order.side === 'long'
        ? { sl: order.stopLoss, tp: order.takeProfit }
        : { sl: order.stopLoss, tp: order.takeProfit };

      let hit: 'stop_loss' | 'take_profit' | null = null;

      if (order.side === 'long') {
        if (order.stopLoss && lastPrice <= order.stopLoss) hit = 'stop_loss';
        if (order.takeProfit && lastPrice >= order.takeProfit) hit = 'take_profit';
      } else {
        if (order.stopLoss && lastPrice >= order.stopLoss) hit = 'stop_loss';
        if (order.takeProfit && lastPrice <= order.takeProfit) hit = 'take_profit';
      }

      if (hit) {
        order.status = 'triggered';
        triggered.push(order);
        for (const cb of this.listeners) {
          cb({ symbol, type: hit!, price: lastPrice, order });
        }
      }
    }

    for (const t of triggered) {
      this.activeOrders.delete(t.clientOrderId);
    }

    return triggered;
  }

  cancelOrdersForSymbol(symbol: string): void {
    for (const [id, order] of this.activeOrders) {
      if (order.symbol === symbol) {
        order.status = 'cancelled';
        this.activeOrders.delete(id);
      }
    }
  }
}