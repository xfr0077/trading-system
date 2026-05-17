import { OrderManager, Order, OrderStatus } from '../src/order-manager';

describe('OrderManager', () => {
  let manager: OrderManager;

  beforeEach(() => {
    manager = new OrderManager();
  });

  test('should create order in pending status', () => {
    const order = manager.createOrder({
      signalId: 'sig-1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: 0.01,
      limitPrice: 98500,
    });
    expect(order.status).toBe('pending');
    expect(order.signalId).toBe('sig-1');
    expect(order.remainingSize).toBe(0.01);
  });

  test('should transition from pending to submitted', () => {
    const order = manager.createOrder({
      signalId: 'sig-1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: 0.01,
      limitPrice: 98500,
    });
    manager.updateStatus(order.clientOrderId, 'submitted', 'exchange-order-123');
    const updated = manager.getOrder(order.clientOrderId);
    expect(updated?.status).toBe('submitted');
    expect(updated?.orderId).toBe('exchange-order-123');
  });

  test('should handle partially_filled and update remainingSize', () => {
    const order = manager.createOrder({
      signalId: 'sig-1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: 0.1,
      limitPrice: 98500,
    });
    manager.updateStatus(order.clientOrderId, 'submitted', 'exchange-order-123');
    manager.updatePartialFill(order.clientOrderId, 0.04);
    const updated = manager.getOrder(order.clientOrderId);
    expect(updated?.status).toBe('partially_filled');
    expect(updated?.remainingSize).toBeCloseTo(0.06);
  });

  test('should handle filled status', () => {
    const order = manager.createOrder({
      signalId: 'sig-1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: 0.01,
      limitPrice: 98500,
    });
    manager.updateStatus(order.clientOrderId, 'submitted', 'exchange-order-123');
    manager.updateStatus(order.clientOrderId, 'filled', 'exchange-order-123', 0.5);
    const updated = manager.getOrder(order.clientOrderId);
    expect(updated?.status).toBe('filled');
    expect(updated?.fee).toBe(0.5);
  });

  test('should handle rejected status', () => {
    const order = manager.createOrder({
      signalId: 'sig-1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: 0.01,
      limitPrice: 98500,
    });
    manager.updateStatus(order.clientOrderId, 'rejected', 'exchange-order-123');
    const updated = manager.getOrder(order.clientOrderId);
    expect(updated?.status).toBe('rejected');
  });

  test('should return open orders', () => {
    manager.createOrder({ signalId: 'sig-1', symbol: 'BTC_USDT_Perp', side: 'buy', size: 0.01, limitPrice: 98500 });
    manager.createOrder({ signalId: 'sig-2', symbol: 'ETH_USDT_Perp', side: 'sell', size: 0.1, limitPrice: 3400 });
    const open = manager.getOpenOrders();
    expect(open.length).toBe(2);
  });
});
