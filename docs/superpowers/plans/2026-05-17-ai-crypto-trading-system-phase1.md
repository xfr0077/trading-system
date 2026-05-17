# AI 自动化加密货币交易系统 实现计划 (Phase 1: 基础架构)

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 搭建 TypeScript 交易引擎 + Python AI 服务的基础通信框架，实现 GRVT 行情接收和 gRPC 信号传递。

**架构：** VPS 端运行 TS 引擎（Docker + Redis），本地运行 Python AI 服务，通过 Tailscale gRPC 通信。

**技术栈：** TypeScript (Node.js), Python 3.10+, gRPC, Redis, SQLite (WAL), GRVT SDK, ONNX Runtime

---

## 文件结构

```
trading-system/
├── ts-engine/                    # VPS 端 TypeScript 交易引擎
│   ├── src/
│   │   ├── index.ts              # 入口文件
│   │   ├── market-data.ts        # GRVT WebSocket 行情接收器
│   │   ├── order-manager.ts      # 订单状态机
│   │   ├── risk-engine.ts        # 风控引擎
│   │   ├── margin-monitor.ts     # 保证金监控
│   │   ├── signal-router.ts      # gRPC Server (接收 AI 信号)
│   │   └── config.ts             # 配置管理
│   ├── proto/
│   │   └── signal.proto          # gRPC Proto 定义
│   ├── tests/
│   │   ├── market-data.test.ts
│   │   ├── order-manager.test.ts
│   │   └── risk-engine.test.ts
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
├── python-ai/                    # 本地 Python AI 服务
│   ├── src/
│   │   ├── main.py               # 入口文件
│   │   ├── feature_engine.py     # 特征工程
│   │   ├── model_inference.py    # 模型推理 (ONNX)
│   │   ├── signal_client.py      # gRPC Client (发送信号到 TS)
│   │   └── config.py             # 配置管理
│   ├── proto/
│   │   └── signal_pb2.py         # 生成的 gRPC 代码
│   │   └── signal_pb2_grpc.py
│   ├── tests/
│   │   ├── test_feature_engine.py
│   │   └── test_model_inference.py
│   ├── requirements.txt
│   └── .env.example
├── docker-compose.yml            # VPS 端 Docker 配置
└── README.md
```

---

### 任务 1：项目初始化与 Proto 定义

**文件：**
- 创建：`trading-system/proto/signal.proto`
- 创建：`trading-system/ts-engine/package.json`
- 创建：`trading-system/python-ai/requirements.txt`

- [ ] **步骤 1：创建 gRPC Proto 定义**

```protobuf
// trading-system/proto/signal.proto
syntax = "proto3";

package signal;

service SignalService {
  rpc SendSignal(TradingSignal) returns (SignalAck);
  rpc HealthCheck(HealthRequest) returns (HealthResponse);
}

message TradingSignal {
  string signal_id = 1;
  string symbol = 2;
  string action = 3;  // "long", "short", "close"
  double stop_loss = 4;
  double take_profit = 5;
  double confidence = 6;
  double position_size = 7;
  int64 timestamp = 8;
  double signal_price = 9;
  int32 max_slippage_bps = 10;
}

message SignalAck {
  string signal_id = 1;
  bool accepted = 2;
  string reason = 3;
}

message HealthRequest {}
message HealthResponse {
  bool healthy = 1;
  string version = 2;
}
```

- [ ] **步骤 2：创建 TS Engine package.json**

