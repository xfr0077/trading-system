# Phase 3 设计规格：订单执行与持久化

> 日期：2026-05-18
> 状态：待用户审查
> 范围：GRVT 实际下单、订单超时取消、SQLite 持久化、WebSocket 实际连接

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                         TS Engine (VPS)                              │
│                                                                       │
│  ┌─────────────────┐    ┌─────────────────┐                          │
│  │ MarketDataWS    │    │ TradingWS       │←── 新增：实际连接 GRVT    │
│  │ (GRVT 行情)      │    │ (GRVT 订单)      │    下单/撤单/状态同步     │
│  │ @grvt/sdk       │    │ @grvt/sdk       │                          │
│  └────────┬────────┘    └────────┬────────┘                          │
│           │                      │                                    │
│           ▼                      ▼                                    │
│  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────────┐  │
│  │ Redis Streams   │    │ OrderManager    │    │ MarginMonitor    │  │
│  │ (行情缓存)       │    │ (订单状态机)     │    │ (保证金监控)      │  │
│  └────────┬────────┘    └────────┬────────┘    └────────┬─────────┘  │
│           │                      │                      │             │
│           │                      ▼                      │             │
│           │             ┌─────────────────┐              │             │
│           │             │ SQLite (WAL)    │←─ 新增：持久化│             │
│           │             │ - orders        │   订单/持仓   │             │
│           │             │ - positions     │   交易历史    │             │
│           │             │ - trade_history │              │             │
│           │             └─────────────────┘              │             │
│           │                      │                       │             │
│           ▼                      ▼                       ▼             │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    SignalRouter (gRPC Server)                   │  │
│  │  1. 接收 AI 信号 → 2. 滑点校验 → 3. 风控验证 → 4. 转换订单     │  │
│  │  5. 提交 GRVT → 6. 设置 TTL 定时器 → 7. 持久化 → 8. 监听回调   │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

### 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 订单超时 | 信号携带 `order_ttl_ms` | AI 最了解信号时效性，不同信号可设不同 TTL |
| 持久化范围 | 订单 + 持仓 + 交易历史 | 风控需要实际持仓，复盘需要完整历史 |
| 订单类型 | 限价单 + 市价单 | 支持挂单和立即成交两种场景 |
| 优先级队列 | 预留 `ISignalQueue` 接口 | 当前不需要，未来可插入实现 |
| 精度处理 | SQLite TEXT + decimal.js | 避免 IEEE 754 浮点精度丢失 |
| 重启恢复 | 启动时对账 + 重新注册 TTL | 防止崩溃/重启后内存 timer 丢失 |
| 状态机保护 | 终态拦截 + 竞态防护 | 防止 filled/cancelled 后被其他状态覆盖 |

### 实盘风险防护

**1. 重启恢复机制**
- 启动时从 SQLite 查询所有 `status IN ('submitted', 'pending', 'partially_filled')` 的订单
- 调用 GRVT REST API 检查这些订单的实际状态（可能在宕机期间已成交）
- 对仍在挂单中的订单，重新计算剩余 TTL（`expiresAt - Date.now()`），重新注册到 `OrderTimeoutManager`
- 对已成交的订单，同步本地 SQLite 持仓和 Shadow Position

**2. 状态机竞态防护**
- `OrderManager.updateStatus()` 中加入终态拦截：如果当前状态已是 `filled`/`cancelled`/`rejected`，拒绝任何后续状态变更
- `cancelOrder` 捕获 GRVT 返回的 400 错误（如"订单已完成，无法取消"），不强制修改本地状态
- TTL 回调执行前检查订单当前状态，如果已是终态则跳过取消

**3. TradingWS 断线重连与补偿**
- 与 MarketDataWS 相同的重连逻辑（指数退避 + 自动重订阅）
- 重连成功后主动调用 GRVT REST API `GET /api/v1/orders?status=open` 拉取未完成订单状态
- 对比本地 SQLite，同步断线期间丢失的 `filled`/`cancelled` 事件

**4. 浮点数精度处理**
- SQLite 中 `size`、`remaining_size`、`limit_price`、`stop_loss`、`take_profit`、`fee`、`price`、`pnl` 全部使用 `TEXT` 类型存储
- TS Engine 内存计算统一使用 `decimal.js`（或 `bignumber.js`）
- GRVT API 交互时使用字符串格式（如 `String(order.limitPrice)`）
- 仅在展示/日志时转换为数字

