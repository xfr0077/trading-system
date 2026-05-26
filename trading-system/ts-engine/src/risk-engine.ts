import { MarginStatus, TradingSignal, RiskCheckInput, RiskCheckResult, RiskConfig } from './types';

export { MarginStatus, TradingSignal, RiskCheckInput, RiskCheckResult, RiskConfig };

export interface AdvancedRiskConfig extends RiskConfig {
  maxPortfolioExposure: number;
  maxCorrelatedExposure: number;
  maxLeverage: number;
  kellyFraction: number;
  atrMultiplier: number;
  minRiskRewardRatio: number;
  maxDrawdownPct: number;
  trailingStopPct: number;
  scaleInLevels: number;
}

export interface PositionMetrics {
  symbol: string;
  size: number;
  entryPrice: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
  weight: number;
  riskContribution: number;
}

export interface PortfolioMetrics {
  totalValue: number;
  totalExposure: number;
  leverage: number;
  maxDrawdown: number;
  sharpeRatio: number;
  winRate: number;
  profitFactor: number;
  positions: PositionMetrics[];
}

// P2: Volatility regime thresholds
const VOL_LOW_THRESHOLD = 0.005;  // 0.5% daily vol = calm market
const VOL_HIGH_THRESHOLD = 0.02;  // 2% daily vol = volatile market

export type VolatilityRegime = 'low' | 'normal' | 'high';

export class RiskEngine {
  private shadowPositions = new Map<string, number>();
  private dailyLossAccumulator = 0;
  private lastResetDate = new Date().toDateString();
  private tradeHistory: Array<{ symbol: string; pnl: number; timestamp: number; capitalAtRisk: number }> = [];
  private peakValue = 0;
  private currentValue = 0;
  private priceHistory = new Map<string, number[]>();
  private readonly MAX_PRICE_HISTORY = 100;
  private volRegime: VolatilityRegime = 'normal';

  constructor(private config: AdvancedRiskConfig) {}

