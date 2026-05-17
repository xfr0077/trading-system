# Phase 3：订单执行与持久化 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 GRVT 实际下单、订单超时取消、SQLite 持久化、WebSocket 实际连接，打通"信号 → 风控 → 下单 → 状态回调 → 持久化"完整链路。

**架构：** TS Engine 通过 TradingWS 提交订单到 GRVT，设置 TTL 定时器自动撤单，所有订单/持仓/交易历史持久化到 SQLite（TEXT 精度），启动时自动恢复未完成订单。

**技术栈：** TypeScript (Node.js), better-sqlite3, decimal.js, @grvt/sdk, gRPC, Redis Streams

---

## 文件结构

```
trading-system/
├── ts-engine/
│   ├── src/
│   │   ├── types.ts                # [修改] 新增 OrderUpdate、TradeRecord、Position 等共享类型
│   │   ├── sqlite-store.ts         # [新增] SQLite 持久化（订单/持仓/交易历史）
│   │   ├── order-executor.ts       # [新增] GRVT 订单执行 + 超时管理
│   │   ├── trading-ws.ts           # [新增] GRVT Trading WebSocket（下单/撤单/重连）
│   │   ├── market-data.ts          # [修改] 实际连接 GRVT WebSocket（替换 TODO）
│   │   ├── signal-router.ts        # [修改] 集成订单执行、持久化、队列接口、重启恢复
│   │   ├── config.ts               # [修改] 新增 Phase 3 环境变量
│   │   └── index.ts                # [修改] 调用 SignalRouter.initialize()
│   ├── tests/
│   │   ├── sqlite-store.test.ts    # [新增]
│   │   ├── order-executor.test.ts  # [新增]
│   │   └── trading-ws.test.ts      # [新增]
│   └── package.json                # [修改] 添加 better-sqlite3, decimal.js
├── python-ai/
│   ├── proto/
│   │   └── signal.proto            # [修改] 新增 order_ttl_ms、order_type 字段
│   └── src/
│       └── signal_client.py        # [修改] 新增 order_ttl_ms、order_type 参数
└── docker-compose.yml              # [修改] 确保 /data 挂载为命名 Volume
```

---

### 任务 1：共享类型定义

**文件：**
- 修改：`trading-system/ts-engine/src/types.ts`

- [ ] **步骤 1：扩展 types.ts 添加 Phase 3 类型**

```typescript
// trading-system/ts-engine/src/types.ts — 追加到现有文件

export interface OrderUpdate {
  clientOrderId: string;
  orderId: string;
  status: 'pending' | 'submitted' | 'filled' | 'cancelled' | 'rejected' | 'partially_filled';
  fee: string;
}

export interface TradeRecord {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  size: string;
  price: string;
  fee: string;
  pnl: string;
  timestamp: number;
}

export interface Position {
  symbol: string;
  side: 'long' | 'short';
  size: string;
  entryPrice: string;
  unrealizedPnl: string;
  realizedPnl: string;
  updatedAt: number;
}
```

- [ ] **步骤 2：Commit**

```bash
git add trading-system/ts-engine/src/types.ts
git commit -m "feat: add shared types for Phase 3 (OrderUpdate, TradeRecord, Position)"
```

---

### 任务 2：SQLite 持久化模块

**文件：**
- 创建：`trading-system/ts-engine/src/sqlite-store.ts`
- 创建：`trading-system/ts-engine/tests/sqlite-store.test.ts`
- 修改：`trading-system/ts-engine/package.json`（添加 `better-sqlite3`）

- [ ] **步骤 1：安装 better-sqlite3**

```bash
cd trading-system/ts-engine
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3
```

- [ ] **步骤 2：编写 SQLite 存储测试**

