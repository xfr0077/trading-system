# AI 自动化加密货币交易系统

> Lighter DEX 永续合约自动化交易系统，AI 信号驱动，模拟盘运行中。

## 架构概览

```
本地 PC (AI 推理)                          VPS 香港 (交易执行)
┌──────────────────────┐                  ┌──────────────────────────────┐
│ Redis → 特征工程     │                  │ gRPC Server → 风控引擎       │
│ → ONNX LSTM 推理     │ ──── gRPC ────→  │ → Lighter Adapter → Python  │
│ → SignalClient       │   (Tailscale)   │    Bridge → Lighter DEX 主网 │
└──────────────────────┘                  │ → SQLite + PositionTracker  │
                                          │ → Dashboard (端口 80)       │
                                          └──────────────────────────────┘
```

## 当前状态

| 项目 | 说明 |
|------|------|
| **模式** | 模拟盘 (PAPER_TRADING=true) |
| **DEX** | Lighter (mainnet) |
| **账户余额** | ~$215 (真实) / $10,000 (模拟) |
| **Dashboard** | http://43.247.132.103/ |
| **部署方式** | Docker Compose on VPS |

## 快速开始

### 前置要求

- **VPS 端**: Docker & Docker Compose v2+
- **本地端**: Python 3.10+, `pip install lighter-sdk`

### 部署

```bash
# 上传代码到 VPS 后
cd /opt/trading-system
docker compose build --no-cache
docker compose up -d

# 查看状态
docker compose ps
docker compose logs -f ts-engine
```
```

### 4. 配置本地 Python AI

```bash
cd python-ai

# 创建虚拟环境
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt

# 生成 gRPC 代码
python -m grpc_tools.protoc -I../proto --python_out=src/proto --grpc_python_out=src/proto ../proto/signal.proto

# 复制并编辑环境变量
cp .env.example .env
```

### 5. 运行测试

```bash
# TS Engine 单元测试
cd ts-engine
npm install
npm test

# Python AI 单元测试
cd ../python-ai
pytest tests/ -v

