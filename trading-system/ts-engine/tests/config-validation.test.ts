import { loadConfig } from '../src/config';

describe('Config Phase 2 - Validation & Defaults', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.GRVT_API_KEY = 'test-key';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // Issue 1: 缺少风控参数默认值测试
  describe('risk parameter defaults', () => {
    test('should use default maxPositionSize of 0.1 when not set', () => {
      delete process.env.MAX_POSITION_SIZE;
      const config = loadConfig();
      expect(config.maxPositionSize).toBe(0.1);
    });

    test('should use default maxDailyLoss of 500 when not set', () => {
      delete process.env.MAX_DAILY_LOSS;
      const config = loadConfig();
      expect(config.maxDailyLoss).toBe(500);
    });

    test('should use default minConfidence of 60.0 when not set', () => {
      delete process.env.MIN_CONFIDENCE;
      const config = loadConfig();
      expect(config.minConfidence).toBe(60.0);
    });

    test('should use default maxPriceDeviationPct of 0.5 when not set', () => {
      delete process.env.MAX_PRICE_DEVIATION_PCT;
      const config = loadConfig();
      expect(config.maxPriceDeviationPct).toBe(0.5);
    });

    test('should use default marginWarningThreshold of 0.7 when not set', () => {
      delete process.env.MARGIN_WARNING_THRESHOLD;
      const config = loadConfig();
      expect(config.marginWarningThreshold).toBe(0.7);
    });

    test('should use default marginCriticalThreshold of 0.9 when not set', () => {
      delete process.env.MARGIN_CRITICAL_THRESHOLD;
      const config = loadConfig();
      expect(config.marginCriticalThreshold).toBe(0.9);
    });
  });

  // Issue 2: 缺少边界值验证
  describe('risk parameter boundary validation', () => {
    test('should throw if MAX_POSITION_SIZE is negative', () => {
      process.env.MAX_POSITION_SIZE = '-1';
      expect(() => loadConfig()).toThrow('MAX_POSITION_SIZE must be a positive number');
    });

    test('should throw if MAX_POSITION_SIZE is NaN', () => {
      process.env.MAX_POSITION_SIZE = 'abc';
      expect(() => loadConfig()).toThrow('MAX_POSITION_SIZE must be a valid number');
    });

    test('should throw if MAX_DAILY_LOSS is negative', () => {
      process.env.MAX_DAILY_LOSS = '-100';
      expect(() => loadConfig()).toThrow('MAX_DAILY_LOSS must be a positive number');
    });

    test('should throw if MIN_CONFIDENCE is negative', () => {
      process.env.MIN_CONFIDENCE = '-10';
      expect(() => loadConfig()).toThrow('MIN_CONFIDENCE must be between 0 and 100');
    });

    test('should throw if MIN_CONFIDENCE exceeds 100', () => {
      process.env.MIN_CONFIDENCE = '150';
      expect(() => loadConfig()).toThrow('MIN_CONFIDENCE must be between 0 and 100');
    });

    test('should throw if MAX_PRICE_DEVIATION_PCT is negative', () => {
      process.env.MAX_PRICE_DEVIATION_PCT = '-5';
      expect(() => loadConfig()).toThrow('MAX_PRICE_DEVIATION_PCT must be a non-negative number');
    });
  });

  // Issue 3: marginWarningThreshold 与 marginCriticalThreshold 无逻辑校验
  describe('margin threshold logical validation', () => {
    test('should throw if marginWarningThreshold is greater than marginCriticalThreshold', () => {
      process.env.MARGIN_WARNING_THRESHOLD = '0.95';
      process.env.MARGIN_CRITICAL_THRESHOLD = '0.8';
      expect(() => loadConfig()).toThrow('MARGIN_WARNING_THRESHOLD must be less than MARGIN_CRITICAL_THRESHOLD');
    });

    test('should throw if marginWarningThreshold equals marginCriticalThreshold', () => {
      process.env.MARGIN_WARNING_THRESHOLD = '0.8';
      process.env.MARGIN_CRITICAL_THRESHOLD = '0.8';
      expect(() => loadConfig()).toThrow('MARGIN_WARNING_THRESHOLD must be less than MARGIN_CRITICAL_THRESHOLD');
    });

    test('should accept valid margin thresholds', () => {
      process.env.MARGIN_WARNING_THRESHOLD = '0.6';
      process.env.MARGIN_CRITICAL_THRESHOLD = '0.85';
      const config = loadConfig();
      expect(config.marginWarningThreshold).toBe(0.6);
      expect(config.marginCriticalThreshold).toBe(0.85);
    });
  });

  // Issue 4: WebSocket URL 无格式校验
  describe('WebSocket URL format validation', () => {
    test('should throw if GRVT_MARKET_DATA_WS_URL does not start with wss:// or https://', () => {
      process.env.GRVT_MARKET_DATA_WS_URL = 'ftp://invalid-url';
      expect(() => loadConfig()).toThrow('GRVT_MARKET_DATA_WS_URL must start with wss:// or https://');
    });

    test('should throw if GRVT_TRADING_WS_URL does not start with wss:// or https://', () => {
      process.env.GRVT_TRADING_WS_URL = 'ws://insecure-url';
      expect(() => loadConfig()).toThrow('GRVT_TRADING_WS_URL must start with wss:// or https://');
    });

    test('should throw if GRVT_REST_API_URL does not start with https://', () => {
      process.env.GRVT_REST_API_URL = 'http://insecure-api';
      expect(() => loadConfig()).toThrow('GRVT_REST_API_URL must start with https://');
    });

    test('should accept valid wss:// URLs', () => {
      process.env.GRVT_MARKET_DATA_WS_URL = 'wss://valid.url/ws';
      process.env.GRVT_TRADING_WS_URL = 'wss://valid.url/ws';
      process.env.GRVT_REST_API_URL = 'https://valid.api';
      const config = loadConfig();
      expect(config.grvtMarketDataWsUrl).toBe('wss://valid.url/ws');
      expect(config.grvtTradingWsUrl).toBe('wss://valid.url/ws');
      expect(config.grvtRestApiUrl).toBe('https://valid.api');
    });
  });
});
