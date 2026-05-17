import { Order } from './sqlite-store';

export class OrderTimeoutManager {
  private timers = new Map<string, NodeJS.Timeout>();

  schedule(orderId: string, ttlMs: number, onCancel: () => void): void {
    if (this.timers.has(orderId)) {
      this.cancel(orderId);
    }

    const timer = setTimeout(async () => {
      await onCancel();
      this.timers.delete(orderId);
    }, ttlMs);

    this.timers.set(orderId, timer);
  }

  cancel(orderId: string): void {
    const timer = this.timers.get(orderId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(orderId);
    }
  }

  async restoreFromDatabase(
    orders: Order[],
    scheduleCallback: (orderId: string, remainingMs: number) => Promise<void>
  ): Promise<void> {
    for (const order of orders) {
      if (order.expiresAt && ['submitted', 'partially_filled'].includes(order.status)) {
        const remainingMs = order.expiresAt - Date.now();
        if (remainingMs > 0) {
          await scheduleCallback(order.clientOrderId, remainingMs);
        }
      }
    }
  }

  clearAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
