# AI 自动化加密货币交易系统 - 架构设计

**日期：** 2026-05-17
**状态：** 待审查
**版本：** v2.0

---

## 1. 系统概述

构建一个基于 GRVT DEX 的 AI 自动化加密货币交易系统，采用 **混合部署架构**（VPS 执行 + 本地 AI 决策），支持多品种交易，具备严格的风控和可观测性。

### 核心设计原则
1. **职责分离**：VPS 上的 TS 引擎负责执行与风控，本地 Python 负责 AI 决策。
2. **故障隔离**：AI 服务挂了，VPS 交易层仍能执行风控撤单。
3. **现实延迟**：GRVT(东京) → VPS(香港) <150ms，VPS ↔ 本地 AI <10ms (内网) / ~100-200ms (公网)。
4. **可移植**：VPS 端 Docker 容器化，换服务器一键迁移。
5. **防御性编程**：针对网络断流、重复下单、幽灵仓位等生产环境问题设计防御机制。

---

## 2. 整体架构 (混合部署)

```
┌─────────────────────────────────────────────────────────────┐
│                    GRVT DEX (AWS 东京)                       │
│  WebSocket: 行情/订单簿/成交  |  REST API: 下单/查询          │
└────────────────────────────┬────────────────────────────────┘
                             │ WebSocket + HTTPS (<150ms)
                             ↓
┌─────────────────────────────────────────────────────────────┐
│  VPS (香港) - 执行层                                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  TypeScript 交易引擎 (Node.js + Docker)               │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  │   │
│  │  │ 行情接收器   │  │  订单管理器   │  │  保证金监控  │  │   │
│  │  │ (WebSocket) │→ │ (状态机)     │→ │ (强平预警)   │  │   │
│  │  └─────────────┘  └──────────────┘  └─────────────┘  │   │
│  │         ↓                  ↑                    ↓     │   │
│  │  ┌────────────────────────────────────────────────┐   │   │
│  │  │              信号路由器 & 风控引擎              │   │   │
│  │  │  (滑点检查/去重) → (仓位/亏损限制) → 下单       │   │   │
│  │  └──────────────────────┬─────────────────────────┘   │   │
│  └─────────────────────────┼─────────────────────────────┘   │
│                             │ Tailscale (gRPC)                │
└─────────────────────────────┼─────────────────────────────────┘
                              │
┌─────────────────────────────┼─────────────────────────────────┐
│  本地电脑 - 决策层           │                                 │
│  ┌─────────────────────────┼──────────────────────────────┐   │
│  │  Python AI 服务 (Direct Run)                            │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐    │   │
│  │  │ 特征工程     │  │  模型推理     │  │  策略管理    │    │   │
│  │  │ (指标计算)   │→ │ (CPU/ONNX)   │→ │ (参数调优)   │    │   │
│  │  └─────────────┘  └──────────────┘  └─────────────┘    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                             │                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              数据持久化层                                 │  │
│  │  ┌─────────────┐              ┌──────────────────┐       │  │
│  │  │ SQLite (WAL)│              │ Parquet 文件      │       │  │
│  │  │ (VPS:交易)   │              │ (本地:历史/回测)   │       │  │
│  │  └─────────────┘              └──────────────────┘       │  │
│  └──────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

---

## 3. 核心组件设计

### 3.1 TypeScript 交易引擎 (VPS)

#### 3.1.1 行情接收器 (MarketDataReceiver)
- **职责**：订阅 GRVT WebSocket，接收订单簿、成交、K 线数据
- **技术**：`ws` 库 + 自动重连机制
- **防御机制**：
  - WebSocket 心跳检测（每 15 秒 ping/pong，适应 GFW 环境）
  - 断线自动重连（指数退避：1s → 2s → 5s → 10s，最大 10 秒）
  - 数据完整性校验（序列号检查，防止丢包）
  - **幽灵仓位防御**：断线期间每 2 秒通过 REST API 轮询仓位状态，重连后立即全量同步。

#### 3.1.2 订单管理器 (OrderManager)
- **职责**：跟踪订单生命周期（新建→部分成交→完成/撤销）
- **技术**：状态机模式
- **防御机制**：
  - UUID 去重（防止重复下单）
  - 订单超时自动撤单（30 秒未成交则撤销）
  - 状态持久化到 SQLite（WAL 模式，重启后可恢复）

#### 3.1.3 保证金监控 (MarginMonitor)
- **职责**：实时监控账户保证金率，防止强平
- **防御机制**：
  - 实时计算预估强平价 (Liquidation Price)
  - 保证金率 < 150% 时触发告警
  - 保证金率 < 120% 时强制减仓/平仓
  - 独立于 AI 信号运行，优先级最高

#### 3.1.4 信号路由器 & 风控引擎 (SignalRouter & RiskEngine)
- **职责**：接收 AI 信号，执行风控检查，转换为 GRVT 订单指令
- **技术**：gRPC Server
- **硬性规则**：
  - 单笔最大亏损 ≤ 账户 2%
  - 单日最大亏损 ≤ 账户 5%
  - 总仓位 ≤ 账户 50%
  - 下单频率限制（每品种每秒最多 1 单）
- **防御机制**：
  - 滑点检查：执行价偏离信号价 > 设定基点 (bps) 则拒绝执行
  - 信号去重：相同信号 5 秒内只执行一次
  - 降级模式：AI 不可用时使用保守策略

### 3.2 Python AI 服务 (本地)

#### 3.2.1 特征工程 (FeatureEngine)
- **职责**：计算技术指标、订单簿特征、波动率
- **输入**：来自 VPS 的行情数据 (通过 Tailscale)
- **输出**：特征向量（NumPy 数组）
- **防御机制**：
  - 特征值范围检查（防止 NaN/Inf）
  - 缺失值填充（使用前值或零值）

#### 3.2.2 模型推理 (ModelInference)
- **职责**：运行训练好的模型，输出买卖信号
- **技术**：ONNX Runtime (CPU 推理，延迟 10-30ms)
- **输出**：`{ direction, action, stop_loss, take_profit, confidence, position_size, signal_price, max_slippage_bps }`
- **防御机制**：
  - 模型版本管理（支持热切换）
  - 推理超时处理（>200ms 返回保守信号）

### 3.3 通信层

#### 3.3.1 Tailscale 虚拟局域网
- **用途**：安全连接 VPS 与本地电脑，绕过公网不稳定和 GFW 干扰
- **优势**：端到端加密，P2P 直连（延迟 ~50-100ms），配置简单

#### 3.3.2 gRPC (Python → TS)
- **用途**：传递交易信号
- **Proto 定义 (v2)**：
  ```protobuf
  service SignalService {
    rpc SendSignal(TradingSignal) returns (SignalAck);
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
    double signal_price = 9;      // 新增：发出信号时的价格
    int32 max_slippage_bps = 10;  // 新增：最大容忍滑点 (基点)
  }
  
  message SignalAck {
    string signal_id = 1;
    bool accepted = 2;
    string reason = 3;  // 如果 rejected，说明原因 (e.g., "SLIPPAGE_TOO_HIGH")
  }
  ```

### 3.4 数据持久化

#### 3.4.1 SQLite (VPS - 实时交易)
- **用途**：存储交易记录、订单状态、风控日志
- **优化**：
  - 启用 WAL (Write-Ahead Logging) 模式，支持高并发读写
  - 设置 `busy_timeout=5000`，避免 `database is locked` 异常

#### 3.4.2 Parquet 文件 (本地 - 历史行情)
- **用途**：存储历史行情数据，用于回测和模型训练
- **目录结构**：
  ```
  data/
  ├── market_data/
  │   ├── BTC_USDT_Perp/
  │   │   ├── 2026-05-17.parquet
  │   │   └── 2026-05-18.parquet
  │   └── ETH_USDT_Perp/
  └── features/
      └── ...
  ```

---

## 4. 防御性设计 (生产级)

### 4.1 订单去重机制
```
每个信号生成唯一 signal_id (UUID)
↓
VPS Redis 记录已发送的 signal_id (TTL 24h)
↓
发送前检查：如果 signal_id 已存在 → 丢弃
↓
GRVT 返回成交确认 → 更新状态
```

### 4.2 止盈止损三重保障
1. **GRVT 服务端止损单**：下单时直接带 `stop_loss`/`take_profit` 参数
2. **本地监控**：WebSocket 实时价格检查，触发时主动平仓
3. **独立风控进程**：每 100ms 检查一次仓位，异常时强制撤单

### 4.3 信号滑点追踪
```typescript
// TS 执行时检查：
const slippage = Math.abs(executionPrice - signal.signal_price) / signal.signal_price;
const maxSlippage = signal.max_slippage_bps / 10000;

