import { MarginStatus } from './types';

export interface MarginMonitorConfig {
  warningThreshold: number;
  criticalThreshold: number;
}

export class MarginMonitor {
  private status: MarginStatus | null = null;
  private callbacks: Array<(status: MarginStatus) => void> = [];

  constructor(private config: MarginMonitorConfig) {}

  updateStatus(raw: Omit<MarginStatus, 'status'>): void {
    const computedStatus: MarginStatus = {
      ...raw,
      status: raw.marginRatio >= this.config.criticalThreshold
        ? 'critical'
        : raw.marginRatio >= this.config.warningThreshold
          ? 'warning'
          : 'normal',
    };
    this.status = computedStatus;
    for (const cb of this.callbacks) {
      cb(computedStatus);
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
