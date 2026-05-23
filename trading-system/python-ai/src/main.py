import asyncio
import logging
import time
import aiohttp
from dotenv import load_dotenv
from src.config import AIConfig

load_dotenv()
from src.redis_reader import RedisMarketReader
from src.feature_engine import FeatureEngine
from src.model_inference import ModelInference
from src.signal_client import SignalClient, SignalError, PositionInfo

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

PING_INTERVAL = 5
PING_URL = "http://ts-engine:80/api/ping"
HALF_OPEN_INTERVAL = 30


class HealthMonitor:
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
        elapsed = time.time() - self.last_heartbeat
        if elapsed > self.timeout_seconds:
            logger.warning(f"Health check timeout: no heartbeat for {elapsed:.1f}s (limit: {self.timeout_seconds}s)")
            return False
        return True


async def ping_loop():
    """P0: Independent ping task - sends heartbeat to dashboard every 5s"""
    async with aiohttp.ClientSession() as session:
        while True:
            try:
                await asyncio.wait_for(session.get(PING_URL), timeout=3)
            except Exception:
                pass
            await asyncio.sleep(PING_INTERVAL)


async def health_check_loop(health: HealthMonitor, grpc_client: SignalClient):
    """Running health monitoring + circuit breaker half-open recovery"""
    last_half_open_check = 0.0
    while True:
        await asyncio.sleep(10)
        if not health.check_timeout():
            health.record_failure("Heartbeat timeout")
        if not health.is_healthy and time.time() - last_half_open_check > HALF_OPEN_INTERVAL:
            last_half_open_check = time.time()
            try:
                ok = await grpc_client.health_check()
                if ok:
                    health.record_success()
                    logger.info("Circuit breaker RESET after recovery")
            except Exception:
                pass


async def main():
    config = AIConfig.from_env()
    logger.info(f"Starting AI service with config: {config}")

    reader = RedisMarketReader(config.redis_url, config.symbols)
    engine = FeatureEngine(window_size=config.feature_window, use_legacy_features=config.use_legacy_features)
    inference = ModelInference(config.model_path, config.confidence_threshold)

    health = HealthMonitor(max_consecutive_failures=3, timeout_seconds=60.0)

    ping_task = asyncio.create_task(ping_loop())
    health_task = asyncio.create_task(health_check_loop(health, None))

    price_buffer: dict[str, list] = {s: [] for s in config.symbols}
    last_action: dict[str, str | None] = {s: None for s in config.symbols}
    last_inference_time: dict[str, float] = {s: 0.0 for s in config.symbols}
    # AI 现在知道自己的持仓了
    current_positions: dict[str, PositionInfo | None] = {s: None for s in config.symbols}

    try:
        async with SignalClient(target=config.ts_engine_grpc_url) as client:
            # Update health_task with real client reference
            health_task = asyncio.create_task(health_check_loop(health, client))

            async for data in reader.stream():
                # Always record success every tick (outside time gate)
                health.record_success()

                buffer = price_buffer[data.symbol]
                buffer.append(data)
                if len(buffer) > config.feature_window:
                    buffer.pop(0)

                # P1: Time-gate inference to every config.inference_interval_seconds
                now = time.time()
                if now - last_inference_time[data.symbol] < config.inference_interval_seconds:
                    continue
                last_inference_time[data.symbol] = now

                if len(buffer) < config.feature_window:
                    continue

                if not health.is_healthy:
                    logger.warning("Circuit breaker OPEN, skipping signal processing")
                    continue

                # Inference
                features = engine.compute(buffer)
                action, confidence = inference.predict(features)

                if action is None:
                    # P2: No heartbeat signal - just log
                    logger.info(f"Confidence {confidence:.1f}% below threshold")
                    continue

                # AI 感知仓位：根据当前持仓情况做智能决策
                pos = current_positions.get(data.symbol)
                if action == 'close':
                    if pos is None or pos.size <= 0:
                        logger.info(f"Skipping close for {data.symbol}: no position to close")
                        continue
                elif action == 'long':
                    if pos is not None and pos.size > 0 and pos.side == 'long':
                        logger.info(f"Skipping long for {data.symbol}: already have a long position")
                        continue
                elif action == 'short':
                    if pos is not None and pos.size > 0 and pos.side == 'short':
                        logger.info(f"Skipping short for {data.symbol}: already have a short position")
                        continue

                # Signal dedup
                if action == last_action[data.symbol]:
                    continue
                last_action[data.symbol] = action

                latest = buffer[-1]
                if action == 'close':
                    stop_loss = 0
                    take_profit = 0
                elif action == 'long':
                    stop_loss = latest.lastPrice * config.stop_loss_pct
                    take_profit = latest.lastPrice * config.take_profit_pct
                else:
                    stop_loss = latest.lastPrice * config.take_profit_pct
                    take_profit = latest.lastPrice * config.stop_loss_pct
                try:
                    ack = await client.send_signal(
                        symbol=data.symbol,
                        action=action,
                        stop_loss=stop_loss,
                        take_profit=take_profit,
                        confidence=confidence,
                        position_size=config.position_size,
                        signal_price=latest.lastPrice,
                        max_slippage_bps=config.max_slippage_bps,
                    )
                    # 更新 AI 的持仓感知
                    if ack.position is not None:
                        current_positions[data.symbol] = ack.position
                        logger.info(f"Position updated: {ack.position.side} {ack.position.symbol} size={ack.position.size}")
                    elif action in ('long', 'short') and ack.accepted:
                        # 开仓成功但无返回仓位（极少情况），记录占位
                        current_positions[data.symbol] = PositionInfo(
                            symbol=data.symbol, side=action, size=config.position_size,
                            entry_price=latest.lastPrice,
                        )
                    elif action == 'close' and ack.accepted:
                        # 平仓成功，清除本地记录
                        current_positions[data.symbol] = None
                    logger.info(f"Signal sent: {action} {data.symbol} (conf={confidence:.1f}%) accepted={ack.accepted} reason={ack.reason}")
                    health.record_success()
                except SignalError as e:
                    logger.error(f"Failed to send signal: {e}")
                    health.record_failure(str(e))
                except Exception as e:
                    logger.error(f"Unexpected error in signal processing: {e}")
                    health.record_failure(str(e))
    finally:
        ping_task.cancel()
        health_task.cancel()
        try:
            await ping_task
        except asyncio.CancelledError:
            pass
        try:
            await health_task
        except asyncio.CancelledError:
            pass


if __name__ == "__main__":
    asyncio.run(main())
