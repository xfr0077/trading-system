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

// Phase 3: Order execution types

export interface OrderUpdate {
  clientOrderId: string;
  orderId: string;
  status: 'pending' | 'submitted' | 'filled' | 'cancelled' | 'rejected' | 'partially_filled';
  fee: string;
}

export interface TradeRecord {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  size: string;
  price: string;
  fee: string;
  pnl: string;
  timestamp: number;
}

export interface Position {
  symbol: string;
  side: 'long' | 'short';
  size: string;
  entryPrice: string;
  unrealizedPnl: string;
  realizedPnl: string;
  updatedAt: number;
}
