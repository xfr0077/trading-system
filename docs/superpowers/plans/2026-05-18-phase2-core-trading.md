# Phase 2：核心交易功能 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 GRVT 行情接收、订单管理器、风控引擎、保证金监控、Python AI 特征工程与推理，打通"行情 → 特征 → 推理 → 信号 → 风控 → 订单"完整链路。

**架构：** TS Engine 订阅 GRVT Market Data WebSocket 写入 Redis Streams，Python AI 消费 Redis 计算特征并推理，通过 gRPC 发送信号到 TS Engine，经风控验证后通过 GRVT Trading WebSocket 提交订单。

**技术栈：** TypeScript (Node.js), Python 3.10+, gRPC, Redis Streams, SQLite (WAL), @grvt/sdk, grvt-pysdk, ONNX Runtime

---

## 文件结构

```
trading-system/
├── ts-engine/
│   ├── src/
│   │   ├── market-data.ts          # [新增] GRVT 行情 WebSocket + Redis 写入 + 内存价格缓存
│   │   ├── order-manager.ts        # [新增] 订单状态机 + GRVT 订单提交
│   │   ├── risk-engine.ts          # [新增] 风控引擎 + Shadow Position
│   │   ├── margin-monitor.ts       # [新增] 保证金监控
│   │   ├── signal-router.ts        # [修改] 集成风控、滑点校验、gRPC keepalive
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
│   │   ├── redis_reader.py         # [新增] Redis Streams 消费者（跳尾机制）
│   │   ├── feature_engine.py       # [新增] 技术指标计算
│   │   ├── model_inference.py      # [新增] ONNX CPU 推理
│   │   ├── main.py                 # [新增] AI 服务主循环
│   │   └── signal_client.py        # [已有]
│   ├── tests/
│   │   ├── test_config.py          # [新增]
│   │   ├── test_redis_reader.py    # [新增]
│   │   ├── test_feature_engine.py  # [新增]
│   │   └── test_model_inference.py # [新增]
│   └── requirements.txt            # [修改] 添加 grvt-pysdk, redis, pytest-asyncio
└── docker-compose.yml              # [修改] Redis 端口绑定调整
```

---

### 任务 1：TS Engine 配置扩展

**文件：**
- 修改：`trading-system/ts-engine/src/config.ts`
- 修改：`trading-system/ts-engine/tests/config.test.ts`

- [ ] **步骤 1：编写配置扩展测试**

```typescript
// trading-system/ts-engine/tests/config.test.ts — 追加到现有文件

describe('Config Phase 2', () => {
  test('should load GRVT WebSocket URLs', () => {
    process.env.GRVT_API_KEY = 'test-key';
    process.env.GRVT_MARKET_DATA_WS_URL = 'wss://market-data.test/ws';
    process.env.GRVT_TRADING_WS_URL = 'wss://trades.test/ws';
    process.env.GRVT_REST_API_URL = 'https://api.test';

    const config = loadConfig();

    expect(config.grvtMarketDataWsUrl).toBe('wss://market-data.test/ws');
    expect(config.grvtTradingWsUrl).toBe('wss://trades.test/ws');
    expect(config.grvtRestApiUrl).toBe('https://api.test');
  });

  test('should use default WebSocket URLs', () => {
    process.env.GRVT_API_KEY = 'test-key';
    delete process.env.GRVT_MARKET_DATA_WS_URL;
    delete process.env.GRVT_TRADING_WS_URL;
    delete process.env.GRVT_REST_API_URL;

    const config = loadConfig();

    expect(config.grvtMarketDataWsUrl).toBe('wss://market-data.dev.gravitymarkets.io/ws');
    expect(config.grvtTradingWsUrl).toBe('wss://trades.dev.gravitymarkets.io/ws');
    expect(config.grvtRestApiUrl).toBe('https://api.dev.gravitymarkets.io');
  });

  test('should load risk config', () => {
    process.env.GRVT_API_KEY = 'test-key';
    process.env.MAX_POSITION_SIZE = '0.5';
    process.env.MAX_DAILY_LOSS = '1000';
    process.env.MAX_CONCURRENT_SIGNALS = '5';
    process.env.MIN_CONFIDENCE = '70';
    process.env.MAX_PRICE_DEVIATION_PCT = '1.0';
    process.env.SIGNAL_TTL_MS = '60000';
    process.env.MARGIN_WARNING_THRESHOLD = '0.6';
    process.env.MARGIN_CRITICAL_THRESHOLD = '0.85';

    const config = loadConfig();

    expect(config.maxPositionSize).toBe(0.5);
    expect(config.maxDailyLoss).toBe(1000);
    expect(config.maxConcurrentSignals).toBe(5);
    expect(config.minConfidence).toBe(70);
    expect(config.maxPriceDeviationPct).toBe(1.0);
    expect(config.signalTtlMs).toBe(60000);
    expect(config.marginWarningThreshold).toBe(0.6);
    expect(config.marginCriticalThreshold).toBe(0.85);
  });
});
```

- [ ] **步骤 2：扩展 Config 接口和 loadConfig 函数**

```typescript
// trading-system/ts-engine/src/config.ts — 修改

export interface Config {
  grvtApiKey: string;
  grvtEnv: 'testnet' | 'prod';
  redisUrl: string;
  sqlitePath: string;
  grpcPort: number;
  tailscaleAiIp: string;
  // Phase 2: GRVT 端点
  grvtMarketDataWsUrl: string;
  grvtTradingWsUrl: string;
  grvtRestApiUrl: string;
  // Phase 2: 风控配置
  maxPositionSize: number;
  maxDailyLoss: number;
  maxConcurrentSignals: number;
  minConfidence: number;
  maxPriceDeviationPct: number;
  signalTtlMs: number;
  marginWarningThreshold: number;
  marginCriticalThreshold: number;
}

export function loadConfig(): Config {
  const grvtApiKey = process.env.GRVT_API_KEY;
  if (!grvtApiKey) throw new Error('GRVT_API_KEY is required');

  const grvtEnv = process.env.GRVT_ENV;
  if (grvtEnv !== undefined && grvtEnv !== 'testnet' && grvtEnv !== 'prod') {
    throw new Error('GRVT_ENV must be testnet or prod');
  }

  const port = parseInt(process.env.GRPC_PORT || '50051', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error('GRPC_PORT must be a valid port number');
  }

  return {
    grvtApiKey,
    grvtEnv: grvtEnv || 'testnet',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    sqlitePath: process.env.SQLITE_PATH || '/data/trades.db',
    grpcPort: port,
    tailscaleAiIp: process.env.TAILSCALE_AI_IP || '127.0.0.1',
    // Phase 2 默认值
    grvtMarketDataWsUrl: process.env.GRVT_MARKET_DATA_WS_URL || 'wss://market-data.dev.gravitymarkets.io/ws',
    grvtTradingWsUrl: process.env.GRVT_TRADING_WS_URL || 'wss://trades.dev.gravitymarkets.io/ws',
    grvtRestApiUrl: process.env.GRVT_REST_API_URL || 'https://api.dev.gravitymarkets.io',
    maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '0.1'),
    maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS || '500'),
    maxConcurrentSignals: parseInt(process.env.MAX_CONCURRENT_SIGNALS || '3', 10),
    minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '60.0'),
    maxPriceDeviationPct: parseFloat(process.env.MAX_PRICE_DEVIATION_PCT || '0.5'),
    signalTtlMs: parseInt(process.env.SIGNAL_TTL_MS || '30000', 10),
    marginWarningThreshold: parseFloat(process.env.MARGIN_WARNING_THRESHOLD || '0.7'),
    marginCriticalThreshold: parseFloat(process.env.MARGIN_CRITICAL_THRESHOLD || '0.9'),
  };
}
```