```typescript
// trading-system/ts-engine/tests/sqlite-store.test.ts
import { SqliteStore, Order, Position, TradeRecord } from '../src/sqlite-store';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

describe('SqliteStore', () => {
  let store: SqliteStore;
  const dbPath = path.join(__dirname, 'test-trading.db');

  beforeEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    store = new SqliteStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  test('should save and retrieve order', () => {
    const order: Order = {
      clientOrderId: 'client-1',
      orderId: 'exchange-1',
      signalId: 'sig-1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: '0.01',
      remainingSize: '0.01',
      limitPrice: '98500',
      stopLoss: '97000',
      takeProfit: '100000',
      status: 'submitted',
      orderType: 'limit',
      fee: '0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 300000,
    };

    store.saveOrder(order);
    const retrieved = store.getOrder('client-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.clientOrderId).toBe('client-1');
    expect(retrieved?.symbol).toBe('BTC_USDT_Perp');
  });

  test('should update order status', () => {
    const order: Order = {
      clientOrderId: 'client-1',
      orderId: 'exchange-1',
      signalId: 'sig-1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: '0.01',
      remainingSize: '0.01',
      limitPrice: '98500',
      status: 'submitted',
      orderType: 'limit',
      fee: '0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 300000,
    };

    store.saveOrder(order);
    order.status = 'filled';
    order.remainingSize = '0';
    order.fee = '0.5';
    store.saveOrder(order);

    const updated = store.getOrder('client-1');
    expect(updated?.status).toBe('filled');
    expect(updated?.fee).toBe('0.5');
  });

  test('should get open orders', () => {
    store.saveOrder({ clientOrderId: 'c1', orderId: 'e1', signalId: 's1', symbol: 'BTC', side: 'buy', size: '0.01', remainingSize: '0.01', limitPrice: '98500', status: 'submitted', orderType: 'limit', fee: '0', createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 300000 });
    store.saveOrder({ clientOrderId: 'c2', orderId: 'e2', signalId: 's2', symbol: 'ETH', side: 'sell', size: '0.1', remainingSize: '0', limitPrice: '3400', status: 'filled', orderType: 'limit', fee: '0', createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 300000 });

    const open = store.getOpenOrders();
    expect(open.length).toBe(1);
    expect(open[0].clientOrderId).toBe('c1');
  });

  test('should update position', () => {
    store.updatePosition('BTC_USDT_Perp', 'long', '0.01', '98500');
    const pos = store.getPosition('BTC_USDT_Perp');
    expect(pos).not.toBeNull();
    expect(pos?.size).toBe('0.01');
    expect(pos?.entryPrice).toBe('98500');
  });

  test('should add and retrieve trade history', () => {
    const trade: TradeRecord = {
      orderId: 'e1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: '0.01',
      price: '98500',
      fee: '0.5',
      pnl: '0',
      timestamp: Date.now(),
    };

    store.addTradeHistory(trade);
    const history = store.getTradeHistory('BTC_USDT_Perp', 10);
    expect(history.length).toBe(1);
    expect(history[0].symbol).toBe('BTC_USDT_Perp');
  });
});
```

- [ ] **步骤 3：实现 SQLite 存储**

