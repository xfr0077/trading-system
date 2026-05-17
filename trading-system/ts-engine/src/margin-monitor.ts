export interface MarginStatus {
  totalEquity: number;
  availableMargin: number;
  usedMargin: number;
  marginRatio: number;
  status: 'normal' | 'warning' | 'critical';
  updatedAt: number;
}

export interface MarginMonitorConfig {
  warningThreshold: number;
  criticalThreshold: number;
}

export class MarginMonitor {
  private status: MarginStatus | null = null;
  private callbacks: Array<(status: MarginStatus) => void> = [];

  constructor(private config: MarginMonitorConfig) {}

  updateStatus(status: MarginStatus): void {
    this.status = status;
    for (const cb of this.callbacks) {
      cb(status);
    }
  }

  getStatus(): MarginStatus {
    if (!this.status) {
      return {
        totalEquity: 0,
        availableMargin: 0,
        usedMargin: 0,
        marginRatio: 0,
        status: 'normal',
        updatedAt: Date.now(),
      };
    }
    return this.status;
  }

  isSafeForNewOrder(requiredMargin: number): boolean {
    const current = this.getStatus();
    return current.availableMargin >= requiredMargin && current.status !== 'critical';
  }

  onStatusChange(callback: (status: MarginStatus) => void): void {
    this.callbacks.push(callback);
  }
}