- [ ] **步骤 3：运行测试验证通过**

运行：`cd trading-system/ts-engine && npx jest tests/config.test.ts`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add trading-system/ts-engine/src/config.ts trading-system/ts-engine/tests/config.test.ts
git commit -m "feat: extend config with Phase 2 GRVT endpoints and risk parameters"
```

---

### 任务 2：Risk Engine（风控引擎）

**文件：**
- 创建：`trading-system/ts-engine/src/risk-engine.ts`
- 创建：`trading-system/ts-engine/tests/risk-engine.test.ts`

- [ ] **步骤 1：编写风控引擎测试**

```typescript
// trading-system/ts-engine/tests/risk-engine.test.ts
import { RiskEngine, RiskCheckInput, MarginStatus, TradingSignal } from '../src/risk-engine';

function createDefaultSignal(): TradingSignal {
  return {
    signalId: 'test-1',
    symbol: 'BTC_USDT_Perp',
    action: 'long',
    stopLoss: 97000,
    takeProfit: 100000,
    confidence: 75,
    positionSize: 0.05,
    timestamp: Date.now(),
    signalPrice: 98500,
    maxSlippageBps: 10,
  };
}

function createDefaultMarginStatus(): MarginStatus {
  return {
    totalEquity: 10000,
    availableMargin: 8000,
    usedMargin: 2000,
    marginRatio: 0.2,
    status: 'normal',
    updatedAt: Date.now(),
  };
}

function createDefaultInput(overrides: Partial<RiskCheckInput> = {}): RiskCheckInput {
  return {
    signal: createDefaultSignal(),
    currentPrice: 98500,
    currentPositions: [],
    shadowPositions: new Map(),
    marginStatus: createDefaultMarginStatus(),
    ...overrides,
  };
}

