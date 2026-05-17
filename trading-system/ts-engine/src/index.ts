import { SignalRouter } from './signal-router';
import { loadConfig } from './config';

async function main() {
  const config = loadConfig();
  const router = new SignalRouter(config);

  try {
    const server = await router.startServer(config.grpcPort);
    console.log(`TS Engine started on port ${config.grpcPort} (env: ${config.grvtEnv})`);

    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down...');
      router.stop();
      server.forceShutdown();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      console.log('SIGINT received, shutting down...');
      router.stop();
      server.forceShutdown();
      process.exit(0);
    });
  } catch (err) {
    console.error('Failed to start TS Engine:', err);
    process.exit(1);
  }
}

main();