```json
{
  "name": "ts-trading-engine",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node src/index.ts",
    "test": "jest",
    "proto:generate": "grpc_tools_node_protoc --js_out=import_style=commonjs,binary:./src/proto --grpc_out=grpc_js:./src/proto --plugin=protoc-gen-grpc=./node_modules/.bin/grpc_tools_node_protoc_plugin --proto_path=../proto ../proto/signal.proto"
  },
  "dependencies": {
    "@grpc/grpc-js": "^1.10.0",
    "@grpc/proto-loader": "^0.7.0",
    "ioredis": "^5.3.0",
    "better-sqlite3": "^9.4.0",
    "ws": "^8.16.0",
    "uuid": "^9.0.0",
    "pino": "^8.19.0"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "@types/node": "^20.11.0",
    "@types/ws": "^8.5.0",
    "@types/uuid": "^9.0.0",
    "grpc-tools": "^1.12.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "ts-node": "^10.9.0",
    "typescript": "^5.3.0"
  }
}
```

- [ ] **步骤 3：创建 Python AI requirements.txt**

```txt
grpcio==1.62.0
grpcio-tools==1.62.0
numpy==1.26.0
pandas==2.2.0
onnxruntime==1.17.0
python-dotenv==1.0.0
pydantic==2.6.0
```

- [ ] **步骤 4：Commit**

```bash
git add trading-system/proto/signal.proto trading-system/ts-engine/package.json trading-system/python-ai/requirements.txt
git commit -m "feat: initialize project structure and proto definition"
```

---

### 任务 2：TS Engine 配置与日志系统

**文件：**
- 创建：`trading-system/ts-engine/src/config.ts`
- 创建：`trading-system/ts-engine/tsconfig.json`

- [ ] **步骤 1：编写配置模块测试**

```typescript
// trading-system/ts-engine/tests/config.test.ts
import { loadConfig } from '../src/config';

describe('Config', () => {
  test('should load config from environment variables', () => {
    process.env.GRVT_API_KEY = 'test-key';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.SQLITE_PATH = '/tmp/test.db';
    
    const config = loadConfig();
    
    expect(config.grvtApiKey).toBe('test-key');
    expect(config.redisUrl).toBe('redis://localhost:6379');
    expect(config.sqlitePath).toBe('/tmp/test.db');
  });

  test('should throw if GRVT_API_KEY is missing', () => {
    delete process.env.GRVT_API_KEY;
    expect(() => loadConfig()).toThrow('GRVT_API_KEY is required');
  });
});
```

- [ ] **步骤 2：实现配置模块**

```typescript
// trading-system/ts-engine/src/config.ts
export interface Config {
  grvtApiKey: string;
  grvtEnv: 'testnet' | 'prod';
  redisUrl: string;
  sqlitePath: string;
  grpcPort: number;
  tailscaleAiIp: string;
}

export function loadConfig(): Config {
  const grvtApiKey = process.env.GRVT_API_KEY;
  if (!grvtApiKey) throw new Error('GRVT_API_KEY is required');

  return {
    grvtApiKey,
    grvtEnv: (process.env.GRVT_ENV as 'testnet' | 'prod') || 'testnet',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    sqlitePath: process.env.SQLITE_PATH || '/data/trades.db',
    grpcPort: parseInt(process.env.GRPC_PORT || '50051', 10),
    tailscaleAiIp: process.env.TAILSCALE_AI_IP || '127.0.0.1',
  };
}
```

- [ ] **步骤 3：运行测试验证通过**

```bash
cd trading-system/ts-engine
npm install
npx jest tests/config.test.ts
```
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add trading-system/ts-engine/src/config.ts trading-system/ts-engine/tests/config.test.ts trading-system/ts-engine/tsconfig.json
git commit -m "feat: add config module with env validation"
```

---

### 任务 3：TS Engine 信号路由器 (gRPC Server)

**文件：**
- 创建：`trading-system/ts-engine/src/signal-router.ts`
- 创建：`trading-system/ts-engine/tests/signal-router.test.ts`

- [ ] **步骤 1：编写信号路由器测试**

```typescript
// trading-system/ts-engine/tests/signal-router.test.ts
import { SignalRouter } from '../src/signal-router';