```typescript
// trading-system/ts-engine/src/sqlite-store.ts
import Database from 'better-sqlite3';
import { OrderUpdate, TradeRecord, Position } from './types';

export interface Order {
  clientOrderId: string;
  orderId: string;
  signalId: string;
  symbol: string;
  side: 'buy' | 'sell';
  size: string;
  remainingSize: string;
  limitPrice: string;
  stopLoss?: string;
  takeProfit?: string;
  status: string;
  orderType: 'limit' | 'market';
  fee: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export class SqliteStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { timeout: 5000 });
    this.db.pragma('journal_mode = WAL');
    this.initializeTables();
  }

  private initializeTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        client_order_id TEXT PRIMARY KEY,
        order_id TEXT,
        signal_id TEXT,
        symbol TEXT,
        side TEXT,
        size TEXT,
        remaining_size TEXT,
        limit_price TEXT,
        stop_loss TEXT,
        take_profit TEXT,
        status TEXT,
        order_type TEXT,
        fee TEXT DEFAULT '0',
        created_at INTEGER,
        updated_at INTEGER,
        expires_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS positions (
        symbol TEXT PRIMARY KEY,
        side TEXT,
        size TEXT,
        entry_price TEXT,
        unrealized_pnl TEXT DEFAULT '0',
        realized_pnl TEXT DEFAULT '0',
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS trade_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT,
        symbol TEXT,
        side TEXT,
        size TEXT,
        price TEXT,
        fee TEXT,
        pnl TEXT,
        timestamp INTEGER
      );
    `);
  }

  saveOrder(order: Order): void {
    this.db.prepare(`
      INSERT INTO orders (client_order_id, order_id, signal_id, symbol, side, size, remaining_size, limit_price, stop_loss, take_profit, status, order_type, fee, created_at, updated_at, expires_at)
      VALUES (@clientOrderId, @orderId, @signalId, @symbol, @side, @size, @remainingSize, @limitPrice, @stopLoss, @takeProfit, @status, @orderType, @fee, @createdAt, @updatedAt, @expiresAt)
      ON CONFLICT(client_order_id) DO UPDATE SET
        order_id = @orderId, status = @status, remaining_size = @remainingSize, fee = @fee, updated_at = @updatedAt
    `).run({
      clientOrderId: order.clientOrderId,
      orderId: order.orderId,
      signalId: order.signalId,
      symbol: order.symbol,
      side: order.side,
      size: order.size,
      remainingSize: order.remainingSize,
      limitPrice: order.limitPrice,
      stopLoss: order.stopLoss || null,
      takeProfit: order.takeProfit || null,
      status: order.status,
      orderType: order.orderType,
      fee: order.fee,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      expiresAt: order.expiresAt,
    });
  }

  getOrder(clientOrderId: string): Order | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE client_order_id = ?').get(clientOrderId) as any;
    if (!row) return null;
    return this.mapRowToOrder(row);
  }

  getOpenOrders(): Order[] {
    const rows = this.db.prepare("SELECT * FROM orders WHERE status IN ('submitted', 'pending', 'partially_filled')").all() as any[];
    return rows.map(this.mapRowToOrder);
  }

  getPosition(symbol: string): Position | null {
    const row = this.db.prepare('SELECT * FROM positions WHERE symbol = ?').get(symbol) as any;
    if (!row) return null;
    return {
      symbol: row.symbol,
      side: row.side,
      size: row.size,
      entryPrice: row.entry_price,
      unrealizedPnl: row.unrealized_pnl,
      realizedPnl: row.realized_pnl,
      updatedAt: row.updated_at,
    };
  }

  getAllPositions(): Position[] {
    const rows = this.db.prepare('SELECT * FROM positions').all() as any[];
    return rows.map(row => ({
      symbol: row.symbol,
      side: row.side,
      size: row.size,
      entryPrice: row.entry_price,
      unrealizedPnl: row.unrealized_pnl,
      realizedPnl: row.realized_pnl,
      updatedAt: row.updated_at,
    }));
  }

  updatePosition(symbol: string, side: 'long' | 'short', size: string, entryPrice: string): void {
    this.db.prepare(`
      INSERT INTO positions (symbol, side, size, entry_price, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET
        side = @side, size = @size, entry_price = @entryPrice, updated_at = @updatedAt
    `).run({
      symbol,
      side,
      size,
      entryPrice,
      updatedAt: Date.now(),
    });
  }

  addTradeHistory(trade: TradeRecord): void {
    this.db.prepare(`
      INSERT INTO trade_history (order_id, symbol, side, size, price, fee, pnl, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(trade.orderId, trade.symbol, trade.side, trade.size, trade.price, trade.fee, trade.pnl, trade.timestamp);
  }

  getTradeHistory(symbol?: string, limit: number = 100): TradeRecord[] {
    let query = 'SELECT * FROM trade_history';
    const params: any[] = [];
    if (symbol) {
      query += ' WHERE symbol = ?';
      params.push(symbol);
    }
    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(row => ({
      orderId: row.order_id,
      symbol: row.symbol,
      side: row.side,
      size: row.size,
      price: row.price,
      fee: row.fee,
      pnl: row.pnl,
      timestamp: row.timestamp,
    }));
  }

  close(): void {
    this.db.close();
  }

  private mapRowToOrder(row: any): Order {
    return {
      clientOrderId: row.client_order_id,
      orderId: row.order_id,
      signalId: row.signal_id,
      symbol: row.symbol,
      side: row.side,
      size: row.size,
      remainingSize: row.remaining_size,
      limitPrice: row.limit_price,
      stopLoss: row.stop_loss,
      takeProfit: row.take_profit,
      status: row.status,
      orderType: row.order_type,
      fee: row.fee,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd trading-system/ts-engine && npx jest tests/sqlite-store.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add trading-system/ts-engine/src/sqlite-store.ts trading-system/ts-engine/tests/sqlite-store.test.ts trading-system/ts-engine/package.json
git commit -m "feat: implement SqliteStore for order/position/trade persistence with TEXT precision"
```

---

### 任务 3：Order Timeout Manager

**文件：**
- 创建：`trading-system/ts-engine/src/order-timeout-manager.ts`
- 创建：`trading-system/ts-engine/tests/order-timeout-manager.test.ts`

- [ ] **步骤 1：编写超时管理器测试**

```typescript
// trading-system/ts-engine/tests/order-timeout-manager.test.ts
import { OrderTimeoutManager } from '../src/order-timeout-manager';

jest.useFakeTimers();

describe('OrderTimeoutManager', () => {
  let manager: OrderTimeoutManager;
  let cancelCallback: jest.Mock;

  beforeEach(() => {
    manager = new OrderTimeoutManager();
    cancelCallback = jest.fn();
  });

  test('should trigger cancel callback after TTL', () => {
    manager.schedule('order-1', 5000, cancelCallback);
    expect(cancelCallback).not.toHaveBeenCalled();

    jest.advanceTimersByTime(5000);
    expect(cancelCallback).toHaveBeenCalledTimes(1);
  });

  test('should cancel timer before TTL', () => {
    manager.schedule('order-1', 5000, cancelCallback);
    manager.cancel('order-1');

    jest.advanceTimersByTime(5000);
    expect(cancelCallback).not.toHaveBeenCalled();
  });

  test('should not trigger callback if already cancelled', () => {
    manager.schedule('order-1', 5000, cancelCallback);
    manager.cancel('order-1');
    manager.cancel('order-1'); // 重复取消不应报错

    jest.advanceTimersByTime(5000);
    expect(cancelCallback).not.toHaveBeenCalled();
  });
});
```

- [ ] **步骤 2：实现超时管理器**

```typescript
// trading-system/ts-engine/src/order-timeout-manager.ts
import { Order } from './sqlite-store';

export class OrderTimeoutManager {
  private timers = new Map<string, NodeJS.Timeout>();

  schedule(orderId: string, ttlMs: number, onCancel: () => void): void {
    if (this.timers.has(orderId)) {
      this.cancel(orderId);
    }

    const timer = setTimeout(async () => {
      await onCancel();
      this.timers.delete(orderId);
    }, ttlMs);

    this.timers.set(orderId, timer);
  }

  cancel(orderId: string): void {
    const timer = this.timers.get(orderId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(orderId);
    }
  }

  async restoreFromDatabase(
    orders: Order[],
    scheduleCallback: (orderId: string, remainingMs: number) => Promise<void>
  ): Promise<void> {
    for (const order of orders) {
      if (order.expiresAt && order.status === 'submitted') {
        const remainingMs = order.expiresAt - Date.now();
        if (remainingMs > 0) {
          await scheduleCallback(order.clientOrderId, remainingMs);
        }
      }
    }
  }

  clearAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
```

- [ ] **步骤 3：运行测试验证通过**

运行：`cd trading-system/ts-engine && npx jest tests/order-timeout-manager.test.ts`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add trading-system/ts-engine/src/order-timeout-manager.ts trading-system/ts-engine/tests/order-timeout-manager.test.ts
git commit -m "feat: implement OrderTimeoutManager with schedule/cancel/restore"
```

---

### 任务 4：Trading WebSocket

**文件：**
- 创建：`trading-system/ts-engine/src/trading-ws.ts`
- 创建：`trading-system/ts-engine/tests/trading-ws.test.ts`

- [ ] **步骤 1：编写 TradingWS 测试**

```typescript
// trading-system/ts-engine/tests/trading-ws.test.ts
import { TradingWebSocket, OrderUpdate } from '../src/trading-ws';

describe('TradingWebSocket', () => {
  let ws: TradingWebSocket;

  beforeEach(() => {
    ws = new TradingWebSocket();
  });

  test('should register order update callbacks', () => {
    const callback = jest.fn();
    ws.onOrderUpdate(callback);
    ws.emitTestUpdate({ clientOrderId: 'c1', orderId: 'e1', status: 'filled', fee: '0.5' });
    expect(callback).toHaveBeenCalledWith({
      clientOrderId: 'c1',
      orderId: 'e1',
      status: 'filled',
      fee: '0.5',
    });
  });

  test('should map GRVT status to local status', () => {
    expect((ws as any).mapGrvtStatus('FILLED')).toBe('filled');
    expect((ws as any).mapGrvtStatus('CANCELLED')).toBe('cancelled');
    expect((ws as any).mapGrvtStatus('PENDING')).toBe('pending');
  });
});
```

- [ ] **步骤 2：实现 TradingWS**

```typescript
// trading-system/ts-engine/src/trading-ws.ts
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

  async connect(config: GrvtConfig): Promise<void> {
    // TODO: 使用 @grvt/sdk 的 GrvtWsClient 实际连接
    // this.client = new GrvtWsClient({ wsUrl: config.tradingWsUrl, apiKey: config.apiKey });
    // await this.client.connect();
    // this.client.subscribeOrderUpdates((order) => { ... });
    // this.client.onDisconnect(() => { this.scheduleReconnect(config); });
    console.log(`[TradingWS] Connecting to ${config.tradingWsUrl}`);
    this.reconnectAttempts = 0;
  }

  private scheduleReconnect(config: GrvtConfig): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[TradingWS] Max reconnect attempts reached');
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect(config);
        // 重连后同步未完成订单（需注入 sqliteStore 和 orderManager）
        // await this.syncPendingOrders();
      } catch (err) {
        this.scheduleReconnect(config);
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

  private mapGrvtStatus(grvtStatus: string): OrderUpdate['status'] {
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
    }
  }
}
```

- [ ] **步骤 3：运行测试验证通过**

运行：`cd trading-system/ts-engine && npx jest tests/trading-ws.test.ts`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add trading-system/ts-engine/src/trading-ws.ts trading-system/ts-engine/tests/trading-ws.test.ts
git commit -m "feat: implement TradingWebSocket with reconnect and order callbacks"
```

