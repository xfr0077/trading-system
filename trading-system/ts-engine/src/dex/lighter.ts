import { IDexAdapter } from './adapter-interface';
import {
  DexConfig, OrderInput, OpenOrder, Position, Fill,
  OrderUpdate, DexCapabilities, DexError, DexErrorCode,
} from './types';
import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';

const SYMBOL_TO_MARKET: Record<string, number> = {
  'ETH_USDT_Perp': 0, 'BTC_USDT_Perp': 1, 'SOL_USDT_Perp': 2,
  'ARB_USDT_Perp': 3, 'OP_USDT_Perp': 4, 'DOGE_USDT_Perp': 5,
  'NEAR_USDT_Perp': 6, 'LINK_USDT_Perp': 7, 'MATIC_USDT_Perp': 8,
  'AVAX_USDT_Perp': 9, 'AAVE_USDT_Perp': 10, 'UNI_USDT_Perp': 11,
  'PEPE_USDT_Perp': 12, 'WIF_USDT_Perp': 13, 'INJ_USDT_Perp': 14,
  'Render_USDT_Perp': 15, 'TAO_USDT_Perp': 16, 'FET_USDT_Perp': 17,
  'AGIX_USDT_Perp': 18, 'OCEAN_USDT_Perp': 19, 'RNDR_USDT_Perp': 20,
  'TIA_USDT_Perp': 21, 'SEI_USDT_Perp': 22, 'STRK_USDT_Perp': 23,
  'WLD_USDT_Perp': 24, 'PYTH_USDT_Perp': 25, 'SUI_USDT_Perp': 26,
  'APT_USDT_Perp': 27, 'HYPE_USDT_Perp': 28, 'ZK_USDT_Perp': 56,
  'EIGEN_USDT_Perp': 49, 'CHIP_USDT_Perp': 163,
};

const MARKET_TO_SYMBOL: Record<number, string> = {};
for (const [k, v] of Object.entries(SYMBOL_TO_MARKET)) {
  MARKET_TO_SYMBOL[v] = k;
}

const ORDER_TYPE_TO_LIGHTER: Record<string, number> = {
  'market': 1, 'limit': 0, 'stop': 2, 'stop_loss': 2,
};
const TIF_TO_LIGHTER: Record<string, number> = {
  'GTC': 0, 'IOC': 0, 'FOK': 0, 'GTT': 1,
};

function getMarketIndex(market: string): number {
  return SYMBOL_TO_MARKET[market] ?? 0;
}

function getSymbol(marketIndex: number): string {
  return MARKET_TO_SYMBOL[marketIndex] || `MARKET_${marketIndex}_USDT_Perp`;
}

function parseOrderSide(isAsk: boolean): 'buy' | 'sell' {
  return isAsk ? 'sell' : 'buy';
}

function mapOrderStatus(status: string): OpenOrder['status'] {
  const m: Record<string, OpenOrder['status']> = {
    'open': 'open', 'filled': 'filled', 'cancelled': 'cancelled',
    'canceled': 'cancelled', 'rejected': 'rejected', 'expired': 'expired',
    'partially_filled': 'partially_filled',
  };
  return m[status] || 'open';
}

interface PendingRequest {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class LighterAdapter implements IDexAdapter {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private connected = false;
  private config: DexConfig | null = null;
  private accountIndex: number | null = null;
  private orderCallbacks: Array<(update: OrderUpdate) => void> = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private lastMarketId = 0;
  private initConfig: DexConfig | null = null;
  private respawnAttempts = 0;
  private maxRespawnAttempts = 5;
  private respawnBackoffMs = 2000;
  private respawnTimer: NodeJS.Timeout | null = null;
  private circuitBreakerFailures = 0;
  private readonly MAX_CIRCUIT_BREAKER_FAILURES = 5;
  private readonly CIRCUIT_BREAKER_RESET_MS = 60000;
  private circuitBreakerOpenUntil = 0;
  private circuitBreakerTimer: NodeJS.Timeout | null = null;

