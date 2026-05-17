export interface MarginStatus {
  totalEquity: number;
  availableMargin: number;
  usedMargin: number;
  marginRatio: number;
  status: 'normal' | 'warning' | 'critical';
  updatedAt: number;
}

export interface TradingSignal {
  signalId: string;
  symbol: string;
  action: string;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  positionSize: number;
  timestamp: number;
  signalPrice: number;
  maxSlippageBps: number;
}

export interface RiskCheckInput {
  signal: TradingSignal;
  currentPrice: number;
  currentPositions: Array<{ symbol: string; size: number }>;
  shadowPositions: Map<string, number>;
  marginStatus: MarginStatus;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason: string;
}

export interface RiskConfig {
  maxPositionSize: number;
  maxDailyLoss: number;
  /** Total exposure multiplier (not signal count limit). Default: 3 */
  maxConcurrentSignals: number;
  minConfidence: number;
  maxPriceDeviationPct: number;
  signalTtlMs: number;
  requireMarginOk: boolean;
}

export class RiskEngine {
  private shadowPositions = new Map<string, number>();

  constructor(private config: RiskConfig) {}

  async check(input: RiskCheckInput): Promise<RiskCheckResult> {
    const { signal, currentPrice, marginStatus } = input;

    if (Date.now() - signal.timestamp > this.config.signalTtlMs) {
      return { allowed: false, reason: 'SIGNAL_EXPIRED' };
    }

    if (signal.confidence < this.config.minConfidence) {
      return { allowed: false, reason: 'CONFIDENCE_TOO_LOW' };
    }

    if (signal.positionSize > this.config.maxPositionSize) {
      return { allowed: false, reason: 'POSITION_SIZE_EXCEEDED' };
    }

    if (currentPrice <= 0) {
      return { allowed: false, reason: 'PRICE_DATA_INVALID' };
    }

    const deviation = Math.abs(signal.signalPrice - currentPrice) / currentPrice * 100;
    if (deviation > this.config.maxPriceDeviationPct) {
      return { allowed: false, reason: 'PRICE_DEVIATION_EXCEEDED' };
    }

    if (this.config.requireMarginOk && (marginStatus.status === 'warning' || marginStatus.status === 'critical')) {
      return { allowed: false, reason: marginStatus.status === 'critical' ? 'MARGIN_CRITICAL' : 'MARGIN_WARNING' };
    }

    const currentShadow = this.shadowPositions.get(signal.symbol) || 0;
    const totalExposure = currentShadow + signal.positionSize;
    if (totalExposure > this.config.maxPositionSize * this.config.maxConcurrentSignals) {
      return { allowed: false, reason: 'CONCURRENT_SIGNALS_EXCEEDED' };
    }

    return { allowed: true, reason: '' };
  }

  updateShadowPosition(symbol: string, delta: number): void {
    const current = this.shadowPositions.get(symbol) || 0;
    const newValue = current + delta;
    if (newValue <= 0) {
      this.shadowPositions.delete(symbol);
    } else {
      this.shadowPositions.set(symbol, newValue);
    }
  }

  getShadowPosition(symbol: string): number {
    return this.shadowPositions.get(symbol) || 0;
  }

  getShadowPositions(): Map<string, number> {
    return new Map(this.shadowPositions);
  }
}
