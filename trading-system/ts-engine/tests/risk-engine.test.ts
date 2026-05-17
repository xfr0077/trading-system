import { RiskEngine, RiskCheckInput, MarginStatus, TradingSignal } from '../src/risk-engine';

function createDefaultSignal(): TradingSignal {
  return {
    signalId: 'test-1',
    symbol: 'BTC_USDT_Perp',
    action: 'long',
    stopLoss: 97000,
    takeProfit: 100000,
    confidence: 75,
    positionSize: 0.05,
    timestamp: Date.now(),
    signalPrice: 98500,
    maxSlippageBps: 10,
  };
}

function createDefaultMarginStatus(): MarginStatus {
  return {
    totalEquity: 10000,
    availableMargin: 8000,
    usedMargin: 2000,
    marginRatio: 0.2,
    status: 'normal',
    updatedAt: Date.now(),
  };
}

function createDefaultInput(overrides: Partial<RiskCheckInput> = {}): RiskCheckInput {
  return {
    signal: createDefaultSignal(),
    currentPrice: 98500,
    currentPositions: [],
    shadowPositions: new Map(),
    marginStatus: createDefaultMarginStatus(),
    ...overrides,
  };
}

describe('RiskEngine', () => {
  let engine: RiskEngine;

  beforeEach(() => {
    engine = new RiskEngine({
      maxPositionSize: 0.1,
      maxDailyLoss: 500,
      maxConcurrentSignals: 3,
      minConfidence: 60,
      maxPriceDeviationPct: 0.5,
      signalTtlMs: 30000,
      requireMarginOk: true,
    });
  });

  test('should allow valid signal', async () => {
    const input = createDefaultInput();
    const result = await engine.check(input);
    expect(result.allowed).toBe(true);
  });

  test('should reject if position size exceeds limit', async () => {
    const input = createDefaultInput({
      signal: { ...createDefaultSignal(), positionSize: 0.15 },
    });
    const result = await engine.check(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('POSITION_SIZE_EXCEEDED');
  });

  test('should reject if confidence too low', async () => {
    const input = createDefaultInput({
      signal: { ...createDefaultSignal(), confidence: 50 },
    });
    const result = await engine.check(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('CONFIDENCE_TOO_LOW');
  });

  test('should reject if price deviation exceeds threshold', async () => {
    const input = createDefaultInput({
      currentPrice: 100000,
    });
    const result = await engine.check(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('PRICE_DEVIATION_EXCEEDED');
  });

  test('should reject if signal expired', async () => {
    const input = createDefaultInput({
      signal: { ...createDefaultSignal(), timestamp: Date.now() - 60000 },
    });
    const result = await engine.check(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('SIGNAL_EXPIRED');
  });

  test('should reject if margin warning', async () => {
    const input = createDefaultInput({
      marginStatus: { ...createDefaultMarginStatus(), status: 'warning' },
    });
    const result = await engine.check(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('MARGIN_WARNING');
  });

  test('should reject if concurrent signals exceeded', async () => {
    engine.updateShadowPosition('BTC_USDT_Perp', 0.1);
    engine.updateShadowPosition('BTC_USDT_Perp', 0.1);
    engine.updateShadowPosition('BTC_USDT_Perp', 0.1);
    const input = createDefaultInput();
    const result = await engine.check(input);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('CONCURRENT_SIGNALS_EXCEEDED');
  });

  test('should track shadow position correctly', () => {
    engine.updateShadowPosition('BTC_USDT_Perp', 0.05);
    expect(engine.getShadowPosition('BTC_USDT_Perp')).toBeCloseTo(0.05);
    engine.updateShadowPosition('BTC_USDT_Perp', -0.02);
    expect(engine.getShadowPosition('BTC_USDT_Perp')).toBeCloseTo(0.03);
  });
});