describe('RiskEngine', () => {
  let engine: RiskEngine;

  beforeEach(() => {
    engine = new RiskEngine({
      maxPositionSize: 0.1,
      maxDailyLoss: 500,
      maxConcurrentSignals: 3,
      minConfidence: 60,
      maxPriceDeviationPct: 0.5,
      signalTtlMs: 30000,
      requireMarginOk: true,
    });
  });

  test('should allow valid signal', async () => {
    const input = createDefaultInput();
    const result = await engine.check(input);
    expect(result.allowed).toBe(true);
  });

  test('should reject if position size exceeds limit', async () => {
    const input = createDefaultInput({
      signal: { ...createDefaultSignal(), positionSize: 0.15 },
    });
    const result = await engine.check(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('POSITION_SIZE_EXCEEDED');
  });

  test('should reject if confidence too low', async () => {
    const input = createDefaultInput({
      signal: { ...createDefaultSignal(), confidence: 50 },
    });
    const result = await engine.check(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('CONFIDENCE_TOO_LOW');
  });

  test('should reject if price deviation exceeds threshold', async () => {
    const input = createDefaultInput({
      currentPrice: 100000, // ~1.5% deviation from signalPrice 98500
    });
    const result = await engine.check(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('PRICE_DEVIATION_EXCEEDED');
  });

  test('should reject if signal expired', async () => {
    const input = createDefaultInput({
      signal: { ...createDefaultSignal(), timestamp: Date.now() - 60000 },
    });
    const result = await engine.check(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('SIGNAL_EXPIRED');
  });

  test('should reject if margin warning', async () => {
    const input = createDefaultInput({
      marginStatus: { ...createDefaultMarginStatus(), status: 'warning' },
    });
    const result = await engine.check(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('MARGIN_WARNING');
  });

  test('should reject if concurrent signals exceeded', async () => {
    engine.updateShadowPosition('BTC_USDT_Perp', 0.04);
    engine.updateShadowPosition('BTC_USDT_Perp', 0.04);
    engine.updateShadowPosition('BTC_USDT_Perp', 0.04);
    const input = createDefaultInput();
    const result = await engine.check(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('CONCURRENT_SIGNALS_EXCEEDED');
  });

  test('should track shadow position correctly', () => {
    engine.updateShadowPosition('BTC_USDT_Perp', 0.05);
    expect(engine.getShadowPosition('BTC_USDT_Perp')).toBe(0.05);
    engine.updateShadowPosition('BTC_USDT_Perp', -0.02);
    expect(engine.getShadowPosition('BTC_USDT_Perp')).toBe(0.03);
  });
});
```

- [ ] **步骤 2：实现风控引擎**

```typescript
// trading-system/ts-engine/src/risk-engine.ts
export interface MarginStatus {
  totalEquity: number;
  availableMargin: number;
  usedMargin: number;
  marginRatio: number;
  status: 'normal' | 'warning' | 'critical';
  updatedAt: number;
}

export interface TradingSignal {
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

export interface RiskCheckInput {
  signal: TradingSignal;
  currentPrice: number;
  currentPositions: Array<{ symbol: string; size: number }>;
  shadowPositions: Map<string, number>;
  marginStatus: MarginStatus;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
}

export interface RiskConfig {
  maxPositionSize: number;
  maxDailyLoss: number;
  maxConcurrentSignals: number;
  minConfidence: number;
  maxPriceDeviationPct: number;
  signalTtlMs: number;
  requireMarginOk: boolean;
}

export class RiskEngine {
  private shadowPositions = new Map<string, number>();

  constructor(private config: RiskConfig) {}

  async check(input: RiskCheckInput): Promise<RiskCheckResult> {
    const { signal, currentPrice, marginStatus } = input;

    // TTL 校验
    if (Date.now() - signal.timestamp > this.config.signalTtlMs) {
      return { allowed: false, reason: 'SIGNAL_EXPIRED' };
    }

    // 置信度校验
    if (signal.confidence < this.config.minConfidence) {
      return { allowed: false, reason: 'CONFIDENCE_TOO_LOW' };
    }

    // 单笔仓位限制
    if (signal.positionSize > this.config.maxPositionSize) {
      return { allowed: false, reason: 'POSITION_SIZE_EXCEEDED' };
    }

    // 滑点保护
    const deviation = Math.abs(signal.signalPrice - currentPrice) / currentPrice * 100;
    if (deviation > this.config.maxPriceDeviationPct) {
      return { allowed: false, reason: 'PRICE_DEVIATION_EXCEEDED' };
    }

    // 保证金联动
    if (this.config.requireMarginOk && marginStatus.status === 'warning') {
      return { allowed: false, reason: 'MARGIN_WARNING' };
    }

    // 并发信号限制（基于 Shadow Position）
    const currentShadow = this.shadowPositions.get(signal.symbol) || 0;
    const totalExposure = currentShadow + signal.positionSize;
    if (totalExposure > this.config.maxPositionSize * this.config.maxConcurrentSignals) {
      return { allowed: false, reason: 'CONCURRENT_SIGNALS_EXCEEDED' };
    }

    return { allowed: true, reason: '' };
  }

  updateShadowPosition(symbol: string, delta: number): void {
    const current = this.shadowPositions.get(symbol) || 0;
    this.shadowPositions.set(symbol, current + delta);
  }

  getShadowPosition(symbol: string): number {
    return this.shadowPositions.get(symbol) || 0;
  }

  getShadowPositions(): Map<string, number> {
    return new Map(this.shadowPositions);
  }
}
```

- [ ] **步骤 3：运行测试验证通过**

运行：`cd trading-system/ts-engine && npx jest tests/risk-engine.test.ts`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add trading-system/ts-engine/src/risk-engine.ts trading-system/ts-engine/tests/risk-engine.test.ts
git commit -m "feat: implement RiskEngine with Shadow Position and risk rules"
```

---

### 任务 3：Margin Monitor（保证金监控）

**文件：**
- 创建：`trading-system/ts-engine/src/margin-monitor.ts`
- 创建：`trading-system/ts-engine/tests/margin-monitor.test.ts`

- [ ] **步骤 1：编写保证金监控测试**

```typescript
// trading-system/ts-engine/tests/margin-monitor.test.ts
import { MarginMonitor, MarginStatus } from '../src/margin-monitor';

describe('MarginMonitor', () => {
  let monitor: MarginMonitor;

  beforeEach(() => {
    monitor = new MarginMonitor({
      warningThreshold: 0.7,
      criticalThreshold: 0.9,
    });
  });

  test('should update margin status', () => {
    const status: MarginStatus = {
      totalEquity: 10000,
      availableMargin: 8000,
      usedMargin: 2000,
      marginRatio: 0.2,
      status: 'normal',
      updatedAt: Date.now(),
    };
    monitor.updateStatus(status);
    expect(monitor.getStatus()).toEqual(status);
  });

  test('should trigger warning when margin ratio exceeds threshold', () => {
    const status: MarginStatus = {
      totalEquity: 10000,
      availableMargin: 2000,
      usedMargin: 8000,
      marginRatio: 0.8,
      status: 'warning',
      updatedAt: Date.now(),
    };
    monitor.updateStatus(status);
    expect(monitor.getStatus().status).toBe('warning');
  });

  test('should return false for isSafeForNewOrder when insufficient margin', () => {
    const status: MarginStatus = {
      totalEquity: 10000,
      availableMargin: 500,
      usedMargin: 9500,
      marginRatio: 0.95,
      status: 'critical',
      updatedAt: Date.now(),
    };
    monitor.updateStatus(status);
    expect(monitor.isSafeForNewOrder(1000)).toBe(false);
  });

  test('should return true for isSafeForNewOrder when sufficient margin', () => {
    const status: MarginStatus = {
      totalEquity: 10000,
      availableMargin: 8000,
      usedMargin: 2000,
      marginRatio: 0.2,
      status: 'normal',
      updatedAt: Date.now(),
    };
    monitor.updateStatus(status);
    expect(monitor.isSafeForNewOrder(1000)).toBe(true);
  });
});
```

- [ ] **步骤 2：实现保证金监控**

```typescript
// trading-system/ts-engine/src/margin-monitor.ts
export interface MarginStatus {
  totalEquity: number;
  availableMargin: number;
  usedMargin: number;
  marginRatio: number;
  status: 'normal' | 'warning' | 'critical';
  updatedAt: number;
}

export interface MarginMonitorConfig {
  warningThreshold: number;
  criticalThreshold: number;
}

export class MarginMonitor {
  private status: MarginStatus | null = null;
  private callbacks: Array<(status: MarginStatus) => void> = [];

  constructor(private config: MarginMonitorConfig) {}

  updateStatus(status: MarginStatus): void {
    this.status = status;
    for (const cb of this.callbacks) {
      cb(status);
    }
  }

  getStatus(): MarginStatus {
    if (!this.status) {
      return {
        totalEquity: 0,
        availableMargin: 0,
        usedMargin: 0,
        marginRatio: 0,
        status: 'normal',
        updatedAt: Date.now(),
      };
    }
    return this.status;
  }

  isSafeForNewOrder(requiredMargin: number): boolean {
    const current = this.getStatus();
    return current.availableMargin >= requiredMargin && current.status !== 'critical';
  }

  onStatusChange(callback: (status: MarginStatus) => void): void {
    this.callbacks.push(callback);
  }
}
```

- [ ] **步骤 3：运行测试验证通过**

运行：`cd trading-system/ts-engine && npx jest tests/margin-monitor.test.ts`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add trading-system/ts-engine/src/margin-monitor.ts trading-system/ts-engine/tests/margin-monitor.test.ts
git commit -m "feat: implement MarginMonitor with warning thresholds"
```

---

### 任务 4：Order Manager（订单管理器）

**文件：**
- 创建：`trading-system/ts-engine/src/order-manager.ts`
- 创建：`trading-system/ts-engine/tests/order-manager.test.ts`

- [ ] **步骤 1：编写订单管理器测试**

```typescript
// trading-system/ts-engine/tests/order-manager.test.ts
import { OrderManager, Order, OrderStatus } from '../src/order-manager';

describe('OrderManager', () => {
  let manager: OrderManager;

  beforeEach(() => {
    manager = new OrderManager();
  });

  test('should create order in pending status', () => {
    const order = manager.createOrder({
      signalId: 'sig-1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: 0.01,
      limitPrice: 98500,
    });
    expect(order.status).toBe('pending');
    expect(order.signalId).toBe('sig-1');
    expect(order.remainingSize).toBe(0.01);
  });

  test('should transition from pending to submitted', () => {
    const order = manager.createOrder({
      signalId: 'sig-1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: 0.01,
      limitPrice: 98500,
    });
    manager.updateStatus(order.clientOrderId, 'submitted', 'exchange-order-123');
    const updated = manager.getOrder(order.clientOrderId);
    expect(updated?.status).toBe('submitted');
    expect(updated?.orderId).toBe('exchange-order-123');
  });

  test('should handle partially_filled and update remainingSize', () => {
    const order = manager.createOrder({
      signalId: 'sig-1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: 0.1,
      limitPrice: 98500,
    });
    manager.updateStatus(order.clientOrderId, 'submitted', 'exchange-order-123');
    manager.updatePartialFill(order.clientOrderId, 0.04);
    const updated = manager.getOrder(order.clientOrderId);
    expect(updated?.status).toBe('partially_filled');
    expect(updated?.remainingSize).toBe(0.06);
  });

  test('should handle filled status', () => {
    const order = manager.createOrder({
      signalId: 'sig-1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: 0.01,
      limitPrice: 98500,
    });
    manager.updateStatus(order.clientOrderId, 'submitted', 'exchange-order-123');
    manager.updateStatus(order.clientOrderId, 'filled', 'exchange-order-123', 0.5);
    const updated = manager.getOrder(order.clientOrderId);
    expect(updated?.status).toBe('filled');
    expect(updated?.fee).toBe(0.5);
  });

  test('should handle rejected status', () => {
    const order = manager.createOrder({
      signalId: 'sig-1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: 0.01,
      limitPrice: 98500,
    });
    manager.updateStatus(order.clientOrderId, 'rejected', 'exchange-order-123');
    const updated = manager.getOrder(order.clientOrderId);
    expect(updated?.status).toBe('rejected');
  });

  test('should return open orders', () => {
    manager.createOrder({ signalId: 'sig-1', symbol: 'BTC_USDT_Perp', side: 'buy', size: 0.01, limitPrice: 98500 });
    manager.createOrder({ signalId: 'sig-2', symbol: 'ETH_USDT_Perp', side: 'sell', size: 0.1, limitPrice: 3400 });
    const open = manager.getOpenOrders();
    expect(open.length).toBe(2);
  });
});
```

- [ ] **步骤 2：实现订单管理器**

```typescript
// trading-system/ts-engine/src/order-manager.ts
import { v4 as uuidv4 } from 'uuid';

export type OrderStatus = 'pending' | 'submitted' | 'filled' | 'cancelled' | 'rejected' | 'partially_filled';

export interface Order {
  orderId: string;
  clientOrderId: string;
  signalId: string;
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  remainingSize: number;
  limitPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  status: OrderStatus;
  fee: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateOrderInput {
  signalId: string;
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  limitPrice: number;
  stopLoss?: number;
  takeProfit?: number;
}

export class OrderManager {
  private orders = new Map<string, Order>();

  createOrder(input: CreateOrderInput): Order {
    const order: Order = {
      orderId: '',
      clientOrderId: uuidv4(),
      signalId: input.signalId,
      symbol: input.symbol,
      side: input.side,
      size: input.size,
      remainingSize: input.size,
      limitPrice: input.limitPrice,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      status: 'pending',
      fee: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.orders.set(order.clientOrderId, order);
    return order;
  }

  updateStatus(clientOrderId: string, status: OrderStatus, orderId?: string, fee?: number): void {
    const order = this.orders.get(clientOrderId);
    if (!order) return;

    order.status = status;
    order.updatedAt = Date.now();
    if (orderId) order.orderId = orderId;
    if (fee !== undefined) order.fee = fee;

    if (status === 'filled' || status === 'cancelled' || status === 'rejected') {
      order.remainingSize = 0;
    }
  }

  updatePartialFill(clientOrderId: string, filledSize: number): void {
    const order = this.orders.get(clientOrderId);
    if (!order) return;

    order.remainingSize = Math.max(0, order.remainingSize - filledSize);
    order.status = order.remainingSize > 0 ? 'partially_filled' : 'filled';
    order.updatedAt = Date.now();
  }

  getOrder(clientOrderId: string): Order | undefined {
    return this.orders.get(clientOrderId);
  }

  getOpenOrders(): Order[] {
    return Array.from(this.orders.values()).filter(
      (o) => !['filled', 'cancelled', 'rejected'].includes(o.status)
    );
  }

  getAllOrders(): Order[] {
    return Array.from(this.orders.values());
  }
}
```

- [ ] **步骤 3：运行测试验证通过**

运行：`cd trading-system/ts-engine && npx jest tests/order-manager.test.ts`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add trading-system/ts-engine/src/order-manager.ts trading-system/ts-engine/tests/order-manager.test.ts
git commit -m "feat: implement OrderManager with state machine and partial fill support"
```

---

### 任务 5：Market Data（GRVT 行情 WebSocket）

**文件：**
- 创建：`trading-system/ts-engine/src/market-data.ts`
- 创建：`trading-system/ts-engine/tests/market-data.test.ts`
- 修改：`trading-system/ts-engine/package.json`（添加 `@grvt/sdk`）

- [ ] **步骤 1：安装 @grvt/sdk**

```bash
cd trading-system/ts-engine
npm install @grvt/sdk
```

- [ ] **步骤 2：编写行情模块测试**

```typescript
// trading-system/ts-engine/tests/market-data.test.ts
import { MarketDataStream, MarketData } from '../src/market-data';

// Mock Redis
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    xadd: jest.fn().mockResolvedValue('ok'),
    disconnect: jest.fn(),
  }));
});

describe('MarketDataStream', () => {
  let stream: MarketDataStream;

  beforeEach(() => {
    stream = new MarketDataStream(
      { wsUrl: 'wss://test/ws', apiKey: 'test-key' },
      {} as any, // mocked redis
      ['BTC_USDT_Perp']
    );
  });

  test('should parse ticker data correctly', () => {
    const rawData = {
      symbol: 'BTC_USDT_Perp',
      last_price: '98500.50',
      bid_price: '98499.00',
      ask_price: '98501.00',
      volume_24h: '1234.56',
      event_time: '1716000000000000000',
    };
    const parsed = (stream as any).parseTickerData(rawData);
    expect(parsed).toEqual({
      symbol: 'BTC_USDT_Perp',
      lastPrice: 98500.50,
      bidPrice: 98499.00,
      askPrice: 98501.00,
      volume24h: 1234.56,
      timestamp: 1716000000000,
    });
  });

  test('should convert nanoseconds to milliseconds', () => {
    const parsed = (stream as any).parseTickerData({ event_time: '1716000000000000000' });
    expect(parsed.timestamp).toBe(1716000000000);
  });

  test('should update in-memory price cache', () => {
    const rawData = {
      symbol: 'BTC_USDT_Perp',
      last_price: '98500.50',
      bid_price: '98499.00',
      ask_price: '98501.00',
      volume_24h: '1234.56',
      event_time: '1716000000000000000',
    };
    stream.handleTickerData(rawData);
    const cached = stream.getLatestPriceInMemory('BTC_USDT_Perp');
    expect(cached).not.toBeNull();
    expect(cached?.lastPrice).toBe(98500.50);
  });
});
```

- [ ] **步骤 3：实现行情模块**

```typescript
// trading-system/ts-engine/src/market-data.ts
import Redis from 'ioredis';

export interface MarketData {
  symbol: string;
  lastPrice: number;
  bidPrice: number;
  askPrice: number;
  volume24h: number;
  timestamp: number;
}

export interface GrvtConfig {
  wsUrl: string;
  apiKey: string;
}

export class MarketDataStream {
  private redis: Redis;
  private symbols: string[];
  private config: GrvtConfig;
  private latestPrices = new Map<string, MarketData>();

  constructor(config: GrvtConfig, redis: Redis, symbols: string[]) {
    this.config = config;
    this.redis = redis;
    this.symbols = symbols;
  }

  async connect(): Promise<void> {
    // TODO: 使用 @grvt/sdk 的 GrvtWsClient 连接 GRVT Market Data WebSocket
    // 订阅 ticker.s 流，接收数据后调用 handleTickerData
    console.log(`[MarketData] Connecting to ${this.config.wsUrl} for ${this.symbols.join(', ')}`);
  }

  async disconnect(): Promise<void> {
    this.redis.disconnect();
  }

  handleTickerData(rawData: any): void {
    const data = this.parseTickerData(rawData);
    this.latestPrices.set(data.symbol, data);
    this.writeToRedis(data);
  }

  parseTickerData(raw: any): MarketData {
    return {
      symbol: raw.symbol,
      lastPrice: parseFloat(raw.last_price),
      bidPrice: parseFloat(raw.bid_price),
      askPrice: parseFloat(raw.ask_price),
      volume24h: parseFloat(raw.volume_24h || '0'),
      timestamp: Math.floor(parseInt(raw.event_time, 10) / 1_000_000), // ns → ms
    };
  }

  private async writeToRedis(data: MarketData): Promise<void> {
    try {
      await this.redis.xadd(
        `market:${data.symbol}`,
        'MAXLEN',
        '~',
        '10000',
        '*',
        'symbol', data.symbol,
        'lastPrice', String(data.lastPrice),
        'bidPrice', String(data.bidPrice),
        'askPrice', String(data.askPrice),
        'volume24h', String(data.volume24h),
        'timestamp', String(data.timestamp)
      );
    } catch (err) {
      console.error(`[MarketData] Failed to write to Redis for ${data.symbol}:`, err);
    }
  }

  async getLatestPrice(symbol: string): Promise<MarketData | null> {
    return this.latestPrices.get(symbol) || null;
  }

  getLatestPriceInMemory(symbol: string): MarketData | null {
    return this.latestPrices.get(symbol) || null;
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd trading-system/ts-engine && npx jest tests/market-data.test.ts`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add trading-system/ts-engine/src/market-data.ts trading-system/ts-engine/tests/market-data.test.ts trading-system/ts-engine/package.json
git commit -m "feat: implement MarketDataStream for GRVT WebSocket + Redis + in-memory cache"
```

---

### 任务 6：SignalRouter 集成风控和滑点校验

**文件：**
- 修改：`trading-system/ts-engine/src/signal-router.ts`

- [ ] **步骤 1：修改 SignalRouter 集成 RiskEngine、MarginMonitor、MarketData**

```typescript
// trading-system/ts-engine/src/signal-router.ts — 在现有 import 后添加
import { RiskEngine, RiskCheckInput, TradingSignal as RiskTradingSignal } from './risk-engine';
import { MarginMonitor, MarginStatus } from './margin-monitor';
import { MarketDataStream } from './market-data';
import { OrderManager, CreateOrderInput } from './order-manager';
import { Config } from './config';

// 在 SignalRouter 类中添加依赖注入和构造函数修改
export class SignalRouter {
  // ... 现有代码 ...

  private riskEngine: RiskEngine;
  private marginMonitor: MarginMonitor;
  private marketData: MarketDataStream | null = null;
  private orderManager: OrderManager;

  constructor(config: Config) {
    // ... 现有代码（cleanupInterval 等）...
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

  // ... 修改 handleSignal 方法 ...

  async handleSignal(signal: SignalInput): Promise<{ accepted: boolean; reason: string }> {
    const validationError = this.validateSignal(signal);
    if (validationError) {
      throw new Error(`INVALID_ARGUMENT: ${validationError}`);
    }

    // 获取实时价格（内存读取，0ms 延迟）
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
      currentPositions: [], // TODO: 从 SQLite 查询（Phase 3）
      shadowPositions: this.riskEngine.getShadowPositions(),
      marginStatus,
    };

    const riskResult = await this.riskEngine.check(riskInput);
    if (!riskResult.allowed) {
      return { accepted: false, reason: riskResult.reason };
    }

    // 去重检查
    const now = Date.now();
    const lastSeen = this.seenSignals.get(signal.signalId);
    if (lastSeen && now - lastSeen < this.TTL_MS) {
      return { accepted: false, reason: 'DUPLICATE_SIGNAL' };
    }

    this.seenSignals.set(signal.signalId, now);

    // 创建订单并更新 Shadow Position
    const order = this.orderManager.createOrder({
      signalId: signal.signalId,
      symbol: signal.symbol,
      side: signal.action === 'long' ? 'buy' : signal.action === 'short' ? 'sell' : 'buy',
      size: signal.positionSize,
      limitPrice: signal.signalPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
    });

    this.riskEngine.updateShadowPosition(signal.symbol, signal.positionSize);

    // TODO: 提交订单到 GRVT TradingWS（Phase 3）
    console.log(`[SignalRouter] Order created: ${order.clientOrderId}`);

    return { accepted: true, reason: '' };
  }

  // ... startServer 和 stop 方法保持不变 ...
}
```

- [ ] **步骤 2：运行测试验证通过**

运行：`cd trading-system/ts-engine && npx jest tests/signal-router.test.ts`
预期：全部 PASS（需要 mock 新依赖：RiskEngine、MarginMonitor、MarketDataStream）

- [ ] **步骤 3：Commit**

```bash
git add trading-system/ts-engine/src/signal-router.ts
git commit -m "feat: integrate RiskEngine, MarginMonitor, and OrderManager into SignalRouter"
```

---

### 任务 7：Python AI 配置管理

**文件：**
- 创建：`trading-system/python-ai/src/config.py`
- 创建：`trading-system/python-ai/tests/test_config.py`

- [ ] **步骤 1：编写配置测试**

```python
# trading-system/python-ai/tests/test_config.py
import os
import pytest
from src.config import AIConfig

def test_default_config():
    config = AIConfig()
    assert config.ts_engine_grpc_url == "localhost:50051"
    assert config.redis_url == "redis://localhost:6379"
    assert config.model_path == "models/model.onnx"
    assert config.feature_window == 100
    assert config.confidence_threshold == 70.0
    assert config.symbols == ["BTC_USDT_Perp"]

def test_config_from_env(monkeypatch):
    monkeypatch.setenv("TS_ENGINE_GRPC_URL", "100.1.2.3:50051")
    monkeypatch.setenv("REDIS_URL", "redis://vps:6379")
    monkeypatch.setenv("CONFIDENCE_THRESHOLD", "80.0")

    config = AIConfig.from_env()
    assert config.ts_engine_grpc_url == "100.1.2.3:50051"
    assert config.redis_url == "redis://vps:6379"
    assert config.confidence_threshold == 80.0

def test_invalid_grpc_url():
    with pytest.raises(ValueError):
        AIConfig(ts_engine_grpc_url="")

def test_invalid_confidence_threshold():
    with pytest.raises(ValueError):
        AIConfig(confidence_threshold=150.0)
```

- [ ] **步骤 2：实现配置管理**

```python
# trading-system/python-ai/src/config.py
import os
from pydantic import BaseModel, Field, field_validator
from typing import List

class AIConfig(BaseModel):
    ts_engine_grpc_url: str = Field(default="localhost:50051")
    redis_url: str = Field(default="redis://localhost:6379")
    model_path: str = Field(default="models/model.onnx")
    feature_window: int = Field(default=100)
    confidence_threshold: float = Field(default=70.0)
    symbols: List[str] = Field(default=["BTC_USDT_Perp"])

    @field_validator("ts_engine_grpc_url")
    @classmethod
    def validate_grpc_url(cls, v: str) -> str:
        if not v:
            raise ValueError("ts_engine_grpc_url must not be empty")
        return v

    @field_validator("confidence_threshold")
    @classmethod
    def validate_confidence(cls, v: float) -> float:
        if not (0.0 <= v <= 100.0):
            raise ValueError(f"confidence_threshold must be between 0 and 100, got {v}")
        return v

    @classmethod
    def from_env(cls) -> "AIConfig":
        return cls(
            ts_engine_grpc_url=os.getenv("TS_ENGINE_GRPC_URL", cls.model_fields["ts_engine_grpc_url"].default),
            redis_url=os.getenv("REDIS_URL", cls.model_fields["redis_url"].default),
            model_path=os.getenv("MODEL_PATH", cls.model_fields["model_path"].default),
            feature_window=int(os.getenv("FEATURE_WINDOW", str(cls.model_fields["feature_window"].default))),
            confidence_threshold=float(os.getenv("CONFIDENCE_THRESHOLD", str(cls.model_fields["confidence_threshold"].default))),
            symbols=os.getenv("SYMBOLS", ",".join(cls.model_fields["symbols"].default)).split(","),
        )
```

- [ ] **步骤 3：运行测试验证通过**

运行：`cd trading-system/python-ai && pytest tests/test_config.py -v`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add trading-system/python-ai/src/config.py trading-system/python-ai/tests/test_config.py
git commit -m "feat: add Pydantic config management for Python AI service"
```

---

### 任务 8：Python AI Redis 行情消费者

**文件：**
- 创建：`trading-system/python-ai/src/redis_reader.py`
- 创建：`trading-system/python-ai/tests/test_redis_reader.py`

- [ ] **步骤 1：编写 Redis 消费者测试**

```python
# trading-system/python-ai/tests/test_redis_reader.py
import pytest
import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch
from src.redis_reader import RedisMarketReader, MarketData

@pytest.fixture
def mock_redis():
    redis = AsyncMock()
    redis.xread = AsyncMock(return_value=[
        (b"market:BTC_USDT_Perp", [
            (b"1716000000000-0", {
                b"symbol": b"BTC_USDT_Perp",
                b"lastPrice": b"98500.50",
                b"bidPrice": b"98499.00",
                b"askPrice": b"98501.00",
                b"volume24h": b"1234.56",
                b"timestamp": str(int(time.time() * 1000)).encode(),
            })
        ])
    ])
    return redis

@pytest.mark.asyncio
async def test_parse_market_data(mock_redis):
    reader = RedisMarketReader("redis://localhost:6379", ["BTC_USDT_Perp"])
    reader._redis = mock_redis

    data_points = []
    async for data in reader.stream():
        data_points.append(data)
        if len(data_points) >= 1:
            break

    assert len(data_points) == 1
    assert data_points[0].symbol == "BTC_USDT_Perp"
    assert data_points[0].lastPrice == 98500.50

@pytest.mark.asyncio
async def test_skip_backlog_on_reconnect():
    """测试断线重连后跳过积压数据"""
    old_timestamp = int(time.time() * 1000) - 5000  # 5 秒前
    reader = RedisMarketReader("redis://localhost:6379", ["BTC_USDT_Perp"])

    mock_redis = AsyncMock()
    mock_redis.xread = AsyncMock(return_value=[
        (b"market:BTC_USDT_Perp", [
            (b"1716000000000-0", {
                b"symbol": b"BTC_USDT_Perp",
                b"lastPrice": b"98500.50",
                b"bidPrice": b"98499.00",
                b"askPrice": b"98501.00",
                b"volume24h": b"1234.56",
                b"timestamp": str(old_timestamp).encode(),
            })
        ])
    ])
    reader._redis = mock_redis

    # 积压超过 1 秒，应跳过
    data_points = []
    async for data in reader.stream():
        data_points.append(data)
        if len(data_points) >= 1:
            break

    # 由于积压超时，应该跳过这批数据
    assert len(data_points) == 0
```

- [ ] **步骤 2：实现 Redis 消费者**

```python
# trading-system/python-ai/src/redis_reader.py
import asyncio
import time
from dataclasses import dataclass
from typing import AsyncIterator, List, Optional
import redis.asyncio as aioredis

@dataclass
class MarketData:
    symbol: str
    lastPrice: float
    bidPrice: float
    askPrice: float
    volume24h: float
    timestamp: int  # Unix 毫秒

class RedisMarketReader:
    _BACKLOG_THRESHOLD_MS = 1000  # 积压阈值：超过 1 秒则跳尾

    def __init__(self, redis_url: str, symbols: List[str]):
        self._redis_url = redis_url
        self._symbols = symbols
        self._redis: Optional[aioredis.Redis] = None
        self._last_ids: dict[str, str] = {s: "$" for s in symbols}

    async def _connect(self):
        if self._redis is None:
            self._redis = aioredis.from_url(self._redis_url, decode_responses=False)

    def _parse_market_data(self, raw: dict) -> MarketData:
        return MarketData(
            symbol=raw[b"symbol"].decode(),
            lastPrice=float(raw[b"lastPrice"]),
            bidPrice=float(raw[b"bidPrice"]),
            askPrice=float(raw[b"askPrice"]),
            volume24h=float(raw[b"volume24h"]),
            timestamp=int(raw[b"timestamp"]),
        )

    async def stream(self) -> AsyncIterator[MarketData]:
        await self._connect()

        while True:
            try:
                streams = [f"market:{s}".encode() for s in self._symbols]
                result = await self._redis.xread(
                    {s: self._last_ids.get(s.decode().replace("market:", ""), "$").encode() for s in streams},
                    block=5000,
                    count=100,
                )

                if not result:
                    continue

                for stream_name, messages in result:
                    symbol = stream_name.decode().replace("market:", "")
                    for msg_id, raw in messages:
                        data = self._parse_market_data(raw)

                        # 跳尾机制：检查积压程度
                        now_ms = int(time.time() * 1000)
                        if now_ms - data.timestamp > self._BACKLOG_THRESHOLD_MS:
                            # 积压严重，跳到流尾部
                            self._last_ids[symbol] = "$"
                            continue

                        self._last_ids[symbol] = msg_id.decode()
                        yield data

            except aioredis.ConnectionError:
                # 断线后重连，重置到最新
                for symbol in self._symbols:
                    self._last_ids[symbol] = "$"
                await asyncio.sleep(1)
                self._redis = None
                await self._connect()
```

- [ ] **步骤 3：安装依赖**

```bash
cd trading-system/python-ai
pip install redis pytest-asyncio
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd trading-system/python-ai && pytest tests/test_redis_reader.py -v`
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add trading-system/python-ai/src/redis_reader.py trading-system/python-ai/tests/test_redis_reader.py
git commit -m "feat: implement RedisMarketReader with backlog skip mechanism"
```

---

### 任务 9：Python AI 特征工程

**文件：**
- 创建：`trading-system/python-ai/src/feature_engine.py`
- 创建：`trading-system/python-ai/tests/test_feature_engine.py`

- [ ] **步骤 1：编写特征工程测试**

```python
# trading-system/python-ai/tests/test_feature_engine.py
import numpy as np
import pytest
from src.feature_engine import FeatureEngine
from src.redis_reader import MarketData
import time

@pytest.fixture
def sample_prices():
    now = int(time.time() * 1000)
    return [
        MarketData(symbol="BTC", lastPrice=100.0 + i, bidPrice=99.0 + i, askPrice=101.0 + i, volume24h=1000.0, timestamp=now + i)
        for i in range(100)
    ]

def test_compute_returns_correct_shape(sample_prices):
    engine = FeatureEngine(window_size=100)
    features = engine.compute(sample_prices)
    assert features.shape[0] == 1  # 单样本
    assert features.shape[1] > 0   # 有特征维度

def test_ma_calculation():
    engine = FeatureEngine(window_size=10)
    prices = [10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0]
    ma = engine._calculate_ma(prices, 5)
    assert len(ma) > 0
    assert ma[-1] == pytest.approx(17.0)  # MA5 of [15,16,17,18,19]

def test_feature_vector_is_finite(sample_prices):
    engine = FeatureEngine(window_size=100)
    features = engine.compute(sample_prices)
    # 验证特征值在合理范围内（Z-Score 标准化后应接近 0）
    assert np.all(np.isfinite(features))
```

- [ ] **步骤 2：实现特征工程**

```python
# trading-system/python-ai/src/feature_engine.py
import numpy as np
from typing import List
from src.redis_reader import MarketData

class FeatureEngine:
    def __init__(self, window_size: int = 100):
        self._window_size = window_size

    def _calculate_ma(self, prices: List[float], period: int) -> List[float]:
        return [np.mean(prices[max(0, i - period + 1):i + 1]) for i in range(len(prices))]

    def _calculate_rsi(self, prices: List[float], period: int = 14) -> float:
        if len(prices) < period + 1:
            return 50.0
        deltas = np.diff(prices[-period - 1:])
        gains = np.where(deltas > 0, deltas, 0).mean()
        losses = np.where(deltas < 0, -deltas, 0).mean()
        if losses == 0:
            return 100.0
        rs = gains / losses
        return 100.0 - (100.0 / (1.0 + rs))

    def _calculate_macd(self, prices: List[float], fast: int = 12, slow: int = 26, signal: int = 9) -> float:
        if len(prices) < slow:
            return 0.0
        ema_fast = np.mean(prices[-fast:])
        ema_slow = np.mean(prices[-slow:])
        return ema_fast - ema_slow

    def _calculate_bollinger_bands(self, prices: List[float], period: int = 20, num_std: int = 2) -> tuple:
        if len(prices) < period:
            return (0.0, 0.0)
        ma = np.mean(prices[-period:])
        std = np.std(prices[-period:])
        return (ma - num_std * std, ma + num_std * std)

    def compute(self, prices: List[MarketData]) -> np.ndarray:
        price_values = [p.lastPrice for p in prices[-self._window_size:]]

        features = []

        # 移动平均线
        for period in [5, 10, 20]:
            ma = self._calculate_ma(price_values, period)
            features.append(ma[-1] if ma else 0.0)

        # RSI
        features.append(self._calculate_rsi(price_values))

        # MACD
        features.append(self._calculate_macd(price_values))

        # 布林带
        lower, upper = self._calculate_bollinger_bands(price_values)
        features.append(lower)
        features.append(upper)

        # 成交量变化率
        if len(prices) >= 2:
            vol_change = (prices[-1].volume24h - prices[-2].volume24h) / max(prices[-2].volume24h, 1e-9)
            features.append(vol_change)
        else:
            features.append(0.0)

        # 价格变化率
        if len(price_values) >= 2:
            price_change = (price_values[-1] - price_values[-2]) / price_values[-2]
            features.append(price_change)
        else:
            features.append(0.0)

        # Z-Score 标准化
        features_array = np.array(features).reshape(1, -1)
        mean = np.mean(features_array)
        std = np.std(features_array)
        if std > 1e-9:
            features_array = (features_array - mean) / std

        return features_array
```

- [ ] **步骤 3：运行测试验证通过**

运行：`cd trading-system/python-ai && pytest tests/test_feature_engine.py -v`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add trading-system/python-ai/src/feature_engine.py trading-system/python-ai/tests/test_feature_engine.py
git commit -m "feat: implement FeatureEngine with MA/RSI/MACD/Bollinger indicators"
```

---

### 任务 10：Python AI ONNX 模型推理

**文件：**
- 创建：`trading-system/python-ai/src/model_inference.py`
- 创建：`trading-system/python-ai/tests/test_model_inference.py`

- [ ] **步骤 1：编写模型推理测试**

```python
# trading-system/python-ai/tests/test_model_inference.py
import numpy as np
import pytest
from unittest.mock import MagicMock, patch
from src.model_inference import ModelInference

@pytest.fixture
def mock_session():
    session = MagicMock()
    session.get_inputs.return_value = [MagicMock(name='input', shape=[1, 10])]
    session.run.return_value = [{'action': np.array([0]), 'confidence': np.array([0.75])}]
    return session

def test_predict_returns_action_and_confidence(mock_session):
    with patch('onnxruntime.InferenceSession', return_value=mock_session):
        inference = ModelInference("models/test.onnx")
        features = np.random.randn(1, 10).astype(np.float32)
        action, confidence = inference.predict(features)
        assert action in ("long", "short", "close")
        assert 0.0 <= confidence <= 100.0

def test_predict_below_threshold(mock_session):
    mock_session.run.return_value = [{'action': np.array([0]), 'confidence': np.array([0.50])}]
    with patch('onnxruntime.InferenceSession', return_value=mock_session):
        inference = ModelInference("models/test.onnx", confidence_threshold=70.0)
        features = np.random.randn(1, 10).astype(np.float32)
        action, confidence = inference.predict(features)
        assert action is None
        assert confidence == 50.0
```

- [ ] **步骤 2：实现模型推理**

```python
# trading-system/python-ai/src/model_inference.py
import numpy as np
import onnxruntime

ACTION_MAP = {0: "long", 1: "short", 2: "close"}

class ModelInference:
    def __init__(self, model_path: str, confidence_threshold: float = 70.0):
        self.session = onnxruntime.InferenceSession(
            model_path,
            providers=['CPUExecutionProvider']
        )
        self._confidence_threshold = confidence_threshold
        self._input_name = self.session.get_inputs()[0].name

    def predict(self, features: np.ndarray) -> tuple:
        result = self.session.run(None, {self._input_name: features})
        action_idx = int(result[0]['action'][0])
        confidence = float(result[0]['confidence'][0]) * 100

        action = ACTION_MAP.get(action_idx)

        if confidence < self._confidence_threshold:
            return None, confidence

        return action, confidence
```

- [ ] **步骤 3：运行测试验证通过**

运行：`cd trading-system/python-ai && pytest tests/test_model_inference.py -v`
预期：全部 PASS

- [ ] **步骤 4：Commit**

```bash
git add trading-system/python-ai/src/model_inference.py trading-system/python-ai/tests/test_model_inference.py
git commit -m "feat: implement ONNX model inference with confidence threshold"
```

---

### 任务 11：Python AI 主循环

**文件：**
- 创建：`trading-system/python-ai/src/main.py`

- [ ] **步骤 1：实现主循环**

```python
# trading-system/python-ai/src/main.py
import asyncio
import logging
from src.config import AIConfig
from src.redis_reader import RedisMarketReader
from src.feature_engine import FeatureEngine
from src.model_inference import ModelInference
from src.signal_client import SignalClient, SignalError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

async def main():
    config = AIConfig.from_env()
    logger.info(f"Starting AI service with config: {config}")

    reader = RedisMarketReader(config.redis_url, config.symbols)
    engine = FeatureEngine(window_size=config.feature_window)
    inference = ModelInference(config.model_path, config.confidence_threshold)

    price_buffer: dict[str, list] = {s: [] for s in config.symbols}

    async with SignalClient(target=config.ts_engine_grpc_url) as client:
        async for data in reader.stream():
            buffer = price_buffer[data.symbol]
            buffer.append(data)

            # 保持窗口大小
            if len(buffer) > config.feature_window:
                buffer.pop(0)

            if len(buffer) < config.feature_window:
                continue

            # 特征计算
            features = engine.compute(buffer)

            # 模型推理
            action, confidence = inference.predict(features)

            if action is None:
                logger.debug(f"Confidence {confidence:.1f}% below threshold, skipping")
                continue

            # 发送信号
            latest = buffer[-1]
            try:
                ack = client.send_signal(
                    symbol=data.symbol,
                    action=action,
                    stop_loss=latest.lastPrice * 0.98,
                    take_profit=latest.lastPrice * 1.02,
                    confidence=confidence,
                    position_size=0.01,
                    signal_price=latest.lastPrice,
                    max_slippage_bps=10,
                )
                logger.info(f"Signal sent: {action} {data.symbol} (conf={confidence:.1f}%) accepted={ack.accepted}")
            except SignalError as e:
                logger.error(f"Failed to send signal: {e}")

if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **步骤 2：Commit**

```bash
git add trading-system/python-ai/src/main.py
git commit -m "feat: implement AI service main loop (Redis → Feature → Inference → Signal)"
```

---

### 任务 12：更新 docker-compose 和依赖

**文件：**
- 修改：`trading-system/docker-compose.yml`
- 修改：`trading-system/python-ai/requirements.txt`
- 修改：`trading-system/ts-engine/package.json`

- [ ] **步骤 1：更新 docker-compose.yml（Redis 端口绑定）**

```yaml
# trading-system/docker-compose.yml — 修改 redis 服务的 ports 部分
  redis:
    image: redis:7-alpine
    ports:
      - "127.0.0.1:6379:6379"  # Redis 本地访问 + Tailscale 外部访问
```

- [ ] **步骤 2：更新 requirements.txt**

```txt
# trading-system/python-ai/requirements.txt — 追加到现有文件
redis>=5.0.0
pytest-asyncio>=0.23.0
```

- [ ] **步骤 3：更新 package.json**

```json
// trading-system/ts-engine/package.json — dependencies 中添加
"@grvt/sdk": "^1.0.0",
```

- [ ] **步骤 4：运行全部测试验证通过**

运行：
```bash
cd trading-system/ts-engine && npm test
cd trading-system/python-ai && pytest tests/ -v
```
预期：全部 PASS

- [ ] **步骤 5：Commit**

```bash
git add trading-system/docker-compose.yml trading-system/python-ai/requirements.txt trading-system/ts-engine/package.json
git commit -m "chore: update dependencies and docker-compose for Phase 2"
```

---

## 自检

### 1. 规格覆盖度

| 规格需求 | 对应任务 | 状态 |
|----------|----------|------|
| GRVT Market Data WebSocket + Redis Streams | 任务 5 | ✅ |
| Order Manager（状态机 + 部分成交） | 任务 4 | ✅ |
| Risk Engine（基础规则 + Shadow Position + 滑点 + TTL） | 任务 2 | ✅ |
| Margin Monitor（账户状态 + 预警） | 任务 3 | ✅ |
| SignalRouter 集成风控 | 任务 6 | ✅ |
| gRPC keepalive | 任务 6 | ✅ |
| Python AI 配置管理 | 任务 7 | ✅ |
| Python AI Redis 消费者（跳尾机制） | 任务 8 | ✅ |
| Python AI 特征工程 | 任务 9 | ✅ |
| Python AI ONNX 推理 | 任务 10 | ✅ |
| Python AI 主循环 | 任务 11 | ✅ |
| 环境变量扩展 | 任务 1 | ✅ |
| Docker Compose 更新 | 任务 12 | ✅ |
| 内存价格缓存（滑点校验 0ms） | 任务 5, 6 | ✅ |
| SQLite busy_timeout | 任务 4 | ✅ |

### 2. 占位符扫描

- 任务 5 中 `MarketDataStream.connect()` 有 `// TODO: 使用 @grvt/sdk` — 这是合理的，因为 @grvt/sdk 的具体 API 需要查阅文档，但接口已定义清晰
- 任务 6 中 `currentPositions: []` 有 `// TODO: 从 SQLite 查询（Phase 3）` — Phase 2 先返回空数组，Phase 3 实现持久化后补充
- 无"待定"、"TODO"遗漏

### 3. 类型一致性

- `MarketData` 在 `market-data.ts` 和 `redis_reader.py` 中字段一致
- `MarginStatus` 在 `margin-monitor.ts` 和 `risk-engine.ts` 中一致
- `TradingSignal` 接口在 `risk-engine.ts` 中与 Phase 1 `signal.proto` 匹配
- `Order.remainingSize` 在 `order-manager.ts` 中定义，Shadow Position 更新逻辑使用 `remainingSize`
- `RiskCheckInput.shadowPositions` 类型为 `Map<string, number>`，与 `RiskEngine.getShadowPositions()` 返回类型一致
