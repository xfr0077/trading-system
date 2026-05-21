# DEX 适配器模块化设计规格

**日期**: 2026-05-21  
**状态**: 已批准  
**范围**: 将紧耦合的 Hyperliquid 交易逻辑重构为可插拔的 DEX 适配器架构

---

## 1. 目标

- 定义统一的 `IDexAdapter` 接口，覆盖核心交易操作
- 将现有 `TradingWebSocket` 重构为 `HyperliquidAdapter`
- 通过环境变量 `DEX_PROVIDER` 切换 DEX
- 为未来接入 Lighter、Ostium、Extended 预留扩展点

---

## 2. 核心类型定义

### 2.1 配置

```typescript
export interface DexConfig {
  dexName: string;
  testnet: boolean;
  privateKey?: string;
  walletAddress?: string;
  rpcUrl?: string;
  wsUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
}
```

### 2.2 订单

```typescript
export interface OrderInput {
  clientOrderId: string;
  market: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  size: number;
  price?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export type OrderStatus = 'pending' | 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired';

export interface OpenOrder {
  exchangeOrderId: string;
  clientOrderId: string;
  market: string;
  side: 'buy' | 'sell';
  type: string;
  size: number;
  filledSize: number;
  price: number;
  avgFillPrice?: number;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
}
```

### 2.3 仓位与成交

```typescript
export interface Position {
  market: string;
  side: 'long' | 'short' | 'none';
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  leverage: number;
  liquidationPrice?: number;
  marginUsed: number;
}

export interface Fill {
  exchangeOrderId: string;
  clientOrderId: string;
  market: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  fee: number;
  feeAsset: string;
  isMaker: boolean;
  timestamp: number;
}
```

### 2.4 事件与错误

```typescript
export interface OrderUpdate {
  type: 'order_placed' | 'order_filled' | 'order_cancelled' | 'order_rejected';
  order: OpenOrder;
  fill?: Fill;
  reason?: string;
  sequenceNumber: number;
}

export enum DexErrorCode {
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  INVALID_ORDER = 'INVALID_ORDER',
  ORDER_NOT_FOUND = 'ORDER_NOT_FOUND',
  AUTH_FAILED = 'AUTH_FAILED',
  CONNECTION_LOST = 'CONNECTION_LOST',
}

export class DexError extends Error {
  constructor(
    message: string,
    public code: DexErrorCode,
    public retryable: boolean,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'DexError';
  }
}
```

### 2.5 能力声明

```typescript
export interface DexCapabilities {
  maxLeverage: number;
  supportedOrderTypes: string[];
  supportedTimeInForce: string[];
  minOrderSize: number;
  tickSize: number;
  rateLimits: { endpoint: string; requestsPerMinute: number }[];
  hasWebSocket: boolean;
  hasBatchOrders: boolean;
  hasReduceOnly: boolean;
}
```

---

## 3. 核心接口

```typescript
export interface IDexAdapter {
  connect(config: DexConfig): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  healthCheck(): Promise<{ healthy: boolean; latencyMs?: number }>;

  submitOrder(order: OrderInput): Promise<string>;
  cancelOrder(exchangeOrderId: string): Promise<void>;

  getOpenOrders(): Promise<OpenOrder[]>;
  getPositions(): Promise<Position[]>;
  getFills(clientOrderId?: string): Promise<Fill[]>;

  onOrderUpdate(callback: (update: OrderUpdate) => void): void;

  getName(): string;
  getCapabilities(): DexCapabilities;
}
```

---

## 4. 目录结构

```
ts-engine/src/
├── dex/
│   ├── index.ts              # 导出 IDexAdapter, createDexAdapter
│   ├── types.ts              # 所有类型定义
│   ├── registry.ts           # 注册表与工厂
│   ├── hyperliquid.ts        # Hyperliquid 适配器（迁移自 trading-ws.ts）
│   └── lighter.ts            # Lighter 适配器骨架（TODO）
├── signal-router.ts          # 改用 IDexAdapter
├── config.ts                 # 添加 DEX_PROVIDER 读取
└── ...
```

---

## 5. 工厂与注册表

```typescript
// dex/registry.ts
const registry = new Map<string, () => IDexAdapter>();

export function registerDex(name: string, factory: () => IDexAdapter) {
  registry.set(name, factory);
}

export function createDexAdapter(dexName: string): IDexAdapter {
  const factory = registry.get(dexName);
  if (!factory) {
    throw new Error(`Unknown DEX: ${dexName}. Available: ${[...registry.keys()].join(', ')}`);
  }
  return factory();
}

// dex/hyperliquid.ts 底部自动注册
registerDex('hyperliquid', () => new HyperliquidAdapter());
```

---

## 6. 配置切换

```env
# .env
DEX_PROVIDER=hyperliquid
PRIVATE_KEY=0x...
DEX_ENV=testnet
```

```typescript
// config.ts
const dexProvider = process.env.DEX_PROVIDER || 'hyperliquid';
const dex = createDexAdapter(dexProvider);
```

---

## 7. 迁移策略

| Phase | 任务 | 风险 |
|-------|------|------|
| 1 | 创建 `dex/` 目录、类型、接口 | 低 |
| 2 | 迁移 `trading-ws.ts` → `hyperliquid.ts` | 中（保持行为一致） |
| 3 | 更新 `signal-router.ts` 使用 `IDexAdapter` | 中 |
| 4 | 更新 `config.ts` 添加 `DEX_PROVIDER` | 低 |
| 5 | 删除旧 `trading-ws.ts`，验证 | 低 |

---

## 8. 测试策略

- **契约测试**: 所有适配器必须通过相同的 `IDexAdapter` 行为测试
- **Mock 适配器**: 用于测试 `SignalRouter` 而不依赖真实 DEX
- **集成测试**: 在 testnet 上验证 Hyperliquid 适配器

---

## 9. 验收标准

1. `DEX_PROVIDER=hyperliquid` 时，系统行为与重构前完全一致
2. 切换 `DEX_PROVIDER` 无需修改任何业务逻辑代码
3. 新增 DEX 只需添加一个适配器文件并调用 `registerDex()`
4. 所有现有测试通过
