import { SignalRouter } from '../src/signal-router';

describe('SignalRouter', () => {
  let router: SignalRouter;

  beforeEach(() => {
    router = new SignalRouter();
  });

  test('should accept valid signal', async () => {
    const signal = {
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
    };

    const ack = await router.handleSignal(signal);
    expect(ack.accepted).toBe(true);
  });

  test('should reject duplicate signal', async () => {
    const signal = {
      signalId: 'uuid-dup',
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
    const ack = await router.handleSignal(signal);
    expect(ack.accepted).toBe(false);
    expect(ack.reason).toBe('DUPLICATE_SIGNAL');
  });
});
