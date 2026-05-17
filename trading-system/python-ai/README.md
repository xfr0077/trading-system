# Python AI 服务

本地 AI 推理服务，负责特征工程、模型推理、发送交易信号到 TS Engine。

## 快速开始

### 安装依赖

```bash
# 创建虚拟环境
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt
```

### 生成 gRPC 代码

```bash
python -m grpc_tools.protoc -I../proto --python_out=src/proto --grpc_python_out=src/proto ../proto/signal.proto
```

### 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件
```

### 测试

```bash
pytest tests/ -v
```

## 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `TS_ENGINE_GRPC_URL` | - | `localhost:50051` | TS Engine gRPC 地址（Tailscale IP） |
| `MODEL_PATH` | - | `models/model.onnx` | ONNX 模型路径 |
| `FEATURE_WINDOW` | - | `100` | K 线特征窗口大小 |
| `CONFIDENCE_THRESHOLD` | - | `70.0` | 最低置信度阈值 |

## 模块说明

### `signal_client.py` — gRPC 信号客户端

- 发送交易信号到 TS Engine
- 参数校验（action、confidence、position_size 等）
- gRPC 错误处理（UNAVAILABLE、DEADLINE_EXCEEDED、INVALID_ARGUMENT）
- 连接管理（支持上下文管理器）
- Keepalive 保活配置

```python
from signal_client import SignalClient, SignalError

# 使用上下文管理器（自动关闭连接）
with SignalClient(target="100.x.x.x:50051") as client:
    try:
        ack = client.send_signal(
            symbol="BTC_USDT_Perp",
            action="long",
            stop_loss=97000.0,
            take_profit=100000.0,
            confidence=75.0,
            position_size=0.01,
            signal_price=98500.0,
            max_slippage_bps=10,
        )
        
        if ack.accepted:
            print("信号已接受")
        else:
            print(f"信号被拒绝: {ack.reason}")
    except SignalError as e:
        print(f"发送失败: {e}")

# 健康检查
with SignalClient(target="100.x.x.x:50051") as client:
    if client.health_check():
        print("TS Engine 在线")
```

### `config.py` — 配置管理（Phase 2）

- 从环境变量/.env 加载配置
- Pydantic 模型验证
- 类型安全的配置接口

### `feature_engine.py` — 特征工程（Phase 2）

- K 线数据预处理
- 技术指标计算（MA、RSI、MACD、布林带等）
- 特征标准化/归一化
- 滑动窗口特征提取

### `model_inference.py` — ONNX 模型推理（Phase 2）

- CPU 模型加载（ONNX Runtime）
- 批量预测
- 置信度计算
- 信号生成逻辑

## 测试

```bash
# 运行所有测试
pytest tests/ -v

# 运行单个测试文件
pytest tests/test_signal_client.py -v

# 运行集成测试
pytest tests/integration/test_e2e.py -v
```

### 测试覆盖

| 模块 | 测试文件 | 覆盖场景 |
|------|----------|----------|
| `signal_client.py` | `tests/test_signal_client.py` | 信号接受/拒绝、参数校验、gRPC 错误处理、健康检查 |
| 端到端 | `tests/integration/test_e2e.py` | gRPC 通信、健康检查、错误处理 |

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Python AI 服务                            │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  行情数据     │→│  特征工程     │→│  ONNX 模型推理    │   │
│  │ (WebSocket)  │  │ (技术指标)    │  │ (CPU)            │   │
│  └──────────────┘  └──────────────┘  └────────┬─────────┘   │
│                                                │             │
│                                    ┌───────────▼─────────┐   │
│                                    │  信号生成            │   │
│                                    │  (置信度过滤)        │   │
│                                    └───────────┬─────────┘   │
│                                                │             │
│                                    ┌───────────▼─────────┐   │
│                                    │  gRPC Client         │   │
│                                    │  (SignalClient)      │   │
│                                    └─────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Phase 2 待实现

- [ ] `config.py` — 配置管理（Pydantic）
- [ ] `feature_engine.py` — 特征工程
- [ ] `model_inference.py` — ONNX 模型推理
- [ ] `main.py` — 入口文件（完整 AI 服务循环）
