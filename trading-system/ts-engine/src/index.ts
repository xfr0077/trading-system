import dotenv from 'dotenv';
import Redis from 'ioredis';
import { SignalRouter } from './signal-router';
import { loadConfig } from './config';

dotenv.config();

// Polyfill WebSocket for Node 20 (used by @wezzcoetzee/grvt)
if (typeof globalThis.WebSocket === 'undefined') {
  const { WebSocket } = require('ws');
  (globalThis as any).WebSocket = WebSocket;
}

// Proxy support for GRVT trading API (bypass geo-restriction)
import { configureProxy } from './trading-ws';
configureProxy();

async function main() {
  const config = loadConfig();
  const router = new SignalRouter(config);
  const redis = new Redis(config.redisUrl);

  try {
    await router.initializeMarketData(redis);
  } catch (err) {
    console.error('[Main] Market data init failed (non-fatal):', err);
  }

  const server = await router.startServer(config.grpcPort);
  console.log(`TS Engine started on port ${config.grpcPort} (env: ${config.grvtEnv})`);

  // Background init with exponential backoff retry
  (async function retryInit() {
    let attempt = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await router.initialize();
        console.log('[Main] GRVT init succeeded');
        return;
      } catch (err) {
        const delay = Math.min(10000 * Math.pow(2, attempt - 1), 120000);
        console.error(`[Main] init attempt ${attempt} failed, retrying in ${delay / 1000}s:`, (err as Error).message);
        await new Promise(r => setTimeout(r, delay));
        attempt++;
      }
    }
  })();

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
}

main();