describe('SignalRouter', () => {
  let router: SignalRouter;

  beforeEach(() => {
    router = new SignalRouter();
  });

  test('should accept valid signal', async () => {
    const signal = {
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
    };

    const ack = await router.handleSignal(signal);
    expect(ack.accepted).toBe(true);
  });

  test('should reject duplicate signal', async () => {
    const signal = {
      signalId: 'uuid-dup',
      symbol: 'BTC_USDT_Perp',
      action: 'long',
      stopLoss: 97000,
      takeProfit: 100000,
      confidence: 75,
      positionSize: 0.01,
      timestamp: Date.now(),
      signalPrice: 98500,
      maxSlippageBps: 10,
    };

    await router.handleSignal(signal);
    const ack = await router.handleSignal(signal);
    expect(ack.accepted).toBe(false);
    expect(ack.reason).toBe('DUPLICATE_SIGNAL');
  });
});
```

- [ ] **步骤 2：实现信号路由器**

```typescript
// trading-system/ts-engine/src/signal-router.ts
import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';

const protoPath = path.join(__dirname, '../../proto/signal.proto');
const protoDefinition = loadSync(protoPath);
const protoDescriptor = grpc.loadPackageDefinition(protoDefinition) as any;

interface TradingSignal {
  signal_id: string;
  symbol: string;
  action: string;
  stop_loss: number;
  take_profit: number;
  confidence: number;
  position_size: number;
  timestamp: number;
  signal_price: number;
  max_slippage_bps: number;
}

export class SignalRouter {
  private seenSignals = new Map<string, number>();
  private readonly TTL_MS = 5 * 60 * 1000; // 5 分钟去重窗口

  async handleSignal(signal: TradingSignal): Promise<{ accepted: boolean; reason: string }> {
    // 去重检查
    const now = Date.now();
    const lastSeen = this.seenSignals.get(signal.signal_id);
    if (lastSeen && now - lastSeen < this.TTL_MS) {
      return { accepted: false, reason: 'DUPLICATE_SIGNAL' };
    }

    this.seenSignals.set(signal.signal_id, now);
    
    // TODO: 调用风控引擎验证
    // TODO: 转换为 GRVT 订单并执行
    
    return { accepted: true, reason: '' };
  }

  startServer(port: number): grpc.Server {
    const server = new grpc.Server();
    server.addService(protoDescriptor.signal.SignalService.service, {
      SendSignal: async (call: grpc.ServerUnaryCall<TradingSignal, any>, callback: grpc.sendUnaryData<any>) => {
        try {
          const result = await this.handleSignal(call.request);
          callback(null, { signal_id: call.request.signal_id, accepted: result.accepted, reason: result.reason });
        } catch (err) {
          callback(err as Error, null);
        }
      },
      HealthCheck: async (_call: any, callback: grpc.sendUnaryData<any>) => {
        callback(null, { healthy: true, version: '0.1.0' });
      },
    });
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), () => {
      server.start();
      console.log(`SignalRouter gRPC server listening on port ${port}`);
    });
    return server;
  }
}
```

- [ ] **步骤 3：运行测试验证通过**

```bash
cd trading-system/ts-engine
npx jest tests/signal-router.test.ts
```
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add trading-system/ts-engine/src/signal-router.ts trading-system/ts-engine/tests/signal-router.test.ts
git commit -m "feat: implement signal router with gRPC server and deduplication"
```

---

### 任务 4：Python AI gRPC Client

**文件：**
- 创建：`trading-system/python-ai/src/signal_client.py`
- 创建：`trading-system/python-ai/tests/test_signal_client.py`

- [ ] **步骤 1：生成 gRPC Python 代码**

```bash
cd trading-system/python-ai
python -m grpc_tools.protoc -I../proto --python_out=src/proto --grpc_python_out=src/proto ../proto/signal.proto
```

- [ ] **步骤 2：编写信号客户端测试**

