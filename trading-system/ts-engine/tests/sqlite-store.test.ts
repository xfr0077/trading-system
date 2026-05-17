import { SqliteStore, Order } from '../src/sqlite-store';
import * as fs from 'fs';
import * as path from 'path';

describe('SqliteStore', () => {
  let store: SqliteStore;
  const dbPath = path.join(__dirname, 'test-trading.db');

  beforeEach(() => {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    store = new SqliteStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  test('should save and retrieve order', () => {
    const order: Order = {
      clientOrderId: 'client-1',
      orderId: 'exchange-1',
      signalId: 'sig-1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: '0.01',
      remainingSize: '0.01',
      limitPrice: '98500',
      stopLoss: '97000',
      takeProfit: '100000',
      status: 'submitted',
      orderType: 'limit',
      fee: '0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 300000,
    };

    store.saveOrder(order);
    const retrieved = store.getOrder('client-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.clientOrderId).toBe('client-1');
    expect(retrieved?.symbol).toBe('BTC_USDT_Perp');
  });

  test('should update order status', () => {
    const order: Order = {
      clientOrderId: 'client-1',
      orderId: 'exchange-1',
      signalId: 'sig-1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy',
      size: '0.01',
      remainingSize: '0.01',
      limitPrice: '98500',
      status: 'submitted',
      orderType: 'limit',
      fee: '0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 300000,
    };

    store.saveOrder(order);
    order.status = 'filled';
    order.remainingSize = '0';
    order.fee = '0.5';
    store.saveOrder(order);

    const updated = store.getOrder('client-1');
    expect(updated?.status).toBe('filled');
    expect(updated?.fee).toBe('0.5');
  });

  test('should get open orders', () => {
    store.saveOrder({ clientOrderId: 'c1', orderId: 'e1', signalId: 's1', symbol: 'BTC', side: 'buy', size: '0.01', remainingSize: '0.01', limitPrice: '98500', status: 'submitted', orderType: 'limit', fee: '0', createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 300000 });
    store.saveOrder({ clientOrderId: 'c2', orderId: 'e2', signalId: 's2', symbol: 'ETH', side: 'sell', size: '0.1', remainingSize: '0', limitPrice: '3400', status: 'filled', orderType: 'limit', fee: '0', createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 300000 });

    const open = store.getOpenOrders();
    expect(open.length).toBe(1);
    expect(open[0].clientOrderId).toBe('c1');
  });

  test('should update position', () => {
    store.updatePosition('BTC_USDT_Perp', 'long', '0.01', '98500');
    const pos = store.getPosition('BTC_USDT_Perp');
    expect(pos).not.toBeNull();
    expect(pos?.size).toBe('0.01');
    expect(pos?.entryPrice).toBe('98500');
  });

  test('should add and retrieve trade history', () => {
    const trade = {
      orderId: 'e1',
      symbol: 'BTC_USDT_Perp',
      side: 'buy' as const,
      size: '0.01',
      price: '98500',
      fee: '0.5',
      pnl: '0',
      timestamp: Date.now(),
    };

    store.addTradeHistory(trade);
    const history = store.getTradeHistory('BTC_USDT_Perp', 10);
    expect(history.length).toBe(1);
    expect(history[0].symbol).toBe('BTC_USDT_Perp');
  });
});
