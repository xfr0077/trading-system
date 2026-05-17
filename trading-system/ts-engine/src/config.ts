export interface Config {
  grvtApiKey: string;
  grvtEnv: 'testnet' | 'prod';
  redisUrl: string;
  sqlitePath: string;
  grpcPort: number;
  tailscaleAiIp: string;
  grvtMarketDataWsUrl: string;
  grvtTradingWsUrl: string;
  grvtRestApiUrl: string;
  maxPositionSize: number;
  maxDailyLoss: number;
  maxConcurrentSignals: number;
  minConfidence: number;
  maxPriceDeviationPct: number;
  signalTtlMs: number;
  marginWarningThreshold: number;
  marginCriticalThreshold: number;
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
    grvtMarketDataWsUrl: process.env.GRVT_MARKET_DATA_WS_URL || 'wss://market-data.dev.gravitymarkets.io/ws',
    grvtTradingWsUrl: process.env.GRVT_TRADING_WS_URL || 'wss://trades.dev.gravitymarkets.io/ws',
    grvtRestApiUrl: process.env.GRVT_REST_API_URL || 'https://api.dev.gravitymarkets.io',
    maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '0.1'),
    maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS || '500'),
    maxConcurrentSignals: parseInt(process.env.MAX_CONCURRENT_SIGNALS || '3', 10),
    minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '60.0'),
    maxPriceDeviationPct: parseFloat(process.env.MAX_PRICE_DEVIATION_PCT || '0.5'),
    signalTtlMs: parseInt(process.env.SIGNAL_TTL_MS || '30000', 10),
    marginWarningThreshold: parseFloat(process.env.MARGIN_WARNING_THRESHOLD || '0.7'),
    marginCriticalThreshold: parseFloat(process.env.MARGIN_CRITICAL_THRESHOLD || '0.9'),
  };
}
