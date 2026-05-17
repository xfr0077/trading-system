# AI 自动化加密货币交易系统

> 基于混合架构的 AI 驱动加密货币交易系统，VPS 端执行交易，本地端运行 AI 推理，通过 Tailscale 安全通信。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        本地 PC (AI 推理)                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  特征工程     │→│  ONNX 模型    │→│  gRPC Client         │   │
│  │ feature_eng  │  │ inference    │  │  (SignalClient)      │   │
│  └──────────────┘  └──────────────┘  └──────────┬───────────┘   │
└─────────────────────────────────────────────────┼───────────────┘
                                                  │ Tailscale
                                                  │ (加密隧道)
                                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                   VPS 香港 (交易执行)                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  gRPC Server │→│  风控引擎     │→│  GRVT DEX 订单执行    │   │
│  │ SignalRouter │  │ risk_engine  │  │  (AWS Tokyo)         │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
│        │                                                        │
│        ▼                                                        │
│  ┌──────────────┐  ┌──────────────┐                             │
│  │  Redis       │  │  SQLite WAL  │                             │
│  │  (行情缓存)   │  │  (交易记录)   │                             │
│  └──────────────┘  └──────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

### 为什么选择混合架构？

| 考量 | 方案 | 理由 |
|------|------|------|
| **执行延迟** | VPS 香港 | GRVT 交易所位于 AWS Tokyo，香港 VPS 延迟 ~150ms，满足 1m/5m 时间帧交易需求 |
| **推理算力** | 本地 PC | 避免云端 GPU 成本，利用本地 CPU 运行 ONNX 模型（~10-30ms 推理延迟可接受） |
| **网络安全** | Tailscale | 绕过 GFW 和公共网络不稳定，提供端到端加密的虚拟局域网 |
| **数据安全** | 本地推理 | 模型和交易策略保留在本地，不暴露给云端 |

## 快速开始

### 前置要求

- **VPS 端**: Docker & Docker Compose v2+, Node.js 20+
- **本地端**: Python 3.10+, Tailscale 客户端
- **网络**: 两端均安装并登录 Tailscale，确保可互相访问

### 1. 克隆项目

```bash
git clone <your-repo-url>
cd trading-system
```

### 2. 配置环境变量

```bash
# 复制并编辑环境变量
cp .env.example .env

# 编辑 .env 文件，填入真实值
# GRVT_API_KEY: 从 https://app.grvt.io 获取
# GRVT_ENV: testnet（测试）或 mainnet（生产）
# TAILSCALE_AI_IP: 本地 AI 设备的 Tailscale IP（通过 `tailscale status` 查看）
```

### 3. 启动 VPS 端服务

```bash
# 构建并启动 Docker 容器
docker compose up -d --build

# 查看服务状态
docker compose ps

# 查看日志
docker compose logs -f ts-engine
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
│   │   ├── config.ts               # 配置管理（环境变量校验）
│   │   └── signal-router.ts        # gRPC Server（信号去重、验证）
│   ├── tests/                      # 单元测试
│   ├── proto/                      # 生成的 gRPC TypeScript 代码
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile                  # 多阶段构建，非 root 用户运行
│   └── .dockerignore
├── python-ai/                      # 本地 Python AI 服务
│   ├── src/
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

- **配置验证**: 启动时校验必需环境变量（`GRVT_API_KEY`、`GRVT_ENV`、`GRPC_PORT`）
- **信号去重**: 5 分钟 TTL 窗口，自动清理过期信号 ID
- **输入验证**: 校验 action 合法性、confidence 范围、position_size 正数等
- **gRPC 错误处理**: 区分 `INVALID_ARGUMENT`、`UNAVAILABLE`、`DEADLINE_EXCEEDED` 等状态码

### Python AI Client

- **参数校验**: 发送前验证信号参数，避免无效请求
- **错误处理**: 捕获 gRPC 异常并转换为 `SignalError`
- **连接管理**: 支持上下文管理器（`with` 语句），自动关闭 channel
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
cd ts-engine && npx jest tests/signal-router.test.ts

# Python
cd python-ai && pytest tests/test_signal_client.py -v

# 集成测试
pytest tests/integration/test_e2e.py -v
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

## Phase 2 计划

Phase 1 已完成基础通信框架，Phase 2 将实现：

- [ ] **GRVT WebSocket 行情接收** (`market-data.ts`) — 实时接收 K 线和深度数据
- [ ] **订单管理器** (`order-manager.ts`) — 订单状态机、生命周期管理
- [ ] **风控引擎** (`risk-engine.ts`) — 仓位限制、最大回撤、风险敞口计算
- [ ] **保证金监控** (`margin-monitor.ts`) — 实时保证金率、强平预警
- [ ] **Python 特征工程** (`feature_engine.py`) — 技术指标计算、特征标准化
- [ ] **ONNX 模型推理** (`model_inference.py`) — CPU 模型加载、批量预测

## 许可证

MIT
