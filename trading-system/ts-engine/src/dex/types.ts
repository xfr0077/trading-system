// DEX Adapter Types

export interface DexConfig {
  dexName: string;
  testnet: boolean;
  privateKey?: string;
  walletAddress?: string;
  rpcUrl?: string;
  wsUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  // Lighter-specific: API key index for signing (2-254, 0-1 reserved for web UI)
  apiKeyIndex?: number;
  apiPublicKey?: string;
  apiPrivateKey?: string;
  accountIndex?: number;
}

export interface OrderInput {
  clientOrderId: string;
  market: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  size: number;
  price?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

export type OrderStatus = 'pending' | 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired';

export interface OpenOrder {
  exchangeOrderId: string;
  clientOrderId: string;
  market: string;
  side: 'buy' | 'sell';
  type: string;
  size: number;
  filledSize: number;
  price: number;
  avgFillPrice?: number;
  status: OrderStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Position {
  market: string;
  side: 'long' | 'short' | 'none';
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  leverage: number;
  liquidationPrice?: number;
  marginUsed: number;
}

export interface Fill {
  exchangeOrderId: string;
  clientOrderId: string;
  market: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  fee: number;
  feeAsset: string;
  isMaker: boolean;
  timestamp: number;
}

export interface OrderUpdate {
  type: 'order_placed' | 'order_filled' | 'order_cancelled' | 'order_rejected';
  order: OpenOrder;
  fill?: Fill;
  reason?: string;
  sequenceNumber: number;
}

export enum DexErrorCode {
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  INVALID_ORDER = 'INVALID_ORDER',
  ORDER_NOT_FOUND = 'ORDER_NOT_FOUND',
  AUTH_FAILED = 'AUTH_FAILED',
  CONNECTION_LOST = 'CONNECTION_LOST',
}

export class DexError extends Error {
  constructor(
    message: string,
    public code: DexErrorCode,
    public retryable: boolean,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'DexError';
  }
}

export interface DexCapabilities {
  maxLeverage: number;
  supportedOrderTypes: string[];
  supportedTimeInForce: string[];
  minOrderSize: number;
  tickSize: number;
  rateLimits: { endpoint: string; requestsPerMinute: number }[];
  hasWebSocket: boolean;
  hasBatchOrders: boolean;
  hasReduceOnly: boolean;
}
