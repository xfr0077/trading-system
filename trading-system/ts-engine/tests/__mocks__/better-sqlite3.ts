// Mock for better-sqlite3 - used in local tests where native module can't compile
// Production uses real better-sqlite3 in Docker (Linux)

const mockStatements = new Map<string, any[]>();
const mockTables = new Set<string>();

class MockStatement {
  private sql: string;

  constructor(sql: string) {
    this.sql = sql;
  }

  run(params: any, ...args: any[]): any {
    if (this.sql.includes('CREATE TABLE')) {
      const tableName = this.sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1];
      if (tableName) mockTables.add(tableName);
      return {};
    }
    if (this.sql.includes('INSERT INTO orders') && this.sql.includes('ON CONFLICT')) {
      const orders = mockStatements.get('orders') || [];
      const existingIdx = orders.findIndex((o: any) => o.client_order_id === params.clientOrderId);
      const record = {
        client_order_id: params.clientOrderId,
        order_id: params.orderId,
        signal_id: params.signalId,
        symbol: params.symbol,
        side: params.side,
        size: params.size,
        remaining_size: params.remainingSize,
        limit_price: params.limitPrice,
        stop_loss: params.stopLoss,
        take_profit: params.takeProfit,
        status: params.status,
        order_type: params.orderType,
        fee: params.fee,
        created_at: params.createdAt,
        updated_at: params.updatedAt,
        expires_at: params.expiresAt,
      };
      if (existingIdx >= 0) {
        orders[existingIdx] = record;
      } else {
        orders.push(record);
      }
      mockStatements.set('orders', orders);
      return {};
    }
    if (this.sql.includes('INSERT INTO positions') && this.sql.includes('ON CONFLICT')) {
      const positions = mockStatements.get('positions') || [];
      const existingIdx = positions.findIndex((p: any) => p.symbol === params.symbol);
      const record = {
        symbol: params.symbol,
        side: params.side,
        size: params.size,
        entry_price: params.entryPrice,
        unrealized_pnl: '0',
        realized_pnl: '0',
        updated_at: params.updatedAt,
      };
      if (existingIdx >= 0) {
        positions[existingIdx] = record;
      } else {
        positions.push(record);
      }
      mockStatements.set('positions', positions);
      return {};
    }
    if (this.sql.includes('INSERT INTO trade_history')) {
      const trades = mockStatements.get('trade_history') || [];
      const allArgs = typeof params === 'object' ? args : [params, ...args];
      trades.push({
        id: trades.length + 1,
        order_id: allArgs[0],
        symbol: allArgs[1],
        side: allArgs[2],
        size: allArgs[3],
        price: allArgs[4],
        fee: allArgs[5],
        pnl: allArgs[6],
        timestamp: allArgs[7],
      });
      mockStatements.set('trade_history', trades);
      return {};
    }
    return {};
  }

  get(...args: any[]): any {
    if (this.sql.includes('SELECT * FROM orders WHERE client_order_id')) {
      const orders = mockStatements.get('orders') || [];
      return orders.find((o: any) => o.client_order_id === args[0]) || undefined;
    }
    if (this.sql.includes('SELECT * FROM positions WHERE symbol')) {
      const positions = mockStatements.get('positions') || [];
      return positions.find((p: any) => p.symbol === args[0]) || undefined;
    }
    return undefined;
  }

  all(...args: any[]): any[] {
    if (this.sql.includes("SELECT * FROM orders WHERE status IN")) {
      const orders = mockStatements.get('orders') || [];
      return orders.filter((o: any) => ['submitted', 'pending', 'partially_filled'].includes(o.status));
    }
    if (this.sql.includes('SELECT * FROM positions') && !this.sql.includes('WHERE')) {
      return mockStatements.get('positions') || [];
    }
    if (this.sql.includes('SELECT * FROM trade_history')) {
      let trades = mockStatements.get('trade_history') || [];
      const limit = args[args.length - 1];
      if (typeof limit === 'number') {
        trades = trades.slice(0, limit);
      }
      return trades;
    }
    return [];
  }
}

class MockDatabase {
  constructor(_path: string, _options?: any) {}

  pragma(cmd: string): any {
    if (cmd === 'journal_mode = WAL') return { journal_mode: 'wal' };
    if (cmd.includes('wal_checkpoint')) return {};
    return {};
  }

  exec(sql: string): void {
    new MockStatement(sql).run({});
  }

  prepare(sql: string): MockStatement {
    return new MockStatement(sql);
  }

  close(): void {}
}

export default MockDatabase;