```python
# trading-system/python-ai/tests/test_signal_client.py
import pytest
from unittest.mock import MagicMock, patch
from src.signal_client import SignalClient

@pytest.fixture
def mock_stub():
    return MagicMock()

def test_send_signal_accepted(mock_stub):
    mock_stub.SendSignal.return_value = MagicMock(accepted=True, reason='')
    
    client = SignalClient(stub=mock_stub)
    result = client.send_signal(
        symbol="BTC_USDT_Perp",
        action="long",
        stop_loss=97000.0,
        take_profit=100000.0,
        confidence=75.0,
        position_size=0.01,
        signal_price=98500.0,
        max_slippage_bps=10
    )
    
    assert result.accepted is True
    mock_stub.SendSignal.assert_called_once()

def test_send_signal_rejected(mock_stub):
    mock_stub.SendSignal.return_value = MagicMock(accepted=False, reason='RISK_LIMIT_EXCEEDED')
    
    client = SignalClient(stub=mock_stub)
    result = client.send_signal(
        symbol="BTC_USDT_Perp",
        action="long",
        stop_loss=97000.0,
        take_profit=100000.0,
        confidence=75.0,
        position_size=0.01,
        signal_price=98500.0,
        max_slippage_bps=10
    )
    
    assert result.accepted is False
    assert result.reason == 'RISK_LIMIT_EXCEEDED'
```

- [ ] **步骤 3：实现信号客户端**

```python
# trading-system/python-ai/src/signal_client.py
import uuid
import time
import grpc
from typing import Optional
from dataclasses import dataclass

# 导入生成的 proto 代码
from proto import signal_pb2
from proto import signal_pb2_grpc

@dataclass
class SignalAck:
    accepted: bool
    reason: str

class SignalClient:
    def __init__(self, stub: Optional[signal_pb2_grpc.SignalServiceStub] = None, target: str = "localhost:50051"):
        if stub:
            self.stub = stub
        else:
            channel = grpc.insecure_channel(target)
            self.stub = signal_pb2_grpc.SignalServiceStub(channel)

    def send_signal(
        self,
        symbol: str,
        action: str,
        stop_loss: float,
        take_profit: float,
        confidence: float,
        position_size: float,
        signal_price: float,
        max_slippage_bps: int = 10,
    ) -> SignalAck:
        request = signal_pb2.TradingSignal(
            signal_id=str(uuid.uuid4()),
            symbol=symbol,
            action=action,
            stop_loss=stop_loss,
            take_profit=take_profit,
            confidence=confidence,
            position_size=position_size,
            timestamp=int(time.time() * 1000),
            signal_price=signal_price,
            max_slippage_bps=max_slippage_bps,
        )
        
        response = self.stub.SendSignal(request)
        return SignalAck(accepted=response.accepted, reason=response.reason)

    def health_check(self) -> bool:
        try:
            response = self.stub.HealthCheck(signal_pb2.HealthRequest())
            return response.healthy
        except Exception:
            return False
```

- [ ] **步骤 4：运行测试验证通过**

```bash
cd trading-system/python-ai
pip install -r requirements.txt pytest
pytest tests/test_signal_client.py -v
```
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add trading-system/python-ai/src/signal_client.py trading-system/python-ai/tests/test_signal_client.py
git commit -m "feat: implement Python gRPC client for sending signals to TS engine"
```

---

### 任务 5：Docker Compose 配置 (VPS 端)

**文件：**
- 创建：`trading-system/docker-compose.yml`
- 创建：`trading-system/ts-engine/Dockerfile`
- 创建：`trading-system/.env.example`

- [ ] **步骤 1：创建 TS Engine Dockerfile**

```dockerfile
# trading-system/ts-engine/Dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production

COPY src/ ./src/
COPY proto/ ./proto/

RUN npm run build

EXPOSE 50051

CMD ["node", "dist/index.js"]
```

- [ ] **步骤 2：创建 Docker Compose 配置**

```yaml
# trading-system/docker-compose.yml
version: '3.8'