# 端到端集成测试
cd ..
pytest tests/integration/ -v
```

## 项目结构

```
trading-system/
├── proto/                          # gRPC Proto 定义
│   └── signal.proto                # 信号服务接口定义
├── ts-engine/                      # VPS 端 TypeScript 交易引擎
│   ├── src/
│   │   ├── index.ts                # 入口文件
│   │   ├── config.ts               # 配置管理（zod schema 校验）
│   │   ├── signal-router.ts        # gRPC Server（信号去重、验证、风控集成）
│   │   ├── risk-engine.ts          # 风控引擎（TTL/置信度/仓位/滑点/保证金/Shadow Position）
│   │   ├── margin-monitor.ts       # 保证金监控（阈值预警、状态回调）
│   │   ├── order-manager.ts        # 订单管理器（xstate 状态机）
│   │   ├── market-data.ts          # 行情数据流 + Redis 写入
│   │   └── dashboard.ts            # HTTP Dashboard（hono 路由）
│   ├── tests/                      # 单元测试
│   ├── proto/                      # 生成的 gRPC TypeScript 代码
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile                  # 多阶段构建，非 root 用户运行
│   └── .dockerignore
├── python-ai/                      # 本地 Python AI 服务
│   ├── src/
│   │   ├── main.py                 # AI 服务主循环
│   │   ├── config.py               # Pydantic 配置管理
│   │   ├── redis_reader.py         # Redis Streams 消费者（跳尾机制）
│   │   ├── feature_engine.py       # 特征工程（ta 库: MA/RSI/MACD/布林带）
│   │   ├── model_inference.py      # ONNX CPU 推理
│   │   ├── signal_client.py        # gRPC Client（发送信号到 TS Engine）
│   │   └── proto/                  # 生成的 gRPC Python 代码
│   ├── tests/                      # 单元测试
│   ├── requirements.txt
│   └── .env.example
├── tests/                          # 集成测试
│   └── integration/
│       ├── conftest.py             # 测试夹具（自动启动 TS Engine）
│       └── test_e2e.py             # 端到端通信测试
├── docker-compose.yml              # VPS 端服务编排（TS Engine + Redis）
├── .env.example                    # 环境变量模板
└── README.md
```

## 核心组件

### gRPC 信号服务

Proto 定义位于 `proto/signal.proto`，包含两个 RPC 方法：

| 方法 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `SendSignal` | `TradingSignal` | `SignalAck` | AI 发送交易信号到 TS Engine |
| `HealthCheck` | `HealthRequest` | `HealthResponse` | 健康检查 |

#### TradingSignal 字段

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `signal_id` | string | 唯一信号 ID（UUID） | `550e8400-e29b-41d4-a716-446655440000` |
| `symbol` | string | 交易对 | `BTC_USDT_Perp` |
| `action` | string | 操作类型：`long`/`short`/`close` | `long` |
| `stop_loss` | double | 止损价格 | `97000.0` |
| `take_profit` | double | 止盈价格 | `100000.0` |
| `confidence` | double | 置信度（0-100） | `75.0` |
| `position_size` | double | 仓位大小 | `0.01` |
| `timestamp` | int64 | 时间戳（毫秒） | `1716000000000` |
| `signal_price` | double | 信号触发价格 | `98500.0` |
| `max_slippage_bps` | int32 | 最大滑点（基点） | `10` |

### TS Engine

- **配置验证**: 启动时校验必需环境变量（`PRIVATE_KEY`、`GRPC_PORT`）
- **信号去重**: 5 分钟 TTL 窗口，自动清理过期信号 ID
- **输入验证**: 校验 action 合法性、confidence 范围、position_size 正数等
- **gRPC 错误处理**: 区分 `INVALID_ARGUMENT`、`UNAVAILABLE`、`DEADLINE_EXCEEDED` 等状态码
- **风控引擎**: TTL 校验、置信度、单笔仓位、滑点保护、保证金联动、Shadow Position
- **订单管理**: 状态机（pending → submitted → partially_filled → filled/cancelled/rejected）
- **行情数据**: Hyperliquid REST API (allMids) → Redis Streams → 内存价格缓存（3s 轮询）
- **保证金监控**: 自动阈值计算（warning/critical）、状态变更回调

### Python AI Client

- **参数校验**: 发送前验证信号参数，避免无效请求
- **错误处理**: 捕获 gRPC 异常并转换为 `SignalError`
- **连接管理**: 支持同步/异步上下文管理器，自动关闭 channel
- **Keepalive**: 默认配置 gRPC 保活选项，防止连接静默断开

## 部署指南

### VPS 端部署

1. **安装 Tailscale**

```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up
```

2. **配置防火墙**

```bash
# 仅允许 Tailscale 网络访问 gRPC 端口
ufw allow from 100.64.0.0/10 to any port 50051
```

3. **启动服务**

```bash
docker compose up -d --build
docker compose logs -f
```

### 本地 AI 端部署

1. **安装 Tailscale**（同上）

2. **获取 VPS 的 Tailscale IP**

```bash
tailscale status
# 找到 VPS 设备的 IP，如 100.x.x.x
```

3. **配置 .env**

```env
TS_ENGINE_GRPC_URL=100.x.x.x:50051  # VPS 的 Tailscale IP + gRPC 端口
```

4. **运行 AI 服务**

```bash
cd python-ai
python src/main.py
```

## 开发指南

### 添加新的 gRPC 方法

1. 编辑 `proto/signal.proto`
2. 重新生成代码：
   ```bash
   # TypeScript
   cd ts-engine && npm run proto:generate
   
   # Python
   cd python-ai && python -m grpc_tools.protoc -I../proto --python_out=src/proto --grpc_python_out=src/proto ../proto/signal.proto
   ```
3. 实现服务端逻辑（`signal-router.ts`）
4. 实现客户端方法（`signal_client.py`）
5. 编写测试

### 运行单个测试

```bash
# TypeScript
cd ts-engine && npx jest tests/risk-engine.test.ts

# Python
cd python-ai && pytest tests/test_feature_engine.py -v

