import { SignalRouter } from '../src/signal-router';
import { Config } from '../src/config';
import { MarketDataStream } from '../src/market-data';

function createMockConfig(overrides = {}): Config {
  return {
    env: 'testnet',
    dexProvider: 'lighter' as const,
    redisUrl: 'redis://localhost:6379',
    sqlitePath: 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\test-signal-router.db',
    grpcPort: 0,
    grpcTlsEnabled: false,
    dashboardPort: 3000,
    tailscaleAiIp: '127.0.0.1',
    symbols: ['BTC_USDT_Perp', 'ETH_USDT_Perp'],
    maxPositionSize: 1,
    maxDailyLoss: 500,
    maxConcurrentSignals: 3,
    minConfidence: 60,
    maxPriceDeviationPct: 0.5,
    signalTtlMs: 30000,
    marginWarningThreshold: 0.7,
    marginCriticalThreshold: 0.9,
    trailingStopPct: 0.01,
    paperTrading: true,
    corsOrigins: ['*'],
    rateLimitRpm: 60,
    ...overrides,
  };
}

function createMockMarketData(): MarketDataStream {
  const mockStream = {
    getLatestPriceInMemory: jest.fn((symbol: string) => ({
      symbol,
      lastPrice: 98500,
      bidPrice: 98490,
      askPrice: 98510,
      volume24h: 1000,
      timestamp: Date.now(),
    })),
    onPriceUpdate: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as MarketDataStream;
  return mockStream;
}

describe('SignalRouter', () => {
  let router: SignalRouter;
  let mockMarketData: MarketDataStream;

  beforeEach(() => {
    mockMarketData = createMockMarketData();
    router = new SignalRouter(createMockConfig());
    router.setMarketData(mockMarketData);
  });

  afterEach(() => {
    router.stop();
  });

  describe('handleSignal', () => {
    const createValidSignal = (overrides = {}): any => ({
      signalId: 'uuid-1',
      symbol: 'BTC_USDT_Perp',
      action: 'long',
      stopLoss: 98300,   // risk=200, reward=1500, ratio=7.5 (>= minRiskRewardRatio=2)
      takeProfit: 100000,
      confidence: 75,
      positionSize: 0.01,
      timestamp: Date.now(),
      signalPrice: 98500,
      maxSlippageBps: 10,
      ...overrides,
    });

    test('should accept valid signal', async () => {
      const signal = createValidSignal();
      const ack = await router.handleSignal(signal);
      expect(ack.accepted).toBe(true);
    });

    test('should reject duplicate signal', async () => {
      const signal = createValidSignal({ signalId: 'uuid-dup' });

      await router.handleSignal(signal);
      const ack = await router.handleSignal(signal);
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toBe('DUPLICATE_SIGNAL');
    });

    test('should reject missing signalId', async () => {
      const signal = createValidSignal({ signalId: '' });
      await expect(router.handleSignal(signal)).rejects.toThrow('INVALID_ARGUMENT: signalId is required');
    });

    test('should reject missing symbol', async () => {
      const signal = createValidSignal({ symbol: '' });
      await expect(router.handleSignal(signal)).rejects.toThrow('INVALID_ARGUMENT: symbol is required');
    });

    test('should reject invalid action', async () => {
      const signal = createValidSignal({ action: 'hold' });
      await expect(router.handleSignal(signal)).rejects.toThrow(
        'INVALID_ARGUMENT: action must be one of: long, short, close',
      );
    });

    test('should reject confidence out of range (negative)', async () => {
      const signal = createValidSignal({ confidence: -1 });
      const ack = await router.handleSignal(signal);
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toBe('INVALID_CONFIDENCE');
    });

    test('should reject confidence out of range (over 100)', async () => {
      const signal = createValidSignal({ confidence: 101 });
      const ack = await router.handleSignal(signal);
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toBe('INVALID_CONFIDENCE');
    });

    test('should reject non-positive positionSize', async () => {
      const signal = createValidSignal({ positionSize: 0 });
      await expect(router.handleSignal(signal)).rejects.toThrow(
        'INVALID_ARGUMENT: positionSize must be greater than 0',
      );
    });

    test('should reject non-positive stopLoss', async () => {
      const signal = createValidSignal({ stopLoss: 0 });
      await expect(router.handleSignal(signal)).rejects.toThrow(
        'INVALID_ARGUMENT: stopLoss must be greater than 0',
      );
    });

    test('should reject non-positive takeProfit', async () => {
      const signal = createValidSignal({ takeProfit: 0 });
      await expect(router.handleSignal(signal)).rejects.toThrow(
        'INVALID_ARGUMENT: takeProfit must be greater than 0',
      );
    });

    test('should reject non-positive signalPrice', async () => {
      const signal = createValidSignal({ signalPrice: 0 });
      await expect(router.handleSignal(signal)).rejects.toThrow(
        'INVALID_ARGUMENT: signalPrice must be greater than 0',
      );
    });

    test('should reject negative maxSlippageBps', async () => {
      const signal = createValidSignal({ maxSlippageBps: -1 });
      await expect(router.handleSignal(signal)).rejects.toThrow(
        'INVALID_ARGUMENT: maxSlippageBps must be non-negative',
      );
    });

    test('should accept long and short actions', async () => {
      const ack1 = await router.handleSignal(createValidSignal({ signalId: 'action-long', action: 'long' }));
      expect(ack1.accepted).toBe(true);
      // 第二个信号用不同 symbol，避免 PENDING_ORDER_EXISTS
      const ack2 = await router.handleSignal(createValidSignal({
        signalId: 'action-short', action: 'short', symbol: 'ETH_USDT_Perp',
        stopLoss: 100000, takeProfit: 95000, signalPrice: 98500,
      }));
      expect(ack2.accepted).toBe(true);
    });

    test('should reject close when no position exists', async () => {
      const signal = createValidSignal({ signalId: 'action-close', action: 'close', stopLoss: 0, takeProfit: 0 });
      const ack = await router.handleSignal(signal);
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toBe('NO_POSITION_TO_CLOSE');
    });

    test('should reject symbol not in whitelist', async () => {
      const signal = createValidSignal({ symbol: 'DOGE_USDT_Perp' });
      const ack = await router.handleSignal(signal);
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toBe('INVALID_SYMBOL');
    });

    test('should reject long signal with stopLoss >= signalPrice', async () => {
      const signal = createValidSignal({ action: 'long', stopLoss: 99000, signalPrice: 98500, takeProfit: 100000 });
      const ack = await router.handleSignal(signal);
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toBe('INVALID_SL_TP');
    });

    test('should reject long signal with signalPrice >= takeProfit', async () => {
      const signal = createValidSignal({ action: 'long', stopLoss: 97000, signalPrice: 100500, takeProfit: 100000 });
      const ack = await router.handleSignal(signal);
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toBe('INVALID_SL_TP');
    });

    test('should reject short signal with takeProfit >= signalPrice', async () => {
      const signal = createValidSignal({ action: 'short', stopLoss: 100000, signalPrice: 98500, takeProfit: 99000 });
      const ack = await router.handleSignal(signal);
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toBe('INVALID_SL_TP');
    });

    test('should reject short signal with signalPrice >= stopLoss', async () => {
      const signal = createValidSignal({ action: 'short', stopLoss: 98000, signalPrice: 98500, takeProfit: 97000 });
      const ack = await router.handleSignal(signal);
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toBe('INVALID_SL_TP');
    });

    test('should accept close action with stopLoss and takeProfit as 0', async () => {
      // close action skips SL/TP > 0 check and direction validation
      const signal = createValidSignal({ signalId: 'close-zero', action: 'close', stopLoss: 0, takeProfit: 0 });
      // Will be rejected for NO_POSITION_TO_CLOSE (no open position), but NOT for SL/TP validation
      const ack = await router.handleSignal(signal);
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toBe('NO_POSITION_TO_CLOSE');
    });

    test('should accept confidence at boundary values (0 and 100)', async () => {
      const signal0 = createValidSignal({ signalId: 'conf-0', confidence: 0 });
      const ack0 = await router.handleSignal(signal0);
      // Confidence 0 passes the range check but may be rejected by risk engine (minConfidence=60)
      // The important thing is it does NOT get INVALID_CONFIDENCE
      expect(ack0.reason).not.toBe('INVALID_CONFIDENCE');

      const signal100 = createValidSignal({ signalId: 'conf-100', confidence: 100 });
      const ack100 = await router.handleSignal(signal100);
      expect(ack100.reason).not.toBe('INVALID_CONFIDENCE');
    });
  });

  describe('cleanup', () => {
    test('should clean up expired signals', async () => {
      const signal = {
        signalId: 'cleanup-test',
        symbol: 'BTC_USDT_Perp',
        action: 'long',
        stopLoss: 97000,
        takeProfit: 100000,
        confidence: 75,
        positionSize: 0.01,
        timestamp: Date.now(),
        signalPrice: 98500,
        maxSlippageBps: 10,
      };

      await router.handleSignal(signal);
      router.stop();

      router['seenSignals'].clear();
      router['seenSignals'].set('old-signal', Date.now() - 10 * 60 * 1000);
      router['seenSignals'].set('recent-signal', Date.now());

      router['cleanupExpiredSignals']();

      expect(router['seenSignals'].has('old-signal')).toBe(false);
      expect(router['seenSignals'].has('recent-signal')).toBe(true);
    });
  });

  describe('startServer', () => {
    test('should return a Promise that resolves to a gRPC server', async () => {
      const serverPromise = router.startServer(0);
      expect(serverPromise).toBeInstanceOf(Promise);

      const server = await serverPromise;
      expect(server).toBeDefined();

      server.forceShutdown();
    });

    // Skipped on Windows: gRPC's SO_REUSEADDR allows binding to the same port
    // as a net.Server, making EADDRINUSE unreproducible.
    const isWindows = process.platform === 'win32';
    const testOrSkip = isWindows ? test.skip : test;
    testOrSkip('should reject when port is already in use', async () => {
      const net = require('net');
      // Occupy a random port with a TCP server to force EADDRINUSE
      const tempServer = net.createServer();
      await new Promise<void>((resolve, reject) => {
        tempServer.on('error', reject);
        tempServer.listen(0, resolve);
      });
      const addr = tempServer.address();
      const occupiedPort = typeof addr === 'object' && addr ? addr.port : 0;

      const router2 = new SignalRouter(createMockConfig());
      router2.setMarketData(createMockMarketData());
      await expect(router2.startServer(occupiedPort)).rejects.toThrow();

      tempServer.close();
      router2.stop();
    });
  });
});