if (slippage > maxSlippage) {
  logger.warn('SLIPPAGE_TOO_HIGH', { signal_id: signal.signal_id, slippage, maxSlippage });
  return reject_signal("SLIPPAGE_TOO_HIGH");
}
```

### 4.4 错误处理策略
- **不吞错误**：所有异常必须记录日志（结构化 JSON 格式）
- **重试机制**：网络请求失败自动重试（最多 3 次，指数退避）
- **熔断器**：连续失败 5 次后暂停该组件，防止雪崩

---

## 5. 部署架构

### 5.1 VPS Docker Compose 配置
```yaml
version: '3.8'

services:
  ts-engine:
    build: ./ts-engine
    ports:
      - "50051:50051"  # gRPC (供本地 AI 调用)
    environment:
      - GRVT_API_KEY=${GRVT_API_KEY}
      - REDIS_URL=redis://redis:6379
      - SQLITE_PATH=/data/trades.db
      - TAILSCALE_IP=${TAILSCALE_IP}  # 本地 AI 的 Tailscale IP
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

### 5.2 本地 Python AI 部署
- **环境**：Python 3.10+，ONNX Runtime
- **运行方式**：直接运行 (非 Docker)，利用本地 CPU/内存
- **配置**：通过 `.env` 文件配置 VPS 的 Tailscale IP 和 gRPC 端口

