import { EGrvtEnvironment } from '@grvt/sdk';
import { GrvtEnv } from '@wezzcoetzee/grvt';

export interface Config {
  grvtApiKey: string;
  grvtPrivateKey: string;
  grvtTradingAccountId: string;
  grvtEnv: EGrvtEnvironment;
  grvtEnvCommunity: GrvtEnv;
  redisUrl: string;
  sqlitePath: string;
  grpcPort: number;
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
  const grvtApiKey = process.env.GRVT_API_KEY;
  if (!grvtApiKey) throw new Error('GRVT_API_KEY is required');

  const grvtPrivateKey = process.env.GRVT_PRIVATE_KEY;
  if (!grvtPrivateKey) throw new Error('GRVT_PRIVATE_KEY is required');

  const grvtTradingAccountId = process.env.GRVT_TRADING_ACCOUNT_ID;
  if (!grvtTradingAccountId) throw new Error('GRVT_TRADING_ACCOUNT_ID is required');

  const grvtEnvRaw = process.env.GRVT_ENV || 'testnet';
  const grvtEnv = mapGrvtEnvironment(grvtEnvRaw);
  const grvtEnvCommunity = mapGrvtEnvironmentCommunity(grvtEnvRaw);

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

  return {
    grvtApiKey,
    grvtPrivateKey,
    grvtTradingAccountId,
    grvtEnv,
    grvtEnvCommunity,
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    sqlitePath: process.env.SQLITE_PATH || '/data/trades.db',
    grpcPort: port,
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
  };
}

function mapGrvtEnvironment(env: string): EGrvtEnvironment {
  const map: Record<string, EGrvtEnvironment> = {
    'testnet': EGrvtEnvironment.TESTNET,
    'prod': EGrvtEnvironment.PRODUCTION,
    'production': EGrvtEnvironment.PRODUCTION,
    'staging': EGrvtEnvironment.STAGING,
    'dev': EGrvtEnvironment.DEV,
  };
  return map[env.toLowerCase()] || EGrvtEnvironment.TESTNET;
}

function mapGrvtEnvironmentCommunity(env: string): GrvtEnv {
  const map: Record<string, GrvtEnv> = {
    'testnet': GrvtEnv.TESTNET,
    'prod': GrvtEnv.PROD,
    'production': GrvtEnv.PROD,
    'staging': GrvtEnv.STG,
    'dev': GrvtEnv.DEV,
  };
  return map[env.toLowerCase()] || GrvtEnv.TESTNET;
}
