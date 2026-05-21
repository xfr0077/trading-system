import { IDexAdapter } from './adapter-interface';
import {
  DexConfig, OrderInput, OpenOrder, Position, Fill,
  OrderUpdate as DexOrderUpdate, DexCapabilities,
} from './types';

interface SimulatedPosition {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
}

interface SimulatedOrder {
  exchangeOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  status: 'open' | 'filled' | 'cancelled' | 'rejected';
  createdAt: number;
  filledAt?: number;
  fillPrice?: number;
}

export class PaperTradingAdapter implements IDexAdapter {
  private connected = false;
  private positions = new Map<string, SimulatedPosition>();
  private orders = new Map<string, SimulatedOrder>();
  private fills: Fill[] = [];
  private orderCallbacks: Array<(update: DexOrderUpdate) => void> = [];
  private balance = 10000;
  private nextOrderId = 1;
  private config: DexConfig | null = null;

  async connect(config: DexConfig): Promise<void> {
    this.config = config;
    this.connected = true;
    console.log('[PaperTrading] Connected (simulated balance: $' + this.balance.toFixed(2) + ')');
  }

  disconnect(): void {
    this.connected = false;
    console.log('[PaperTrading] Disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs?: number }> {
    return { healthy: this.connected, latencyMs: 1 };
  }

  async submitOrder(order: OrderInput): Promise<string> {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const exchangeOrderId = `paper-${this.nextOrderId++}`;
    const orderPrice = order.price || 0;
    const simOrder: SimulatedOrder = {
      exchangeOrderId,
      clientOrderId: order.clientOrderId,
      symbol: order.market,
      side: order.side,
      size: order.size,
      price: orderPrice,
      status: 'open',
      createdAt: Date.now(),
    };

    this.orders.set(exchangeOrderId, simOrder);

    // Simulate immediate fill with slippage
    const slippageBps = 5;
    const slippage = orderPrice * (slippageBps / 10000);
    const fillPrice = order.side === 'buy'
      ? orderPrice + slippage
      : orderPrice - slippage;

    // Update position
    const existingPos = this.positions.get(order.market);
    if (existingPos) {
      if (existingPos.side === 'long' && order.side === 'buy') {
        const totalSize = existingPos.size + order.size;
        existingPos.entryPrice = (existingPos.entryPrice * existingPos.size + fillPrice * order.size) / totalSize;
        existingPos.size = totalSize;
      } else if (existingPos.side === 'short' && order.side === 'sell') {
        const totalSize = existingPos.size + order.size;
        existingPos.entryPrice = (existingPos.entryPrice * existingPos.size + fillPrice * order.size) / totalSize;
        existingPos.size = totalSize;
      } else {
        const closeSize = Math.min(existingPos.size, order.size);
        const pnl = existingPos.side === 'long'
          ? (fillPrice - existingPos.entryPrice) * closeSize
          : (existingPos.entryPrice - fillPrice) * closeSize;
        existingPos.realizedPnl += pnl;
        this.balance += pnl;

        if (order.size > existingPos.size) {
          const remainingSize = order.size - existingPos.size;
          const newSide = order.side === 'buy' ? 'long' : 'short';
          this.positions.set(order.market, {
            symbol: order.market,
            side: newSide,
            size: remainingSize,
            entryPrice: fillPrice,
            currentPrice: fillPrice,
            unrealizedPnl: 0,
            realizedPnl: existingPos.realizedPnl,
          });
        } else {
          existingPos.size -= closeSize;
          if (existingPos.size <= 0.0001) {
            this.positions.delete(order.market);
          }
        }
      }
    } else {
      const newSide = order.side === 'buy' ? 'long' : 'short';
      this.positions.set(order.market, {
        symbol: order.market,
        side: newSide,
        size: order.size,
        entryPrice: fillPrice,
        currentPrice: fillPrice,
        unrealizedPnl: 0,
        realizedPnl: 0,
      });
    }

    simOrder.status = 'filled';
    simOrder.filledAt = Date.now();
    simOrder.fillPrice = fillPrice;

    this.fills.unshift({
      exchangeOrderId,
      clientOrderId: order.clientOrderId,
      market: order.market,
      side: order.side === 'buy' ? 'buy' : 'sell',
      price: fillPrice,
      size: order.size,
      fee: 0,
      feeAsset: 'USDT',
      isMaker: false,
      timestamp: Date.now(),
    });

    const filledOrder: OpenOrder = {
      exchangeOrderId,
      clientOrderId: order.clientOrderId,
      market: order.market,
      side: order.side,
      type: 'market',
      size: order.size,
      filledSize: order.size,
      price: fillPrice,
      avgFillPrice: fillPrice,
      status: 'filled',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    for (const cb of this.orderCallbacks) {
      cb({
        type: 'order_filled',
        order: filledOrder,
        fill: {
          exchangeOrderId,
          clientOrderId: order.clientOrderId,
          market: order.market,
          side: order.side === 'buy' ? 'buy' : 'sell',
          price: fillPrice,
          size: order.size,
          fee: 0,
          feeAsset: 'USDT',
          isMaker: false,
          timestamp: Date.now(),
        },
        sequenceNumber: Date.now(),
      });
    }

    console.log(`[PaperTrading] Order filled: ${order.side} ${order.size} ${order.market} @ $${fillPrice.toFixed(2)} (slippage: $${slippage.toFixed(2)})`);

    return exchangeOrderId;
  }

  async cancelOrder(exchangeOrderId: string): Promise<void> {
    const order = this.orders.get(exchangeOrderId);
    if (order && order.status === 'open') {
      order.status = 'cancelled';
      const cancelledOrder: OpenOrder = {
        exchangeOrderId,
        clientOrderId: order.clientOrderId,
        market: order.symbol,
        side: order.side,
        type: 'market',
        size: order.size,
        filledSize: 0,
        price: order.price,
        status: 'cancelled',
        createdAt: order.createdAt,
        updatedAt: Date.now(),
      };

      for (const cb of this.orderCallbacks) {
        cb({
          type: 'order_cancelled',
          order: cancelledOrder,
          sequenceNumber: Date.now(),
        });
      }
      console.log(`[PaperTrading] Order cancelled: ${exchangeOrderId}`);
    }
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    return Array.from(this.orders.values())
      .filter(o => o.status === 'open')
      .map(o => ({
        exchangeOrderId: o.exchangeOrderId,
        clientOrderId: o.clientOrderId,
        market: o.symbol,
        side: o.side,
        type: 'market',
        size: o.size,
        filledSize: 0,
        price: o.price,
        status: o.status,
        createdAt: o.createdAt,
        updatedAt: o.createdAt,
      }));
  }

  async getPositions(): Promise<Position[]> {
    const result: Position[] = [];
    for (const pos of this.positions.values()) {
      result.push({
        market: pos.symbol,
        side: pos.side,
        size: pos.size,
        entryPrice: pos.entryPrice,
        markPrice: pos.currentPrice,
        unrealizedPnl: pos.unrealizedPnl,
        realizedPnl: pos.realizedPnl,
        leverage: 1,
        liquidationPrice: undefined,
        marginUsed: pos.entryPrice * pos.size,
      });
    }
    return result;
  }

  async getFills(_clientOrderId?: string): Promise<Fill[]> {
    return this.fills.slice(0, 50);
  }

  async getAccount(): Promise<{ availableBalance: number; totalBalance: number }> {
    let totalUnrealizedPnl = 0;
    for (const pos of this.positions.values()) {
      totalUnrealizedPnl += pos.unrealizedPnl;
    }
    const totalBalance = this.balance + totalUnrealizedPnl;
    return {
      availableBalance: this.balance,
      totalBalance,
    };
  }

  onOrderUpdate(callback: (update: DexOrderUpdate) => void): void {
    this.orderCallbacks.push(callback);
  }

  getName(): string {
    return 'paper';
  }

  getCapabilities(): DexCapabilities {
    return {
      maxLeverage: 1,
      supportedOrderTypes: ['market'],
      supportedTimeInForce: ['IOC'],
      minOrderSize: 0.0001,
      tickSize: 0.01,
      rateLimits: [],
      hasWebSocket: false,
      hasBatchOrders: false,
      hasReduceOnly: true,
    };
  }

  updatePrices(symbol: string, price: number): void {
    const pos = this.positions.get(symbol);
    if (pos) {
      pos.currentPrice = price;
      pos.unrealizedPnl = pos.side === 'long'
        ? (price - pos.entryPrice) * pos.size
        : (pos.entryPrice - price) * pos.size;
    }
  }

  getStats(): { totalTrades: number; winRate: number; totalPnl: number; balance: number } {
    return {
      totalTrades: this.fills.length,
      winRate: 0,
      totalPnl: this.balance - 10000,
      balance: this.balance,
    };
  }
}
