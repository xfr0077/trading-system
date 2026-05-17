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
