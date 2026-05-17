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