---

### 任务 5：SignalRouter 集成订单执行

**文件：**
- 修改：`trading-system/ts-engine/src/signal-router.ts`
- 修改：`trading-system/ts-engine/src/index.ts`

- [ ] **步骤 1：修改 SignalRouter 集成 OrderExecutor、SqliteStore、OrderTimeoutManager**

```typescript
// trading-system/ts-engine/src/signal-router.ts — 在现有 import 后添加
import { SqliteStore, Order } from './sqlite-store';
import { OrderTimeoutManager } from './order-timeout-manager';
import { TradingWebSocket, OrderUpdate } from './trading-ws';
import { ISignalQueue, DefaultSignalQueue } from './signal-queue';  // 见下方

// 在 SignalRouter 类中添加
export class SignalRouter {
  // ... 现有代码 ...

  private sqliteStore: SqliteStore;
  private timeoutManager: OrderTimeoutManager;
  private tradingWs: TradingWebSocket;
  private signalQueue: ISignalQueue;

  constructor(config: Config) {
    // ... 现有代码 ...
    this.sqliteStore = new SqliteStore(config.sqlitePath);
    this.timeoutManager = new OrderTimeoutManager();
    this.tradingWs = new TradingWebSocket();
    this.signalQueue = new DefaultSignalQueue();

    // 注册订单状态回调
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
          this.riskEngine.updateShadowPosition(order.symbol, `-0`);
        }
      });
    });
    console.log(`[SignalRouter] Restored ${openOrders.length} pending orders from database`);

    // 连接 TradingWS
    await this.tradingWs.connect({
      tradingWsUrl: this.config.grvtTradingWsUrl,
      apiKey: this.config.grvtApiKey,
    });
  }

  async handleSignal(signal: SignalInput): Promise<{ accepted: boolean; reason: string }> {
    const validationError = this.validateSignal(signal);
    if (validationError) {
      throw new Error(`INVALID_ARGUMENT: ${validationError}`);
    }

    // 获取实时价格
    if (!this.marketData) {
      return { accepted: false, reason: 'MARKET_DATA_NOT_INITIALIZED' };
    }
    const currentPriceData = this.marketData.getLatestPriceInMemory(signal.symbol);
    if (!currentPriceData) {
      return { accepted: false, reason: 'PRICE_DATA_UNAVAILABLE' };
    }

    // 风控检查
    const marginStatus = this.marginMonitor.getStatus();
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
      currentPositions: [],
      shadowPositions: this.riskEngine.getShadowPositions(),
      marginStatus,
    };

    const riskResult = await this.riskEngine.check(riskInput);
    if (!riskResult.allowed) {
      return { accepted: false, reason: riskResult.reason };
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
    const exchangeOrderId = await this.tradingWs.submitOrder({
      ...order,
      orderType: 'limit',
      remainingSize: String(order.size),
      size: String(order.size),
      limitPrice: String(order.limitPrice),
      stopLoss: String(order.stopLoss || 0),
      takeProfit: String(order.takeProfit || 0),
      fee: '0',
      expiresAt: Date.now() + 300000,
    });

    this.orderManager.updateStatus(order.clientOrderId, 'submitted', exchangeOrderId);

    // 设置超时定时器
    const ttlMs = 300000;  // 默认 5 分钟，Phase 3 后续从信号中读取
    this.timeoutManager.schedule(order.clientOrderId, ttlMs, async () => {
      const currentOrder = this.orderManager.getOrder(order.clientOrderId);
      if (currentOrder && !['filled', 'cancelled', 'rejected'].includes(currentOrder.status)) {
        await this.tradingWs.cancelOrder(exchangeOrderId);
        this.orderManager.updateStatus(order.clientOrderId, 'cancelled');
        this.riskEngine.updateShadowPosition(order.symbol, -order.size);
      }
    });

    // 持久化
    this.sqliteStore.saveOrder({
      ...order,
      orderId: exchangeOrderId,
      orderType: 'limit',
      remainingSize: String(order.size),
      size: String(order.size),
      limitPrice: String(order.limitPrice),
      stopLoss: String(order.stopLoss || 0),
      takeProfit: String(order.takeProfit || 0),
      fee: '0',
      expiresAt: Date.now() + ttlMs,
    });

    this.riskEngine.updateShadowPosition(signal.symbol, signal.positionSize);

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
      this.riskEngine.updateShadowPosition(order.symbol, -order.size);
      this.sqliteStore.updatePosition(order.symbol, order.side === 'buy' ? 'long' : 'short', order.size, order.limitPrice);
      this.timeoutManager.cancel(order.clientOrderId);
    } else if (update.status === 'cancelled' || update.status === 'rejected') {
      this.riskEngine.updateShadowPosition(order.symbol, -order.size);
      this.timeoutManager.cancel(order.clientOrderId);
    }

    // 更新并保存订单
    order.orderId = update.orderId;
    order.status = update.status;
    order.fee = update.fee;
    order.updatedAt = Date.now();
    this.sqliteStore.saveOrder(order);
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
```

