import Redis from 'ioredis';
import { SignalRouter } from './signal-router';
import { loadConfig } from './config';

async function main() {
  const config = loadConfig();
  const router = new SignalRouter(config);
  const redis = new Redis(config.redisUrl);

  try {
    await router.initialize();
    await router.initializeMarketData(redis);
    const server = await router.startServer(config.grpcPort);
    console.log(`TS Engine started on port ${config.grpcPort} (env: ${config.grvtEnv})`);

    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down...');
      router.stop();
      redis.disconnect();
      server.forceShutdown();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('SIGINT received, shutting down...');
      router.stop();
      redis.disconnect();
      server.forceShutdown();
      process.exit(0);
    });
  } catch (err) {
    console.error('Failed to start TS Engine:', err);
    redis.disconnect();
    process.exit(1);
  }
}

main();
