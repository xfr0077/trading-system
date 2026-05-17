import { SignalRouter } from '../src/signal-router';

describe('SignalRouter', () => {
  let router: SignalRouter;

  beforeEach(() => {
    router = new SignalRouter();
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

    test('should accept all valid actions', async () => {
      for (const action of ['long', 'short', 'close']) {
        const signal = createValidSignal({ signalId: `action-${action}`, action });
        const ack = await router.handleSignal(signal);
        expect(ack.accepted).toBe(true);
      }
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
      const router2 = new SignalRouter();
      const server1 = await router2.startServer(fixedPort);

      const router3 = new SignalRouter();
      await expect(router3.startServer(fixedPort)).rejects.toThrow();

      server1.forceShutdown();
      router2.stop();
      router3.stop();
    });
  });
});
