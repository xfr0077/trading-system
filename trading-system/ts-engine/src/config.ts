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

  const grvtEnv = process.env.GRVT_ENV;
  if (grvtEnv !== undefined && grvtEnv !== 'testnet' && grvtEnv !== 'prod') {
    throw new Error('GRVT_ENV must be testnet or prod');
  }

  const port = parseInt(process.env.GRPC_PORT || '50051', 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error('GRPC_PORT must be a valid port number');
  }

  return {
    grvtApiKey,
    grvtEnv: grvtEnv || 'testnet',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    sqlitePath: process.env.SQLITE_PATH || '/data/trades.db',
    grpcPort: port,
    tailscaleAiIp: process.env.TAILSCALE_AI_IP || '127.0.0.1',
  };
}
