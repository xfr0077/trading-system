export interface Config {
  env: string;
  dexProvider: 'lighter' | 'ostium';
  redisUrl: string;
  sqlitePath: string;
  grpcPort: number;
  grpcTlsEnabled: boolean;
  dashboardPort: number;
  tailscaleAiIp: string;
  symbols: string[];
  maxPositionSize: number;
  maxDailyLoss: number;
  maxConcurrentSignals: number;
  minConfidence: number;
  maxPriceDeviationPct: number;
  signalTtlMs: number;
  marginWarningThreshold: number;
  marginCriticalThreshold: number;
  trailingStopPct: number;
  paperTrading: boolean;
  dashboardToken?: string;
  corsOrigins: string[];
  rateLimitRpm: number;
  // Lighter-specific
  lighterApiKeyIndex?: number;
  lighterApiPublicKey?: string;
  lighterApiPrivateKey?: string;
  lighterBaseUrl?: string;
  walletAddress?: string;
  lighterAccountIndex?: number;
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

export function loadConfig(): Config {
  const symbols = (process.env.SYMBOLS || 'BTC_USDT_Perp,ETH_USDT_Perp').split(',').map(s => s.trim());

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

  const corsOriginsRaw = process.env.CORS_ORIGINS || '';
  const corsOrigins = corsOriginsRaw
    ? corsOriginsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : ['http://localhost:3000'];

  const rateLimitRpm = parseInt(process.env.RATE_LIMIT_RPM || '60', 10);
  if (isNaN(rateLimitRpm) || rateLimitRpm < 1) {
    throw new Error('RATE_LIMIT_RPM must be a positive integer');
  }

  const dashboardToken = process.env.DASHBOARD_TOKEN || undefined;
  const grpcTlsEnabled = process.env.GRPC_TLS_ENABLED === 'true';

  return {
    env: process.env.DEX_ENV || 'testnet',
    dexProvider: (process.env.DEX_PROVIDER || process.env.DEX || 'lighter') as 'lighter' | 'ostium',
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    sqlitePath: process.env.SQLITE_PATH || '/data/trades.db',
    grpcPort: port,
    grpcTlsEnabled,
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3000', 10),
    tailscaleAiIp: process.env.TAILSCALE_AI_IP || '127.0.0.1',
    symbols,
    maxPositionSize,
    maxDailyLoss,
    maxConcurrentSignals: parseInt(process.env.MAX_CONCURRENT_SIGNALS || '3', 10),
    minConfidence: minConfidenceRaw,
    maxPriceDeviationPct,
    signalTtlMs: parseInt(process.env.SIGNAL_TTL_MS || '300000', 10),
    marginWarningThreshold,
    marginCriticalThreshold,
    trailingStopPct: parseFloat(process.env.TRAILING_STOP_PCT || '0.03'),
    paperTrading: process.env.PAPER_TRADING === 'true',
    dashboardToken,
    corsOrigins,
    rateLimitRpm,
    // Lighter-specific
    lighterApiKeyIndex: process.env.LIGHTER_API_KEY_INDEX ? parseInt(process.env.LIGHTER_API_KEY_INDEX, 10) : undefined,
    lighterApiPublicKey: process.env.LIGHTER_API_PUBLIC_KEY || undefined,
    lighterApiPrivateKey: process.env.LIGHTER_API_PRIVATE_KEY || undefined,
    lighterBaseUrl: process.env.LIGHTER_BASE_URL || undefined,
    lighterAccountIndex: process.env.LIGHTER_ACCOUNT_INDEX ? parseInt(process.env.LIGHTER_ACCOUNT_INDEX, 10) : undefined,
    walletAddress: process.env.WALLET_ADDRESS || undefined,
  };
}
