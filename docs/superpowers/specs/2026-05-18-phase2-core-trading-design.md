# Phase 2 设计规格：核心交易功能（TS Engine 端）

> 日期：2026-05-18
> 状态：待用户审查
> 范围：GRVT 行情接收、订单管理器、风控引擎、保证金监控、Python AI 特征工程与推理

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                         TS Engine (VPS)                              │
│                                                                       │
│  ┌─────────────────┐    ┌─────────────────┐                          │
│  │ MarketDataWS    │    │ TradingWS       │                          │
│  │ (GRVT 行情)      │    │ (GRVT 订单)      │                          │
│  │ @grvt/sdk       │    │ @grvt/sdk       │                          │
│  └────────┬────────┘    └────────┬────────┘                          │
│           │                      │                                    │
│           ▼                      ▼                                    │
│  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────────┐  │
│  │ Redis Streams   │    │ OrderManager    │    │ MarginMonitor    │  │
│  │ (行情缓存)       │    │ (订单状态机)     │    │ (保证金监控)      │  │
│  └────────┬────────┘    └────────┬────────┘    └────────┬─────────┘  │
│           │                      │                      │             │
│           │                      │                      │             │
│           ▼                      ▼                      ▼             │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    SignalRouter (gRPC Server)                   │  │
│  │  1. 接收 AI 信号 → 2. 滑点校验 → 3. 风控验证 → 4. 转换订单     │  │
│  │  5. 发送 GRVT → 6. 等待回调 → 7. 记录结果                      │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
                              │ Tailscale gRPC
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Python AI Service (Local PC)                      │
│                                                                       │
│  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────────┐ │
│  │ Redis Reader    │→   │ FeatureEngine   │→   │ ModelInference   │ │
│  │ (消费 Redis     │    │ (技术指标计算)   │    │ (ONNX CPU 推理)  │ │
│  │  Streams 行情)   │    │ MA/RSI/MACD     │    │ 置信度输出       │ │
│  └─────────────────┘    └─────────────────┘    └────────┬─────────┘ │
│                                                         │            │
│                                              ┌──────────▼──────────┐│
│                                              │  SignalClient       ││
│                                              │  (gRPC 发送信号)     ││
│                                              └─────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

### 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 行情数据源 | TS Engine 订阅 GRVT WS → 写入 Redis → Python AI 消费 Redis | 单一事实来源，避免数据不一致 |
| 风控持仓计算 | SQLite 实际持仓 + 内存 Shadow Position | 防止在途订单导致的风控漏洞 |
| 保证金联动 | Margin Monitor 状态直接接入 Risk Engine | 本地拦截保证金不足信号，避免浪费 API 限频 |
| 订单重连同步 | WS 重连后调用 GRVT REST API 对齐订单状态 | 防止断线期间订单状态丢失 |
| 信号延迟保护 | TTL + 实时价格滑点校验 | 覆盖 95% 延迟场景 |
| gRPC 保活 | 服务端 + 客户端双向 keepalive | Tailscale 虚拟网卡断网快速感知 |

### gRPC 服务端保活配置

由于 Python AI 通过 Tailscale 虚拟网卡连接 TS Engine，网络断连时 TCP 层可能无法及时感知。配置双向 keepalive：

```typescript
// SignalRouter 服务端选项
const serverOptions = {
  'grpc.keepalive_time_ms': 10000,       // 每 10 秒发送 keepalive
  'grpc.keepalive_timeout_ms': 5000,     // 5 秒无响应判定断连
  'grpc.keepalive_permit_without_calls': 1,
  'grpc.http2.max_pings_without_data': 0,
};
```

断连检测时间：~15 秒（10s 间隔 + 5s 超时），远快于 TCP 默认 keepalive（2 小时）。
| gRPC 保活 | 服务端 + 客户端双向 keepalive | Tailscale 虚拟网卡断网快速感知 |

---

## 2. 模块设计

### 2.1 Market Data 模块 (`market-data.ts`)

**职责：** 连接 GRVT Market Data WebSocket，接收实时行情，写入 Redis Streams。

**WebSocket 连接：**
- 端点：`GRVT_MARKET_DATA_WS_URL`（环境变量，默认 `wss://market-data.dev.gravitymarkets.io/ws`）
- 认证：使用 `@grvt/sdk` 的 `GrvtWsClient`，API Key + Cookie 认证
- 订阅流：`ticker.s`（mini ticker snapshot），支持多标的
- 断线重连：SDK 内置自动重连（指数退避），重连后自动重新订阅

