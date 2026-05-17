import { MarginMonitor } from '../src/margin-monitor';
import { MarginStatus } from '../src/types';

describe('MarginMonitor', () => {
  let monitor: MarginMonitor;

  beforeEach(() => {
    monitor = new MarginMonitor({
      warningThreshold: 0.7,
      criticalThreshold: 0.9,
    });
  });

  test('should update margin status', () => {
    const raw: Omit<MarginStatus, 'status'> = {
      totalEquity: 10000,
      availableMargin: 8000,
      usedMargin: 2000,
      marginRatio: 0.2,
      updatedAt: Date.now(),
    };
    monitor.updateStatus(raw);
    const result = monitor.getStatus();
    expect(result.totalEquity).toBe(10000);
    expect(result.availableMargin).toBe(8000);
    expect(result.usedMargin).toBe(2000);
    expect(result.marginRatio).toBe(0.2);
    expect(result.status).toBe('normal');
  });

  test('should automatically compute warning status when margin ratio exceeds warning threshold', () => {
    const raw: Omit<MarginStatus, 'status'> = {
      totalEquity: 10000,
      availableMargin: 2000,
      usedMargin: 8000,
      marginRatio: 0.8,
      updatedAt: Date.now(),
    };
    monitor.updateStatus(raw);
    expect(monitor.getStatus().status).toBe('warning');
  });

  test('should automatically compute critical status when margin ratio exceeds critical threshold', () => {
    const raw: Omit<MarginStatus, 'status'> = {
      totalEquity: 10000,
      availableMargin: 500,
      usedMargin: 9500,
      marginRatio: 0.95,
      updatedAt: Date.now(),
    };
    monitor.updateStatus(raw);
    expect(monitor.getStatus().status).toBe('critical');
  });

  test('should return normal status when margin ratio is below warning threshold', () => {
    const raw: Omit<MarginStatus, 'status'> = {
      totalEquity: 10000,
      availableMargin: 5000,
      usedMargin: 5000,
      marginRatio: 0.5,
      updatedAt: Date.now(),
    };
    monitor.updateStatus(raw);
    expect(monitor.getStatus().status).toBe('normal');
  });

  test('should return warning status when margin ratio equals warning threshold', () => {
    const raw: Omit<MarginStatus, 'status'> = {
      totalEquity: 10000,
      availableMargin: 3000,
      usedMargin: 7000,
      marginRatio: 0.7,
      updatedAt: Date.now(),
    };
    monitor.updateStatus(raw);
    expect(monitor.getStatus().status).toBe('warning');
  });

  test('should return critical status when margin ratio equals critical threshold', () => {
    const raw: Omit<MarginStatus, 'status'> = {
      totalEquity: 10000,
      availableMargin: 1000,
      usedMargin: 9000,
      marginRatio: 0.9,
      updatedAt: Date.now(),
    };
    monitor.updateStatus(raw);
    expect(monitor.getStatus().status).toBe('critical');
  });

  test('should return false for isSafeForNewOrder when insufficient margin', () => {
    const raw: Omit<MarginStatus, 'status'> = {
      totalEquity: 10000,
      availableMargin: 500,
      usedMargin: 9500,
      marginRatio: 0.95,
      updatedAt: Date.now(),
    };
    monitor.updateStatus(raw);
    expect(monitor.isSafeForNewOrder(1000)).toBe(false);
  });

  test('should return true for isSafeForNewOrder when sufficient margin', () => {
    const raw: Omit<MarginStatus, 'status'> = {
      totalEquity: 10000,
      availableMargin: 8000,
      usedMargin: 2000,
      marginRatio: 0.2,
      updatedAt: Date.now(),
    };
    monitor.updateStatus(raw);
    expect(monitor.isSafeForNewOrder(1000)).toBe(true);
  });

  test('should trigger onStatusChange callback with computed status', () => {
    const callback = jest.fn();
    monitor.onStatusChange(callback);

    const raw: Omit<MarginStatus, 'status'> = {
      totalEquity: 10000,
      availableMargin: 2000,
      usedMargin: 8000,
      marginRatio: 0.8,
      updatedAt: Date.now(),
    };
    monitor.updateStatus(raw);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ status: 'warning' }));
  });
});
