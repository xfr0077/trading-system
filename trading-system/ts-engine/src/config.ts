import { z } from 'zod';

// ---- Zod schema replaces all manual validation functions ----

const ConfigSchema = z.object({
  env: z.string().default('testnet'),
  dexProvider: z.enum(['lighter', 'ostium']).default('lighter'),
  redisUrl: z.string().default('redis://localhost:6379'),
  sqlitePath: z.string().default('/data/trades.db'),
  grpcPort: z.number().int().min(1).max(65535).default(50051),
  grpcTlsEnabled: z.boolean().default(false),
  dashboardPort: z.number().int().default(3000),
  tailscaleAiIp: z.string().default('127.0.0.1'),
  symbols: z.array(z.string()).default(['BTC_USDT_Perp', 'ETH_USDT_Perp']),
  maxPositionSize: z.number().positive().default(0.1),
  maxDailyLoss: z.number().positive().default(500),
  maxConcurrentSignals: z.number().int().positive().default(3),
  minConfidence: z.number().min(0).max(100).default(60),
  maxPriceDeviationPct: z.number().nonnegative().default(0.5),
  signalTtlMs: z.number().int().positive().default(300000),
  marginWarningThreshold: z.number().default(0.7),
  marginCriticalThreshold: z.number().default(0.9),
  trailingStopPct: z.number().default(0.03),
  paperTrading: z.boolean().default(false),
  dashboardToken: z.string().optional(),
  corsOrigins: z.array(z.string()).default(['http://localhost:3000']),
  rateLimitRpm: z.number().int().positive().default(60),
  // Lighter-specific
  lighterApiKeyIndex: z.number().int().optional(),
  lighterApiPublicKey: z.string().optional(),
  lighterApiPrivateKey: z.string().optional(),
  lighterBaseUrl: z.string().optional(),
  walletAddress: z.string().optional(),
  lighterAccountIndex: z.number().int().optional(),
}).refine(
  (data) => data.marginWarningThreshold < data.marginCriticalThreshold,
  { message: 'MARGIN_WARNING_THRESHOLD must be less than MARGIN_CRITICAL_THRESHOLD' },
);

// ---- Derived type (replaces manual interface) ----

export type Config = z.infer<typeof ConfigSchema>;

// ---- Loader ----

function parseEnvInt(key: string): number | undefined {
  const v = process.env[key];
  if (v === undefined || v === '') return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

function parseEnvFloat(key: string): number | undefined {
  const v = process.env[key];
  if (v === undefined || v === '') return undefined;
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

export function loadConfig(): Config {
  const raw: Record<string, unknown> = {
    env: process.env.DEX_ENV,
    dexProvider: process.env.DEX_PROVIDER || process.env.DEX,
    redisUrl: process.env.REDIS_URL,
    sqlitePath: process.env.SQLITE_PATH,
    grpcPort: parseEnvInt('GRPC_PORT'),
    grpcTlsEnabled: process.env.GRPC_TLS_ENABLED === 'true' ? true : undefined,
    dashboardPort: parseEnvInt('DASHBOARD_PORT'),
    tailscaleAiIp: process.env.TAILSCALE_AI_IP,
    symbols: process.env.SYMBOLS
      ? process.env.SYMBOLS.split(',').map((s) => s.trim())
      : undefined,
    maxPositionSize: parseEnvFloat('MAX_POSITION_SIZE'),
    maxDailyLoss: parseEnvFloat('MAX_DAILY_LOSS'),
    maxConcurrentSignals: parseEnvInt('MAX_CONCURRENT_SIGNALS'),
    minConfidence: parseEnvFloat('MIN_CONFIDENCE'),
    maxPriceDeviationPct: parseEnvFloat('MAX_PRICE_DEVIATION_PCT'),
    signalTtlMs: parseEnvInt('SIGNAL_TTL_MS'),
    marginWarningThreshold: parseEnvFloat('MARGIN_WARNING_THRESHOLD'),
    marginCriticalThreshold: parseEnvFloat('MARGIN_CRITICAL_THRESHOLD'),
    trailingStopPct: parseEnvFloat('TRAILING_STOP_PCT'),
    paperTrading: process.env.PAPER_TRADING === 'true' ? true : undefined,
    dashboardToken: process.env.DASHBOARD_TOKEN || undefined,
    corsOrigins: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined,
    rateLimitRpm: parseEnvInt('RATE_LIMIT_RPM'),
    lighterApiKeyIndex: parseEnvInt('LIGHTER_API_KEY_INDEX'),
    lighterApiPublicKey: process.env.LIGHTER_API_PUBLIC_KEY || undefined,
    lighterApiPrivateKey: process.env.LIGHTER_API_PRIVATE_KEY || undefined,
    lighterBaseUrl: process.env.LIGHTER_BASE_URL || undefined,
    walletAddress: process.env.WALLET_ADDRESS || undefined,
    lighterAccountIndex: parseEnvInt('LIGHTER_ACCOUNT_INDEX'),
  };

  // Strip undefined values so zod defaults apply
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined) clean[k] = v;
  }

  return ConfigSchema.parse(clean);
}
