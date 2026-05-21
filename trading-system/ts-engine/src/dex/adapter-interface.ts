import { DexConfig, OrderInput, OpenOrder, Position, Fill, OrderUpdate, DexCapabilities } from './types';

export interface IDexAdapter {
  connect(config: DexConfig): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  healthCheck(): Promise<{ healthy: boolean; latencyMs?: number }>;

  submitOrder(order: OrderInput): Promise<string>;
  cancelOrder(exchangeOrderId: string): Promise<void>;

  getOpenOrders(): Promise<OpenOrder[]>;
  getPositions(): Promise<Position[]>;
  getFills(clientOrderId?: string): Promise<Fill[]>;
  getAccount?(): Promise<{ availableBalance: number; totalBalance: number }>;
  getMidPrice?(market: string): Promise<{ midPrice: number; bestBid: number; bestAsk: number; spread: number } | null>;

  onOrderUpdate(callback: (update: OrderUpdate) => void): void;

  getName(): string;
  getCapabilities(): DexCapabilities;
}