**5. 优雅停机 (Graceful Shutdown)**
- 监听 `SIGTERM` 和 `SIGINT` 信号
- 停机顺序：
  1. 停止接收新的 gRPC 信号（关闭 gRPC server）
  2. 清理 `OrderTimeoutManager` 中的所有内存定时器
  3. 平滑断开 GRVT WebSocket 连接（TradingWS + MarketDataWS）
  4. 执行 `db.pragma('wal_checkpoint(TRUNCATE)')` 确保 WAL 日志完全写入
  5. 正常关闭 SQLite 连接
- 这样能大大减轻下一次"启动恢复"时的同步压力

**6. 重连拉取状态的并发优化**
- 如果 GRVT API 支持 `GET /api/v1/orders?status=open`，一次性拉取所有活跃订单
- 在内存中与 SQLite 的结果进行 Diff 比对，效率远高于串行 `for...of` 请求
- 如果只能单个查询，使用 `Promise.all` 配合并发限制（如 `p-limit`）进行批量查询

**7. 科学计数法陷阱防护**
- JS 原生的 `String(0.0000001)` 或 `decimal.js` 的 `toString()` 可能输出科学计数法（如 `"1e-7"`）
- GRVT API 只接受普通数字字符串，科学计数法会报错
- 在发送给交易所的映射函数中，统一使用 `decimalObj.toFixed()` 强制禁止科学计数法
- 示例：`new Decimal('0.0000001').toFixed()` → `"0.0000001"`（而非 `"1e-7"`）

**8. WAL 文件膨胀管理**
- 高频交易写入下，`-wal` 文件可能持续膨胀占用磁盘
- `better-sqlite3` 默认会触发自动 Checkpoint，但极端情况下可能滞后
- 在启动阶段显式执行一次 `db.pragma('wal_checkpoint(TRUNCATE)')`
- 可选：添加定时任务（如每天交易清淡时段）定期执行 checkpoint

---

## 2. 模块设计

### 2.1 订单执行模块 (`order-executor.ts`)

**职责：** 通过 GRVT Trading WebSocket 实际提交订单、撤单、监听订单状态回调。

**GRVT 订单格式映射：**
```typescript
// 限价单
{
  is_market: false,
  time_in_force: 'GOOD_TILL_TIME',
  expiration: order.expiresAt,  // TTL 超时时间
  legs: [{
    instrument: order.symbol,
    size: String(order.remainingSize),
    limit_price: String(order.limitPrice),
    is_buying_asset: order.side === 'buy',
  }],
  // ... signature, metadata 等
}

// 市价单
{
  is_market: true,
  time_in_force: 'IMMEDIATE_OR_CANCEL',
  legs: [{
    instrument: order.symbol,
    size: String(order.remainingSize),
    is_buying_asset: order.side === 'buy',
  }],
  // ...
}
```

**核心功能：**
- `submitOrder(order: Order): Promise<string>` — 提交订单到 GRVT，返回交易所订单 ID
- `cancelOrder(exchangeOrderId: string): Promise<void>` — 撤销挂单
- `onOrderUpdate(callback: (update: OrderUpdate) => void): void` — 监听订单状态回调

**订单超时机制：**
```typescript
class OrderTimeoutManager {
  private timers = new Map<string, NodeJS.Timeout>();

  schedule(orderId: string, ttlMs: number, onCancel: () => void): void {
    const timer = setTimeout(async () => {
      // 竞态防护：执行前检查订单是否已是终态
      const order = this.orderManager.getOrder(orderId);
      if (order && ['filled', 'cancelled', 'rejected'].includes(order.status)) {
        this.timers.delete(orderId);
        return;
      }
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

  // 重启恢复：从 SQLite 恢复未完成订单的定时器
  async restoreFromDatabase(orders: Order[]): Promise<void> {
    for (const order of orders) {
      if (order.expiresAt && order.status === 'submitted') {
        const remainingMs = order.expiresAt - Date.now();
        if (remainingMs > 0) {
          this.schedule(order.clientOrderId, remainingMs, async () => {
            await this.orderExecutor.cancelOrder(order.orderId);
            // ... 状态更新逻辑
          });
        }
      }
    }
  }
}
```

**测试场景：**
- 限价单提交成功
- 市价单提交成功
- 订单超时自动取消
- 订单状态回调（filled/cancelled/rejected）
- 撤单成功/失败

---

### 2.2 SQLite 持久化模块 (`sqlite-store.ts`)

**职责：** 订单、持仓、交易历史的持久化存储和查询。

