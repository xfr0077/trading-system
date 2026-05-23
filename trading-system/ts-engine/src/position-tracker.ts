import { Position } from './types';

export interface PositionData {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  updatedAt: number;
}

export interface OpenOrderData {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  stopLoss?: number;
  takeProfit?: number;
  status: string;
  createdAt: number;
}

export interface PositionTrackerConfig {
  pollIntervalMs: number;
}

export class PositionTracker {
  private positions = new Map<string, PositionData>();
  private openOrders = new Map<string, OpenOrderData>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Array<(positions: Map<string, PositionData>, openOrders: Map<string, OpenOrderData>) => void> = [];
  private _pollIntervalMs = 10000;

  getPositions(): Map<string, PositionData> {
    return new Map(this.positions);
  }

  getOpenOrders(): Map<string, OpenOrderData> {
    return new Map(this.openOrders);
  }

  getPosition(symbol: string): PositionData | undefined {
    return this.positions.get(symbol);
  }

  hasPosition(symbol: string): boolean {
    const p = this.positions.get(symbol);
    return p !== undefined && p.size > 0;
  }

  onOrderFilled(symbol: string, side: 'buy' | 'sell', size: number, fillPrice: number): number {
    const existing = this.positions.get(symbol);
    let fillPnl = 0;
    if (existing) {
      if (existing.side === (side === 'buy' ? 'long' : 'short')) {
        // Same direction: average entry price
        const totalSize = existing.size + size;
        existing.entryPrice = (existing.entryPrice * existing.size + fillPrice * size) / totalSize;
        existing.size = totalSize;
      } else {
        // Opposite direction: reduce or close — calculate realized PnL
        const closeSize = Math.min(size, existing.size);
        fillPnl = existing.side === 'long'
          ? (fillPrice - existing.entryPrice) * closeSize
          : (existing.entryPrice - fillPrice) * closeSize;
        existing.realizedPnl += fillPnl;

        if (size >= existing.size) {
          this.positions.delete(symbol);
        } else {
          existing.size -= size;
        }
      }
      existing.updatedAt = Date.now();
    } else {
      this.positions.set(symbol, {
        symbol,
        side: side === 'buy' ? 'long' : 'short',
        size,
        entryPrice: fillPrice,
        unrealizedPnl: 0,
        realizedPnl: 0,
        updatedAt: Date.now(),
      });
    }
    return fillPnl;
  }

  onOrderCancelled(symbol: string, side: 'buy' | 'sell', size: number): void {
  }

  addOpenOrder(clientOrderId: string, data: OpenOrderData): void {
    this.openOrders.set(clientOrderId, data);
  }

  removeOpenOrder(clientOrderId: string): void {
    this.openOrders.delete(clientOrderId);
  }

  hasOpenOrder(clientOrderId: string): boolean {
    return this.openOrders.has(clientOrderId);
  }

  onUpdate(callback: (positions: Map<string, PositionData>, openOrders: Map<string, OpenOrderData>) => void): void {
    this.listeners.push(callback);
  }

  sync(rawPositions: Position[], rawOrders: any[]): void {
    console.log('[PositionTracker] sync() raw positions:', JSON.stringify(rawPositions));
    if (rawPositions.length === 0) {
      console.log('[PositionTracker] DEX returned empty positions, preserving local tracking');
    } else {
      // 合并 DEX 仓位数据，保留本地累加的 realizedPnl（避免 sync 覆盖刚成交的盈亏）
      const oldPositions = new Map(this.positions);
      this.positions.clear();
      for (const p of rawPositions) {
        const size = Math.abs(parseFloat(p.size || '0'));
        if (size > 0) {
          const oldPos = oldPositions.get(p.symbol);
          this.positions.set(p.symbol, {
            symbol: p.symbol,
            side: p.side && (p.side as string) !== 'none' ? p.side : (parseFloat(p.size) < 0 ? 'short' : 'long'),
            size,
            entryPrice: parseFloat(p.entryPrice || '0'),
            unrealizedPnl: parseFloat(p.unrealizedPnl || '0'),
            realizedPnl: oldPos ? oldPos.realizedPnl : parseFloat(p.realizedPnl || '0'),
            updatedAt: p.updatedAt || Date.now(),
          });
        }
      }
    }
    // 合并交易所订单和本地订单，不清空本地提交的订单
    const exchangeOrderIds = new Set<string>();
    for (const o of rawOrders) {
      const orderId = o.orderId || o.clientOrderId;
      exchangeOrderIds.add(orderId);
      this.openOrders.set(orderId, {
        orderId,
        symbol: o.symbol || o.instrument,
        side: o.side,
        size: parseFloat(o.size || '0'),
        price: parseFloat(o.price || o.limitPrice || '0'),
        stopLoss: o.stopLoss ? parseFloat(o.stopLoss) : undefined,
        takeProfit: o.takeProfit ? parseFloat(o.takeProfit) : undefined,
        status: o.status,
        createdAt: o.createdAt || Date.now(),
      });
    }
    // 移除已在交易所终态的本地订单
    for (const [id, order] of this.openOrders) {
      if (!exchangeOrderIds.has(id) && ['filled', 'cancelled', 'rejected'].includes(order.status)) {
        this.openOrders.delete(id);
      }
    }
  }

  startPolling(getPositions: () => Promise<Position[]>, getOpenOrders: () => Promise<any[]>, pollIntervalMs = 10000): void {
    this._pollIntervalMs = pollIntervalMs;
    const poll = async () => {
      try {
        const [rawPositions, rawOrders] = await Promise.all([getPositions(), getOpenOrders()]);
        this.sync(rawPositions, rawOrders);

        for (const cb of this.listeners) {
          cb(this.positions, this.openOrders);
        }
      } catch (err) {
        console.error('[PositionTracker] Poll error:', err);
      }

      this.pollTimer = setTimeout(poll, this._pollIntervalMs);
    };

    poll();
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  updatePositionPnl(symbol: string, currentPrice: number): void {
    const p = this.positions.get(symbol);
    if (!p || p.size <= 0) return;

    const markPrice = p.side === 'long'
      ? (currentPrice - p.entryPrice) * p.size
      : (p.entryPrice - currentPrice) * p.size;
    p.unrealizedPnl = markPrice;
  }
}
