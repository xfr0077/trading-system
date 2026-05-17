# TS Engine — TypeScript 交易引擎

VPS 端交易执行引擎，负责接收 AI 信号、风控验证、执行 GRVT 订单。

## 快速开始

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

### 构建

```bash
npm run build
```

### 运行

```bash
npm start
```

### 测试

```bash
npm test
```

### 生成 gRPC 代码

```bash
npm run proto:generate
```

## 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `GRVT_API_KEY` | ✅ | - | GRVT 交易所 API 密钥 |
| `GRVT_ENV` | - | `testnet` | 运行环境：`testnet` 或 `mainnet` |
| `GRPC_PORT` | - | `50051` | gRPC 服务监听端口 |
| `REDIS_URL` | - | `redis://localhost:6379` | Redis 连接字符串 |
| `SQLITE_PATH` | - | `/data/trades.db` | SQLite 数据库路径 |
| `TAILSCALE_AI_IP` | ✅ | - | 本地 AI 的 Tailscale IP |

## 模块说明

### `config.ts` — 配置管理

- 从环境变量加载配置
- 启动时校验必需字段
- 类型安全的配置接口

```typescript
import { loadConfig } from './config';

const config = loadConfig();
console.log(config.grpcPort); // 50051
```

### `signal-router.ts` — gRPC 信号路由器

- 实现 `SignalService` gRPC 服务
- 信号去重（5 分钟 TTL 窗口）
- 输入参数验证
- 自动清理过期信号 ID
- 正确的 gRPC 错误状态码

```typescript
import { SignalRouter } from './signal-router';

const router = new SignalRouter();
const server = await router.startServer(50051);

// 处理信号
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

### `index.ts` — 入口文件

- 加载配置
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
│                                    │  风控引擎 (Phase 2)  │   │
│                                    └───────────┬─────────┘   │
│                                                │             │
│                                    ┌───────────▼─────────┐   │
│                                    │  GRVT 订单执行       │   │
│                                    │  (Phase 2)          │   │
│                                    └─────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 测试

```bash
# 运行所有测试
npm test

# 运行单个测试文件
npx jest tests/signal-router.test.ts

# 运行集成测试
npx jest tests/integration.test.ts --forceExit
```

### 测试覆盖

| 模块 | 测试文件 | 覆盖场景 |
|------|----------|----------|
| `config.ts` | `tests/config.test.ts` | 环境变量加载、缺失校验、类型校验 |
| `signal-router.ts` | `tests/signal-router.test.ts` | 信号接受、重复拒绝、参数验证 |
| 端到端 | `tests/integration/test_e2e.py` | gRPC 通信、健康检查、错误处理 |

## Phase 2 待实现

- [ ] `market-data.ts` — GRVT WebSocket 行情接收
- [ ] `order-manager.ts` — 订单状态机
- [ ] `risk-engine.ts` — 风控引擎
- [ ] `margin-monitor.ts` — 保证金监控