**数据库表结构：**
```sql
-- 订单表（金额/数量字段使用 TEXT 避免浮点精度丢失）
CREATE TABLE orders (
  client_order_id TEXT PRIMARY KEY,
  order_id TEXT,              -- 交易所订单 ID
  signal_id TEXT,
  symbol TEXT,
  side TEXT,                  -- 'buy' | 'sell'
  size TEXT,                  -- 字符串格式，如 "0.01"
  remaining_size TEXT,
  limit_price TEXT,
  stop_loss TEXT,
  take_profit TEXT,
  status TEXT,                -- pending/submitted/filled/cancelled/rejected/partially_filled
  order_type TEXT,            -- 'limit' | 'market'
  fee TEXT DEFAULT '0',
  created_at INTEGER,
  updated_at INTEGER,
  expires_at INTEGER          -- TTL 超时时间
);

-- 持仓表
CREATE TABLE positions (
  symbol TEXT PRIMARY KEY,
  side TEXT,                  -- 'long' | 'short'
  size TEXT,
  entry_price TEXT,
  unrealized_pnl TEXT DEFAULT '0',
  realized_pnl TEXT DEFAULT '0',
  updated_at INTEGER
);

-- 交易历史表
CREATE TABLE trade_history (
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
```

**核心功能：**
- `saveOrder(order: Order): Promise<void>` — 保存/更新订单
- `getOrder(clientOrderId: string): Promise<Order | null>` — 查询订单
- `getOpenOrders(): Promise<Order[]>` — 查询未完结订单
- `getPosition(symbol: string): Promise<Position | null>` — 查询持仓
- `getAllPositions(): Promise<Position[]>` — 查询所有持仓
- `updatePosition(symbol: string, delta: number, price: number): Promise<void>` — 更新持仓
- `addTradeHistory(trade: TradeRecord): Promise<void>` — 添加交易记录
- `getTradeHistory(symbol?: string, limit?: number): Promise<TradeRecord[]>` — 查询交易历史

**busy_timeout 配置：**
```typescript
import Database from 'better-sqlite3';

const db = new Database(config.sqlitePath, {
  timeout: 5000,  // 5 秒 busy_timeout
});
db.pragma('journal_mode = WAL');

// Docker 部署注意：确保 sqlitePath 所在目录挂载为 Volume
// WAL 模式会生成 -wal 和 -shm 伴随文件，需确保权限正确
```

**测试场景：**
- 订单 CRUD 操作
- 持仓更新（加仓/减仓/清仓）
- 交易历史查询
- 并发写入（busy_timeout 生效）
- 数据库重启后数据恢复

---

### 2.3 SignalRouter 集成订单执行

**修改内容：**
1. 注入 `OrderExecutor` 和 `SqliteStore`
2. `handleSignal` 中调用 `orderExecutor.submitOrder()`
3. 设置订单超时定时器
4. 订单状态回调中更新 SQLite 和 Shadow Position
5. 预留 `ISignalQueue` 接口

```typescript
interface ISignalQueue {
  enqueue(signal: SignalInput): Promise<SignalInput>;
  size(): number;
}

class DefaultSignalQueue implements ISignalQueue {
  async enqueue(signal: SignalInput): Promise<SignalInput> {
    return signal;  // 直接返回，不排队
  }
  size(): number { return 0; }
}

// SignalRouter 中
private signalQueue: ISignalQueue = new DefaultSignalQueue();
private orderExecutor: OrderExecutor;
private sqliteStore: SqliteStore;
private timeoutManager: OrderTimeoutManager;

// 启动时恢复未完成订单的定时器
async initialize(): Promise<void> {
  const openOrders = await this.sqliteStore.getOpenOrders();
  await this.timeoutManager.restoreFromDatabase(openOrders);
  console.log(`[SignalRouter] Restored ${openOrders.length} pending orders from database`);
}

async handleSignal(signal: SignalInput): Promise<{ accepted: boolean; reason: string }> {
  // ... 现有验证和风控逻辑 ...

  // 通过队列（默认直接通过）
  const processedSignal = await this.signalQueue.enqueue(signal);

  // 创建订单
  const order = this.orderManager.createOrder({
    signalId: processedSignal.signalId,
    symbol: processedSignal.symbol,
    side: processedSignal.action === 'long' ? 'buy' : 'sell',
    size: processedSignal.positionSize,
    limitPrice: processedSignal.signalPrice,
    orderType: processedSignal.orderType || 'limit',
    ttlMs: processedSignal.orderTtlMs || 300000,  // 默认 5 分钟
  });

  // 提交到 GRVT
  const exchangeOrderId = await this.orderExecutor.submitOrder(order);
  this.orderManager.updateStatus(order.clientOrderId, 'submitted', exchangeOrderId);

  // 设置超时定时器
  this.timeoutManager.schedule(
    order.clientOrderId,
    order.ttlMs,
    async () => {
      await this.orderExecutor.cancelOrder(exchangeOrderId);
      this.orderManager.updateStatus(order.clientOrderId, 'cancelled');
      this.riskEngine.updateShadowPosition(order.symbol, -order.remainingSize);
    }
  );

  // 持久化
  await this.sqliteStore.saveOrder(order);
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

  this.orderManager.updateStatus(order.clientOrderId, update.status, update.orderId, update.fee);

  // 更新 Shadow Position
  if (update.status === 'filled') {
    this.riskEngine.updateShadowPosition(order.symbol, -order.remainingSize);
    // 更新持仓
    this.sqliteStore.updatePosition(order.symbol, order.size, order.limitPrice);
    // 记录交易历史
    this.sqliteStore.addTradeHistory({ ... });
  } else if (update.status === 'cancelled' || update.status === 'rejected') {
    this.riskEngine.updateShadowPosition(order.symbol, -order.remainingSize);
    this.timeoutManager.cancel(order.clientOrderId);
  }

  // 持久化
  this.sqliteStore.saveOrder(order);
}
```

