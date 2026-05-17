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

function validatePositiveNumber(value: number, name: string): number {
  if (isNaN(value)) {
    throw new Error(`${name} must be a valid number`);
  }
  if (value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function validateNonNegativeNumber(value: number, name: string): number {
  if (isNaN(value)) {
    throw new Error(`${name} must be a valid number`);
  }
  if (value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function validateUrl(value: string, name: string, allowedPrefixes: string[]): string {
  const isValid = allowedPrefixes.some(prefix => value.startsWith(prefix));
  if (!isValid) {
    throw new Error(`${name} must start with ${allowedPrefixes.join(' or ')}`);
  }
  return value;
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

  const maxPositionSize = validatePositiveNumber(
    parseFloat(process.env.MAX_POSITION_SIZE || '0.1'),
    'MAX_POSITION_SIZE'
  );

  const maxDailyLoss = validatePositiveNumber(
    parseFloat(process.env.MAX_DAILY_LOSS || '500'),
    'MAX_DAILY_LOSS'
  );

  const minConfidenceRaw = parseFloat(process.env.MIN_CONFIDENCE || '60.0');
  if (isNaN(minConfidenceRaw)) {
    throw new Error('MIN_CONFIDENCE must be a valid number');
  }
  if (minConfidenceRaw < 0 || minConfidenceRaw > 100) {
    throw new Error('MIN_CONFIDENCE must be between 0 and 100');
  }

  const maxPriceDeviationPct = validateNonNegativeNumber(
    parseFloat(process.env.MAX_PRICE_DEVIATION_PCT || '0.5'),
    'MAX_PRICE_DEVIATION_PCT'
  );

  const marginWarningThreshold = parseFloat(process.env.MARGIN_WARNING_THRESHOLD || '0.7');
  const marginCriticalThreshold = parseFloat(process.env.MARGIN_CRITICAL_THRESHOLD || '0.9');

  if (isNaN(marginWarningThreshold) || isNaN(marginCriticalThreshold)) {
    throw new Error('Margin thresholds must be valid numbers');
  }

  if (marginWarningThreshold >= marginCriticalThreshold) {
    throw new Error('MARGIN_WARNING_THRESHOLD must be less than MARGIN_CRITICAL_THRESHOLD');
  }

  const grvtMarketDataWsUrl = validateUrl(
    process.env.GRVT_MARKET_DATA_WS_URL || 'wss://market-data.dev.gravitymarkets.io/ws',
    'GRVT_MARKET_DATA_WS_URL',
    ['wss://', 'https://']
  );

  const grvtTradingWsUrl = validateUrl(
    process.env.GRVT_TRADING_WS_URL || 'wss://trades.dev.gravitymarkets.io/ws',
    'GRVT_TRADING_WS_URL',
    ['wss://', 'https://']
  );

  const grvtRestApiUrl = validateUrl(
    process.env.GRVT_REST_API_URL || 'https://api.dev.gravitymarkets.io',
    'GRVT_REST_API_URL',
    ['https://']
  );

  return {
    grvtApiKey,
    grvtEnv: grvtEnv || 'testnet',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    sqlitePath: process.env.SQLITE_PATH || '/data/trades.db',
    grpcPort: port,
    tailscaleAiIp: process.env.TAILSCALE_AI_IP || '127.0.0.1',
    grvtMarketDataWsUrl,
    grvtTradingWsUrl,
    grvtRestApiUrl,
    maxPositionSize,
    maxDailyLoss,
    maxConcurrentSignals: parseInt(process.env.MAX_CONCURRENT_SIGNALS || '3', 10),
    minConfidence: minConfidenceRaw,
    maxPriceDeviationPct,
    signalTtlMs: parseInt(process.env.SIGNAL_TTL_MS || '30000', 10),
    marginWarningThreshold,
    marginCriticalThreshold,
  };
}