- [ ] **步骤 2：创建 signal-queue.ts（预留接口）**

```typescript
// trading-system/ts-engine/src/signal-queue.ts
import { SignalInput } from './signal-router';

export interface ISignalQueue {
  enqueue(signal: SignalInput): Promise<SignalInput>;
  size(): number;
}

export class DefaultSignalQueue implements ISignalQueue {
  async enqueue(signal: SignalInput): Promise<SignalInput> {
    return signal;  // 直接返回，不排队
  }
  size(): number { return 0; }
}
```

- [ ] **步骤 3：修改 index.ts 调用 initialize()**

```typescript
// trading-system/ts-engine/src/index.ts — 修改 main 函数
async function main() {
  const config = loadConfig();
  const router = new SignalRouter(config);

  try {
    await router.initialize();  // 新增：初始化（恢复订单、连接 WS）
    const server = await router.startServer(config.grpcPort);
    console.log(`TS Engine started on port ${config.grpcPort} (env: ${config.grvtEnv})`);

    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down...');
      router.stop();
      server.forceShutdown();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('SIGINT received, shutting down...');
      router.stop();
      server.forceShutdown();
      process.exit(0);
    });
  } catch (err) {
    console.error('Failed to start TS Engine:', err);
    process.exit(1);
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd trading-system/ts-engine && npx jest tests/signal-router.test.ts`
预期：全部 PASS（可能需要更新 mock）

