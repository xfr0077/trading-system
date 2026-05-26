import { loadConfig } from '../src/config';

describe('Config', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('should load config from environment variables', () => {
    process.env.LIGHTER_API_PRIVATE_KEY = '0xtest-secret';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.SQLITE_PATH = '/tmp/test.db';

    const config = loadConfig();

    expect(config.lighterApiPrivateKey).toBe('0xtest-secret');
    expect(config.redisUrl).toBe('redis://localhost:6379');
    expect(config.sqlitePath).toBe('/tmp/test.db');
  });

  test('should default env to testnet when DEX_ENV is not set', () => {
    process.env.LIGHTER_API_PRIVATE_KEY = '0xtest-secret';
    delete process.env.DEX_ENV;

    const config = loadConfig();

    expect(config.env).toBe('testnet');
  });

  test('should accept valid env values', () => {
    process.env.LIGHTER_API_PRIVATE_KEY = '0xtest-secret';

    process.env.DEX_ENV = 'production';
    expect(loadConfig().env).toBe('production');

    process.env.DEX_ENV = 'testnet';
    expect(loadConfig().env).toBe('testnet');
  });

  test('should default dexProvider to lighter', () => {
    process.env.LIGHTER_API_PRIVATE_KEY = '0xtest-secret';
    delete process.env.DEX_PROVIDER;
    delete process.env.DEX;

    expect(loadConfig().dexProvider).toBe('lighter');
  });

  test('should parse grpcPort from environment', () => {
    process.env.LIGHTER_API_PRIVATE_KEY = '0xtest-secret';
    process.env.GRPC_PORT = '8080';

    const config = loadConfig();

    expect(config.grpcPort).toBe(8080);
  });

  test('should default grpcPort to 50051 when GRPC_PORT is not set', () => {
    process.env.LIGHTER_API_PRIVATE_KEY = '0xtest-secret';
    delete process.env.GRPC_PORT;

    const config = loadConfig();

    expect(config.grpcPort).toBe(50051);
  });

  test('should use default when GRPC_PORT is non-numeric', () => {
    process.env.LIGHTER_API_PRIVATE_KEY = '0xtest-secret';
    process.env.GRPC_PORT = 'abc';

    // Non-numeric env values are ignored → zod applies default
    expect(loadConfig().grpcPort).toBe(50051);
  });

  test('should throw if GRPC_PORT is out of range', () => {
    process.env.LIGHTER_API_PRIVATE_KEY = '0xtest-secret';

    process.env.GRPC_PORT = '0';
    expect(() => loadConfig()).toThrow();

    process.env.GRPC_PORT = '65536';
    expect(() => loadConfig()).toThrow();
  });

  test('should default tailscaleAiIp to 127.0.0.1 when not set', () => {
    process.env.LIGHTER_API_PRIVATE_KEY = '0xtest-secret';
    delete process.env.TAILSCALE_AI_IP;

    const config = loadConfig();

    expect(config.tailscaleAiIp).toBe('127.0.0.1');
  });
});

describe('Config Phase 2', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('should load environment and symbols', () => {
    process.env.LIGHTER_API_PRIVATE_KEY = '0xtest-secret';
    process.env.DEX_ENV = 'testnet';
    process.env.SYMBOLS = 'BTC_USDT_Perp,ETH_USDT_Perp';

    const config = loadConfig();

    expect(config.env).toBe('testnet');
    expect(config.symbols).toEqual(['BTC_USDT_Perp', 'ETH_USDT_Perp']);
  });

  test('should use default environment and symbols', () => {
    process.env.LIGHTER_API_PRIVATE_KEY = '0xtest-secret';
    delete process.env.DEX_ENV;
    delete process.env.SYMBOLS;

    const config = loadConfig();

    expect(config.env).toBe('testnet');
    expect(config.symbols).toEqual(['BTC_USDT_Perp', 'ETH_USDT_Perp']);
  });

  test('should load risk config', () => {
    process.env.LIGHTER_API_PRIVATE_KEY = '0xtest-secret';
    process.env.MAX_POSITION_SIZE = '0.5';
    process.env.MAX_DAILY_LOSS = '1000';
    process.env.MAX_CONCURRENT_SIGNALS = '5';
    process.env.MIN_CONFIDENCE = '70';
    process.env.MAX_PRICE_DEVIATION_PCT = '1.0';
    process.env.SIGNAL_TTL_MS = '60000';
    process.env.MARGIN_WARNING_THRESHOLD = '0.6';
    process.env.MARGIN_CRITICAL_THRESHOLD = '0.85';

    const config = loadConfig();

    expect(config.maxPositionSize).toBe(0.5);
    expect(config.maxDailyLoss).toBe(1000);
    expect(config.maxConcurrentSignals).toBe(5);
    expect(config.minConfidence).toBe(70);
    expect(config.maxPriceDeviationPct).toBe(1.0);
    expect(config.signalTtlMs).toBe(60000);
    expect(config.marginWarningThreshold).toBe(0.6);
    expect(config.marginCriticalThreshold).toBe(0.85);
  });
});