**数据写入 Redis Streams：**
- Key 格式：`market:{symbol}`（如 `market:BTC_USDT_Perp`）
- 每条消息包含：`symbol`, `lastPrice`, `bidPrice`, `askPrice`, `volume24h`, `timestamp`
- 使用 `XADD` 命令，最大长度 10000（`MAXLEN ~ 10000`）

```typescript
interface MarketData {
  symbol: string;
  lastPrice: number;
  bidPrice: number;
  askPrice: number;
  volume24h: number;
  timestamp: number;  // Unix 毫秒
}

class MarketDataStream {
  constructor(config: GrvtConfig, redis: Redis, symbols: string[]);
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getLatestPrice(symbol: string): Promise<MarketData | null>;
}
```

**测试场景：**
- 正常接收行情数据并写入 Redis
- 断线后自动重连并重新订阅
- Redis 写入失败时的错误处理
- 多标的并发订阅

---

### 2.2 Order Manager 模块 (`order-manager.ts`)

**职责：** 将 AI 信号转换为 GRVT 订单，管理订单生命周期，监听状态回调。

**订单状态机：**
```
pending → submitted → filled
              ↓           ↓
         cancelled    rejected
              ↓
         partially_filled → filled/cancelled
```

**订单数据结构：**
```typescript
interface Order {
  orderId: string;         // 交易所返回的 ID（submitted 后获取）
  clientOrderId: string;   // 本地生成的唯一 ID（UUID）
  signalId: string;        // 关联的 AI 信号 ID
  symbol: string;
  side: 'buy' | 'sell';
  size: number;            // 原始订单总量
  remainingSize: number;   // 未成交量（部分成交时更新）
  limitPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  status: 'pending' | 'submitted' | 'filled' | 'cancelled' | 'rejected' | 'partially_filled';
  fee: number;             // 手续费（成交后更新）
  createdAt: number;       // Unix 毫秒
  updatedAt: number;       // Unix 毫秒
}
```

**核心功能：**
- `createOrder(signal: TradingSignal): Promise<Order>` — 创建并提交订单
- `updateOrderStatus(orderId: string, status: OrderStatus): void` — 更新订单状态（来自 WS 回调）
- `getOpenOrders(): Order[]` — 获取未完结订单
- `syncWithExchange(): Promise<void>` — WS 重连后调用 GRVT REST API 对齐订单状态

**Startup/Reconnection Sync 机制：**
1. WS 连接成功后，调用 `GET /api/v1/orders?status=open` 获取交易所未完结订单
2. 与本地 SQLite 中 `status IN ('pending', 'submitted', 'partially_filled')` 的订单比对
3. 本地有但交易所没有的 → 标记为 `cancelled`（可能已过期或被取消）
4. 交易所有但本地没有的 → 插入本地数据库（可能是外部操作或断线期间丢失）
5. 状态不一致的 → 以交易所为准更新本地

**订单记录持久化：**
- SQLite WAL 模式，表 `orders`
- 每次状态变更写入数据库

**测试场景：**
- 正常创建订单并等待成交
- 订单被拒绝/取消
- 部分成交后完全成交
- WS 重连后状态同步
- 并发创建多个订单

---

### 2.3 Risk Engine 模块 (`risk-engine.ts`)

**职责：** 在 AI 信号到达后、订单提交前进行风控验证。

**风控规则（可配置）：**

| 规则 | 配置项 | 默认值 | 说明 |
|------|--------|--------|------|
| 单笔最大仓位 | `maxPositionSize` | 0.1 BTC | 单笔订单最大仓位 |
| 每日最大亏损 | `maxDailyLoss` | 500 USDT | 当日累计亏损上限 |
| 并发信号限制 | `maxConcurrentSignals` | 3 | 同一标的最大并发持仓 |
| 最低置信度 | `minConfidence` | 60.0 | 信号置信度低于此值拒绝 |
| 保证金联动 | `requireMarginOk` | true | 保证金率低于预警线时拒绝开仓 |
| 滑点保护 | `maxPriceDeviationPct` | 0.5% | 信号价格与实时价格偏差超过此值拒绝 |
| 信号 TTL | `signalTtlMs` | 30000 | 信号超过 30 秒未处理则拒绝 |