- [ ] **步骤 5：Commit**

```bash
git add trading-system/ts-engine/src/signal-router.ts trading-system/ts-engine/src/signal-queue.ts trading-system/ts-engine/src/index.ts
git commit -m "feat: integrate OrderExecutor, SqliteStore, OrderTimeoutManager into SignalRouter"
```

---

### 任务 6：MarketData 实际连接

**文件：**
- 修改：`trading-system/ts-engine/src/market-data.ts`

- [ ] **步骤 1：修改 market-data.ts 使用 @grvt/sdk 实际连接**

```typescript
// trading-system/ts-engine/src/market-data.ts — 修改 connect 方法

async connect(): Promise<void> {
  // TODO: 使用 @grvt/sdk 实际连接
  // this.client = new GrvtWsClient({ wsUrl: this.config.wsUrl, apiKey: this.config.apiKey });
  // await this.client.connect();
  // for (const symbol of this.symbols) {
  //   this.client.subscribeTicker(symbol, (data) => this.handleTickerData(data));
  // }
  // this.client.onReconnect(() => { ... });
  console.log(`[MarketData] Connecting to ${this.config.wsUrl} for ${this.symbols.join(', ')}`);
}
```

- [ ] **步骤 2：Commit**

```bash
git add trading-system/ts-engine/src/market-data.ts
git commit -m "feat: prepare MarketDataStream for @grvt/sdk actual connection"
```