# 集成测试
pytest tests/integration/test_e2e.py -v
```

## 环境变量

### TS Engine

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `PRIVATE_KEY` | ✅ | - | EVM 钱包私钥（Hyperliquid 签名） |
| `DEX` | - | `hyperliquid` | 交易所：`hyperliquid` 或 `grvt` |
| `DEX_ENV` | - | `testnet` | 运行环境：`testnet` 或 `production` |
| `GRPC_PORT` | - | `50051` | gRPC 服务监听端口 |
| `REDIS_URL` | - | `redis://localhost:6379` | Redis 连接字符串 |
| `SQLITE_PATH` | - | `/data/trades.db` | SQLite 数据库路径 |
| `TAILSCALE_AI_IP` | ✅ | - | 本地 AI 的 Tailscale IP |
| `GRPC_PORT` | - | `50051` | gRPC 监听端口 |
| `DASHBOARD_PORT` | - | `3000` | Dashboard HTTP 端口 |
| `MAX_POSITION_SIZE` | - | `0.1` | 单笔最大仓位 |
| `MAX_DAILY_LOSS` | - | `500` | 每日最大亏损（USDT） |
| `MAX_CONCURRENT_SIGNALS` | - | `3` | 同一标的最大并发持仓 |
| `MIN_CONFIDENCE` | - | `60.0` | 最低置信度阈值 |
| `MAX_PRICE_DEVIATION_PCT` | - | `0.5` | 最大价格偏差百分比 |
| `SIGNAL_TTL_MS` | - | `30000` | 信号有效期（毫秒） |
| `MARGIN_WARNING_THRESHOLD` | - | `0.7` | 保证金率预警阈值 |
| `MARGIN_CRITICAL_THRESHOLD` | - | `0.9` | 保证金率强平阈值 |

### Python AI

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `TS_ENGINE_GRPC_URL` | - | `localhost:50051` | TS Engine gRPC 地址 |
| `REDIS_URL` | - | `redis://localhost:6379` | Redis 连接字符串 |
| `MODEL_PATH` | - | `models/model.onnx` | ONNX 模型路径 |
| `FEATURE_WINDOW` | - | `100` | K 线特征窗口大小 |
| `CONFIDENCE_THRESHOLD` | - | `70.0` | 最低置信度阈值 |
| `SYMBOLS` | - | `BTC_USDT_Perp` | 监控的交易对（逗号分隔） |

## Phase 进度

### Phase 1 ✅ 已完成

- [x] 项目初始化与 Proto 定义
- [x] TS Engine 配置与日志系统
- [x] TS Engine 信号路由器 (gRPC Server)
- [x] Python AI gRPC Client
- [x] Docker Compose 配置 (VPS 端)
- [x] 集成测试 (端到端通信)

### Phase 2 ✅ 已完成

- [x] TS Engine 配置扩展（DEX 切换、风控参数）
- [x] Risk Engine（风控引擎 + Shadow Position）
- [x] Margin Monitor（保证金监控 + 阈值预警）
- [x] Order Manager（订单状态机 + 部分成交）
- [x] Market Data（Hyperliquid REST + Redis + 内存缓存）
- [x] SignalRouter 集成风控和滑点校验
- [x] Python AI 配置管理（Pydantic）
- [x] Python AI Redis 行情消费者（跳尾机制）
- [x] Python AI 特征工程（MA/RSI/MACD/布林带）
- [x] Python AI ONNX 模型推理（CPU）
- [x] Python AI 主循环

### Phase 3 ✅ 已完成

- [x] Hyperliquid SDK 实际下单（限价 + 市价，WebSocket 签名）
- [x] 订单超时取消（OrderTimeoutManager，支持重启恢复）
- [x] SQLite 持久化（订单 + 持仓 + 交易历史，WAL 模式）
- [x] Hyperliquid SDK 实际连接（hyperliquid 1.7.7，WebSocket + REST）
- [x] 信号优先级队列预留接口（ISignalQueue）
- [x] 重启恢复：从 SQLite 恢复未完成订单的取消定时器
- [x] 竞态防护：终态订单拒收后置状态变更

## 许可证

MIT