**持仓计算逻辑：**
```
总风险仓位 = SQLite 实际持仓 + 内存中在途订单总量（Shadow Position）
```

Shadow Position 更新时机：
- 订单进入 `submitted` → 增加对应仓位（delta = order.size）
- 订单 `partially_filled` → 按已成交量扣减（delta = -(order.size - order.remainingSize)）
- 订单 `filled` / `rejected` / `cancelled` → 扣减剩余在途仓位（delta = -order.remainingSize）

> **关键：** `partially_filled` 时立即按实际成交量调整 Shadow Position，避免与实际持仓重复计算。

**保证金联动：**
- 从 `MarginMonitor` 获取当前保证金状态
- 如果 `marginStatus === 'warning'` 或 `availableMargin < requiredMargin` → 拒绝

**滑点保护：**
```
|signal_price - current_price| / current_price > maxPriceDeviationPct → 拒绝
```

**输入/输出：**
```typescript
interface RiskCheckInput {
  signal: TradingSignal;
  currentPrice: number;        // 从 Redis 获取的实时价格
  currentPositions: Position[]; // 从 SQLite 查询的实际持仓
  shadowPositions: Map<string, number>; // 内存中在途仓位
  marginStatus: MarginStatus;   // 当前保证金状态
}

interface RiskCheckResult {
  allowed: boolean;
  reason: string;  // 拒绝原因（如 'POSITION_SIZE_EXCEEDED', 'PRICE_DEVIATION_EXCEEDED'）
}

class RiskEngine {
  constructor(config: RiskConfig);
  check(input: RiskCheckInput): Promise<RiskCheckResult>;
  updateShadowPosition(symbol: string, delta: number): void;
}
```

**测试场景：**
- 正常信号通过所有风控规则
- 单笔仓位超限 → 拒绝
- 每日亏损超限 → 拒绝
- 并发信号超限 → 拒绝
- 置信度过低 → 拒绝
- 保证金不足 → 拒绝
- 价格偏差超限 → 拒绝
- 信号过期 → 拒绝
- Shadow Position 正确累加和扣减

---

### 2.4 Margin Monitor 模块 (`margin-monitor.ts`)

**职责：** 监听账户保证金状态，提供实时保证金率查询和预警。

**数据来源：**
- GRVT Trading WebSocket 的账户状态流（`account` 流）
- 启动时调用 REST API `GET /api/v1/account` 获取初始状态

**保证金状态：**
```typescript
interface MarginStatus {
  totalEquity: number;        // 总权益（USDT）
  availableMargin: number;    // 可用保证金
  usedMargin: number;         // 已用保证金
  marginRatio: number;        // 保证金率（usedMargin / totalEquity）
  status: 'normal' | 'warning' | 'critical';
  updatedAt: number;          // Unix 毫秒
}
```

**预警阈值（可配置）：**
- `warningThreshold`：默认 0.7（保证金率 70% 触发预警）
- `criticalThreshold`：默认 0.9（保证金率 90% 触发强平预警）

**核心功能：**
- `getStatus(): MarginStatus` — 获取当前保证金状态
- `onStatusChange(callback: (status: MarginStatus) => void): void` — 状态变化回调
- `isSafeForNewOrder(requiredMargin: number): boolean` — 判断是否足够开新仓

**测试场景：**
- 正常接收账户状态更新
- 保证金率达到预警阈值 → 触发预警
- 保证金率达到强平阈值 → 触发强平预警
- 可用保证金不足 → `isSafeForNewOrder` 返回 false

---

### 2.5 Python AI 端补充

#### 2.5.1 配置管理 (`config.py`)

```python
from pydantic import BaseModel, Field

class AIConfig(BaseModel):
    ts_engine_grpc_url: str = Field(default="localhost:50051")
    redis_url: str = Field(default="redis://localhost:6379")
    model_path: str = Field(default="models/model.onnx")
    feature_window: int = Field(default=100)
    confidence_threshold: float = Field(default=70.0)
    symbols: list[str] = Field(default=["BTC_USDT_Perp"])
```

#### 2.5.2 Redis 行情消费者 (`redis_reader.py`)