---

### 2.4 MarketDataWS 实际连接

**修改内容：**
1. 使用 `@grvt/sdk` 的 `GrvtWsClient` 实际连接 GRVT Market Data WebSocket
2. 订阅 `ticker.s` 流
3. 断线重连后自动重新订阅

```typescript
import { GrvtWsClient, EStreamEndpoints } from '@grvt/sdk';

async connect(): Promise<void> {
  this.client = new GrvtWsClient({
    wsUrl: this.config.wsUrl,
    apiKey: this.config.apiKey,
  });

  await this.client.connect();

  // 订阅 ticker.s
  for (const symbol of this.symbols) {
    this.client.subscribeTicker(symbol, (data) => {
      this.handleTickerData(data);
    });
  }

  // 监听断线重连
  this.client.onReconnect(() => {
    console.log('[MarketData] Reconnected, resubscribing...');
    for (const symbol of this.symbols) {
      this.client.subscribeTicker(symbol, (data) => {
        this.handleTickerData(data);
      });
    }
  });
}
```

---

### 2.5 TradingWS 实际连接

**职责：** 连接 GRVT Trading WebSocket，提交订单、撤单、监听账户状态。

**断线重连与补偿：**
```typescript
import { GrvtWsClient } from '@grvt/sdk';

class TradingWebSocket {
  private client: GrvtWsClient;
  private orderCallbacks: Array<(update: OrderUpdate) => void> = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  async connect(config: GrvtConfig): Promise<void> {
    this.client = new GrvtWsClient({
      wsUrl: config.tradingWsUrl,
      apiKey: config.apiKey,
    });

    await this.client.connect();
    this.reconnectAttempts = 0;

    // 监听订单状态更新
    this.client.subscribeOrderUpdates((order) => {
      const update: OrderUpdate = {
        clientOrderId: order.client_order_id,
        orderId: order.order_id,
        status: this.mapGrvtStatus(order.status),
        fee: order.fee || '0',
      };
      for (const cb of this.orderCallbacks) {
        cb(update);
      }
    });

    // 监听账户状态
    this.client.subscribeAccount((account) => {
      this.marginMonitor.updateStatus({
        totalEquity: account.total_equity,
        availableMargin: account.available_margin,
        usedMargin: account.used_margin,
        marginRatio: account.margin_ratio,
        status: this.computeMarginStatus(account.margin_ratio),
        updatedAt: Date.now(),
      });
    });

    // 监听断线重连
    this.client.onDisconnect(() => {
      console.log('[TradingWS] Disconnected, attempting reconnect...');
      this.scheduleReconnect(config);
    });
  }

  private scheduleReconnect(config: GrvtConfig): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[TradingWS] Max reconnect attempts reached');
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    setTimeout(async () => {
      try {
        await this.connect(config);
        // 重连成功后主动拉取未完成订单状态
        await this.syncPendingOrders();
      } catch (err) {
        this.scheduleReconnect(config);
      }
    }, delay);
  }

  // 重连后同步未完成订单状态
  private async syncPendingOrders(): Promise<void> {
    const openOrders = await this.sqliteStore.getOpenOrders();
    for (const order of openOrders) {
      const remoteStatus = await this.fetchOrderStatus(order.orderId);
      if (remoteStatus && remoteStatus !== order.status) {
        // 同步本地状态
        this.handleOrderUpdate({
          clientOrderId: order.clientOrderId,
          orderId: order.orderId,
          status: remoteStatus,
          fee: remoteStatus.fee || '0',
        });
      }
    }
  }

  async submitOrder(order: Order): Promise<string> {
    const grvtOrder = this.buildGrvtOrder(order);
    const response = await this.client.createOrder(grvtOrder);
    return response.order_id;
  }

  async cancelOrder(exchangeOrderId: string): Promise<void> {
    try {
      await this.client.cancelOrder(exchangeOrderId);
    } catch (err: any) {
      // 竞态防护：如果订单已完成（400 错误），不强制修改本地状态
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
}
```

