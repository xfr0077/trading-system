import { TradingWebSocket } from '../src/trading-ws';
import { OrderUpdate } from '../src/types';

describe('TradingWebSocket', () => {
  let ws: TradingWebSocket;

  beforeEach(() => {
    ws = new TradingWebSocket();
  });

  afterEach(() => {
    ws.disconnect();
  });

  test('should register order update callbacks', () => {
    const callback = jest.fn();
    ws.onOrderUpdate(callback);
    ws.emitTestUpdate({ clientOrderId: 'c1', orderId: 'e1', status: 'filled', fee: '0.5' });
    expect(callback).toHaveBeenCalledWith({
      clientOrderId: 'c1',
      orderId: 'e1',
      status: 'filled',
      fee: '0.5',
    });
  });

  test('should map GRVT status to local status', () => {
    expect(ws.mapGrvtStatus('FILLED')).toBe('filled');
    expect(ws.mapGrvtStatus('CANCELLED')).toBe('cancelled');
    expect(ws.mapGrvtStatus('PENDING')).toBe('pending');
    expect(ws.mapGrvtStatus('PARTIALLY_FILLED')).toBe('partially_filled');
    expect(ws.mapGrvtStatus('UNKNOWN')).toBe('pending');
  });

  test('should return mock order id on submit', async () => {
    const order = { clientOrderId: 'test-1' } as any;
    const result = await ws.submitOrder(order);
    expect(result).toBe('exchange-test-1');
  });

  test('should cancel order without error', async () => {
    await expect(ws.cancelOrder('exchange-1')).resolves.not.toThrow();
  });

  test('should connect without error', async () => {
    await expect(ws.connect({ tradingWsUrl: 'wss://test.grvt.io', apiKey: 'test-key', apiSecret: '0xtest' })).resolves.not.toThrow();
  });
});
