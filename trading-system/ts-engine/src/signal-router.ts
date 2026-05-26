import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import * as path from 'path';
import * as fs from 'fs';
import { RiskEngine, RiskCheckInput } from './risk-engine';
import { MarginMonitor } from './margin-monitor';
import { MarketDataStream, MarketData } from './market-data';
import { OrderManager } from './order-manager';
import { Config } from './config';
import { SqliteStore, Order } from './sqlite-store';
import { OrderTimeoutManager } from './order-timeout-manager';
import { IDexAdapter, createDexAdapter, DexConfig, OrderInput as DexOrderInput, OrderUpdate as DexOrderUpdate, Position as DexPosition, OpenOrder as DexOpenOrder } from './dex';
import { OrderUpdate } from './types';
import { ISignalQueue, DefaultSignalQueue } from './signal-queue';
import { PositionTracker, PositionData } from './position-tracker';
import { SLTPMonitor, SLTPOrder } from './sltp-monitor';

const protoPaths = [
  path.join(__dirname, '../../proto/signal.proto'),
  path.join(__dirname, '../proto/signal.proto'),
  path.join('/app/proto/signal.proto'),
  path.join(process.cwd(), 'proto/signal.proto'),
];
const protoPath = protoPaths.find(p => fs.existsSync(p)) || protoPaths[0];
const protoDefinition = loadSync(protoPath);
const protoDescriptor = grpc.loadPackageDefinition(protoDefinition) as any;

const VALID_ACTIONS = new Set(['long', 'short', 'close']);

interface TradingSignal {
  signalId: string;
  symbol: string;
  action: string;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  positionSize: number;
  timestamp: number;
  signalPrice: number;
  maxSlippageBps: number;
}

interface SignalInput {
  signalId: string;
  symbol: string;
  action: string;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  positionSize: number;
  timestamp: number;
  signalPrice: number;
  maxSlippageBps: number;
}

export { SignalInput };

export class SignalRouter {
  private seenSignals = new Map<string, number>();
  private seenActions = new Map<string, number>();
  private readonly TTL_MS = 5 * 60 * 1000;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private orderStatusPollInterval: NodeJS.Timeout | null = null;
  private riskEngine: RiskEngine;
  private marginMonitor: MarginMonitor;
  private marketData: MarketDataStream | null = null;
  private orderManager: OrderManager;
  private sqliteStore: SqliteStore;
  private timeoutManager: OrderTimeoutManager;
  private dexAdapter: IDexAdapter;
  private signalQueue: ISignalQueue;
  private positionTracker: PositionTracker;
  private sltpMonitor: SLTPMonitor;
  private config: Config;
  private redis: any = null;
  // P2: Signal rate limiting
  private signalTimestamps = new Map<string, number[]>(); // symbol -> [timestamps]
  private readonly MAX_SIGNALS_PER_MINUTE = 3;
  public signalHistory: Array<{ signalId: string; symbol: string; action: string; confidence: number; positionSize: number; signalPrice: number; accepted: boolean; reason: string; timestamp: number }> = [];
  private readonly MAX_SIGNAL_HISTORY = 200;
  private _lastPythonAiPing: number = 0;

  constructor(config: Config) {
    this.config = config;
    this.cleanupInterval = setInterval(() => this.cleanupExpiredSignals(), 60 * 1000);
    this.cleanupInterval.unref();

    this.riskEngine = new RiskEngine({
      maxPositionSize: config.maxPositionSize,
      maxDailyLoss: config.maxDailyLoss,
      maxConcurrentSignals: config.maxConcurrentSignals,
      minConfidence: config.minConfidence,
      maxPriceDeviationPct: config.maxPriceDeviationPct,
      signalTtlMs: config.signalTtlMs,
      requireMarginOk: true,
      maxPortfolioExposure: config.maxPositionSize * 3,
      maxCorrelatedExposure: config.maxPositionSize * 2,
      maxLeverage: 10,
      kellyFraction: 0.25,
      atrMultiplier: 2,
      minRiskRewardRatio: 1,
      maxDrawdownPct: 0.15,
      trailingStopPct: 0.03,
      scaleInLevels: 3,
    });
    this.marginMonitor = new MarginMonitor({
      warningThreshold: config.marginWarningThreshold,
      criticalThreshold: config.marginCriticalThreshold,
    });
    this.orderManager = new OrderManager();
    this.sqliteStore = new SqliteStore(config.sqlitePath);
    this.timeoutManager = new OrderTimeoutManager();
    // Paper trading mode: use simulated adapter instead of real DEX
    if (config.paperTrading) {
      const { PaperTradingAdapter } = require('./dex/paper-trading');
      this.dexAdapter = new PaperTradingAdapter();
      this.dexAdapter.connect({ dexName: 'paper-trading', testnet: true }).catch(() => {});
      console.log('[SignalRouter] PAPER TRADING MODE enabled');
    } else {
      const { LighterAdapter } = require('./dex/lighter');
      this.dexAdapter = new LighterAdapter(config.lighterBaseUrl!);
    }
    this.signalQueue = new DefaultSignalQueue();
    this.positionTracker = new PositionTracker();
    this.sltpMonitor = new SLTPMonitor();

    this.dexAdapter.onOrderUpdate((update: DexOrderUpdate) => {
      const internalUpdate: OrderUpdate = {
        clientOrderId: update.order.clientOrderId,
        orderId: update.order.exchangeOrderId,
        status: this.mapDexOrderStatus(update.order.status),
        fee: update.fill ? String(update.fill.fee) : '0',
        fillPrice: update.order.avgFillPrice ? String(update.order.avgFillPrice) : undefined,
      };
      this.handleOrderUpdate(internalUpdate);
    });
  }