  async connect(config: DexConfig): Promise<void> {
    this.initConfig = config;
    await this.spawnBridge(config);
  }

  private async spawnBridge(config: DexConfig): Promise<void> {
    this.config = config;
    const pk = config.apiPrivateKey || process.env.LIGHTER_API_PRIVATE_KEY;
    if (!pk) throw new DexError('apiPrivateKey required', DexErrorCode.AUTH_FAILED, false);

    const python = process.platform === 'win32' ? 'python' : 'python3';
    this.proc = spawn(python, [__dirname + '/../../lighter_bridge.py'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    this.proc.on('exit', (code) => {
      console.error(`[LighterAdapter] Bridge exited with code ${code}`);
      this.connected = false;
      this.rejectAll(`Process exited with code ${code}`);
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
      // C4: Auto-respawn with exponential backoff
      if (this.respawnAttempts < this.maxRespawnAttempts && this.initConfig) {
        this.respawnAttempts++;
        const delay = this.respawnBackoffMs * Math.pow(2, this.respawnAttempts - 1);
        console.log(`[LighterAdapter] Respawn attempt ${this.respawnAttempts}/${this.maxRespawnAttempts} in ${delay}ms`);
        this.respawnTimer = setTimeout(() => {
          this.spawnBridge(this.initConfig!).catch(err => {
            console.error(`[LighterAdapter] Respawn failed:`, err.message);
          });
        }, delay);
      } else if (this.respawnAttempts >= this.maxRespawnAttempts) {
        console.error(`[LighterAdapter] Max respawn attempts reached, giving up`);
      }
    });

    this.proc.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.error('[lighter-bridge]', msg);
    });

    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on('line', (line: string) => {
      try {
        const msg = JSON.parse(line);
        const req = this.pending.get(msg.id);
        if (!req) return;
        this.pending.delete(msg.id);
        clearTimeout(req.timer);
        if (msg.ok) {
          req.resolve(msg.data);
        } else {
          req.reject(new Error(msg.error || 'Unknown error'));
        }
      } catch { /* ignore malformed responses */ }
    });

    const result = await this.send('init', {
      url: config.rpcUrl || 'https://mainnet.zklighter.elliot.ai',
      account_index: config.accountIndex || parseInt(process.env.LIGHTER_ACCOUNT_INDEX || '725539'),
      api_key_index: config.apiKeyIndex || parseInt(process.env.LIGHTER_API_KEY_INDEX || '7'),
      api_private_key: pk,
      wallet: config.walletAddress,
    });

    this.accountIndex = result.account_index;
    this.connected = true;
    this.respawnAttempts = 0; // Reset on successful connect
    this.startOrderPolling();
    console.log(`[LighterAdapter] Connected (account: ${this.accountIndex})`);
  }

  disconnect(): void {
    this.connected = false;
    if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.rl) { this.rl.close(); this.rl = null; }
    if (this.proc) {
      this.rejectAll('Disconnected');
      this.proc.kill();
      this.proc = null;
    }
  }

  isConnected(): boolean {
    return this.connected && this.proc !== null && this.proc.exitCode === null;
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs?: number }> {
    try {
      const result = await this.send('health_check', {}, 5000);
      return result;
    } catch {
      return { healthy: false };
    }
  }

  async submitOrder(order: OrderInput): Promise<string> {
    const marketIndex = getMarketIndex(order.market);
    const clientOrderIndex = parseInt(order.clientOrderId.replace(/[^0-9]/g, '').slice(0, 10)) || Date.now();
    const isAsk = order.side === 'sell';
    const orderType = ORDER_TYPE_TO_LIGHTER[order.type] ?? 1;
    const timeInForce = TIF_TO_LIGHTER[order.timeInForce || 'GTC'] ?? 0;

    const result = await this.send('submit_order', {
      market_index: marketIndex,
      client_order_index: clientOrderIndex,
      base_amount: order.size.toString(),
      price: (order.price || 0).toString(),
      is_ask: isAsk,
      order_type: orderType,
      time_in_force: timeInForce,
      reduce_only: order.reduceOnly || false,
    });

    const orderIndex = String(result.order_index || result.orderId || clientOrderIndex);
    const exchangeOrderId = `${marketIndex}:${orderIndex}`;
    this.lastMarketId = marketIndex;
    return exchangeOrderId;
  }

