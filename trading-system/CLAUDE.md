## VPS 部署信息
- VPS IP: 43.247.132.103
- Dashboard: http://43.247.132.103/
- 当前模式: 模拟盘 (PAPER_TRADING=true)
- 平台: Docker Compose (v5)
- 健康检查: `curl http://43.247.132.103/api/status`

## 服务
- ts-engine: Node.js gRPC (50051) + HTTP Dashboard (80)
- python-ai: Python ONNX 推理，通过 gRPC 连接 ts-engine
- redis: 行情数据流
- 数据库: SQLite (trades.db)

## DEX 配置
- 当前 DEX: Lighter (mainnet)
- 账户: account_index=725539, wallet=0xF380e481B121E0d5fC0D06d7370f6CFC81A195F5
- API Key Index: 7
- Lighter URL: https://mainnet.zklighter.elliot.ai

## 风控参数 (适用于 ~$215 账户)
- MAX_POSITION_SIZE=0.003 BTC (~$231)
- MAX_DAILY_LOSS=$20
- MAX_CONCURRENT_SIGNALS=2
- MIN_CONFIDENCE=60%

## 部署命令
```bash
# 构建并重启
cd /opt/trading-system
docker compose build --no-cache ts-engine
docker compose up -d ts-engine

# 查看日志
docker compose logs -f ts-engine

# 全部重启
docker compose up -d
```