  async initialize(): Promise<void> {
    await this.sqliteStore.waitReady();

    // 重启恢复：从数据库恢复未完成订单的定时器
    const openOrders = this.sqliteStore.getOpenOrders();
    await this.timeoutManager.restoreFromDatabase(openOrders, async (orderId, remainingMs) => {
      this.timeoutManager.schedule(orderId, remainingMs, async () => {
        const order = this.sqliteStore.getOrder(orderId);
        if (order && order.status === 'submitted') {
          await this.dexAdapter.cancelOrder(order.orderId);
          this.orderManager.updateStatus(orderId, 'cancelled');
          order.status = 'cancelled';
          order.updatedAt = Date.now();
          this.sqliteStore.saveOrder(order);
          this.riskEngine.updateShadowPosition(order.symbol, -parseFloat(order.size));
        }
      });
    });
    console.log(`[SignalRouter] Restored ${openOrders.length} pending orders from database`);

    // 清理过期订单
    const now = Date.now();
    let expiredCount = 0;
    for (const order of openOrders) {
      if (order.expiresAt && order.expiresAt < now && order.status === 'submitted') {
        // 取消交易所订单
        if (order.orderId) {
          await this.dexAdapter.cancelOrder(order.orderId).catch(() => {});
        }
        // 更新本地状态
        order.status = 'cancelled';
        order.updatedAt = now;
        this.sqliteStore.saveOrder(order);
        this.riskEngine.updateShadowPosition(order.symbol, -parseFloat(order.size));
        // 从 positionTracker 中移除
        this.positionTracker.removeOpenOrder(order.clientOrderId);
        expiredCount++;
      }
    }
    if (expiredCount > 0) {
      console.log(`[SignalRouter] Cleaned up ${expiredCount} expired orders`);
    }

    // 同步数据库中未过期的挂单到 positionTracker
    const validOrders = openOrders.filter(o => !o.expiresAt || o.expiresAt >= now || o.status !== 'submitted');
    for (const order of validOrders) {
      this.positionTracker.addOpenOrder(order.clientOrderId, {
        orderId: order.orderId || order.clientOrderId,
        symbol: order.symbol,
        side: order.side,
        size: parseFloat(order.size),
        price: parseFloat(order.limitPrice),
        stopLoss: order.stopLoss ? parseFloat(order.stopLoss) : undefined,
        takeProfit: order.takeProfit ? parseFloat(order.takeProfit) : undefined,
        status: order.status,
        createdAt: order.createdAt,
      });
    }
    if (openOrders.length > 0) {
      console.log(`[SignalRouter] Synced ${openOrders.length} open orders to positionTracker`);
    }

    // 从数据库恢复 SLTP 监控（之前成交的订单）
    const filledOrders = this.sqliteStore.getFilledOrdersWithSLTP();
    for (const order of filledOrders) {
      this.sltpMonitor.addOrder({
        orderId: order.orderId,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        side: order.side === 'buy' ? 'long' : 'short',
        size: parseFloat(order.size),
        stopLoss: order.stopLoss && order.stopLoss !== '0' ? parseFloat(order.stopLoss) : undefined,
        takeProfit: order.takeProfit && order.takeProfit !== '0' ? parseFloat(order.takeProfit) : undefined,
        entryPrice: parseFloat(order.limitPrice),
        status: 'active',
        createdAt: order.createdAt,
      });
    }
    if (filledOrders.length > 0) {
      console.log(`[SignalRouter] Restored ${filledOrders.length} SLTP monitors from database`);
    }

    // 从 SQLite 恢复信号历史
    const savedSignals = this.sqliteStore.getRecentSignals(this.MAX_SIGNAL_HISTORY);
    if (savedSignals.length > 0) {
      this.signalHistory = savedSignals;
      console.log(`[SignalRouter] Restored ${savedSignals.length} signals from database`);
    }

    // 连接 DEX Adapter
    const dexConfig: DexConfig = {
      dexName: this.config.dexProvider,
      testnet: this.config.env === 'testnet',
      walletAddress: this.config.walletAddress,
      rpcUrl: this.config.lighterBaseUrl,
      apiKeyIndex: this.config.lighterApiKeyIndex,
      apiPublicKey: this.config.lighterApiPublicKey,
      apiPrivateKey: this.config.lighterApiPrivateKey,
      accountIndex: this.config.lighterAccountIndex,
    };
    await this.dexAdapter.connect(dexConfig);

    // C2: Start MarginMonitor polling from DEX adapter
    this.startMarginPolling();

    // 启动持仓轮询
    this.positionTracker.startPolling(
      async () => (await this.dexAdapter.getPositions()).map(p => this.mapDexPosition(p)),
      async () => (await this.dexAdapter.getOpenOrders()).map(o => this.mapDexOpenOrder(o)),
    );

    // 首次同步持仓，确保信号到达前有数据
    try {
      const dexPositions = await this.dexAdapter.getPositions();
      const dexOrders = await this.dexAdapter.getOpenOrders();
      const positions = dexPositions.map(p => this.mapDexPosition(p));
      const orders = dexOrders.map(o => this.mapDexOpenOrder(o));
      if (dexPositions.length > 0 || dexOrders.length > 0) {
        this.positionTracker.sync(positions, orders);
      } else {
        // Restore paper trading positions from SQLite on restart
        const savedPositions = this.sqliteStore.getAllPositions();
        if (savedPositions.length > 0) {
          const activePositions = savedPositions.filter(p => parseFloat(p.size) > 0);
          if (activePositions.length > 0) {
            try {
              const restored = activePositions.map(p => ({
                symbol: p.symbol, side: p.side as 'long' | 'short',
                size: parseFloat(p.size), entryPrice: parseFloat(p.entryPrice),
                currentPrice: parseFloat(p.entryPrice), unrealizedPnl: 0, realizedPnl: parseFloat(p.realizedPnl),
              }));
              if (typeof (this.dexAdapter as any).importState === 'function') {
                (this.dexAdapter as any).importState({ positions: restored, balance: 10000, orders: [], fills: [] });
              }
              // Also sync position tracker
              for (const p of restored) {
                this.positionTracker.onOrderFilled(p.symbol, p.side === 'long' ? 'buy' : 'sell', p.size, p.entryPrice);
              }
              console.log(`[SignalRouter] Restored ${restored.length} positions from SQLite`);
            } catch (e) {
              console.warn('[SignalRouter] Failed to restore positions from SQLite:', e);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[SignalRouter] Initial position fetch failed, will rely on polling:', err);
    }

    // 加载 instruments（通过 getCapabilities 获取 DEX 能力）
    await this.loadInstruments();

    // 启动订单状态轮询（REST API 无推送，需主动查询）
    this.startOrderStatusPolling();
  }

  private startMarginPolling(): void {
    const pollMargin = async () => {
      try {
        const getAccountFn = this.dexAdapter.getAccount;
        if (!getAccountFn) return;
        const account = await getAccountFn.call(this.dexAdapter);
        const totalBalance = account.totalBalance || 0;
        const availableBalance = account.availableBalance || 0;
        const usedMargin = totalBalance - availableBalance;
        const marginRatio = totalBalance > 0 ? usedMargin / totalBalance : 0;

        this.marginMonitor.updateStatus({
          totalEquity: totalBalance,
          availableMargin: availableBalance,
          usedMargin,
          marginRatio,
          updatedAt: Date.now(),
        });
      } catch (err) {
        console.warn('[SignalRouter] Margin polling error:', err);
      }
    };

    // Initial poll
    pollMargin();
    // Poll every 10 seconds
    setInterval(pollMargin, 10000).unref();
  }

  private startOrderStatusPolling(): void {
    this.orderStatusPollInterval = setInterval(async () => {
      try {
        const submittedOrders = this.sqliteStore.getOpenOrders().filter(o => o.status === 'submitted');
        if (submittedOrders.length === 0) return;

        const exchangeOrders = await this.dexAdapter.getOpenOrders();
        const exchangeOrderMap = new Map<string, any>();
        for (const o of exchangeOrders) {
          exchangeOrderMap.set(o.clientOrderId || o.exchangeOrderId, o);
        }

        const dexPositions = await this.dexAdapter.getPositions();
        const positionMap = new Map<string, any>();
        for (const p of dexPositions) {
          positionMap.set(p.market, p);
        }

        for (const localOrder of submittedOrders) {
          const exchangeOrder = exchangeOrderMap.get(localOrder.clientOrderId);
          if (exchangeOrder) {
            const newStatus = this.mapExchangeStatus(exchangeOrder.status);
            if (newStatus !== localOrder.status) {
              this.handleOrderUpdate({
                clientOrderId: localOrder.clientOrderId,
                orderId: exchangeOrder.exchangeOrderId || localOrder.orderId,
                status: newStatus,
                fee: String(exchangeOrder.fee || '0'),
              });
            }
          } else {
            // 交易所查不到，检查是否有对应持仓来判断是否成交
            const position = positionMap.get(localOrder.symbol);
            if (position && position.size > 0) {
              console.log(`[SignalRouter] Order ${localOrder.clientOrderId} likely filled (position exists for ${localOrder.symbol})`);
              this.handleOrderUpdate({
                clientOrderId: localOrder.clientOrderId,
                orderId: localOrder.orderId,
                status: 'filled',
                fee: '0',
              });
            } else {
              // 无持仓且不在挂单中，可能已取消或过期
              console.log(`[SignalRouter] Order ${localOrder.clientOrderId} not found in open orders, marking as cancelled`);
              this.handleOrderUpdate({
                clientOrderId: localOrder.clientOrderId,
                orderId: localOrder.orderId,
                status: 'cancelled',
                fee: '0',
              });
            }
          }
        }
      } catch (err) {
        console.error('[SignalRouter] Order status polling error:', err);
      }
    }, 5000);
    this.orderStatusPollInterval.unref();
  }

  private mapDexOrderStatus(status: string): 'pending' | 'submitted' | 'filled' | 'cancelled' | 'rejected' | 'partially_filled' {
    const map: Record<string, 'pending' | 'submitted' | 'filled' | 'cancelled' | 'rejected' | 'partially_filled'> = {
      'pending': 'pending',
      'open': 'submitted',
      'new': 'submitted',
      'partially_filled': 'partially_filled',
      'filled': 'filled',
      'cancelled': 'cancelled',
      'rejected': 'rejected',
      'expired': 'cancelled',
    };
    return map[status] || 'submitted';
  }

  private mapDexPosition(dexPos: DexPosition): { symbol: string; side: 'long' | 'short'; size: string; entryPrice: string; unrealizedPnl: string; realizedPnl: string; updatedAt: number } {
    return {
      symbol: dexPos.market,
      side: dexPos.side === 'none' ? 'long' : dexPos.side,
      size: String(dexPos.size),
      entryPrice: String(dexPos.entryPrice),
      unrealizedPnl: String(dexPos.unrealizedPnl),
      realizedPnl: String(dexPos.realizedPnl),
      updatedAt: Date.now(),
    };
  }

  private mapDexOpenOrder(dexOrder: DexOpenOrder): { orderId: string; symbol: string; side: 'buy' | 'sell'; size: number; price: number; stopLoss?: number; takeProfit?: number; status: string; createdAt: number } {
    return {
      orderId: dexOrder.exchangeOrderId,
      symbol: dexOrder.market,
      side: dexOrder.side,
      size: dexOrder.size,
      price: dexOrder.price,
      status: dexOrder.status,
      createdAt: dexOrder.createdAt,
    };
  }

  private mapExchangeStatus(status: string): 'pending' | 'submitted' | 'filled' | 'cancelled' | 'rejected' | 'partially_filled' {
    const map: Record<string, 'pending' | 'submitted' | 'filled' | 'cancelled' | 'rejected' | 'partially_filled'> = {
      'open': 'submitted',
      'new': 'submitted',
      'partially_filled': 'partially_filled',
      'filled': 'filled',
      'cancelled': 'cancelled',
      'rejected': 'rejected',
      'expired': 'cancelled',
    };
    return map[status] || 'submitted';
  }

  private async loadInstruments(): Promise<void> {
    if (!this.dexAdapter || !this.config) return;
    try {
      const caps = this.dexAdapter.getCapabilities();
      console.log(`[SignalRouter] DEX capabilities loaded: ${this.config.dexProvider} (maxLeverage: ${caps.maxLeverage})`);
    } catch (err) {
      console.error('[SignalRouter] Failed to load DEX capabilities:', err);
    }
  }

  async initializeMarketData(redis: any): Promise<void> {
    this.redis = redis;
    const { MarketDataStream } = await import('./market-data');
    this.marketData = new MarketDataStream({
      symbols: this.config.symbols,
    }, redis, this.dexAdapter);
    await this.marketData.connect();

    this.marketData.onPriceUpdate((data) => {
      // Paper trading: update simulated position prices
      if (this.config.paperTrading && 'updatePrices' in this.dexAdapter) {
        (this.dexAdapter as any).updatePrices(data.symbol, data.lastPrice);
      }

      // M1: Update price history for real ATR calculation
      this.riskEngine.updatePriceHistory(data.symbol, data.lastPrice);

      // P1: Use bid/ask for SLTP triggers instead of lastPrice
      // Long SL triggers on bid (can sell at bid), Long TP triggers on ask (can sell at ask)
      // Short SL triggers on ask (can buy at ask), Short TP triggers on bid (can buy at bid)
      const sltpPrice = data.lastPrice; // Fallback, but check bid/ask for precision
      const triggered = this.sltpMonitor.checkPrice(data.symbol, sltpPrice, data.bidPrice, data.askPrice);
      for (const t of triggered) {
        const closeSide = t.side === 'long' ? 'sell' : 'buy';
        const triggeredType = t.stopLoss ? 'stop_loss' : 'take_profit';
        // P1: Use appropriate price for close order
        const closePrice = t.stopLoss
          ? (t.side === 'long' ? data.bidPrice : data.askPrice) // SL: use worse price (conservative)
          : (t.side === 'long' ? data.askPrice : data.bidPrice); // TP: use better price (optimistic)
        console.log(`[SLTP] ${triggeredType.toUpperCase()} triggered for ${t.symbol} @ ${closePrice}`);
        this.submitCloseOrder(t.symbol, closeSide, t.size, closePrice, t).catch(err => {
          console.error(`[SLTP] Failed to submit close order: ${err.message}`);
        });
      }
    });
  }

  private async getRedisLatestPrice(symbol: string): Promise<MarketData | null> {
    if (!this.redis) return null;
    try {
      const result = await this.redis.xrevrange(`market:${symbol}`, '+', '-', 'COUNT', 1);
      if (result && result.length > 0) {
        const entry = result[0];
        const fields = entry[1];
        const lastPrice = parseFloat(fields[fields.indexOf('lastPrice') + 1]);
        const bidPrice = parseFloat(fields[fields.indexOf('bidPrice') + 1]);
        const askPrice = parseFloat(fields[fields.indexOf('askPrice') + 1]);
        const timestamp = parseInt(fields[fields.indexOf('timestamp') + 1], 10) || Date.now();
        if (lastPrice > 0) return { symbol, lastPrice, bidPrice, askPrice, volume24h: 0, timestamp };
      }
    } catch (err) {
      console.error('[SignalRouter] Redis price fallback failed:', err);
    }
    return null;
  }

  getPositionTracker(): PositionTracker {
    return this.positionTracker;
  }

  getSLTPMonitor(): SLTPMonitor {
    return this.sltpMonitor;
  }

  getRiskEngine(): RiskEngine {
    return this.riskEngine;
  }

  getMarketData(): MarketDataStream | null {
    return this.marketData;
  }

  getSqliteStore(): SqliteStore {
    return this.sqliteStore;
  }

  getDexAdapter(): IDexAdapter {
    return this.dexAdapter;
  }

  getSignalHistory(): Array<{ signalId: string; symbol: string; action: string; confidence: number; positionSize: number; signalPrice: number; accepted: boolean; reason: string; timestamp: number }> {
    return this.signalHistory;
  }

  getSymbols(): string[] {
    return this.config.symbols;
  }

  getLastSignalTimestamp(symbol?: string): number | null {
    const history = this.getSignalHistory();
    if (history.length === 0) return null;
    if (symbol === undefined) return history[0].timestamp;
    const entry = history.find(s => s.symbol === symbol);
    return entry ? entry.timestamp : null;
  }

  getLastPythonAiPing(): number | null {
    return this._lastPythonAiPing > 0 ? this._lastPythonAiPing : null;
  }

  getSignalStats(): { total: number; accepted: number; rejected: number; byAction: Record<string, number>; bySymbol: Record<string, number>; acceptedByAction: Record<string, number>; acceptedBySymbol: Record<string, number> } {
    const history = this.getSignalHistory();
    let accepted = 0;
    const byAction: Record<string, number> = {};
    const bySymbol: Record<string, number> = {};
    const acceptedByAction: Record<string, number> = {};
    const acceptedBySymbol: Record<string, number> = {};
    for (const s of history) {
      byAction[s.action] = (byAction[s.action] || 0) + 1;
      bySymbol[s.symbol] = (bySymbol[s.symbol] || 0) + 1;
      if (s.accepted) {
        accepted++;
        acceptedByAction[s.action] = (acceptedByAction[s.action] || 0) + 1;
        acceptedBySymbol[s.symbol] = (acceptedBySymbol[s.symbol] || 0) + 1;
      }
    }
    return {
      total: history.length,
      accepted,
      rejected: history.length - accepted,
      byAction,
      bySymbol,
      acceptedByAction,
      acceptedBySymbol,
    };
  }

  getConfidenceDistribution(binSize: number = 5): Array<{ min: number; max: number; count: number; accepted: number }> {
    const history = this.getSignalHistory();
    const bins: Array<{ min: number; max: number; count: number; accepted: number }> = [];
    for (let min = 0; min < 100; min += binSize) {
      const max = Math.min(min + binSize, 100);
      let count = 0;
      let accepted = 0;
      for (const s of history) {
        if (s.confidence >= min && (max === 100 ? s.confidence <= max : s.confidence < max)) {
          count++;
          if (s.accepted) accepted++;
        }
      }
      bins.push({ min, max, count, accepted });
    }
    return bins;
  }

  ping(): void {
    this._lastPythonAiPing = Date.now();
  }

  setMarketData(stream: MarketDataStream): void {
    this.marketData = stream;
  }

  getMarginMonitor(): MarginMonitor {
    return this.marginMonitor;
  }

  getOrderManager(): OrderManager {
    return this.orderManager;
  }

  private async submitCloseOrder(symbol: string, side: 'buy' | 'sell', size: number, price: number, sltpOrder: SLTPOrder): Promise<string | null> {
    try {
      // H1: Verify position still exists before submitting close
      const positions = await this.dexAdapter.getPositions();
      const pos = positions.find(p => p.market === symbol);
      if (!pos || pos.size <= 0) {
        console.log(`[SLTP] No position for ${symbol}, skipping close order`);
        return null;
      }

      const orderInput: DexOrderInput = {
        clientOrderId: `sltp-${sltpOrder.clientOrderId}-${Date.now()}`,
        market: symbol,
        side,
        type: 'market',
        size: Math.min(size, pos.size), // H1: Don't close more than actual position
        price,
        reduceOnly: true,
      };

      const exchangeOrderId = await this.dexAdapter.submitOrder(orderInput);
      if (exchangeOrderId) {
        console.log(`[SLTP] Close order submitted: ${orderInput.clientOrderId} -> ${exchangeOrderId}`);
        // H2: Keep SLTP in "pending_close" state until close order confirms
        sltpOrder.status = 'triggered';
        sltpOrder.pendingCloseOrderId = exchangeOrderId;
      }
      return exchangeOrderId;
    } catch (err) {
      console.error(`[SLTP] Close order failed: ${(err as Error).message}`);
      // H2: Re-add to active monitoring if close submission fails
      sltpOrder.status = 'active';
      sltpOrder.pendingCloseOrderId = undefined;
      this.sltpMonitor.addOrder(sltpOrder);
      return null;
    }
  }

  private cleanupExpiredSignals(): void {
    const now = Date.now();
    for (const [id, timestamp] of this.seenSignals.entries()) {
      if (now - timestamp >= this.TTL_MS) {
        this.seenSignals.delete(id);
      }
    }
  }

  private validateSignal(signal: SignalInput): string | null {
    if (!signal.signalId || signal.signalId.trim() === '') {
      return 'signalId is required';
    }
    if (!signal.symbol || signal.symbol.trim() === '') {
      return 'symbol is required';
    }
    if (!signal.action || !VALID_ACTIONS.has(signal.action)) {
      return `action must be one of: ${Array.from(VALID_ACTIONS).join(', ')}`;
    }
    if (signal.positionSize <= 0) {
      return 'positionSize must be greater than 0';
    }
    // For close action, stopLoss and takeProfit can be 0
    if (signal.action !== 'close') {
      if (signal.stopLoss <= 0) {
        return 'stopLoss must be greater than 0';
      }
      if (signal.takeProfit <= 0) {
        return 'takeProfit must be greater than 0';
      }
    }
    if (signal.signalPrice <= 0) {
      return 'signalPrice must be greater than 0';
    }
    if (signal.maxSlippageBps < 0) {
      return 'maxSlippageBps must be non-negative';
    }
    return null;
  }

  private recordSignal(signal: SignalInput, result: { accepted: boolean; reason: string }): void {
    const record = {
      signalId: signal.signalId,
      symbol: signal.symbol,
      action: signal.action,
      confidence: signal.confidence,
      positionSize: signal.positionSize,
      signalPrice: signal.signalPrice,
      accepted: result.accepted,
      reason: result.reason,
      timestamp: Date.now(),
    };
    this.signalHistory.unshift(record);
    if (this.signalHistory.length > this.MAX_SIGNAL_HISTORY) {
      this.signalHistory.length = this.MAX_SIGNAL_HISTORY;
    }
    // Persist to SQLite so signals survive restarts
    this.sqliteStore.saveSignal(record);
  }

  async handleSignal(signal: SignalInput): Promise<{ accepted: boolean; reason: string }> {
    const validationError = this.validateSignal(signal);
    if (validationError) {
      throw new Error(`INVALID_ARGUMENT: ${validationError}`);
    }

    const reject = (reason: string): { accepted: false; reason: string } => {
      console.log(`[SignalRouter] Signal rejected: ${signal.action} ${signal.symbol} - ${reason}`);
      this.recordSignal(signal, { accepted: false, reason });
      return { accepted: false, reason };
    };

    // Cross-field validations
    if (signal.confidence < 0 || signal.confidence > 100) return reject('INVALID_CONFIDENCE');
    if (!this.config.symbols.includes(signal.symbol)) return reject('INVALID_SYMBOL');

    // P2: Signal rate limiting - max N signals per minute per symbol
    const rateLimitNow = Date.now();
    const symbolTimestamps = this.signalTimestamps.get(signal.symbol) || [];
    const oneMinuteAgo = rateLimitNow - 60 * 1000;
    const recentSignals = symbolTimestamps.filter(t => t > oneMinuteAgo);
    if (recentSignals.length >= this.MAX_SIGNALS_PER_MINUTE) {
      return reject('SIGNAL_RATE_LIMITED');
    }
    recentSignals.push(rateLimitNow);
    this.signalTimestamps.set(signal.symbol, recentSignals);

    // Direction-based stop-loss/take-profit validation
    if (signal.action === 'long') {
      if (signal.stopLoss >= signal.signalPrice || signal.signalPrice >= signal.takeProfit) {
        return reject('INVALID_SL_TP');
      }
    } else if (signal.action === 'short') {
      if (signal.takeProfit >= signal.signalPrice || signal.signalPrice >= signal.stopLoss) {
        return reject('INVALID_SL_TP');
      }
    }
    // For action 'close': no SL/TP validation needed

    if (!this.marketData) {
      return reject('MARKET_DATA_NOT_INITIALIZED');
    }
    let currentPriceData = this.marketData.getLatestPriceInMemory(signal.symbol);
    if (!currentPriceData) {
      console.log('[SignalRouter] No live price data, falling back to Redis');
      currentPriceData = await this.getRedisLatestPrice(signal.symbol);
      if (!currentPriceData) {
        return reject('PRICE_DATA_UNAVAILABLE');
      }
    }

    const marginStatus = this.marginMonitor.getStatus();
    const realPositions = this.positionTracker.getPositions();
    const currentPositions = Array.from(realPositions.values()).map(p => ({ symbol: p.symbol, size: p.size }));
    const riskInput: RiskCheckInput = {
      signal: {
        signalId: signal.signalId,
        symbol: signal.symbol,
        action: signal.action,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        confidence: signal.confidence,
        positionSize: signal.positionSize,
        timestamp: signal.timestamp,
        signalPrice: signal.signalPrice,
        maxSlippageBps: signal.maxSlippageBps,
      },
      currentPrice: currentPriceData.lastPrice,
      currentPositions,
      shadowPositions: this.riskEngine.getShadowPositions(),
      marginStatus,
    };

    // 去重检查（需要在挂单检查和风控检查之前）
    // 1. 按 signalId 去重
    const now = Date.now();
    const lastSeen = this.seenSignals.get(signal.signalId);
    if (lastSeen && now - lastSeen < this.TTL_MS) {
      return reject('DUPLICATE_SIGNAL');
    }
    this.seenSignals.set(signal.signalId, now);

    // 2. 按 symbol+action 去重窗口（30 秒内同一方向信号只接受一次，防 Python AI 重复发送）
    const actionKey = `${signal.symbol}:${signal.action}`;
    const lastActionTime = this.seenActions.get(actionKey);
    if (lastActionTime && now - lastActionTime < 30_000) {
      return reject('DUPLICATE_ACTION');
    }
    this.seenActions.set(actionKey, now);

    const riskResult = await this.riskEngine.check(riskInput);
    if (!riskResult.allowed) {
      console.log(`[SignalRouter] Risk check rejected: ${riskResult.reason}`);
      return reject(riskResult.reason);
    }

    // Position check: close without position, or duplicate direction
    const pos = realPositions.get(signal.symbol);

    if (signal.action === 'close') {
      if (!pos || pos.size <= 0) {
        return reject('NO_POSITION_TO_CLOSE');
      }
    } else if (signal.action === 'long' || signal.action === 'short') {
      if (pos && pos.size > 0 && pos.side === signal.action) {
        return reject('POSITION_ALREADY_OPEN');
      }
    }

    // 挂单检查：同一 symbol 有待成交订单，不再新挂
    const pendingOrders = this.positionTracker.getOpenOrders();
    for (const [_, order] of pendingOrders) {
      if (order.symbol === signal.symbol) {
        return reject('PENDING_ORDER_EXISTS');
      }
    }

    // 通过队列（默认直接通过）
    const processedSignal = await this.signalQueue.enqueue(signal);

    // P0 Fix: Use totalBalance for portfolio value, not availableBalance
    const dexPositions = await this.dexAdapter.getPositions();
    const accountInfo = await this.dexAdapter.getAccount?.();
    const totalValue = accountInfo?.totalBalance || accountInfo?.availableBalance || 200;

    const dynamicSize = this.riskEngine.calculateDynamicPositionSize(
      processedSignal,
      currentPriceData.lastPrice,
      totalValue,
    );

    // P1: Use AI's SL/TP if confidence is high (>= 80%), otherwise use calculated SLTP
    let stopLoss: number;
    let takeProfit: number;
    if (processedSignal.confidence >= 80) {
      // Trust AI's risk assessment for high-confidence signals
      stopLoss = processedSignal.stopLoss;
      takeProfit = processedSignal.takeProfit;
    } else {
      // Use risk engine's ATR-based calculation for lower confidence
      const calculated = this.riskEngine.calculateSLTP(
        processedSignal,
        currentPriceData.lastPrice,
      );
      stopLoss = calculated.stopLoss;
      takeProfit = calculated.takeProfit;
    }

    // 创建订单
    // close 信号使用实际持仓大小开平仓单，而非 dynamicSize
    const orderSize = processedSignal.action === 'close' && pos
      ? Math.abs(pos.size)
      : dynamicSize;

    const order = this.orderManager.createOrder({
      signalId: processedSignal.signalId,
      symbol: processedSignal.symbol,
      side: processedSignal.action === 'long' ? 'buy' : 'sell',
      size: orderSize,
      limitPrice: currentPriceData.lastPrice,
      stopLoss,
      takeProfit,
    });

    // 提交到 DEX（使用市价单）
    const ttlMs = this.config.signalTtlMs;
    const expiresAt = Date.now() + ttlMs;
    const orderForSubmit: Order = {
      clientOrderId: order.clientOrderId,
      orderId: '',
      signalId: order.signalId,
      symbol: order.symbol,
      side: order.side,
      size: String(order.size),
      remainingSize: String(order.size),
      limitPrice: String(order.limitPrice),
      stopLoss: String(order.stopLoss || 0),
      takeProfit: String(order.takeProfit || 0),
      status: 'pending',
      orderType: 'market',
      fee: '0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt,
    };

    const dexOrderInput: DexOrderInput = {
      clientOrderId: order.clientOrderId,
      market: order.symbol,
      side: order.side,
      type: 'market',
      size: order.size,
      price: currentPriceData.lastPrice,
    };

    // 同步到 positionTracker（必须在 submitOrder 之前，确保 handleOrderUpdate 能正确移除）
    this.positionTracker.addOpenOrder(order.clientOrderId, {
      orderId: '',
      symbol: order.symbol,
      side: order.side,
      size: order.size,
      price: order.limitPrice,
      stopLoss: order.stopLoss || undefined,
      takeProfit: order.takeProfit || undefined,
      status: 'pending',
      createdAt: Date.now(),
    });

    const exchangeOrderId = await this.dexAdapter.submitOrder(dexOrderInput).catch(err => {
      console.error(`[SignalRouter] Order submission failed:`, (err as Error).message);
      this.positionTracker.removeOpenOrder(order.clientOrderId);
      return null;
    });

    if (!exchangeOrderId) {
      console.error(`[SignalRouter] Signal ${order.clientOrderId} rejected: order submission failed`);
      return reject('ORDER_SUBMISSION_FAILED');
    }

    this.orderManager.updateStatus(order.clientOrderId, 'submitted', exchangeOrderId);

    // C5: Update shadow position AFTER successful submission, using dynamicSize
    this.riskEngine.updateShadowPosition(signal.symbol, dynamicSize);

    // 设置超时定时器
    this.timeoutManager.schedule(order.clientOrderId, ttlMs, async () => {
      const currentOrder = this.orderManager.getOrder(order.clientOrderId);
      if (currentOrder && !['filled', 'cancelled', 'rejected'].includes(currentOrder.status)) {
        await this.dexAdapter.cancelOrder(exchangeOrderId);
        this.orderManager.updateStatus(order.clientOrderId, 'cancelled');
        this.riskEngine.updateShadowPosition(order.symbol, -order.size);
      }
    });

    // 持久化
    this.sqliteStore.saveOrder({
      clientOrderId: order.clientOrderId,
      orderId: exchangeOrderId,
      signalId: order.signalId,
      symbol: order.symbol,
      side: order.side,
      size: String(order.size),
      remainingSize: String(order.size),
      limitPrice: String(order.limitPrice),
      stopLoss: String(order.stopLoss || 0),
      takeProfit: String(order.takeProfit || 0),
      status: 'submitted',
      orderType: 'market',
      fee: '0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt,
    });

    console.log(`[SignalRouter] Order submitted: ${order.clientOrderId} -> ${exchangeOrderId}`);

    this.recordSignal(signal, { accepted: true, reason: '' });
    return { accepted: true, reason: '' };
  }

  // 订单状态回调处理（含竞态防护）
  private handleOrderUpdate(update: OrderUpdate): void {
    const order = this.orderManager.getOrder(update.clientOrderId);
    if (!order) return;

    // 竞态防护：终态订单拒绝任何状态变更
    if (['filled', 'cancelled', 'rejected'].includes(order.status)) {
      console.log(`[SignalRouter] Order ${update.clientOrderId} already in terminal state ${order.status}, ignoring update to ${update.status}`);
      return;
    }

    const updatedOrder = this.orderManager.updateStatus(order.clientOrderId, update.status, update.orderId, parseFloat(update.fee));
    if (!updatedOrder) return;

    // 更新 Shadow Position 和持久化
    if (update.status === 'filled') {
      this.riskEngine.updateShadowPosition(order.symbol, -order.size);

      // 计算成交盈亏后更新仓位（优先使用 DEX 实际成交价）
      const fillPrice = parseFloat(update.fillPrice || String(order.limitPrice));
      const fillPnl = this.positionTracker.onOrderFilled(order.symbol, order.side, order.size, fillPrice);
      this.positionTracker.removeOpenOrder(order.clientOrderId);
      // Correctly update position in SQLite: reduce existing if opposite direction
      // 使用 PositionTracker 的最新数据（含 realizedPnl），确保与内存一致
      const newSide = order.side === 'buy' ? 'long' : 'short';
      const newSize = order.size;
      const updatedPos = this.positionTracker.getPosition(order.symbol);
      const realizedPnlStr = updatedPos ? String(updatedPos.realizedPnl.toFixed(2)) : '0';
      const existingPos = this.sqliteStore.getPosition(order.symbol);
      if (existingPos && parseFloat(existingPos.size) > 0 && existingPos.side !== newSide) {
        // Opposite direction: reduce or close
        const existingSize = parseFloat(existingPos.size);
        const netSize = existingSize - newSize;
        if (netSize <= 0) {
          // Position fully closed
          this.sqliteStore.updatePosition(order.symbol, existingPos.side, '0', existingPos.entryPrice, realizedPnlStr);
        } else {
          // Partially reduced
          this.sqliteStore.updatePosition(order.symbol, existingPos.side, String(netSize), existingPos.entryPrice, realizedPnlStr);
        }
      } else {
        // Same direction or new position: add or create
        this.sqliteStore.updatePosition(order.symbol, newSide, String(newSize), String(order.limitPrice), realizedPnlStr);
      }
      this.timeoutManager.cancel(order.clientOrderId);

      // Record trade history for every fill — 使用 PositionTracker 算出的实际盈亏
      this.sqliteStore.addTradeHistory({
        orderId: order.orderId || order.clientOrderId,
        symbol: order.symbol,
        side: order.side,
        size: String(order.size),
        price: String(order.limitPrice),
        fee: update.fee,
        pnl: String(fillPnl.toFixed(2)),
        timestamp: Date.now(),
      });

      if (order.stopLoss || order.takeProfit) {
        this.sltpMonitor.addOrder({
          orderId: order.orderId,
          clientOrderId: order.clientOrderId,
          symbol: order.symbol,
          side: order.side === 'buy' ? 'long' : 'short',
          size: order.size,
          stopLoss: order.stopLoss ? parseFloat(String(order.stopLoss)) : undefined,
          takeProfit: order.takeProfit ? parseFloat(String(order.takeProfit)) : undefined,
          entryPrice: parseFloat(String(order.limitPrice)),
          status: 'active',
          createdAt: order.createdAt,
          trailingStopPct: this.config.trailingStopPct || 0,
          highestPrice: parseFloat(String(order.limitPrice)),
          lowestPrice: parseFloat(String(order.limitPrice)),
        });
      }
    } else if (update.status === 'cancelled' || update.status === 'rejected') {
      this.riskEngine.updateShadowPosition(order.symbol, -order.size);
      this.timeoutManager.cancel(order.clientOrderId);
      this.positionTracker.removeOpenOrder(order.clientOrderId);
    }

    // 更新并保存订单 (use fresh snapshot from xstate)
    this.sqliteStore.saveOrder({
      clientOrderId: updatedOrder.clientOrderId,
      orderId: updatedOrder.orderId,
      signalId: updatedOrder.signalId,
      symbol: updatedOrder.symbol,
      side: updatedOrder.side,
      size: String(updatedOrder.size),
      remainingSize: String(updatedOrder.remainingSize),
      limitPrice: String(updatedOrder.limitPrice),
      stopLoss: String(updatedOrder.stopLoss || 0),
      takeProfit: String(updatedOrder.takeProfit || 0),
      status: updatedOrder.status,
      orderType: updatedOrder.orderType || 'market',
      fee: update.fee,
      createdAt: updatedOrder.createdAt,
      updatedAt: updatedOrder.updatedAt,
      expiresAt: updatedOrder.createdAt + this.config.signalTtlMs,
    });
  }

  async startServer(port: number, tlsEnabled = false): Promise<grpc.Server> {
    const server = new grpc.Server();
    server.addService(protoDescriptor.signal.SignalService.service, {
      SendSignal: async (call: grpc.ServerUnaryCall<TradingSignal, any>, callback: grpc.sendUnaryData<any>) => {
        try {
          const result = await this.handleSignal({
            signalId: call.request.signalId,
            symbol: call.request.symbol,
            action: call.request.action,
            stopLoss: call.request.stopLoss,
            takeProfit: call.request.takeProfit,
            confidence: call.request.confidence,
            positionSize: call.request.positionSize,
            timestamp: call.request.timestamp,
            signalPrice: call.request.signalPrice,
            maxSlippageBps: call.request.maxSlippageBps,
          });

          // 将当前仓位信息返回给 AI，让 AI 感知到自己在做什么
          const pos = this.positionTracker.getPositions().get(call.request.symbol);
          const positionPayload = pos && pos.size > 0 ? {
            symbol: pos.symbol,
            side: pos.side,
            size: pos.size,
            entry_price: pos.entryPrice,
            unrealized_pnl: pos.unrealizedPnl,
            realized_pnl: pos.realizedPnl,
          } : null;

          callback(null, { signal_id: call.request.signalId, accepted: result.accepted, reason: result.reason, position: positionPayload });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[SignalRouter] SendSignal error: ${message}`);
          if (message.startsWith('INVALID_ARGUMENT:')) {
            callback({ code: grpc.status.INVALID_ARGUMENT, details: message.replace('INVALID_ARGUMENT: ', '') }, null);
          } else {
            callback({ code: grpc.status.INTERNAL, details: message }, null);
          }
        }
      },
      HealthCheck: async (_call: any, callback: grpc.sendUnaryData<any>) => {
        callback(null, { healthy: true, version: '0.1.0' });
      },
    });

    return new Promise<grpc.Server>((resolve, reject) => {
      let credentials: grpc.ServerCredentials;
      if (tlsEnabled) {
        const tlsKeyPath = process.env.GRPC_TLS_KEY_PATH || '/app/certs/server.key';
        const tlsCertPath = process.env.GRPC_TLS_CERT_PATH || '/app/certs/server.crt';
        try {
          const key = fs.readFileSync(tlsKeyPath);
          const cert = fs.readFileSync(tlsCertPath);
          credentials = grpc.ServerCredentials.createSsl(null, [{ private_key: key, cert_chain: cert }]);
        } catch (err) {
          console.warn(`[SignalRouter] TLS certs not found, falling back to insecure: ${(err as Error).message}`);
          credentials = grpc.ServerCredentials.createInsecure();
        }
      } else {
        credentials = grpc.ServerCredentials.createInsecure();
      }
      server.bindAsync(`0.0.0.0:${port}`, credentials, (err, boundPort) => {
        if (err) {
          console.error(`[SignalRouter] Failed to bind server on port ${port}: ${err.message}`);
          reject(err);
          return;
        }
        console.log(`SignalRouter gRPC server listening on port ${boundPort}`);
        resolve(server);
      });
    });
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.orderStatusPollInterval) {
      clearInterval(this.orderStatusPollInterval);
      this.orderStatusPollInterval = null;
    }
    this.timeoutManager.clearAll();
    this.dexAdapter.disconnect();
    this.sqliteStore.close();
  }
}