### 5.3 换服务器迁移步骤 (VPS 端)
1. 在新服务器上安装 Docker 和 Docker Compose
2. 复制项目文件（代码 + 数据）
3. 配置环境变量（`.env` 文件）
4. 运行 `docker-compose up -d`
5. 验证服务状态：`docker-compose ps`

---

## 6. 开发流程

### 6.1 严格模式开发流程
1. **先写测试**：使用 TDD，为每个组件编写测试用例（包括异常场景）
2. **AI 实现**：AI 根据测试用例编写实现代码
3. **自动化验证**：运行测试，确保通过
4. **代码审查**：使用 `requesting-code-review` 技能，重点检查状态管理、错误处理、并发安全

### 6.2 关键测试用例示例
```typescript
// 订单去重测试
test('should reject duplicate order with same UUID', async () => {
  const order = createOrder({ id: 'uuid-123', ... });
  await router.send(order);
  
  // 第二次发送相同 UUID 应该被拒绝
  await expect(router.send(order)).rejects.toThrow('DUPLICATE_ORDER');
});

// 滑点检查测试
test('should reject order if slippage exceeds limit', async () => {
  const signal = createSignal({ signal_price: 100, max_slippage_bps: 10 }); // 0.1%
  const executionPrice = 100.2; // 0.2% slippage
  
  await expect(router.execute(signal, executionPrice)).rejects.toThrow('SLIPPAGE_TOO_HIGH');
});

// WebSocket 断线重连测试
test('should reconnect after WebSocket disconnect', async () => {
  const receiver = new MarketDataReceiver();
  await receiver.connect();
  
  // 模拟断线
  mockWebSocket.disconnect();
  
  // 应该自动重连 (1s, 2s, 5s, 10s)
  await waitFor(() => expect(receiver.isConnected()).toBe(true));
});
```

---

## 7. 监控与告警

### 7.1 关键指标
- **延迟**：GRVT → VPS 延迟、VPS ↔ 本地 AI 延迟
- **成功率**：订单成交率、信号执行率
- **风控**：仓位使用率、保证金率、止损触发次数
- **健康度**：WebSocket 连接状态、AI 服务存活状态

### 7.2 告警规则
- WebSocket 断线超过 10 秒 → 告警
- AI 服务 5 分钟无信号 → 告警
- 保证金率 < 150% → 告警
- 单日亏损超过 4% → 告警（接近 5% 限制）
- 订单失败率超过 10% → 告警

---

## 8. 后续优化方向

1. **模型训练**：使用历史数据训练专用模型，替代云端 API
2. **策略扩展**：支持更多策略类型（趋势跟踪、均值回归、套利）
3. **多交易所**：扩展支持其他 DEX/CEX
4. **移动端监控**：开发手机 App 实时监控交易状态

---

## 9. 风险与免责声明

- 本系统仅供学习和研究使用，不构成投资建议
- 加密货币交易存在高风险，可能导致本金损失
- 请在测试环境中充分验证后再考虑实盘交易
- 作者不对使用本系统造成的任何损失负责