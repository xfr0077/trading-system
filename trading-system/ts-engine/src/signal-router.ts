import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import * as path from 'path';
import * as fs from 'fs';
import { RiskEngine, RiskCheckInput } from './risk-engine';
import { MarginMonitor } from './margin-monitor';
import { MarketDataStream } from './market-data';
import { OrderManager } from './order-manager';
import { Config } from './config';
import { SqliteStore, Order } from './sqlite-store';
import { OrderTimeoutManager } from './order-timeout-manager';
import { TradingWebSocket, GrvtConfig } from './trading-ws';
import { GrvtEnv } from '@wezzcoetzee/grvt';
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
  private readonly TTL_MS = 5 * 60 * 1000;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private riskEngine: RiskEngine;
  private marginMonitor: MarginMonitor;
  private marketData: MarketDataStream | null = null;
  private orderManager: OrderManager;
  private sqliteStore: SqliteStore;
  private timeoutManager: OrderTimeoutManager;
  private tradingWs: TradingWebSocket;
  private signalQueue: ISignalQueue;
  private positionTracker: PositionTracker;
  private sltpMonitor: SLTPMonitor;
  private config: Config;

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
    });
    this.marginMonitor = new MarginMonitor({
      warningThreshold: config.marginWarningThreshold,
      criticalThreshold: config.marginCriticalThreshold,
    });
    this.orderManager = new OrderManager();
    this.sqliteStore = new SqliteStore(config.sqlitePath);
    this.timeoutManager = new OrderTimeoutManager();
    this.tradingWs = new TradingWebSocket();
    this.signalQueue = new DefaultSignalQueue();
    this.positionTracker = new PositionTracker();
    this.sltpMonitor = new SLTPMonitor();

    this.tradingWs.onOrderUpdate((update) => this.handleOrderUpdate(update));
  }

  async initialize(): Promise<void> {
    // 重启恢复：从数据库恢复未完成订单的定时器
    const openOrders = this.sqliteStore.getOpenOrders();
    await this.timeoutManager.restoreFromDatabase(openOrders, async (orderId, remainingMs) => {
      this.timeoutManager.schedule(orderId, remainingMs, async () => {
        const order = this.sqliteStore.getOrder(orderId);
        if (order && order.status === 'submitted') {
          await this.tradingWs.cancelOrder(order.orderId);
          this.orderManager.updateStatus(orderId, 'cancelled');
          order.status = 'cancelled';
          order.updatedAt = Date.now();
          this.sqliteStore.saveOrder(order);
          this.riskEngine.updateShadowPosition(order.symbol, 0);
        }
      });
    });
    console.log(`[SignalRouter] Restored ${openOrders.length} pending orders from database`);

    // 同步数据库中的挂单到 positionTracker，防止重复下单
    for (const order of openOrders) {
      this.positionTracker['openOrders'].set(order.clientOrderId, {
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

    // 连接 TradingWS
    await this.tradingWs.connect({
      apiKey: this.config.grvtApiKey,
      privateKey: this.config.grvtPrivateKey,
      tradingAccountId: this.config.grvtTradingAccountId,
      env: this.config.grvtEnv,
    });

    // 启动持仓轮询
    this.positionTracker.startPolling(
      () => this.tradingWs.getPositions(),
      () => this.tradingWs.getOpenOrders(),
    );

    // 首次同步持仓，确保信号到达前有数据
    try {
      const positions = await this.tradingWs.getPositions();
      const orders = await this.tradingWs.getOpenOrders();
      if (positions.length > 0 || orders.length > 0) {
        this.positionTracker.sync(positions, orders);
      }
    } catch (err) {
      console.warn('[SignalRouter] Initial position fetch failed, will rely on polling:', err);
    }

    // 加载 instruments
    await this.loadInstruments();
  }

  private async loadInstruments(): Promise<void> {
    if (!this.tradingWs || !this.config) return;
    try {
      const instruments = await this.tradingWs.getInstruments();
      for (const inst of instruments) {
        this.tradingWs.addInstrument(inst.symbol, inst.instrument_hash, inst.base_decimals || 9);
      }
      console.log(`[SignalRouter] Loaded ${instruments.length} instruments`);
    } catch (err) {
      console.error('[SignalRouter] Failed to load instruments:', err);
    }
  }

  async initializeMarketData(redis: any): Promise<void> {
    const { MarketDataStream } = await import('./market-data');
    this.marketData = new MarketDataStream({
      apiKey: this.config.grvtApiKey,
      env: this.config.grvtEnvCommunity,
      symbols: this.config.symbols,
    }, redis);
    await this.marketData.connect();

    this.marketData.onPriceUpdate((data) => {
      const triggered = this.sltpMonitor.checkPrice(data.symbol, data.lastPrice, data.bidPrice, data.askPrice);
      for (const t of triggered) {
        const closeSide = t.side === 'long' ? 'sell' : 'buy';
        const triggeredType = t.stopLoss ? 'stop_loss' : 'take_profit';
        console.log(`[SLTP] ${triggeredType.toUpperCase()} triggered for ${t.symbol} @ ${data.lastPrice}`);
        this.submitCloseOrder(t.symbol, closeSide, t.size, data.lastPrice, t).catch(err => {
          console.error(`[SLTP] Failed to submit close order: ${err.message}`);
        });
      }
    });
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
      const orderForSubmit: Order = {
        clientOrderId: `sltp-${sltpOrder.clientOrderId}-${Date.now()}`,
        orderId: '',
        signalId: '',
        symbol,
        side,
        size: String(size),
        remainingSize: String(size),
        limitPrice: String(price),
        stopLoss: '0',
        takeProfit: '0',
        status: 'pending',
        orderType: 'market',
        fee: '0',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt: Date.now() + 30000,
      };

      const exchangeOrderId = await this.tradingWs.submitOrder(orderForSubmit);
      if (exchangeOrderId) {
        console.log(`[SLTP] Close order submitted: ${orderForSubmit.clientOrderId} -> ${exchangeOrderId}`);
      }
      return exchangeOrderId;
    } catch (err) {
      console.error(`[SLTP] Close order failed: ${(err as Error).message}`);
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
    if (signal.confidence < 0 || signal.confidence > 100) {
      return 'confidence must be between 0 and 100';
    }
    if (signal.positionSize <= 0) {
      return 'positionSize must be greater than 0';
    }
    if (signal.stopLoss <= 0) {
      return 'stopLoss must be greater than 0';
    }
    if (signal.takeProfit <= 0) {
      return 'takeProfit must be greater than 0';
    }
    if (signal.signalPrice <= 0) {
      return 'signalPrice must be greater than 0';
    }
    if (signal.maxSlippageBps < 0) {
      return 'maxSlippageBps must be non-negative';
    }
    return null;
  }

  async handleSignal(signal: SignalInput): Promise<{ accepted: boolean; reason: string }> {
    const validationError = this.validateSignal(signal);
    if (validationError) {
      throw new Error(`INVALID_ARGUMENT: ${validationError}`);
    }

    if (!this.marketData) {
      return { accepted: false, reason: 'MARKET_DATA_NOT_INITIALIZED' };
    }
    const currentPriceData = this.marketData.getLatestPriceInMemory(signal.symbol);
    if (!currentPriceData) {
      return { accepted: false, reason: 'PRICE_DATA_UNAVAILABLE' };
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

    const riskResult = await this.riskEngine.check(riskInput);
    if (!riskResult.allowed) {
      return { accepted: false, reason: riskResult.reason };
    }

    // Position check: close without position, or duplicate direction
    const pos = realPositions.get(signal.symbol);

    if (signal.action === 'close') {
      if (!pos || pos.size <= 0) {
        return { accepted: false, reason: 'NO_POSITION_TO_CLOSE' };
      }
    } else if (signal.action === 'long' || signal.action === 'short') {
      if (pos && pos.size > 0 && pos.side === signal.action) {
        return { accepted: false, reason: 'POSITION_ALREADY_OPEN' };
      }
    }

    // 挂单检查：同一 symbol 有待成交订单，不再新挂
    const pendingOrders = this.positionTracker.getOpenOrders();
    for (const [_, order] of pendingOrders) {
      if (order.symbol === signal.symbol) {
        return { accepted: false, reason: 'PENDING_ORDER_EXISTS' };
      }
    }

    // 通过队列（默认直接通过）
    const processedSignal = await this.signalQueue.enqueue(signal);

    // 去重检查
    const now = Date.now();
    const lastSeen = this.seenSignals.get(processedSignal.signalId);
    if (lastSeen && now - lastSeen < this.TTL_MS) {
      return { accepted: false, reason: 'DUPLICATE_SIGNAL' };
    }

    this.seenSignals.set(processedSignal.signalId, now);

    // 创建订单
    const order = this.orderManager.createOrder({
      signalId: processedSignal.signalId,
      symbol: processedSignal.symbol,
      side: processedSignal.action === 'long' ? 'buy' : 'sell',
      size: processedSignal.positionSize,
      limitPrice: processedSignal.signalPrice,
      stopLoss: processedSignal.stopLoss,
      takeProfit: processedSignal.takeProfit,
    });

    // 提交到 GRVT
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
      orderType: 'limit',
      fee: '0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt,
    };

    const exchangeOrderId = await this.tradingWs.submitOrder(orderForSubmit).catch(err => {
      console.error(`[SignalRouter] Order submission to GRVT failed (non-fatal):`, (err as Error).message);
      return null;
    });

    if (!exchangeOrderId) {
      console.warn(`[SignalRouter] Signal ${order.clientOrderId} accepted but order not submitted to GRVT`);
      return { accepted: true, reason: 'ORDER_SUBMISSION_FAILED' };
    }

    this.orderManager.updateStatus(order.clientOrderId, 'submitted', exchangeOrderId);

    // 设置超时定时器
    this.timeoutManager.schedule(order.clientOrderId, ttlMs, async () => {
      const currentOrder = this.orderManager.getOrder(order.clientOrderId);
      if (currentOrder && !['filled', 'cancelled', 'rejected'].includes(currentOrder.status)) {
        await this.tradingWs.cancelOrder(exchangeOrderId);
        this.orderManager.updateStatus(order.clientOrderId, 'cancelled');
        this.riskEngine.updateShadowPosition(order.symbol, 0);
      }
    });

    // 持久化
    this.sqliteStore.saveOrder({
      ...orderForSubmit,
      orderId: exchangeOrderId,
      status: 'submitted',
    });

    this.riskEngine.updateShadowPosition(signal.symbol, signal.positionSize);

    // 同步到 positionTracker
    this.positionTracker['openOrders'].set(order.clientOrderId, {
      orderId: exchangeOrderId,
      symbol: order.symbol,
      side: order.side,
      size: order.size,
      price: order.limitPrice,
      stopLoss: order.stopLoss || undefined,
      takeProfit: order.takeProfit || undefined,
      status: 'submitted',
      createdAt: Date.now(),
    });

    console.log(`[SignalRouter] Order submitted: ${order.clientOrderId} -> ${exchangeOrderId}`);

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

    this.orderManager.updateStatus(order.clientOrderId, update.status, update.orderId, parseFloat(update.fee));

    // 更新 Shadow Position 和持久化
    if (update.status === 'filled') {
      this.riskEngine.updateShadowPosition(order.symbol, 0);
      this.positionTracker.onOrderFilled(order.symbol, order.side, order.size, parseFloat(String(order.limitPrice)));
      this.positionTracker['openOrders'].delete(order.clientOrderId);
      this.sqliteStore.updatePosition(order.symbol, order.side === 'buy' ? 'long' : 'short', String(order.size), String(order.limitPrice));
      this.timeoutManager.cancel(order.clientOrderId);

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
        });
      }
    } else if (update.status === 'cancelled' || update.status === 'rejected') {
      this.riskEngine.updateShadowPosition(order.symbol, 0);
      this.timeoutManager.cancel(order.clientOrderId);
      this.positionTracker['openOrders'].delete(order.clientOrderId);
    }

    // 更新并保存订单
    order.orderId = update.orderId;
    order.status = update.status;
    order.updatedAt = Date.now();
    this.sqliteStore.saveOrder({
      clientOrderId: order.clientOrderId,
      orderId: order.orderId,
      signalId: order.signalId,
      symbol: order.symbol,
      side: order.side,
      size: String(order.size),
      remainingSize: String(order.remainingSize),
      limitPrice: String(order.limitPrice),
      stopLoss: String(order.stopLoss || 0),
      takeProfit: String(order.takeProfit || 0),
      status: order.status,
      orderType: 'limit',
      fee: update.fee,
      createdAt: order.createdAt,
      updatedAt: Date.now(),
      expiresAt: order.createdAt + this.config.signalTtlMs,
    });
  }

  async startServer(port: number): Promise<grpc.Server> {
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
          callback(null, { signal_id: call.request.signalId, accepted: result.accepted, reason: result.reason });
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
      server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
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
    this.timeoutManager.clearAll();
    this.tradingWs.disconnect();
    this.sqliteStore.close();
  }
}