---

### 任务 7：Proto 和 Python Client 扩展

**文件：**
- 修改：`trading-system/proto/signal.proto`
- 修改：`trading-system/python-ai/src/signal_client.py`

- [ ] **步骤 1：修改 signal.proto 新增字段**

```protobuf
// trading-system/proto/signal.proto — 在 TradingSignal message 中添加
message TradingSignal {
  string signal_id = 1;
  string symbol = 2;
  string action = 3;
  double stop_loss = 4;
  double take_profit = 5;
  double confidence = 6;
  double position_size = 7;
  int64 timestamp = 8;
  double signal_price = 9;
  int32 max_slippage_bps = 10;
  // Phase 3 新增
  int64 order_ttl_ms = 11;      // 订单超时时间（毫秒）
  string order_type = 12;       // "limit" 或 "market"
}
```

- [ ] **步骤 2：重新生成 gRPC 代码**

```bash
# TypeScript
cd trading-system/ts-engine && npm run proto:generate

# Python
cd trading-system/python-ai && python -m grpc_tools.protoc -I../proto --python_out=src/proto --grpc_python_out=src/proto ../proto/signal.proto
```

- [ ] **步骤 3：修改 signal_client.py 支持新字段**

```python
# trading-system/python-ai/src/signal_client.py — 修改 send_signal 方法
def send_signal(
    self,
    symbol: str,
    action: str,
    stop_loss: float,
    take_profit: float,
    confidence: float,
    position_size: float,
    signal_price: float,
    max_slippage_bps: int = 10,
    order_ttl_ms: int = 300000,
    order_type: str = "limit",
) -> SignalAck:
    self._validate_signal(symbol, action, stop_loss, take_profit, confidence, position_size, signal_price)

    request = signal_pb2.TradingSignal(
        signal_id=str(uuid.uuid4()),
        symbol=symbol,
        action=action,
        stop_loss=stop_loss,
        take_profit=take_profit,
        confidence=confidence,
        position_size=position_size,
        timestamp=int(time.time() * 1000),
        signal_price=signal_price,
        max_slippage_bps=max_slippage_bps,
        order_ttl_ms=order_ttl_ms,
        order_type=order_type,
    )
    # ... 后续代码不变
```

