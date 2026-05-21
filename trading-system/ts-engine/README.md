# TS Engine — TypeScript 交易引擎

VPS 端交易执行引擎，接收 AI 信号 → 风控验证 → 执行 Lighter 订单。

## 架构

```
gRPC (Python AI) → SignalRouter → RiskEngine → DexAdapter → lighter_bridge.py → Lighter DEX
                    ↕               ↕            ↕
                 Dashboard      SQLite       PositionTracker
                 (端口 80)      (trades.db)
```

## 环境变量 (当前值)

| 变量 | 当前值 | 说明 |
|------|--------|------|
| `DEX_PROVIDER` | `lighter` | DEX 适配器 |
| `PAPER_TRADING` | `true` | 模拟盘模式 |
| `GRPC_PORT` | `50051` | gRPC 端口 |
| `DASHBOARD_PORT` | `80` | Dashboard 端口 |
| `MAX_POSITION_SIZE` | `0.003` | 最大仓位 (BTC) |
| `MAX_DAILY_LOSS` | `20` | 日亏限额 $ |
| `MAX_CONCURRENT_SIGNALS` | `2` | 最大并发信号 |
| `MIN_CONFIDENCE` | `60` | 最小置信度 % |
| `SIGNAL_TTL_MS` | `300000` | 信号有效期 5min |
| `CORS_ORIGINS` | `http://localhost:3000` | CORS 来源 |
| `RATE_LIMIT_RPM` | `60` | 限速 |

## 关键模块

| 模块 | 路径 | 职责 |
|------|------|------|
| `SignalRouter` | `src/signal-router.ts` | gRPC 服务 + 信号路由 |
| `RiskEngine` | `src/risk-engine.ts` | 11 项风控检查 + 动态仓位 |
| `LighterAdapter` | `src/dex/lighter.ts` | Lighter DEX 适配器 (Python 桥接) |
| `Dashboard` | `src/dashboard.ts` | HTTP Dashboard |
| `lighter_bridge.py` | `lighter_bridge.py` | Python SDK 桥接进程 |

## Dashboard API

| 路径 | 说明 |
|------|------|
| `/` | 中文 Dashboard 页面 |
| `/api/status` | 系统状态 (uptime/版本/模式) |
| `/api/positions` | 当前持仓 |
| `/api/orders` | 挂单列表 |
| `/api/risk` | 风控详情 |
| `/api/history` | 最近 100 条订单 |
| `/api/signals` | AI 信号历史 |
| `/api/paper-stats` | 模拟盘统计 |
| `/api/sltp` | 止盈止损监控 |
| `/api/events` | SSE 实时推送 |

## 模块说明

### `signal-router.ts` — 核心路由
- gRPC 服务端，接收 Python AI 发来的交易信号
- 信号验证 → 风控检查 → 动态仓位 → SL/TP 决策 → 订单执行
- 信号历史记录（供 Dashboard 展示）

### `risk-engine.ts` — 风控引擎
11 项检查：信号过期 / 置信度 / 日亏 / 价格偏差 / 保证金 / 并发 / 敞口 / 相关性 / 回撤 / 风报比
动态仓位 = min(Kelly公式, 波动率调整值, MAX_POSITION_SIZE)

### `dex/lighter.ts` — Lighter DEX 适配器
通过 Python 子进程桥接 (`lighter_bridge.py`)，JSON 行协议通信
支持：市价/限价/止损/止盈订单，自动重连，断路器

### `dashboard.ts` — HTTP 仪表盘
- 中文 UI，实时 SSE 推送
- REST API：信号/持仓/挂单/交易记录/风控

### `order-manager.ts` — 订单管理
状态机 `pending → submitted → filled/cancelled/rejected`
内存缓存 + SQLite，最大 1000 条

### `position-tracker.ts` — 持仓跟踪
内存映射 + DEX 轮询同步（2 秒间隔）

