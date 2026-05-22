import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import * as fs from 'fs';
import { TradeRecord, Position } from './types';

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

export class SqliteStore {
  private db: SqlJsDatabase | null = null;
  private ready: Promise<void>;
  private dbPath: string;
  private persistTimer: NodeJS.Timeout | null = null;
  private persistPending = false;
  private readonly MAX_ORDER_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  private readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.ready = this.init(dbPath);
  }

  private async init(dbPath: string): Promise<void> {
    const SQL = await initSqlJs();
    if (fs.existsSync(dbPath)) {
      try {
        const buffer = fs.readFileSync(dbPath);
        this.db = new SQL.Database(buffer);
        // Verify database integrity
        const integrity = this.db.exec('PRAGMA integrity_check');
        if (integrity[0]?.values?.[0]?.[0] !== 'ok') {
          console.warn('[SqliteStore] Database integrity check failed, recreating');
          this.db = new SQL.Database();
        }
      } catch (err) {
        console.error('[SqliteStore] Failed to load existing database, creating new:', err);
        this.db = new SQL.Database();
      }
    } else {
      this.db = new SQL.Database();
    }
    this.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        client_order_id TEXT PRIMARY KEY,
        order_id TEXT, signal_id TEXT, symbol TEXT, side TEXT,
        size TEXT, remaining_size TEXT, limit_price TEXT,
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
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT, symbol TEXT, side TEXT,
        size TEXT, price TEXT, fee TEXT, pnl TEXT, timestamp INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_trade_history_symbol ON trade_history(symbol);
      CREATE INDEX IF NOT EXISTS idx_trade_history_timestamp ON trade_history(timestamp);
      CREATE TABLE IF NOT EXISTS signals (
        signal_id TEXT PRIMARY KEY, symbol TEXT, action TEXT,
        confidence REAL, position_size REAL, signal_price REAL,
        accepted INTEGER, reason TEXT, timestamp INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
    `);
    this.persistSync();

    // Start periodic cleanup of old terminal orders
    this.cleanupTimer = setInterval(() => this.cleanupOldOrders(), this.CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  async waitReady(): Promise<void> {
    await this.ready;
  }

  private exec(sql: string): void {
    if (this.db) this.db.run(sql);
  }

  private schedulePersist(): void {
    this.persistPending = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.flushToDisk(), 1000);
  }

  private async flushToDisk(): Promise<void> {
    this.persistTimer = null;
    this.persistPending = false;
    if (!this.db) return;
    try {
      const data = this.db.export();
      await fs.promises.writeFile(this.dbPath, Buffer.from(data));
    } catch (err) {
      console.error('[SqliteStore] Persist failed:', err);
      // Retry once after 5 seconds
      setTimeout(() => {
        if (this.db && this.persistPending === false) {
          try {
            const data = this.db.export();
            fs.writeFileSync(this.dbPath, Buffer.from(data));
          } catch (retryErr) {
            console.error('[SqliteStore] Retry persist failed:', retryErr);
          }
        }
      }, 5000);
    }
  }

  private persistSync(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, Buffer.from(data));
    } catch (err) {
      console.error('[SqliteStore] Sync persist failed:', err);
    }
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.persistPending) {
      await this.flushToDisk();
    }
  }

  saveOrder(order: Order, sync = false): void {
    if (!this.db) return;
    this.db.run(
      `INSERT INTO orders (client_order_id, order_id, signal_id, symbol, side, size, remaining_size, limit_price, stop_loss, take_profit, status, order_type, fee, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_order_id) DO UPDATE SET
         order_id = excluded.order_id,
         signal_id = excluded.signal_id,
         status = excluded.status,
         size = excluded.size,
         remaining_size = excluded.remaining_size,
         limit_price = excluded.limit_price,
         stop_loss = excluded.stop_loss,
         take_profit = excluded.take_profit,
         order_type = excluded.order_type,
         fee = excluded.fee,
         updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
      [order.clientOrderId, order.orderId, order.signalId, order.symbol, order.side,
       order.size, order.remainingSize, order.limitPrice, order.stopLoss || null,
       order.takeProfit || null, order.status, order.orderType, order.fee,
       order.createdAt, order.updatedAt, order.expiresAt]
    );
    // H4: Sync immediately for terminal states to prevent data loss
    if (sync || ['filled', 'cancelled', 'rejected'].includes(order.status)) {
      this.persistSync();
    } else {
      this.schedulePersist();
    }
  }

  getOrder(clientOrderId: string): Order | null {
    if (!this.db) return null;
    const stmt = this.db.prepare('SELECT * FROM orders WHERE client_order_id = ?');
    stmt.bind([clientOrderId]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as any;
      stmt.free();
      return this.mapRowToOrder(row);
    }
    stmt.free();
    return null;
  }

  getOpenOrders(): Order[] {
    if (!this.db) return [];
    const stmt = this.db.prepare("SELECT * FROM orders WHERE status IN ('submitted', 'pending', 'partially_filled') ORDER BY created_at ASC");
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as any);
    stmt.free();
    return rows.map(this.mapRowToOrder);
  }

  getPosition(symbol: string): Position | null {
    if (!this.db) return null;
    const stmt = this.db.prepare('SELECT * FROM positions WHERE symbol = ?');
    stmt.bind([symbol]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as any;
      stmt.free();
      return {
        symbol: row.symbol, side: row.side, size: row.size,
        entryPrice: row.entry_price, unrealizedPnl: row.unrealized_pnl,
        realizedPnl: row.realized_pnl, updatedAt: row.updated_at,
      };
    }
    stmt.free();
    return null;
  }

  getAllPositions(): Position[] {
    if (!this.db) return [];
    const stmt = this.db.prepare('SELECT * FROM positions');
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as any);
    stmt.free();
    return rows.map(row => ({
      symbol: row.symbol, side: row.side, size: row.size,
      entryPrice: row.entry_price, unrealizedPnl: row.unrealized_pnl,
      realizedPnl: row.realized_pnl, updatedAt: row.updated_at,
    }));
  }

  getRecentOrders(limit: number = 50): Order[] {
    if (!this.db) return [];
    const stmt = this.db.prepare('SELECT * FROM orders ORDER BY updated_at DESC, created_at DESC LIMIT ?');
    stmt.bind([limit]);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as any);
    stmt.free();
    return rows.map(this.mapRowToOrder);
  }

  getFilledOrdersWithSLTP(): Order[] {
    if (!this.db) return [];
    const stmt = this.db.prepare(
      "SELECT * FROM orders WHERE status = 'filled' AND " +
      "((stop_loss IS NOT NULL AND stop_loss != '' AND stop_loss != '0') OR " +
      "(take_profit IS NOT NULL AND take_profit != '' AND take_profit != '0'))"
    );
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as any);
    stmt.free();
    return rows.map(this.mapRowToOrder);
  }

  updatePosition(symbol: string, side: 'long' | 'short', size: string, entryPrice: string): void {
    if (!this.db) return;
    this.db.run(
      `INSERT INTO positions (symbol, side, size, entry_price, unrealized_pnl, realized_pnl, updated_at)
       VALUES (?, ?, ?, ?, '0', '0', ?)
       ON CONFLICT(symbol) DO UPDATE SET
         side = excluded.side,
         size = excluded.size,
         entry_price = excluded.entry_price,
         updated_at = excluded.updated_at`,
      [symbol, side, size, entryPrice, Date.now()]
    );
    this.schedulePersist();
  }

  addTradeHistory(trade: TradeRecord): void {
    if (!this.db) return;
    this.db.run(
      `INSERT INTO trade_history (order_id, symbol, side, size, price, fee, pnl, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [trade.orderId, trade.symbol, trade.side, trade.size, trade.price, trade.fee, trade.pnl, trade.timestamp]
    );
    this.schedulePersist();
  }

  getTradeHistory(symbol?: string, limit: number = 100): TradeRecord[] {
    if (!this.db) return [];
    let query = 'SELECT * FROM trade_history';
    const params: any[] = [];
    if (symbol) { query += ' WHERE symbol = ?'; params.push(symbol); }
    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);
    const stmt = this.db.prepare(query);
    stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows.map(row => ({
      orderId: row.order_id, symbol: row.symbol, side: row.side,
      size: row.size, price: row.price, fee: row.fee, pnl: row.pnl, timestamp: row.timestamp,
    }));
  }

  saveSignal(signal: { signalId: string; symbol: string; action: string; confidence: number; positionSize: number; signalPrice: number; accepted: boolean; reason: string; timestamp: number }): void {
    if (!this.db) return;
    this.db.run(
      `INSERT OR REPLACE INTO signals (signal_id, symbol, action, confidence, position_size, signal_price, accepted, reason, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [signal.signalId, signal.symbol, signal.action, signal.confidence, signal.positionSize, signal.signalPrice, signal.accepted ? 1 : 0, signal.reason, signal.timestamp]
    );
    this.schedulePersist();
  }

  getRecentSignals(limit: number = 200): Array<{ signalId: string; symbol: string; action: string; confidence: number; positionSize: number; signalPrice: number; accepted: boolean; reason: string; timestamp: number }> {
    if (!this.db) return [];
    const stmt = this.db.prepare('SELECT * FROM signals ORDER BY timestamp DESC LIMIT ?');
    stmt.bind([limit]);
    const rows: any[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows.map(row => ({
      signalId: row.signal_id, symbol: row.symbol, action: row.action,
      confidence: row.confidence, positionSize: row.position_size, signalPrice: row.signal_price,
      accepted: row.accepted === 1, reason: row.reason || '', timestamp: row.timestamp,
    }));
  }

  /** Clean up terminal orders older than MAX_ORDER_AGE_MS to prevent unbounded growth */
  private cleanupOldOrders(): void {
    if (!this.db) return;
    const cutoff = Date.now() - this.MAX_ORDER_AGE_MS;
    const beforeCount = this.db.exec("SELECT COUNT(*) FROM orders WHERE status IN ('filled', 'cancelled', 'rejected')")[0]?.values?.[0]?.[0] as number || 0;
    this.db.run(
      "DELETE FROM orders WHERE status IN ('filled', 'cancelled', 'rejected') AND updated_at < ?",
      [cutoff]
    );
    const afterCount = this.db.exec("SELECT COUNT(*) FROM orders WHERE status IN ('filled', 'cancelled', 'rejected')")[0]?.values?.[0]?.[0] as number || 0;
    const cleaned = beforeCount - afterCount;
    if (cleaned > 0) {
      console.log(`[SqliteStore] Cleaned up ${cleaned} old terminal orders (${afterCount} remaining)`);
      this.schedulePersist();
    }
  }

  /** Get order statistics for monitoring */
  getStats(): { total: number; open: number; filled: number; cancelled: number; rejected: number } {
    if (!this.db) return { total: 0, open: 0, filled: 0, cancelled: 0, rejected: 0 };
    const result = this.db.exec(
      "SELECT status, COUNT(*) as count FROM orders GROUP BY status"
    );
    const stats = { total: 0, open: 0, filled: 0, cancelled: 0, rejected: 0 };
    if (result[0]?.values) {
      for (const [status, count] of result[0].values) {
        const s = status as string;
        const c = count as number;
        stats.total += c;
        if (s === 'filled') stats.filled += c;
        else if (s === 'cancelled') stats.cancelled += c;
        else if (s === 'rejected') stats.rejected += c;
        else stats.open += c;
      }
    }
    return stats;
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.db) {
      // Force immediate flush before closing
      try {
        const data = this.db.export();
        fs.writeFileSync(this.dbPath, Buffer.from(data));
      } catch (err) {
        console.error('[SqliteStore] Final flush failed:', err);
      }
      this.db.close();
      this.db = null;
    }
    this.persistPending = false;
  }

  private mapRowToOrder(row: any): Order {
    return {
      clientOrderId: row.client_order_id, orderId: row.order_id,
      signalId: row.signal_id, symbol: row.symbol, side: row.side,
      size: row.size, remainingSize: row.remaining_size,
      limitPrice: row.limit_price, stopLoss: row.stop_loss,
      takeProfit: row.take_profit, status: row.status,
      orderType: row.order_type, fee: row.fee,
      createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at,
    };
  }
}
