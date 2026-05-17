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
  maxConcurrentSignals: number;
  minConfidence: number;
  maxPriceDeviationPct: number;
  signalTtlMs: number;
  requireMarginOk: boolean;
}
