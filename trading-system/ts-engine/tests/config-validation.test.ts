import { loadConfig } from '../src/config';

describe('Config Phase 2 - Validation & Defaults', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.GRVT_PRIVATE_KEY = '0xtest-secret';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

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
});
