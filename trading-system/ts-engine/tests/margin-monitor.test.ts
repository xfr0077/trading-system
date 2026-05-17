import { MarginMonitor, MarginStatus } from '../src/margin-monitor';

describe('MarginMonitor', () => {
  let monitor: MarginMonitor;

  beforeEach(() => {
    monitor = new MarginMonitor({
      warningThreshold: 0.7,
      criticalThreshold: 0.9,
    });
  });

  test('should update margin status', () => {
    const status: MarginStatus = {
      totalEquity: 10000,
      availableMargin: 8000,
      usedMargin: 2000,
      marginRatio: 0.2,
      status: 'normal',
      updatedAt: Date.now(),
    };
    monitor.updateStatus(status);
    expect(monitor.getStatus()).toEqual(status);
  });

  test('should trigger warning when margin ratio exceeds threshold', () => {
    const status: MarginStatus = {
      totalEquity: 10000,
      availableMargin: 2000,
      usedMargin: 8000,
      marginRatio: 0.8,
      status: 'warning',
      updatedAt: Date.now(),
    };
    monitor.updateStatus(status);
    expect(monitor.getStatus().status).toBe('warning');
  });

  test('should return false for isSafeForNewOrder when insufficient margin', () => {
    const status: MarginStatus = {
      totalEquity: 10000,
      availableMargin: 500,
      usedMargin: 9500,
      marginRatio: 0.95,
      status: 'critical',
      updatedAt: Date.now(),
    };
    monitor.updateStatus(status);
    expect(monitor.isSafeForNewOrder(1000)).toBe(false);
  });

  test('should return true for isSafeForNewOrder when sufficient margin', () => {
    const status: MarginStatus = {
      totalEquity: 10000,
      availableMargin: 8000,
      usedMargin: 2000,
      marginRatio: 0.2,
      status: 'normal',
      updatedAt: Date.now(),
    };
    monitor.updateStatus(status);
    expect(monitor.isSafeForNewOrder(1000)).toBe(true);
  });
});
