import { SignalRouter } from '../src/signal-router';
import { Config } from '../src/config';
import { MarketDataStream } from '../src/market-data';
import { EGrvtEnvironment } from '@grvt/sdk';
import { GrvtEnv } from '@wezzcoetzee/grvt';

// Mock TradingWebSocket
jest.mock('../src/trading-ws', () => {
  return {
    TradingWebSocket: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      submitOrder: jest.fn().mockResolvedValue('exchange-order-1'),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
      getInstruments: jest.fn().mockResolvedValue([]),
      addInstrument: jest.fn(),
      onOrderUpdate: jest.fn(),
      disconnect: jest.fn(),
    })),
  };
});

function createMockConfig(overrides = {}): Config {
  return {
    grvtApiKey: 'test-key',
    grvtPrivateKey: '0xtest-secret',
    grvtTradingAccountId: 'test-account',
    grvtEnv: EGrvtEnvironment.TESTNET,
    grvtEnvCommunity: GrvtEnv.TESTNET,
    redisUrl: 'redis://localhost:6379',
    sqlitePath: '/tmp/test.db',
    grpcPort: 0,
    tailscaleAiIp: '127.0.0.1',
    symbols: ['BTC_USDT_Perp'],
    maxPositionSize: 1,
    maxDailyLoss: 500,
    maxConcurrentSignals: 3,
    minConfidence: 60,
    maxPriceDeviationPct: 0.5,
    signalTtlMs: 30000,
    marginWarningThreshold: 0.7,
    marginCriticalThreshold: 0.9,
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
      stopLoss: 97000,
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
      await expect(router.handleSignal(signal)).rejects.toThrow(
        'INVALID_ARGUMENT: confidence must be between 0 and 100',
      );
    });

    test('should reject confidence out of range (over 100)', async () => {
      const signal = createValidSignal({ confidence: 101 });
      await expect(router.handleSignal(signal)).rejects.toThrow(
        'INVALID_ARGUMENT: confidence must be between 0 and 100',
      );
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
      for (const action of ['long', 'short']) {
        const signal = createValidSignal({ signalId: `action-${action}`, action });
        const ack = await router.handleSignal(signal);
        expect(ack.accepted).toBe(true);
      }
    });

    test('should reject close when no position exists', async () => {
      const signal = createValidSignal({ signalId: 'action-close', action: 'close' });
      const ack = await router.handleSignal(signal);
      expect(ack.accepted).toBe(false);
      expect(ack.reason).toBe('NO_POSITION_TO_CLOSE');
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

    test('should reject when port is already in use', async () => {
      const fixedPort = 19999;
      const router2 = new SignalRouter(createMockConfig());
      router2.setMarketData(createMockMarketData());
      const server1 = await router2.startServer(fixedPort);

      const router3 = new SignalRouter(createMockConfig());
      router3.setMarketData(createMockMarketData());
      await expect(router3.startServer(fixedPort)).rejects.toThrow();

      server1.forceShutdown();
      router2.stop();
      router3.stop();
    });
  });
});