- 消费 Redis Streams `market:{symbol}`
- 使用 `XREAD` 阻塞读取（`BLOCK 5000`）
- **断线重连策略（跳尾机制）：**
  1. `XREAD` 读取到数据后，检查最新一条消息的时间戳
  2. 如果 `now() - latest_message.timestamp > 1000ms`，说明积压严重（刚从断线恢复）
  3. 放弃当前批数据，将 `XREAD` 的起始 ID 强制重置为 `$`（跳到流尾部）
  4. 如果积压 < 1 秒，正常消费这批数据
- 将行情数据转换为特征工程输入格式

```python
class RedisMarketReader:
    _BACKLOG_THRESHOLD_MS = 1000  # 积压阈值：超过 1 秒则跳尾

    def __init__(self, redis_url: str, symbols: list[str]):
        ...
    
    async def stream(self) -> AsyncIterator[MarketData]:
        """持续产出行情数据。断线重连后自动检测积压程度，
        超过阈值则跳到流尾部（$），确保 AI 只基于最新行情推理。"""
        ...
```

> **设计理由：** Tailscale 跨地域连接可能抖动。小断线（<1s）正常消费无影响；大断线（>1s）如果追赶消费旧行情，AI 会对过期数据产生信号，浪费 CPU 算力并增加 gRPC 通信延迟。跳尾机制确保 AI 始终基于最新行情做决策。

#### 2.5.3 特征工程 (`feature_engine.py`)

- 技术指标计算：
  - 移动平均线（MA5, MA10, MA20）
  - RSI（14 周期）
  - MACD（12, 26, 9）
  - 布林带（20, 2）
  - 成交量变化率
- 特征标准化（Z-Score，基于滚动窗口统计量）
- 输出固定长度的特征向量

```python
class FeatureEngine:
    def __init__(self, window_size: int = 100):
        ...
    
    def compute(self, prices: list[MarketData]) -> np.ndarray:
        """返回 shape=(1, n_features) 的特征向量"""
        ...
```

#### 2.5.4 ONNX 模型推理 (`model_inference.py`)

- CPU 模型加载（`onnxruntime.InferenceSession`）
- 输入：特征向量（来自 FeatureEngine）
- 输出：预测结果 + 置信度
- 置信度过滤（低于 `confidence_threshold` 不生成信号）

```python
class ModelInference:
    def __init__(self, model_path: str):
        self.session = onnxruntime.InferenceSession(model_path, providers=['CPUExecutionProvider'])
    
    def predict(self, features: np.ndarray) -> tuple[str, float]:
        """返回 (action, confidence)"""
        ...
```

#### 2.5.5 主循环 (`main.py`)

```
while True:
    1. 从 Redis 读取最新行情
    2. FeatureEngine 计算特征
    3. ModelInference 推理
    4. 置信度 >= threshold → 生成信号
    5. SignalClient 发送到 TS Engine
    6. 等待下一轮
```

**测试场景：**
- `test_feature_engine.py` — 技术指标计算正确性、特征向量 shape 验证
- `test_model_inference.py` — ONNX 模型加载、推理输出格式
- `test_redis_reader.py` — Redis Streams 消费、断线重连

---

## 3. 数据流（完整）

```
1. MarketDataWS 接收 GRVT 行情 → 写入 Redis Streams
2. Python AI 消费 Redis Streams → FeatureEngine → ModelInference → 生成信号
3. SignalClient 通过 gRPC 发送信号到 TS Engine
4. SignalRouter 接收信号：
   a. 滑点校验：对比 Redis 实时价格，偏差超限 → 拒绝
   b. TTL 校验：信号时间戳过期 → 拒绝
   c. RiskEngine 验证：
      - 单笔仓位限制
      - 每日亏损限制
      - 并发信号限制
      - 置信度阈值
      - 保证金联动检查
   d. 验证通过 → OrderManager 创建订单
5. OrderManager 提交订单到 GRVT TradingWS
6. 订单状态回调 → 更新 Shadow Position → 写入 SQLite
7. MarginMonitor 持续监听账户状态 → 更新保证金状态
```

---

