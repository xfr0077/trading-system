import asyncio
import logging
import time
from dotenv import load_dotenv
from src.config import AIConfig

load_dotenv()
from src.redis_reader import RedisMarketReader
from src.feature_engine import FeatureEngine
from src.model_inference import ModelInference
from src.signal_client import SignalClient, SignalError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class HealthMonitor:
    """周期性健康检查，实现超时断路器"""
    def __init__(self, max_consecutive_failures: int = 3, timeout_seconds: float = 30.0):
        self.consecutive_failures = 0
        self.max_consecutive_failures = max_consecutive_failures
        self.timeout_seconds = timeout_seconds
        self.last_heartbeat = time.time()
        self.is_healthy = True
    
    def record_success(self):
        self.consecutive_failures = 0
        self.last_heartbeat = time.time()
        self.is_healthy = True
    
    def record_failure(self, error_msg: str):
        self.consecutive_failures += 1
        logger.error(f"Health check failure ({self.consecutive_failures}/{self.max_consecutive_failures}): {error_msg}")
        if self.consecutive_failures >= self.max_consecutive_failures:
            self.is_healthy = False
            logger.critical(f"Health check FAILED: {self.max_consecutive_failures} consecutive failures. Circuit breaker triggered.")
    
    def check_timeout(self) -> bool:
        """检查是否超时"""
        elapsed = time.time() - self.last_heartbeat
        if elapsed > self.timeout_seconds:
            logger.warning(f"Health check timeout: no heartbeat for {elapsed:.1f}s (limit: {self.timeout_seconds}s)")
            return False
        return True

async def main():
    config = AIConfig.from_env()
    logger.info(f"Starting AI service with config: {config}")

    reader = RedisMarketReader(config.redis_url, config.symbols)
    engine = FeatureEngine(window_size=config.feature_window, use_legacy_features=config.use_legacy_features)
    inference = ModelInference(config.model_path, config.confidence_threshold)
    
    # 初始化健康监控
    health = HealthMonitor(max_consecutive_failures=3, timeout_seconds=60.0)
    
    # 启动周期性健康检查
    async def health_check_loop():
        while True:
            await asyncio.sleep(10)  # 每10秒检查一次
            if not health.check_timeout():
                health.record_failure("Heartbeat timeout")
            if health.is_healthy:
                logger.debug("Health check: OK")
            else:
                logger.critical("Health check: CRITICAL - Circuit breaker OPEN")
    
    health_task = asyncio.create_task(health_check_loop())

    price_buffer: dict[str, list] = {s: [] for s in config.symbols}
    last_action: dict[str, str | None] = {s: None for s in config.symbols}

    try:
        async with SignalClient(target=config.ts_engine_grpc_url) as client:
            async for data in reader.stream():
                # 检查断路器状态
                if not health.is_healthy:
                    logger.warning("Circuit breaker OPEN, skipping signal processing")
                    continue
                
                buffer = price_buffer[data.symbol]
                buffer.append(data)

                # 每轮都记录心跳（即使不发送信号）
                health.record_success()

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
                    logger.info(f"Confidence {confidence:.1f}% below threshold, skipping")
                    continue

                # 信号去重：预测结果未变化时不重复发送
                if action == last_action[data.symbol]:
                    continue

                last_action[data.symbol] = action

                # 发送信号
                latest = buffer[-1]
                # Direction-aware SL/TP: for short, SL > price, TP < price
                if action == 'long':
                    stop_loss = latest.lastPrice * config.stop_loss_pct
                    take_profit = latest.lastPrice * config.take_profit_pct
                else:  # short or close
                    stop_loss = latest.lastPrice * config.take_profit_pct  # SL above price
                    take_profit = latest.lastPrice * config.stop_loss_pct  # TP below price
                try:
                    ack = client.send_signal(
                        symbol=data.symbol,
                        action=action,
                        stop_loss=stop_loss,
                        take_profit=take_profit,
                        confidence=confidence,
                        position_size=config.position_size,
                        signal_price=latest.lastPrice,
                        max_slippage_bps=config.max_slippage_bps,
                    )
                    logger.info(f"Signal sent: {action} {data.symbol} (conf={confidence:.1f}%) accepted={ack.accepted}")
                    health.record_success()
                except SignalError as e:
                    logger.error(f"Failed to send signal: {e}")
                    health.record_failure(str(e))
                except Exception as e:
                    logger.error(f"Unexpected error in signal processing: {e}")
                    health.record_failure(str(e))
    finally:
        health_task.cancel()
        try:
            await health_task
        except asyncio.CancelledError:
            pass

if __name__ == "__main__":
    asyncio.run(main())