---

## 3. 数据流（完整）

```
1. MarketDataWS 连接 GRVT → 接收行情 → 写入 Redis Streams + 内存缓存
2. Python AI 消费 Redis → FeatureEngine → ModelInference → 生成信号（含 order_ttl_ms）
3. SignalClient 通过 gRPC 发送信号到 TS Engine
4. SignalRouter 接收信号：
   a. 滑点校验：对比内存实时价格
   b. TTL 校验：信号时间戳过期 → 拒绝
   c. RiskEngine 验证（含 SQLite 实际持仓 + Shadow Position + 保证金联动）
   d. 验证通过 → OrderManager 创建订单
   e. OrderExecutor 提交到 GRVT TradingWS
   f. 设置 TTL 定时器（超时自动撤单）
   g. 持久化到 SQLite
5. 订单状态回调 → 更新 OrderManager → 更新 Shadow Position → 更新 SQLite 持仓/历史
6. 订单超时 → 自动撤单 → 更新状态 → 清理 Shadow Position
7. MarginMonitor 持续监听账户状态 → 更新保证金状态
```

---

## 4. 环境变量（新增）

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `GRVT_TRADING_WS_URL` | - | `wss://trades.dev.gravitymarkets.io/ws` | GRVT 交易 WebSocket 端点 |
| `GRVT_SUB_ACCOUNT_ID` | ✅ | - | GRVT 子账户 ID |
| `DEFAULT_ORDER_TTL_MS` | - | `300000` | 默认订单超时（5 分钟） |

---

## 5. 文件结构（Phase 3 新增/修改）

```
trading-system/
├── ts-engine/
│   ├── src/
│   │   ├── order-executor.ts       # [新增] GRVT 订单执行 + 超时管理
│   │   ├── sqlite-store.ts         # [新增] SQLite 持久化
│   │   ├── trading-ws.ts           # [新增] GRVT Trading WebSocket
│   │   ├── market-data.ts          # [修改] 实际连接 GRVT WebSocket
│   │   ├── signal-router.ts        # [修改] 集成订单执行、持久化、队列接口
│   │   ├── config.ts               # [修改] 新增 Phase 3 环境变量
│   │   └── types.ts                # [修改] 新增 OrderUpdate、TradeRecord 等
│   ├── tests/
│   │   ├── order-executor.test.ts  # [新增]
│   │   ├── sqlite-store.test.ts    # [新增]
│   │   └── trading-ws.test.ts      # [新增]
│   └── package.json                # [修改] 添加 better-sqlite3 类型
├── python-ai/
│   ├── src/
│   │   ├── signal_client.py        # [修改] 新增 order_ttl_ms 字段
│   └── proto/
│       └── signal.proto            # [修改] 新增 order_ttl_ms 字段
└── docker-compose.yml              # [修改] 确保 /data 挂载为命名 Volume
```

---

## 6. 测试策略

### 单元测试

| 模块 | 测试文件 | 场景数 |
|------|----------|--------|
| OrderExecutor | `order-executor.test.ts` | 6 |
| SqliteStore | `sqlite-store.test.ts` | 8 |
| TradingWS | `trading-ws.test.ts` | 5 |
| SignalRouter 集成 | `signal-router.test.ts`（扩展） | 5 |

### 集成测试

- 端到端：信号 → 风控 → 下单 → 状态回调 → 持久化
- 订单超时：挂单超时自动取消
- 数据库重启：恢复未完成订单状态

---

## 7. Phase 3 范围确认

**包含：**
- [x] GRVT TradingWS 实际下单（限价 + 市价）
- [x] 订单超时取消（信号携带 TTL）
- [x] SQLite 持久化（订单 + 持仓 + 交易历史）
- [x] GRVT WebSocket 实际连接（替换 TODO）
- [x] 信号优先级队列预留接口

**不包含（Phase 4+）：**
- 撤单重发逻辑
- 订单拆分
- 信号优先级队列完整实现
- 投资组合风险敞口
- 相关性风险
- 动态仓位调整
- 最大回撤熔断