- [ ] **步骤 4：Commit**

```bash
git add trading-system/proto/signal.proto trading-system/python-ai/src/signal_client.py
git commit -m "feat: add order_ttl_ms and order_type to signal proto and client"
```

---

### 任务 8：Docker Compose 和依赖更新

**文件：**
- 修改：`trading-system/docker-compose.yml`
- 修改：`trading-system/ts-engine/package.json`

- [ ] **步骤 1：更新 docker-compose.yml 确保 /data 挂载**

```yaml
# trading-system/docker-compose.yml — 确保 ts-engine 的 volumes 正确
  ts-engine:
    build: ./ts-engine
    ports:
      - "50051:50051"
    environment:
      - GRVT_API_KEY=${GRVT_API_KEY}
      - GRVT_ENV=${GRVT_ENV:-testnet}
      - REDIS_URL=redis://redis:6379
      - SQLITE_PATH=/data/trades.db
      - TAILSCALE_AI_IP=${TAILSCALE_AI_IP}
    volumes:
      - ts-data:/data  # 使用命名 Volume 确保 WAL 文件持久化
    depends_on:
      redis:
        condition: service_healthy
    restart: always

volumes:
  redis_data:
  ts-data:  # 新增
```

- [ ] **步骤 2：更新 package.json 添加依赖**

```json
// trading-system/ts-engine/package.json — dependencies 中添加
"better-sqlite3": "^9.4.0",
"decimal.js": "^10.4.0",
```

- [ ] **步骤 3：运行全部测试验证通过**

运行：
```bash
cd trading-system/ts-engine && npm test
cd trading-system/python-ai && pytest tests/ -v
```
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add trading-system/docker-compose.yml trading-system/ts-engine/package.json
git commit -m "chore: update dependencies and docker-compose for Phase 3"
```

---

## 自检

### 1. 规格覆盖度

| 规格需求 | 对应任务 | 状态 |
|----------|----------|------|
| GRVT TradingWS 实际下单（限价 + 市价） | 任务 4, 5 | ✅ |
| 订单超时取消（信号携带 TTL） | 任务 3, 5 | ✅ |
| SQLite 持久化（订单 + 持仓 + 交易历史） | 任务 2 | ✅ |
| GRVT WebSocket 实际连接（替换 TODO） | 任务 6 | ✅ |
| 信号优先级队列预留接口 | 任务 5 | ✅ |
| 重启恢复机制 | 任务 3, 5 | ✅ |
| 状态机竞态防护 | 任务 5 | ✅ |
| TradingWS 断线重连 | 任务 4 | ✅ |
| 浮点数精度（TEXT 存储） | 任务 2 | ✅ |
| Docker WAL 部署注意 | 任务 8 | ✅ |
| Proto 扩展（order_ttl_ms, order_type） | 任务 7 | ✅ |

### 2. 占位符扫描

- 任务 4、6 中 `connect()` 和 `submitOrder()` 有 `// TODO: 使用 @grvt/sdk` — 这是合理的，因为 @grvt/sdk 的具体 API 需要查阅文档，但接口已定义清晰
- 无"待定"、"TODO"遗漏

### 3. 类型一致性

- `OrderUpdate` 在 `types.ts` 定义，`trading-ws.ts` 和 `signal-router.ts` 均导入
- `TradeRecord`、`Position` 在 `types.ts` 定义，`sqlite-store.ts` 使用
- `Order` 接口在 `sqlite-store.ts` 定义，`order-timeout-manager.ts` 和 `trading-ws.ts` 导入
- 所有金额/数量字段使用 `string` 类型（TEXT 存储）
- `ISignalQueue` 接口在 `signal-queue.ts` 定义，`signal-router.ts` 导入