### `sqlite-store.ts` — 持久化
sql.js 内存写入 + 1 秒 debounce 刷盘
终态订单即时同步，7 天过期清理

### `sltp-monitor.ts` — 止盈止损
价格水平监控 + 追踪止损，bid/ask 精确触发

### `signal-router.ts` — gRPC 信号路由器

- 实现 `SignalService` gRPC 服务
- 信号去重（5 分钟 TTL 窗口）
- 输入参数验证
- 自动清理过期信号 ID
- 正确的 gRPC 错误状态码
- Phase 2 集成：RiskEngine、MarginMonitor、OrderManager、MarketData

```typescript
import { SignalRouter } from './signal-router';
import { loadConfig } from './config';

const config = loadConfig();
const router = new SignalRouter(config);
const server = await router.startServer(50051);

// 处理信号（自动经过风控验证）
const ack = await router.handleSignal({
  signalId: 'uuid-1',
  symbol: 'BTC_USDT_Perp',
  action: 'long',
  stopLoss: 97000,
  takeProfit: 100000,
  confidence: 75,
  positionSize: 0.01,
  timestamp: Date.now(),
  signalPrice: 98500,
  maxSlippageBps: 10,
});
```

### `risk-engine.ts` — 风控引擎

- TTL 校验（信号过期）
- 置信度校验
- 单笔仓位限制
- 滑点保护（价格偏差）
- 保证金联动（warning/critical 状态拒绝）
- 并发信号限制（基于 Shadow Position）
- Shadow Position 内存计数器（跟踪在途订单）

```typescript
import { RiskEngine } from './risk-engine';

const engine = new RiskEngine({
  maxPositionSize: 0.1,
  maxDailyLoss: 500,
  maxConcurrentSignals: 3,
  minConfidence: 60,
  maxPriceDeviationPct: 0.5,
  signalTtlMs: 30000,
  requireMarginOk: true,
});

const result = await engine.check(riskInput);
if (!result.allowed) {
  console.log(`信号被拒绝: ${result.reason}`);
}
```

### `margin-monitor.ts` — 保证金监控

- 监听账户保证金状态
- 自动根据阈值计算状态等级（normal/warning/critical）
- 状态变更回调通知
- 新订单安全检查（可用保证金 + 非 critical 状态）

```typescript
import { MarginMonitor } from './margin-monitor';

const monitor = new MarginMonitor({
  warningThreshold: 0.7,
  criticalThreshold: 0.9,
});

monitor.onStatusChange((status) => {
  console.log(`保证金状态变化: ${status.status}`);
});

monitor.updateStatus({
  totalEquity: 10000,
  availableMargin: 8000,
  usedMargin: 2000,
  marginRatio: 0.2,
  updatedAt: Date.now(),
});
```

### `order-manager.ts` — 订单管理器

- 订单状态机：`pending → submitted → partially_filled → filled/cancelled/rejected`
- 部分成交支持（`remainingSize` 动态更新）
- 订单查询（按 clientOrderId、开放订单、全部订单）

```typescript
import { OrderManager } from './order-manager';

const manager = new OrderManager();

const order = manager.createOrder({
  signalId: 'sig-1',
  symbol: 'BTC_USDT_Perp',
  side: 'buy',
  size: 0.01,
  limitPrice: 98500,
});

manager.updatePartialFill(order.clientOrderId, 0.005);
console.log(order.remainingSize); // 0.005
```

### `market-data.ts` — GRVT 行情 WebSocket

- 连接 GRVT Market Data WebSocket（使用 @grvt/sdk）
- 订阅 `ticker.s` 流接收实时价格
- 写入 Redis Streams（供 Python AI 消费）
- 内存价格缓存（供 SignalRouter 滑点校验，0ms 延迟）

