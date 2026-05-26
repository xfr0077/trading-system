/**
 * SQLite persistence backed by sql.js (WASM-based, works everywhere).
 *
 * Same public API as before.  Internal cleanup: removed debounced persist,
 * simplified sync-write path, and extracted inline SQL for readability.
 */

import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as fs from 'fs';
import { TradeRecord, Position } from './types';

// ---- Public types (unchanged) ----

export interface Order {
  clientOrderId: string;
  orderId: string;
  signalId: string;
  symbol: string;
  side: 'buy' | 'sell';
  size: string;
  remainingSize: string;
  limitPrice: string;
  stopLoss?: string;
  takeProfit?: string;
  status: string;
  orderType: 'limit' | 'market';
  fee: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

// ---- Helpers ----

function rowToOrder(row: Record<string, unknown>): Order {
  return {
    clientOrderId: row.client_order_id as string,
    orderId: (row.order_id as string) || '',
    signalId: (row.signal_id as string) || '',
    symbol: row.symbol as string,
    side: row.side as 'buy' | 'sell',
    size: row.size as string,
    remainingSize: row.remaining_size as string,
    limitPrice: row.limit_price as string,
    stopLoss: (row.stop_loss as string) || undefined,
    takeProfit: (row.take_profit as string) || undefined,
    status: row.status as string,
    orderType: (row.order_type as 'limit' | 'market') || 'market',
    fee: (row.fee as string) || '0',
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    expiresAt: row.expires_at as number,
  };
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS orders (
    client_order_id TEXT PRIMARY KEY, order_id TEXT, signal_id TEXT,
    symbol TEXT, side TEXT, size TEXT, remaining_size TEXT, limit_price TEXT,
    stop_loss TEXT, take_profit TEXT, status TEXT, order_type TEXT,
    fee TEXT DEFAULT '0', created_at INTEGER, updated_at INTEGER, expires_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_symbol ON orders(symbol);
  CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON orders(updated_at);
  CREATE TABLE IF NOT EXISTS positions (
    symbol TEXT PRIMARY KEY, side TEXT, size TEXT, entry_price TEXT,
    unrealized_pnl TEXT DEFAULT '0', realized_pnl TEXT DEFAULT '0', updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS trade_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT, symbol TEXT,
    side TEXT, size TEXT, price TEXT, fee TEXT, pnl TEXT, timestamp INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_th_symbol ON trade_history(symbol);
  CREATE INDEX IF NOT EXISTS idx_th_timestamp ON trade_history(timestamp);
  CREATE TABLE IF NOT EXISTS signals (
    signal_id TEXT PRIMARY KEY, symbol TEXT, action TEXT,
    confidence REAL, position_size REAL, signal_price REAL,
    accepted INTEGER, reason TEXT, timestamp INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(timestamp);
`;

// ---- Store ----

export class SqliteStore {
  private db: SqlJsDatabase | null = null;
  private ready: Promise<void>;
  private dbPath: string;
  private readonly MAX_ORDER_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const SQL = await initSqlJs();
    if (fs.existsSync(this.dbPath)) {
      try {
        const buffer = fs.readFileSync(this.dbPath);
        this.db = new SQL.Database(buffer);
        const integrity = this.db.exec('PRAGMA integrity_check');
        if (integrity[0]?.values?.[0]?.[0] !== 'ok') {
          console.warn('[SqliteStore] Database integrity check failed, recreating');
          this.db = new SQL.Database();
        }
      } catch (err) {
        console.error('[SqliteStore] Failed to load existing database:', err);
        this.db = new SQL.Database();
      }
    } else {
      this.db = new SQL.Database();
    }
    this.db.run(SCHEMA_SQL);
    this.persistSync();

    this.cleanupTimer = setInterval(() => this.cleanupOldOrders(), 60 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  // ---- Lifecycle ----

  async waitReady(): Promise<void> { await this.ready; }
  async flush(): Promise<void> { this.persistSync(); }

  close(): void {
    if (!this.db) return;
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
    this.persistSync();
    this.db.close();
    this.db = null;
  }

  private persistSync(): void {
    if (!this.db) return;
    try {
      fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
    } catch (err) {
      console.error('[SqliteStore] Persist failed:', err);
    }
  }

  private cleanupOldOrders(): void {
    if (!this.db) return;
    try {
      const cutoff = Date.now() - this.MAX_ORDER_AGE_MS;
      this.db.run(
        "DELETE FROM orders WHERE status IN ('filled','cancelled','rejected') AND updated_at < ?",
        [cutoff],
      );
      this.persistSync();
    } catch { /* non-critical */ }
  }

  // ---- Orders ----

  saveOrder(order: Order): void {
    if (!this.db) return;
    this.db.run(
      `INSERT INTO orders (client_order_id, order_id, signal_id, symbol, side, size, remaining_size, limit_price, stop_loss, take_profit, status, order_type, fee, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_order_id) DO UPDATE SET
         order_id = excluded.order_id, signal_id = excluded.signal_id,
         status = excluded.status, size = excluded.size,
         remaining_size = excluded.remaining_size, limit_price = excluded.limit_price,
         stop_loss = excluded.stop_loss, take_profit = excluded.take_profit,
         order_type = excluded.order_type, fee = excluded.fee,
         updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
      [
        order.clientOrderId, order.orderId, order.signalId, order.symbol, order.side,
        order.size, order.remainingSize, order.limitPrice, order.stopLoss ?? null,
        order.takeProfit ?? null, order.status, order.orderType, order.fee,
        order.createdAt, order.updatedAt, order.expiresAt,
      ],
    );
    this.persistSync();
  }

  getOrder(clientOrderId: string): Order | null {
    if (!this.db) return null;
    const stmt = this.db.prepare('SELECT * FROM orders WHERE client_order_id = ?');
    stmt.bind([clientOrderId]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      stmt.free();
      return rowToOrder(row);
    }
    stmt.free();
    return null;
  }

  getOpenOrders(): Order[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(
      "SELECT * FROM orders WHERE status IN ('submitted','pending','partially_filled') ORDER BY created_at ASC",
    );
    const rows: Order[] = [];
    while (stmt.step()) rows.push(rowToOrder(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return rows;
  }

  getRecentOrders(limit: number = 50): Order[] {
    if (!this.db) return [];
    const stmt = this.db.prepare('SELECT * FROM orders ORDER BY updated_at DESC, created_at DESC LIMIT ?');
    stmt.bind([limit]);
    const rows: Order[] = [];
    while (stmt.step()) rows.push(rowToOrder(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return rows;
  }

  getFilledOrdersWithSLTP(): Order[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(
      "SELECT * FROM orders WHERE status = 'filled' AND " +
      "((stop_loss IS NOT NULL AND stop_loss != '' AND stop_loss != '0') OR " +
      "(take_profit IS NOT NULL AND take_profit != '' AND take_profit != '0'))",
    );
    const rows: Order[] = [];
    while (stmt.step()) rows.push(rowToOrder(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return rows;
  }

  // ---- Positions ----

  getPosition(symbol: string): Position | null {
    if (!this.db) return null;
    const stmt = this.db.prepare('SELECT * FROM positions WHERE symbol = ?');
    stmt.bind([symbol]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      stmt.free();
      return {
        symbol: row.symbol as string, side: row.side as 'long' | 'short',
        size: row.size as string, entryPrice: row.entry_price as string,
        unrealizedPnl: row.unrealized_pnl as string,
        realizedPnl: row.realized_pnl as string, updatedAt: row.updated_at as number,
      };
    }
    stmt.free();
    return null;
  }

  getAllPositions(): Position[] {
    if (!this.db) return [];
    const stmt = this.db.prepare('SELECT * FROM positions');
    const rows: Position[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      rows.push({
        symbol: row.symbol as string, side: row.side as 'long' | 'short',
        size: row.size as string, entryPrice: row.entry_price as string,
        unrealizedPnl: row.unrealized_pnl as string,
        realizedPnl: row.realized_pnl as string, updatedAt: row.updated_at as number,
      });
    }
    stmt.free();
    return rows;
  }

  updatePosition(symbol: string, side: 'long' | 'short', size: string, entryPrice: string, realizedPnl?: string): void {
    if (!this.db) return;
    this.db.run(
      `INSERT INTO positions (symbol, side, size, entry_price, unrealized_pnl, realized_pnl, updated_at)
       VALUES (?, ?, ?, ?, '0', ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET
         side = excluded.side, size = excluded.size, entry_price = excluded.entry_price,
         realized_pnl = excluded.realized_pnl, updated_at = excluded.updated_at`,
      [symbol, side, size, entryPrice, realizedPnl || '0', Date.now()],
    );
    this.persistSync();
  }

  // ---- Trade history ----

  addTradeHistory(trade: TradeRecord): void {
    if (!this.db) return;
    this.db.run(
      'INSERT INTO trade_history (order_id, symbol, side, size, price, fee, pnl, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [trade.orderId, trade.symbol, trade.side, trade.size, trade.price, trade.fee, trade.pnl, trade.timestamp],
    );
    this.persistSync();
  }

  getTradeHistory(symbol?: string, limit: number = 100): TradeRecord[] {
    if (!this.db) return [];
    let sql = 'SELECT * FROM trade_history';
    const params: (number | string | null)[] = [];
    if (symbol) { sql += ' WHERE symbol = ?'; params.push(symbol); }
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows: TradeRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      rows.push({
        orderId: row.order_id as string, symbol: row.symbol as string,
        side: row.side as 'buy' | 'sell', size: row.size as string,
        price: row.price as string, fee: row.fee as string,
        pnl: row.pnl as string, timestamp: row.timestamp as number,
      });
    }
    stmt.free();
    return rows;
  }

  // ---- Signals ----

  saveSignal(signal: {
    signalId: string; symbol: string; action: string; confidence: number;
    positionSize: number; signalPrice: number; accepted: boolean; reason: string; timestamp: number;
  }): void {
    if (!this.db) return;
    this.db.run(
      `INSERT INTO signals (signal_id, symbol, action, confidence, position_size, signal_price, accepted, reason, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(signal_id) DO UPDATE SET accepted = excluded.accepted, reason = excluded.reason`,
      [
        signal.signalId, signal.symbol, signal.action, signal.confidence,
        signal.positionSize, signal.signalPrice, signal.accepted ? 1 : 0,
        signal.reason, signal.timestamp,
      ],
    );
    this.persistSync();
  }

  getRecentSignals(limit: number = 200): Array<{
    signalId: string; symbol: string; action: string; confidence: number;
    positionSize: number; signalPrice: number; accepted: boolean; reason: string; timestamp: number;
  }> {
    if (!this.db) return [];
    const stmt = this.db.prepare('SELECT * FROM signals ORDER BY timestamp DESC LIMIT ?');
    stmt.bind([limit]);
    const rows: Array<ReturnType<SqliteStore['getRecentSignals']>[0]> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      rows.push({
        signalId: row.signal_id as string, symbol: row.symbol as string,
        action: row.action as string, confidence: row.confidence as number,
        positionSize: row.position_size as number, signalPrice: row.signal_price as number,
        accepted: (row.accepted as number) === 1, reason: row.reason as string,
        timestamp: row.timestamp as number,
      });
    }
    stmt.free();
    return rows;
  }
}