  async cancelOrder(exchangeOrderId: string): Promise<void> {
    const [marketId, orderId] = exchangeOrderId.split(':');
    await this.send('cancel_order', {
      market_index: parseInt(marketId || '0'),
      order_index: parseInt(orderId || exchangeOrderId),
    });
  }

  async getOpenOrders(): Promise<OpenOrder[]> {
    const orders = await this.send('get_open_orders', {
      account_index: this.accountIndex,
      market_id: this.lastMarketId,
    });
    return (orders as any[]).map(o => ({
      exchangeOrderId: `${o.market_id || o.market_index}:${o.order_index || o.orderId || o.id}`,
      clientOrderId: String(o.client_order_index || ''),
      market: getSymbol(o.market_index || o.market_id || 0),
      side: parseOrderSide(o.is_ask || false),
      type: String(o.order_type === 0 ? 'market' : 'limit'),
      size: parseFloat(o.initial_base_amount || o.base_amount || o.size || 0),
      filledSize: parseFloat(o.filled_base_amount || o.filled_amount || 0),
      price: parseFloat(o.price || 0),
      avgFillPrice: o.filled_quote_amount && o.filled_base_amount
        ? parseFloat(o.filled_quote_amount) / parseFloat(o.filled_base_amount)
        : undefined,
      status: mapOrderStatus(o.status || 'open'),
      createdAt: (o.created_at || o.timestamp || 0) * 1000,
      updatedAt: (o.updated_at || o.timestamp || 0) * 1000,
    }));
  }

  async getPositions(): Promise<Position[]> {
    const positions = await this.send('get_positions', {
      account_index: this.accountIndex,
    });
    return (positions as any[]).map(p => {
      const sign = p.sign ?? 1;
      const size = parseFloat(p.position || 0) * sign;
      return {
        market: getSymbol(p.market_id || 0),
        side: size > 0 ? 'long' : size < 0 ? 'short' : 'none',
        size: Math.abs(size),
        entryPrice: parseFloat(p.avg_entry_price || 0),
        markPrice: 0,
        unrealizedPnl: parseFloat(p.unrealized_pnl || 0),
        realizedPnl: parseFloat(p.realized_pnl || 0),
        leverage: 1,
        liquidationPrice: p.liquidation_price ? parseFloat(p.liquidation_price) : undefined,
        marginUsed: parseFloat(p.allocated_margin || 0),
      };
    });
  }

  async getAccount(): Promise<{ availableBalance: number; totalBalance: number }> {
    const result = await this.send('get_account', {
      account_index: this.accountIndex,
    });
    const accounts = result.accounts || [];
    const acc = accounts[0] || {};
    return {
      availableBalance: parseFloat(acc.available_balance || 0),
      totalBalance: parseFloat(acc.collateral || acc.total_asset_value || 0),
    };
  }

  async getMidPrice(market: string): Promise<{ midPrice: number; bestBid: number; bestAsk: number; spread: number } | null> {
    const marketIndex = getMarketIndex(market);
    try {
      const result = await this.send('get_mid_price', { market_id: marketIndex }, 5000);
      return {
        midPrice: result.mid_price || 0,
        bestBid: result.best_bid || 0,
        bestAsk: result.best_ask || 0,
        spread: result.spread || 0,
      };
    } catch {
      return null;
    }
  }

