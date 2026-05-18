import { TradingWebSocket, GrvtConfig } from '../src/trading-ws';
import { OrderUpdate } from '../src/types';
import { EGrvtEnvironment } from '@grvt/sdk';

// Mock external dependencies
jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({ data: { result: { instruments: [] } } }),
  post: jest.fn().mockResolvedValue({ data: { result: { order_id: 'exchange-order-1' } } }),
}));

jest.mock('ethers', () => ({
  Wallet: jest.fn().mockImplementation(() => ({
    address: '0xtest',
    signTypedData: jest.fn().mockResolvedValue('0xsignature'),
  })),
  Signature: {
    from: jest.fn().mockReturnValue({ r: '0xr', s: '0xs', v: 1 }),
  },
}));

jest.mock('set-cookie-parser', () => ({
  parse: jest.fn().mockReturnValue([{ name: 'gravity', value: 'test-cookie', expires: new Date() }]),
}));

// Mock fetch globally
(global as any).fetch = jest.fn().mockResolvedValue({
  ok: true,
  headers: {
    get: jest.fn().mockReturnValue('gravity=test-cookie'),
  },
});

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

  test('should cancel order without error', async () => {
    // Mock connected state
    (ws as any).cookie = 'test-cookie';
    (ws as any).config = { env: EGrvtEnvironment.TESTNET, tradingAccountId: 'test-account' };
    (ws as any).accountId = 'test-account';
    
    await expect(ws.cancelOrder('exchange-1')).resolves.not.toThrow();
  });
});
