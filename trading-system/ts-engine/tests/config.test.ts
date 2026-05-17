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
});