```typescript
import { MarketDataStream } from './market-data';
import Redis from 'ioredis';

const stream = new MarketDataStream(
  { wsUrl: config.grvtMarketDataWsUrl, apiKey: config.grvtApiKey },
  new Redis(config.redisUrl),
  ['BTC_USDT_Perp', 'ETH_USDT_Perp'],
);

await stream.connect();

// 获取实时价格（内存读取，0ms 延迟）
const price = stream.getLatestPriceInMemory('BTC_USDT_Perp');
```

### `index.ts` — 入口文件

- 加载配置
- 初始化 SignalRouter（含所有依赖模块）
- 启动 gRPC 服务器
- 处理 SIGTERM/SIGINT 优雅关闭

## Docker 部署

```bash
# 构建镜像
docker build -t ts-engine .

# 运行容器
docker run -p 50051:50051 \
  -e GRVT_API_KEY=your-key \
  -e GRVT_ENV=testnet \
  -e TAILSCALE_AI_IP=100.x.x.x \
  ts-engine
```

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                      TS Engine                               │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  gRPC Server │→│  信号去重     │→│  输入验证         │   │
│  │ (signal-     │  │ (5min TTL)   │  │ (action,conf,    │   │
│  │  router)     │  │              │  │  position_size)  │   │
│  └──────────────┘  └──────────────┘  └────────┬─────────┘   │
│                                                │             │
│                                    ┌───────────▼─────────┐   │
│                                    │  滑点校验           │   │
│                                    │  (内存价格 0ms)     │   │
│                                    └───────────┬─────────┘   │
│                                                │             │
│                                    ┌───────────▼─────────┐   │
│                                    │  风控引擎           │   │
│                                    │  - TTL/置信度       │   │
│                                    │  - 仓位/滑点        │   │
│                                    │  - 保证金联动       │   │
│                                    │  - Shadow Position  │   │
│                                    └───────────┬─────────┘   │
│                                                │             │
│                                    ┌───────────▼─────────┐   │
│                                    │  订单管理器         │   │
│                                    │  - 状态机           │   │
│                                    │  - 部分成交         │   │
│                                    └───────────┬─────────┘   │
│                                                │             │
│                                    ┌───────────▼─────────┐   │
│                                    │  GRVT 订单执行       │   │
│                                    │  - 限价/市价        │   │
│                                    │  - TTL 超时取消     │   │
│                                    └─────────────────────┘   │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  行情 WS     │  │  保证金监控   │  │  SQLite 持久化    │   │
│  │  (Redis)     │  │  (预警)      │  │  (订单/持仓)     │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 测试

```bash
# 运行所有测试
npm test

# 运行单个测试文件
npx jest tests/risk-engine.test.ts

# 运行集成测试
cd .. && pytest tests/integration/test_e2e.py -v
```

### 测试覆盖

| 模块 | 测试文件 | 覆盖场景 |
|------|----------|----------|
| `config.ts` | `tests/config.test.ts` | 环境变量加载、缺失校验、类型校验、Phase 2 扩展 |
| `signal-router.ts` | `tests/signal-router.test.ts` | 信号接受、重复拒绝、参数验证、风控集成 |
| `risk-engine.ts` | `tests/risk-engine.test.ts` | TTL、置信度、仓位、滑点、保证金、并发、Shadow Position |
| `margin-monitor.ts` | `tests/margin-monitor.test.ts` | 状态更新、阈值计算、安全检查、回调 |
| `order-manager.ts` | `tests/order-manager.test.ts` | 创建、状态转换、部分成交、开放订单 |
| `market-data.ts` | `tests/market-data.test.ts` | 行情解析、ns→ms 转换、内存缓存 |
| 端到端 | `tests/integration/test_e2e.py` | gRPC 通信、健康检查、错误处理 |

## Phase 3 待实现

- [ ] GRVT TradingWS 实际下单（限价 + 市价）
- [ ] 订单超时取消（信号携带 TTL）
- [ ] SQLite 持久化（订单 + 持仓 + 交易历史）
- [ ] GRVT WebSocket 实际连接（替换 TODO）
- [ ] 信号优先级队列预留接口
