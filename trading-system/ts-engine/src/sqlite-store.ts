import Database from 'better-sqlite3';
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
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { timeout: 5000 });
    this.db.pragma('journal_mode = WAL');
    this.initializeTables();
  }

  private initializeTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        client_order_id TEXT PRIMARY KEY,
        order_id TEXT,
        signal_id TEXT,
        symbol TEXT,
        side TEXT,
        size TEXT,
        remaining_size TEXT,
        limit_price TEXT,
        stop_loss TEXT,
        take_profit TEXT,
        status TEXT,
        order_type TEXT,
        fee TEXT DEFAULT '0',
        created_at INTEGER,
        updated_at INTEGER,
        expires_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS positions (
        symbol TEXT PRIMARY KEY,
        side TEXT,
        size TEXT,
        entry_price TEXT,
        unrealized_pnl TEXT DEFAULT '0',
        realized_pnl TEXT DEFAULT '0',
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS trade_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT,
        symbol TEXT,
        side TEXT,
        size TEXT,
        price TEXT,
        fee TEXT,
        pnl TEXT,
        timestamp INTEGER
      );
    `);
  }

  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  saveOrder(order: Order): void {
    this.db.prepare(`
      INSERT INTO orders (client_order_id, order_id, signal_id, symbol, side, size, remaining_size, limit_price, stop_loss, take_profit, status, order_type, fee, created_at, updated_at, expires_at)
      VALUES (@clientOrderId, @orderId, @signalId, @symbol, @side, @size, @remainingSize, @limitPrice, @stopLoss, @takeProfit, @status, @orderType, @fee, @createdAt, @updatedAt, @expiresAt)
      ON CONFLICT(client_order_id) DO UPDATE SET
        order_id = @orderId, status = @status, remaining_size = @remainingSize, fee = @fee, updated_at = @updatedAt
    `).run({
      clientOrderId: order.clientOrderId,
      orderId: order.orderId,
      signalId: order.signalId,
      symbol: order.symbol,
      side: order.side,
      size: order.size,
      remainingSize: order.remainingSize,
      limitPrice: order.limitPrice,
      stopLoss: order.stopLoss || null,
      takeProfit: order.takeProfit || null,
      status: order.status,
      orderType: order.orderType,
      fee: order.fee,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      expiresAt: order.expiresAt,
    });
  }

  getOrder(clientOrderId: string): Order | null {
    const row = this.db.prepare('SELECT * FROM orders WHERE client_order_id = ?').get(clientOrderId) as any;
    if (!row) return null;
    return this.mapRowToOrder(row);
  }

  getOpenOrders(): Order[] {
    const rows = this.db.prepare("SELECT * FROM orders WHERE status IN ('submitted', 'pending', 'partially_filled')").all() as any[];
    return rows.map(this.mapRowToOrder);
  }

  getPosition(symbol: string): Position | null {
    const row = this.db.prepare('SELECT * FROM positions WHERE symbol = ?').get(symbol) as any;
    if (!row) return null;
    return {
      symbol: row.symbol,
      side: row.side,
      size: row.size,
      entryPrice: row.entry_price,
      unrealizedPnl: row.unrealized_pnl,
      realizedPnl: row.realized_pnl,
      updatedAt: row.updated_at,
    };
  }

  getAllPositions(): Position[] {
    const rows = this.db.prepare('SELECT * FROM positions').all() as any[];
    return rows.map(row => ({
      symbol: row.symbol,
      side: row.side,
      size: row.size,
      entryPrice: row.entry_price,
      unrealizedPnl: row.unrealized_pnl,
      realizedPnl: row.realized_pnl,
      updatedAt: row.updated_at,
    }));
  }

  updatePosition(symbol: string, side: 'long' | 'short', size: string, entryPrice: string): void {
    this.db.prepare(`
      INSERT INTO positions (symbol, side, size, entry_price, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET
        side = @side, size = @size, entry_price = @entryPrice, updated_at = @updatedAt
    `).run({
      symbol,
      side,
      size,
      entryPrice,
      updatedAt: Date.now(),
    });
  }

  addTradeHistory(trade: TradeRecord): void {
    this.db.prepare(`
      INSERT INTO trade_history (order_id, symbol, side, size, price, fee, pnl, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(trade.orderId, trade.symbol, trade.side, trade.size, trade.price, trade.fee, trade.pnl, trade.timestamp);
  }

  getTradeHistory(symbol?: string, limit: number = 100): TradeRecord[] {
    let query = 'SELECT * FROM trade_history';
    const params: any[] = [];
    if (symbol) {
      query += ' WHERE symbol = ?';
      params.push(symbol);
    }
    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(row => ({
      orderId: row.order_id,
      symbol: row.symbol,
      side: row.side,
      size: row.size,
      price: row.price,
      fee: row.fee,
      pnl: row.pnl,
      timestamp: row.timestamp,
    }));
  }

  close(): void {
    this.checkpoint();
    this.db.close();
  }

  private mapRowToOrder(row: any): Order {
    return {
      clientOrderId: row.client_order_id,
      orderId: row.order_id,
      signalId: row.signal_id,
      symbol: row.symbol,
      side: row.side,
      size: row.size,
      remainingSize: row.remaining_size,
      limitPrice: row.limit_price,
      stopLoss: row.stop_loss,
      takeProfit: row.take_profit,
      status: row.status,
      orderType: row.order_type,
      fee: row.fee,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }
}