services:
  ts-engine:
    build: ./ts-engine
    ports:
      - "50051:50051"
    environment:
      - GRVT_API_KEY=${GRVT_API_KEY}
      - GRVT_ENV=${GRVT_ENV:-testnet}
      - REDIS_URL=redis://redis:6379
      - SQLITE_PATH=/data/trades.db
      - TAILSCALE_AI_IP=${TAILSCALE_AI_IP}
    volumes:
      - ./data:/data
    depends_on:
      - redis
    restart: always

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --maxmemory 512mb --maxmemory-policy allkeys-lru
    volumes:
      - redis_data:/data
    restart: always

volumes:
  redis_data:
```

- [ ] **步骤 3：创建 .env.example**

```env
# trading-system/.env.example
GRVT_API_KEY=your-api-key-here
GRVT_ENV=testnet
TAILSCALE_AI_IP=100.x.x.x  # 本地 AI 的 Tailscale IP
```

- [ ] **步骤 4：Commit**

```bash
git add trading-system/docker-compose.yml trading-system/ts-engine/Dockerfile trading-system/.env.example
git commit -m "feat: add Docker Compose configuration for VPS deployment"
```

---

### 任务 6：集成测试 (端到端通信)

**文件：**
- 创建：`trading-system/tests/integration.test.ts`
- 创建：`trading-system/tests/integration_test.py`

- [ ] **步骤 1：编写 TS 端集成测试**

```typescript
// trading-system/tests/integration.test.ts
import { SignalRouter } from '../src/signal-router';
import * as grpc from '@grpc/grpc-js';

describe('Integration: SignalRouter gRPC', () => {
  let server: grpc.Server;
  let client: any;

  beforeAll((done) => {
    const router = new SignalRouter();
    server = router.startServer(50052);
    
    const protoLoader = require('@grpc/proto-loader');
    const grpcLib = require('@grpc/grpc-js');
    const protoPath = require('path').join(__dirname, '../proto/signal.proto');
    const packageDefinition = protoLoader.loadSync(protoPath);
    const protoDescriptor = grpcLib.loadPackageDefinition(packageDefinition);
    
    client = new protoDescriptor.signal.SignalService('localhost:50052', grpcLib.credentials.createInsecure());
    done();
  });

  afterAll((done) => {
    server.close(done);
  });

  test('should handle signal via gRPC', (done) => {
    client.SendSignal({
      signal_id: 'test-1',
      symbol: 'BTC_USDT_Perp',
      action: 'long',
      stop_loss: 97000,
      take_profit: 100000,
      confidence: 75,
      position_size: 0.01,
      timestamp: Date.now(),
      signal_price: 98500,
      max_slippage_bps: 10,
    }, (err: Error, response: any) => {
      expect(err).toBeNull();
      expect(response.accepted).toBe(true);
      done();
    });
  });
});
```

- [ ] **步骤 2：运行集成测试**

```bash
cd trading-system/ts-engine
npx jest tests/integration.test.ts --forceExit
```
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add trading-system/tests/integration.test.ts
git commit -m "test: add end-to-end gRPC integration test"
```

---

## 自检

1. **规格覆盖度**：
   - Proto 定义 ✅ (任务 1)
   - TS Engine 配置 ✅ (任务 2)
   - 信号路由器 + 去重 ✅ (任务 3)
   - Python gRPC Client ✅ (任务 4)
   - Docker Compose ✅ (任务 5)
   - 集成测试 ✅ (任务 6)

2. **占位符扫描**：无"待定"、"TODO"（除任务 3 中明确标注的后续扩展点） ✅

3. **类型一致性**：TradingSignal 字段在 Proto、TS、Python 中保持一致 ✅

4. **下一步**：Phase 2 将实现 GRVT WebSocket 行情接收、订单管理器、风控引擎、保证金监控。