## 4. 环境变量（新增）

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `GRVT_MARKET_DATA_WS_URL` | - | `wss://market-data.dev.gravitymarkets.io/ws` | GRVT 行情 WebSocket 端点 |
| `GRVT_TRADING_WS_URL` | - | `wss://trades.dev.gravitymarkets.io/ws` | GRVT 交易 WebSocket 端点 |
| `GRVT_REST_API_URL` | - | `https://api.dev.gravitymarkets.io` | GRVT REST API 端点 |
| `REDIS_URL` | - | `redis://localhost:6379` | Redis 连接字符串 |
| `MAX_POSITION_SIZE` | - | `0.1` | 单笔最大仓位（BTC 等） |
| `MAX_DAILY_LOSS` | - | `500` | 每日最大亏损（USDT） |
| `MAX_CONCURRENT_SIGNALS` | - | `3` | 同一标的最大并发持仓 |
| `MIN_CONFIDENCE` | - | `60.0` | 最低置信度阈值 |
| `MAX_PRICE_DEVIATION_PCT` | - | `0.5` | 最大价格偏差百分比 |
| `SIGNAL_TTL_MS` | - | `30000` | 信号有效期（毫秒） |
| `MARGIN_WARNING_THRESHOLD` | - | `0.7` | 保证金率预警阈值 |
| `MARGIN_CRITICAL_THRESHOLD` | - | `0.9` | 保证金率强平阈值 |

---

## 5. 文件结构（Phase 2 新增/修改）

```
trading-system/
├── ts-engine/
│   ├── src/
│   │   ├── market-data.ts          # [新增] GRVT 行情 WebSocket
│   │   ├── order-manager.ts        # [新增] 订单管理器
│   │   ├── risk-engine.ts          # [新增] 风控引擎
│   │   ├── margin-monitor.ts       # [新增] 保证金监控
│   │   ├── signal-router.ts        # [修改] 集成风控和滑点校验
│   │   └── config.ts               # [修改] 新增 Phase 2 环境变量
│   ├── tests/
│   │   ├── market-data.test.ts     # [新增]
│   │   ├── order-manager.test.ts   # [新增]
│   │   ├── risk-engine.test.ts     # [新增]
│   │   └── margin-monitor.test.ts  # [新增]
│   └── package.json                # [修改] 添加 @grvt/sdk 依赖
├── python-ai/
│   ├── src/
│   │   ├── config.py               # [新增] Pydantic 配置
│   │   ├── redis_reader.py         # [新增] Redis 行情消费者
│   │   ├── feature_engine.py       # [新增] 特征工程
│   │   ├── model_inference.py      # [新增] ONNX 推理
│   │   ├── main.py                 # [新增] AI 服务主循环
│   │   └── signal_client.py        # [已有]
│   ├── tests/
│   │   ├── test_feature_engine.py  # [新增]
│   │   ├── test_model_inference.py # [新增]
│   │   └── test_redis_reader.py    # [新增]
│   └── requirements.txt            # [修改] 添加 grvt-pysdk
└── docker-compose.yml              # [修改] 添加 Redis 端口映射（AI 端访问）
```

---

## 6. 测试策略

### 单元测试

| 模块 | 测试文件 | 场景数 |
|------|----------|--------|
| MarketData | `market-data.test.ts` | 5 |
| OrderManager | `order-manager.test.ts` | 6 |
| RiskEngine | `risk-engine.test.ts` | 9 |
| MarginMonitor | `margin-monitor.test.ts` | 4 |
| FeatureEngine | `test_feature_engine.py` | 4 |
| ModelInference | `test_model_inference.py` | 3 |
| RedisReader | `test_redis_reader.py` | 3 |

### 集成测试

- `test_e2e.py` 扩展：加入行情 → 特征 → 推理 → 信号 → 订单的完整链路
- 使用模拟 GRVT WebSocket 和模拟 ONNX 模型

---

## 7. Phase 2 范围确认

**包含：**
- [x] GRVT Market Data WebSocket 连接 + Redis Streams 写入
- [x] Order Manager（状态机 + 订单创建 + 状态同步）
- [x] Risk Engine（基础风控规则 + Shadow Position + 保证金联动 + 滑点保护）
- [x] Margin Monitor（账户状态监听 + 预警）
- [x] Python AI 配置管理 + Redis 消费者
- [x] Python 特征工程（MA/RSI/MACD/布林带）
- [x] Python ONNX 模型推理（CPU）
- [x] Python AI 主循环

**不包含（Phase 3+）：**
- 投资组合风险敞口计算
- 相关性风险
- 动态仓位调整（Kelly 公式）
- 最大回撤熔断
- 撤单重发逻辑
- 订单拆分
- 信号优先级队列
