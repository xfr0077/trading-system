import { IDexAdapter } from './adapter-interface';
import {
  DexConfig, OrderInput, OpenOrder, Position, Fill,
  OrderUpdate as DexOrderUpdate, DexCapabilities,
} from './types';

const SYMBOL_TO_MARKET: Record<string, number> = {
  'ETH_USDT_Perp': 0, 'BTC_USDT_Perp': 1, 'SOL_USDT_Perp': 2,
  'ARB_USDT_Perp': 3, 'OP_USDT_Perp': 4, 'DOGE_USDT_Perp': 5,
  'NEAR_USDT_Perp': 6, 'LINK_USDT_Perp': 7, 'MATIC_USDT_Perp': 8,
  'AVAX_USDT_Perp': 9, 'AAVE_USDT_Perp': 10, 'UNI_USDT_Perp': 11,
  'PEPE_USDT_Perp': 12, 'WIF_USDT_Perp': 13, 'INJ_USDT_Perp': 14,
  'Render_USDT_Perp': 15, 'TAO_USDT_Perp': 16, 'FET_USDT_Perp': 17,
  'AGIX_USDT_Perp': 18, 'OCEAN_USDT_Perp': 19, 'RNDR_USDT_Perp': 20,
  'TIA_USDT_Perp': 21, 'SEI_USDT_Perp': 22, 'STRK_USDT_Perp': 23,
  'WLD_USDT_Perp': 24, 'PYTH_USDT_Perp': 25, 'SUI_USDT_Perp': 26,
  'APT_USDT_Perp': 27, 'HYPE_USDT_Perp': 28, 'ZK_USDT_Perp': 56,
  'EIGEN_USDT_Perp': 49, 'CHIP_USDT_Perp': 163,
};

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

  importState(state: { positions: SimulatedPosition[]; balance: number; orders: SimulatedOrder[]; fills: Fill[] }): void {
    for (const p of state.positions) {
      this.positions.set(p.symbol, p);
    }
    for (const o of state.orders) {
      this.orders.set(o.clientOrderId, o);
    }
    this.fills = state.fills;
    this.balance = state.balance;
  }

  async getMidPrice(market: string): Promise<{ midPrice: number; bestBid: number; bestAsk: number; spread: number } | null> {
    // Try Lighter public API first
    const lighterUrl = this.config?.rpcUrl || process.env.LIGHTER_BASE_URL || 'https://mainnet.zklighter.elliot.ai';
    const marketIndex = SYMBOL_TO_MARKET[market];
    if (marketIndex !== undefined) {
      try {
        const resp = await fetch(`${lighterUrl}/v1/orderbook?market_id=${marketIndex}&depth=1`);
        if (resp.ok) {
          const data = await resp.json() as any;
          const bestBid = parseFloat(data.bids?.[0]?.price || '0');
          const bestAsk = parseFloat(data.asks?.[0]?.price || '0');
          if (bestBid > 0 && bestAsk > 0) {
            return { midPrice: (bestBid + bestAsk) / 2, bestBid, bestAsk, spread: bestAsk - bestBid };
          }
        }
      } catch {
        // Fall through to Binance
      }
    }

    // Fallback: Binance public API (free, no auth needed)
    const binanceSymbolMap: Record<string, string> = {
      'BTC_USDT_Perp': 'BTCUSDT',
      'ETH_USDT_Perp': 'ETHUSDT',
      'SOL_USDT_Perp': 'SOLUSDT',
    };
    const binanceSymbol = binanceSymbolMap[market];
    if (binanceSymbol) {
      try {
        const resp = await fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${binanceSymbol}`);
        if (resp.ok) {
          const data = await resp.json() as any;
          const bestBid = parseFloat(data.bidPrice || '0');
          const bestAsk = parseFloat(data.askPrice || '0');
          if (bestBid > 0 && bestAsk > 0) {
            return { midPrice: (bestBid + bestAsk) / 2, bestBid, bestAsk, spread: bestAsk - bestBid };
          }
        }
      } catch {
        // Ignore
      }
    }

    return null;
  }
}
