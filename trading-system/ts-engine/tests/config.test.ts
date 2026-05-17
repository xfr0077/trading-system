import { loadConfig } from '../src/config';

describe('Config', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('should load config from environment variables', () => {
    process.env.GRVT_API_KEY = 'test-key';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.SQLITE_PATH = '/tmp/test.db';

    const config = loadConfig();

    expect(config.grvtApiKey).toBe('test-key');
    expect(config.redisUrl).toBe('redis://localhost:6379');
    expect(config.sqlitePath).toBe('/tmp/test.db');
  });

  test('should throw if GRVT_API_KEY is missing', () => {
    delete process.env.GRVT_API_KEY;
    expect(() => loadConfig()).toThrow('GRVT_API_KEY is required');
  });

  test('should default grvtEnv to testnet when GRVT_ENV is not set', () => {
    process.env.GRVT_API_KEY = 'test-key';
    delete process.env.GRVT_ENV;

    const config = loadConfig();

    expect(config.grvtEnv).toBe('testnet');
  });

  test('should accept valid GRVT_ENV values', () => {
    process.env.GRVT_API_KEY = 'test-key';

    process.env.GRVT_ENV = 'prod';
    expect(loadConfig().grvtEnv).toBe('prod');

    process.env.GRVT_ENV = 'testnet';
    expect(loadConfig().grvtEnv).toBe('testnet');
  });

  test('should throw if GRVT_ENV is invalid', () => {
    process.env.GRVT_API_KEY = 'test-key';
    process.env.GRVT_ENV = 'staging';

    expect(() => loadConfig()).toThrow('GRVT_ENV must be testnet or prod');
  });

  test('should parse grpcPort from environment', () => {
    process.env.GRVT_API_KEY = 'test-key';
    process.env.GRPC_PORT = '8080';

    const config = loadConfig();

    expect(config.grpcPort).toBe(8080);
  });

  test('should default grpcPort to 50051 when GRPC_PORT is not set', () => {
    process.env.GRVT_API_KEY = 'test-key';
    delete process.env.GRPC_PORT;

    const config = loadConfig();

    expect(config.grpcPort).toBe(50051);
  });

  test('should throw if GRPC_PORT is NaN', () => {
    process.env.GRVT_API_KEY = 'test-key';
    process.env.GRPC_PORT = 'abc';

    expect(() => loadConfig()).toThrow('GRPC_PORT must be a valid port number');
  });

  test('should throw if GRPC_PORT is out of range', () => {
    process.env.GRVT_API_KEY = 'test-key';

    process.env.GRPC_PORT = '0';
    expect(() => loadConfig()).toThrow('GRPC_PORT must be a valid port number');

    process.env.GRPC_PORT = '65536';
    expect(() => loadConfig()).toThrow('GRPC_PORT must be a valid port number');
  });

  test('should default tailscaleAiIp to 127.0.0.1 when not set', () => {
    process.env.GRVT_API_KEY = 'test-key';
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

  test('should load GRVT WebSocket URLs', () => {
    process.env.GRVT_API_KEY = 'test-key';
    process.env.GRVT_MARKET_DATA_WS_URL = 'wss://market-data.test/ws';
    process.env.GRVT_TRADING_WS_URL = 'wss://trades.test/ws';
    process.env.GRVT_REST_API_URL = 'https://api.test';

    const config = loadConfig();

    expect(config.grvtMarketDataWsUrl).toBe('wss://market-data.test/ws');
    expect(config.grvtTradingWsUrl).toBe('wss://trades.test/ws');
    expect(config.grvtRestApiUrl).toBe('https://api.test');
  });

  test('should use default WebSocket URLs', () => {
    process.env.GRVT_API_KEY = 'test-key';
    delete process.env.GRVT_MARKET_DATA_WS_URL;
    delete process.env.GRVT_TRADING_WS_URL;
    delete process.env.GRVT_REST_API_URL;

    const config = loadConfig();

    expect(config.grvtMarketDataWsUrl).toBe('wss://market-data.dev.gravitymarkets.io/ws');
    expect(config.grvtTradingWsUrl).toBe('wss://trades.dev.gravitymarkets.io/ws');
    expect(config.grvtRestApiUrl).toBe('https://api.dev.gravitymarkets.io');
  });

  test('should load risk config', () => {
    process.env.GRVT_API_KEY = 'test-key';
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
