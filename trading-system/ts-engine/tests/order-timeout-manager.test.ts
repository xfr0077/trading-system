import { OrderTimeoutManager } from '../src/order-timeout-manager';

jest.useFakeTimers();

describe('OrderTimeoutManager', () => {
  let manager: OrderTimeoutManager;
  let cancelCallback: jest.Mock;

  beforeEach(() => {
    manager = new OrderTimeoutManager();
    cancelCallback = jest.fn();
  });

  test('should trigger cancel callback after TTL', () => {
    manager.schedule('order-1', 5000, cancelCallback);
    expect(cancelCallback).not.toHaveBeenCalled();

    jest.advanceTimersByTime(5000);
    expect(cancelCallback).toHaveBeenCalledTimes(1);
  });

  test('should cancel timer before TTL', () => {
    manager.schedule('order-1', 5000, cancelCallback);
    manager.cancel('order-1');

    jest.advanceTimersByTime(5000);
    expect(cancelCallback).not.toHaveBeenCalled();
  });

  test('should not trigger callback if already cancelled', () => {
    manager.schedule('order-1', 5000, cancelCallback);
    manager.cancel('order-1');
    manager.cancel('order-1');

    jest.advanceTimersByTime(5000);
    expect(cancelCallback).not.toHaveBeenCalled();
  });

  test('should clear all timers', () => {
    manager.schedule('order-1', 5000, cancelCallback);
    manager.schedule('order-2', 5000, cancelCallback);
    manager.clearAll();

    jest.advanceTimersByTime(5000);
    expect(cancelCallback).not.toHaveBeenCalled();
  });

  test('should restore orders with remaining TTL', async () => {
    const scheduleCallback = jest.fn().mockResolvedValue(undefined);
    const now = Date.now();
    const orders = [
      { clientOrderId: 'c1', expiresAt: now + 10000, status: 'submitted' },
      { clientOrderId: 'c2', expiresAt: now - 5000, status: 'submitted' },
      { clientOrderId: 'c3', expiresAt: now + 10000, status: 'filled' },
    ] as any[];

    await manager.restoreFromDatabase(orders, scheduleCallback);

    expect(scheduleCallback).toHaveBeenCalledTimes(1);
    expect(scheduleCallback).toHaveBeenCalledWith('c1', expect.any(Number));
  });
});