  private resetDailyLossIfNeeded(): void {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyLossAccumulator = 0;
      this.lastResetDate = today;
    }
  }

  recordRealizedLoss(loss: number, capitalAtRisk: number = 0): void {
    if (loss > 0) {
      this.dailyLossAccumulator += loss;
    }
    this.tradeHistory.push({
      symbol: '',
      pnl: -loss,
      timestamp: Date.now(),
      capitalAtRisk: capitalAtRisk || 0,
    });
  }

  getDailyLoss(): number {
    this.resetDailyLossIfNeeded();
    return this.dailyLossAccumulator;
  }

  calculateDynamicPositionSize(signal: TradingSignal, currentPrice: number, portfolioValue: number): number {
    const kelly = this.calculateKellyFraction(signal, currentPrice);
    const stopDistance = Math.abs(signal.signalPrice - signal.stopLoss);
    if (stopDistance <= 0) return 0;
    // Dollar risk = portfolio * kelly. Convert to contracts: risk / stopDistance
    const riskDollars = portfolioValue * kelly * this.config.kellyFraction;
    const size = riskDollars / stopDistance;
    return Math.min(size, this.config.maxPositionSize);
  }

  private calculateKellyFraction(signal: TradingSignal, currentPrice: number): number {
    const recentTrades = this.tradeHistory.slice(-50);
    if (recentTrades.length < 10) return 0.02;

    const wins = recentTrades.filter(t => t.pnl > 0);
    const losses = recentTrades.filter(t => t.pnl < 0);
    const winRate = wins.length / recentTrades.length;

    // P0 Fix: Use returns (PnL / capitalAtRisk) instead of raw PnL
    const avgWinReturn = wins.length > 0 && wins[0].capitalAtRisk > 0
      ? wins.reduce((s, t) => s + (t.pnl / t.capitalAtRisk), 0) / wins.length
      : 0.05; // Default 5% avg win return
    const avgLossReturn = losses.length > 0 && losses[0].capitalAtRisk > 0
      ? Math.abs(losses.reduce((s, t) => s + (t.pnl / t.capitalAtRisk), 0) / losses.length)
      : 0.025; // Default 2.5% avg loss return

    if (avgLossReturn === 0) return 0.02;

    const b = avgWinReturn / avgLossReturn;
    const kelly = (b * winRate - (1 - winRate)) / b;

    return Math.max(0, Math.min(kelly, 0.25));
  }

  private adjustForVolatility(signal: TradingSignal, currentPrice: number): number {
    const atr = this.calculateATR(signal, currentPrice);
    if (atr === 0) return 0.02;

    // P2: Adjust risk per trade based on volatility regime
    const regimeMultiplier = this.getRegimeMultiplier();
    const riskPerTrade = this.config.maxDailyLoss * 0.02 * regimeMultiplier;
    const stopDistance = Math.abs(signal.signalPrice - signal.stopLoss);
    const volatilitySize = riskPerTrade / (stopDistance || atr * this.config.atrMultiplier);

    return Math.max(0.001, Math.min(volatilitySize, 0.1));
  }

  private calculateATR(signal: TradingSignal, currentPrice: number): number {
    // M1: Use real ATR from price history if available
    const history = this.priceHistory.get(signal.symbol);
    if (history && history.length >= 14) {
      const period = 14;
      const trueRanges: number[] = [];
      for (let i = history.length - period; i < history.length; i++) {
        if (i === 0) continue;
        const high = history[i];
        const low = history[i];
        const prevClose = history[i - 1];
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trueRanges.push(tr);
      }
      if (trueRanges.length > 0) {
        const atr = trueRanges.reduce((s, r) => s + r, 0) / trueRanges.length;
        // P2: Update volatility regime based on ATR
        this.updateVolRegime(signal.symbol, atr / currentPrice);
        // Ensure minimum ATR to prevent SL/TP = entry price
        return Math.max(atr, currentPrice * 0.005);
      }
    }
    // Fallback: 2% of price
    return currentPrice * 0.02;
  }

  private updateVolRegime(symbol: string, dailyVol: number): void {
    if (dailyVol < VOL_LOW_THRESHOLD) {
      this.volRegime = 'low';
    } else if (dailyVol > VOL_HIGH_THRESHOLD) {
      this.volRegime = 'high';
    } else {
      this.volRegime = 'normal';
    }
  }

  private getRegimeMultiplier(): number {
    switch (this.volRegime) {
      case 'low': return 1.5;    // Increase position size in calm markets
      case 'normal': return 1.0; // Normal sizing
      case 'high': return 0.5;   // Reduce position size in volatile markets
    }
  }

  getVolatilityRegime(): VolatilityRegime {
    return this.volRegime;
  }

  calculateSLTP(signal: TradingSignal, currentPrice: number): { stopLoss: number; takeProfit: number } {
    const atr = this.calculateATR(signal, currentPrice);
    // P2: Adjust ATR multiplier based on volatility regime
    const regimeMultiplier = this.volRegime === 'high' ? 1.5 : this.volRegime === 'low' ? 1.0 : 1.0;
    const atrMultiplier = this.config.atrMultiplier * regimeMultiplier;

    let stopLoss: number;
    let takeProfit: number;
    if (signal.action === 'long') {
      stopLoss = currentPrice - (atr * atrMultiplier);
      const risk = currentPrice - stopLoss;
      takeProfit = currentPrice + (risk * this.config.minRiskRewardRatio);
    } else {
      stopLoss = currentPrice + (atr * atrMultiplier);
      const risk = stopLoss - currentPrice;
      takeProfit = currentPrice - (risk * this.config.minRiskRewardRatio);
    }

    // Safety guard: ensure minimum SL/TP distance (0.5% of entry)
    const minDist = currentPrice * 0.005;
    if (signal.action === 'long') {
      if (currentPrice - stopLoss < minDist) stopLoss = currentPrice - minDist;
      if (takeProfit - currentPrice < minDist * this.config.minRiskRewardRatio) {
        takeProfit = currentPrice + minDist * this.config.minRiskRewardRatio;
      }
    } else {
      if (stopLoss - currentPrice < minDist) stopLoss = currentPrice + minDist;
      if (currentPrice - takeProfit < minDist * this.config.minRiskRewardRatio) {
        takeProfit = currentPrice - minDist * this.config.minRiskRewardRatio;
      }
    }

    return { stopLoss, takeProfit };
  }

  async check(input: RiskCheckInput): Promise<RiskCheckResult> {
    const { signal, currentPrice, marginStatus } = input;

    if (Date.now() - signal.timestamp > this.config.signalTtlMs) {
      return { allowed: false, reason: 'SIGNAL_EXPIRED' };
    }

    if (signal.confidence < this.config.minConfidence) {
      return { allowed: false, reason: 'CONFIDENCE_TOO_LOW' };
    }

    this.resetDailyLossIfNeeded();
    if (this.dailyLossAccumulator >= this.config.maxDailyLoss) {
      return { allowed: false, reason: 'DAILY_LOSS_EXCEEDED' };
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
    const realPosition = input.currentPositions.find(p => p.symbol === signal.symbol);
    const realSize = realPosition ? realPosition.size : 0;
    // Close actions reduce exposure, don't add signal.positionSize
    const newSize = signal.action === 'close' ? 0 : signal.positionSize;
    const totalExposure = currentShadow + realSize + newSize;

    if (totalExposure > this.config.maxPositionSize * this.config.maxConcurrentSignals) {
      return { allowed: false, reason: 'CONCURRENT_SIGNALS_EXCEEDED' };
    }

    if (totalExposure > this.config.maxPortfolioExposure) {
      return { allowed: false, reason: 'PORTFOLIO_EXPOSURE_EXCEEDED' };
    }

    // P1: Enforce correlated exposure check
    const correlatedExposure = this.calculateCorrelatedExposure(signal.symbol, totalExposure);
    if (correlatedExposure > this.config.maxCorrelatedExposure) {
      return { allowed: false, reason: 'CORRELATED_EXPOSURE_EXCEEDED' };
    }

    // P1: Enforce drawdown check
    const drawdown = this.getDrawdown();
    if (drawdown > this.config.maxDrawdownPct) {
      return { allowed: false, reason: 'MAX_DRAWDOWN_EXCEEDED' };
    }

    // Skip risk-reward check for close actions (exits, not entries)
    if (signal.action !== 'close') {
      const riskReward = this.validateRiskReward(signal, currentPrice);
      if (!riskReward.valid) {
        return { allowed: false, reason: 'RISK_REWARD_TOO_LOW' };
      }
    }

    return { allowed: true, reason: '' };
  }

  private calculateCorrelatedExposure(newSymbol: string, exposureForSymbol: number): number {
    // exposureForSymbol already includes shadow + real + new for newSymbol
    // Only add correlated positions from OTHER symbols (with 0.5 correlation)
    let total = exposureForSymbol;
    for (const [symbol, size] of this.shadowPositions) {
      if (symbol !== newSymbol) {
        total += size * 0.5;
      }
    }
    return total;
  }

  private validateRiskReward(signal: TradingSignal, currentPrice: number): { valid: boolean; ratio: number } {
    const risk = Math.abs(signal.signalPrice - signal.stopLoss);
    const reward = Math.abs(signal.takeProfit - signal.signalPrice);
    const ratio = risk > 0 ? reward / risk : 0;
    return { valid: ratio >= this.config.minRiskRewardRatio, ratio };
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

  updatePortfolioValue(value: number): void {
    this.currentValue = value;
    if (value > this.peakValue) {
      this.peakValue = value;
    }
  }

  getDrawdown(): number {
    if (this.peakValue === 0) return 0;
    return (this.peakValue - this.currentValue) / this.peakValue;
  }

  getPortfolioMetrics(positions: PositionMetrics[]): PortfolioMetrics {
    const totalValue = positions.reduce((s, p) => s + p.currentValue, 0);
    const totalExposure = positions.reduce((s, p) => s + Math.abs(p.currentValue), 0);

    return {
      totalValue,
      totalExposure,
      leverage: totalValue > 0 ? totalExposure / totalValue : 0,
      maxDrawdown: this.getDrawdown(),
      sharpeRatio: this.calculateSharpeRatio(),
      winRate: this.calculateWinRate(),
      profitFactor: this.calculateProfitFactor(),
      positions,
    };
  }

  private calculateSharpeRatio(): number {
    if (this.tradeHistory.length < 10) return 0;
    const returns = this.tradeHistory.slice(-50).map(t => t.capitalAtRisk > 0 ? t.pnl / t.capitalAtRisk : 0);
    const avg = returns.reduce((s, r) => s + r, 0) / returns.length;
    const std = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avg, 2), 0) / returns.length);
    return std > 0 ? avg / std : 0;
  }

  private calculateWinRate(): number {
    if (this.tradeHistory.length === 0) return 0;
    const wins = this.tradeHistory.filter(t => t.pnl > 0).length;
    return wins / this.tradeHistory.length;
  }

  private calculateProfitFactor(): number {
    const wins = this.tradeHistory.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const losses = Math.abs(this.tradeHistory.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    return losses > 0 ? wins / losses : wins > 0 ? Infinity : 0;
  }

  updatePriceHistory(symbol: string, price: number): void {
    const history = this.priceHistory.get(symbol) || [];
    history.push(price);
    if (history.length > this.MAX_PRICE_HISTORY) {
      history.shift();
    }
    this.priceHistory.set(symbol, history);
  }
}
