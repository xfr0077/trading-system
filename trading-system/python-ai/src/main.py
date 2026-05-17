import asyncio
import logging
from src.config import AIConfig
from src.redis_reader import RedisMarketReader
from src.feature_engine import FeatureEngine
from src.model_inference import ModelInference
from src.signal_client import SignalClient, SignalError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

async def main():
    config = AIConfig.from_env()
    logger.info(f"Starting AI service with config: {config}")

    reader = RedisMarketReader(config.redis_url, config.symbols)
    engine = FeatureEngine(window_size=config.feature_window)
    inference = ModelInference(config.model_path, config.confidence_threshold)

    price_buffer: dict[str, list] = {s: [] for s in config.symbols}

    async with SignalClient(target=config.ts_engine_grpc_url) as client:
        async for data in reader.stream():
            buffer = price_buffer[data.symbol]
            buffer.append(data)

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
                logger.debug(f"Confidence {confidence:.1f}% below threshold, skipping")
                continue

            # 发送信号
            latest = buffer[-1]
            try:
                ack = client.send_signal(
                    symbol=data.symbol,
                    action=action,
                    stop_loss=latest.lastPrice * 0.98,
                    take_profit=latest.lastPrice * 1.02,
                    confidence=confidence,
                    position_size=0.01,
                    signal_price=latest.lastPrice,
                    max_slippage_bps=10,
                )
                logger.info(f"Signal sent: {action} {data.symbol} (conf={confidence:.1f}%) accepted={ack.accepted}")
            except SignalError as e:
                logger.error(f"Failed to send signal: {e}")

if __name__ == "__main__":
    asyncio.run(main())
