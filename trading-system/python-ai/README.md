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

### 运行 AI 服务

```bash
python src/main.py
```

### 测试

```bash
pytest tests/ -v
```

## 环境变量

| 变量 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `TS_ENGINE_GRPC_URL` | - | `localhost:50051` | TS Engine gRPC 地址（Tailscale IP） |
| `REDIS_URL` | - | `redis://localhost:6379` | Redis 连接字符串 |
| `MODEL_PATH` | - | `models/model.onnx` | ONNX 模型路径 |
| `FEATURE_WINDOW` | - | `100` | K 线特征窗口大小 |
| `CONFIDENCE_THRESHOLD` | - | `70.0` | 最低置信度阈值 |
| `SYMBOLS` | - | `BTC_USDT_Perp` | 监控的交易对（逗号分隔） |

## 模块说明

### `config.py` — 配置管理

- Pydantic 模型验证
- 从环境变量/.env 加载配置
- 字段验证（gRPC URL 非空、置信度 0-100）

```python
from src.config import AIConfig

config = AIConfig.from_env()
print(config.ts_engine_grpc_url)  # localhost:50051
print(config.confidence_threshold)  # 70.0
```

### `redis_reader.py` — Redis 行情消费者

- 消费 TS Engine 写入的 Redis Streams `market:{symbol}`
- 跳尾机制：断线重连后跳过超过 1 秒的积压数据
- 阻塞读取（`BLOCK 5000`），持续产出行情数据

```python
from src.redis_reader import RedisMarketReader

reader = RedisMarketReader("redis://localhost:6379", ["BTC_USDT_Perp"])

async for data in reader.stream():
    print(f"{data.symbol}: {data.lastPrice}")
```

### `feature_engine.py` — 特征工程

- 技术指标计算：
  - 移动平均线（MA5, MA10, MA20）
  - RSI（14 周期）
  - MACD（12, 26, 9）
  - 布林带（20, 2）
  - 成交量变化率
  - 价格变化率
- 特征标准化（Z-Score，基于滚动窗口统计量）
- 输出固定长度的特征向量

```python
from src.feature_engine import FeatureEngine
from src.redis_reader import MarketData

engine = FeatureEngine(window_size=100)
features = engine.compute(price_data_list)  # 返回 shape=(1, n_features)
```

### `model_inference.py` — ONNX 模型推理

- CPU 模型加载（`onnxruntime.InferenceSession`）
- 输入：特征向量（来自 FeatureEngine）
- 输出：预测结果 + 置信度
- 置信度过滤（低于 `confidence_threshold` 返回 None）

```python
from src.model_inference import ModelInference

inference = ModelInference("models/model.onnx", confidence_threshold=70.0)
action, confidence = inference.predict(features)

if action is None:
    print(f"置信度 {confidence:.1f}% 低于阈值，跳过")
else:
    print(f"信号: {action}, 置信度: {confidence:.1f}%")
```

### `signal_client.py` — gRPC 信号客户端

- 发送交易信号到 TS Engine
- 参数校验（action、confidence、position_size 等）
- gRPC 错误处理（UNAVAILABLE、DEADLINE_EXCEEDED、INVALID_ARGUMENT）
- 连接管理（支持同步/异步上下文管理器）
- Keepalive 保活配置

```python
from src.signal_client import SignalClient, SignalError

# 同步上下文管理器
with SignalClient(target="100.x.x.x:50051") as client:
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

# 异步上下文管理器（用于 main.py）
async with SignalClient(target="100.x.x.x:50051") as client:
    ack = client.send_signal(...)
```

### `main.py` — AI 服务主循环

完整串联 AI 推理流程：
```
Redis MarketReader → FeatureEngine → ModelInference → SignalClient → TS Engine
```

```python
# 运行主循环
python src/main.py
```

## 测试

```bash
# 运行所有测试
pytest tests/ -v

# 运行单个测试文件
pytest tests/test_feature_engine.py -v
```

### 测试覆盖

| 模块 | 测试文件 | 覆盖场景 |
|------|----------|----------|
| `config.py` | `tests/test_config.py` | 默认配置、环境变量加载、字段验证 |
| `redis_reader.py` | `tests/test_redis_reader.py` | 行情解析、跳尾机制 |
| `feature_engine.py` | `tests/test_feature_engine.py` | 技术指标计算、特征向量 shape、标准化 |
| `model_inference.py` | `tests/test_model_inference.py` | ONNX 推理、置信度阈值过滤 |
| `signal_client.py` | `tests/test_signal_client.py` | 信号接受/拒绝、参数校验、gRPC 错误、连接管理 |

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Python AI 服务                            │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  Redis       │→│  特征工程     │→│  ONNX 模型推理    │   │
│  │  MarketReader│  │ (技术指标)    │  │ (CPU)            │   │
│  │ (跳尾机制)    │  │ MA/RSI/MACD  │  │ 置信度过滤       │   │
│  └──────────────┘  └──────────────┘  └────────┬─────────┘   │
│                                                │             │
│                                    ┌───────────▼─────────┐   │
│                                    │  SignalClient       │   │
│                                    │  (gRPC 发送信号)     │   │
│                                    │  - 参数校验         │   │
│                                    │  - 错误处理         │   │
│                                    │  - Keepalive        │   │
│                                    └─────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Phase 3 待实现

- [ ] 信号中携带 `order_ttl_ms`（订单超时时间）
- [ ] 信号中携带 `order_type`（限价/市价）
- [ ] 支持多模型并行推理