  async getFills(_clientOrderId?: string): Promise<Fill[]> {
    const trades = await this.send('get_fills', {
      account_index: this.accountIndex,
      limit: 50,
    });
    return (trades as any[]).map(t => ({
      exchangeOrderId: String(t.trade_id || ''),
      clientOrderId: String(t.client_order_index || ''),
      market: getSymbol(t.market_id || 0),
      side: t.is_maker_ask ? 'sell' : 'buy',
      price: parseFloat(t.price || 0),
      size: parseFloat(t.size || 0),
      fee: parseFloat(t.maker_fee || t.taker_fee || 0),
      feeAsset: 'USDC',
      isMaker: t.is_maker_ask !== undefined ? !t.is_maker_ask : false,
      timestamp: Math.floor((t.timestamp || 0) / 1000),
    }));
  }

  onOrderUpdate(callback: (update: OrderUpdate) => void): void {
    this.orderCallbacks.push(callback);
  }

  getName(): string {
    return 'lighter';
  }

  getCapabilities(): DexCapabilities {
    return {
      maxLeverage: 50,
      supportedOrderTypes: ['market', 'limit', 'stop', 'take_profit'],
      supportedTimeInForce: ['GTC', 'IOC', 'FOK', 'GTT'],
      minOrderSize: 0.0001,
      tickSize: 0.01,
      rateLimits: [
        { endpoint: 'order', requestsPerMinute: 60 },
        { endpoint: 'cancel', requestsPerMinute: 120 },
        { endpoint: 'query', requestsPerMinute: 300 },
      ],
      hasWebSocket: false,
      hasBatchOrders: true,
      hasReduceOnly: true,
    };
  }

  private send(action: string, params: any = {}, timeoutMs = 15000): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      if (Date.now() < this.circuitBreakerOpenUntil) {
        const remaining = Math.ceil((this.circuitBreakerOpenUntil - Date.now()) / 1000);
        return reject(new DexError(`Circuit breaker open (${remaining}s remaining)`, DexErrorCode.RATE_LIMITED, false));
      }
      if (!this.proc || !this.proc.stdin?.writable) {
        return reject(new DexError('Not connected', DexErrorCode.CONNECTION_LOST, false));
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.recordFailure(action, 'timeout');
        reject(new Error(`Bridge request '${action}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (data: any) => { this.resetCircuitBreaker(); resolve(data); },
        reject: (err: Error) => { this.recordFailure(action, err.message); reject(err); },
        timer,
      });
      this.proc.stdin.write(JSON.stringify({ id, action, params }) + '\n');
    });
  }

  private recordFailure(action: string, reason: string): void {
    this.circuitBreakerFailures++;
    console.warn(`[LighterAdapter] Circuit breaker: ${action} failed (${this.circuitBreakerFailures}/${this.MAX_CIRCUIT_BREAKER_FAILURES}): ${reason}`);
    if (this.circuitBreakerFailures >= this.MAX_CIRCUIT_BREAKER_FAILURES) {
      this.circuitBreakerOpenUntil = Date.now() + this.CIRCUIT_BREAKER_RESET_MS;
      console.error(`[LighterAdapter] Circuit breaker OPEN for ${this.CIRCUIT_BREAKER_RESET_MS / 1000}s`);
      this.circuitBreakerFailures = 0;
      if (!this.circuitBreakerTimer) {
        this.circuitBreakerTimer = setTimeout(() => {
          this.circuitBreakerOpenUntil = 0;
          this.circuitBreakerTimer = null;
          console.log(`[LighterAdapter] Circuit breaker CLOSED`);
        }, this.CIRCUIT_BREAKER_RESET_MS);
      }
    }
  }

  private resetCircuitBreaker(): void {
    this.circuitBreakerFailures = 0;
  }

  private rejectAll(reason: string): void {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private startOrderPolling(): void {
    this.pollTimer = setInterval(async () => {
      try {
        const orders = await this.getOpenOrders();
        for (const order of orders) {
          const update: OrderUpdate = {
            type: order.status === 'filled' ? 'order_filled' : 'order_placed',
            order,
            sequenceNumber: Date.now(),
          };
          for (const cb of this.orderCallbacks) cb(update);
        }
      } catch {
        // poll silently
      }
    }, 5000);
    this.pollTimer.unref();
  }
}

import { registerDex } from './registry';
registerDex('lighter', () => new LighterAdapter());
