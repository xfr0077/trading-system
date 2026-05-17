import { v4 as uuidv4 } from 'uuid';

export type OrderStatus = 'pending' | 'submitted' | 'filled' | 'cancelled' | 'rejected' | 'partially_filled';

export interface Order {
  orderId: string;
  clientOrderId: string;
  signalId: string;
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  remainingSize: number;
  limitPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  status: OrderStatus;
  fee: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateOrderInput {
  signalId: string;
  symbol: string;
  side: 'buy' | 'sell';
  size: number;
  limitPrice: number;
  stopLoss?: number;
  takeProfit?: number;
}

export class OrderManager {
  private orders = new Map<string, Order>();

  createOrder(input: CreateOrderInput): Order {
    const order: Order = {
      orderId: '',
      clientOrderId: uuidv4(),
      signalId: input.signalId,
      symbol: input.symbol,
      side: input.side,
      size: input.size,
      remainingSize: input.size,
      limitPrice: input.limitPrice,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      status: 'pending',
      fee: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.orders.set(order.clientOrderId, order);
    return order;
  }

  updateStatus(clientOrderId: string, status: OrderStatus, orderId?: string, fee?: number): void {
    const order = this.orders.get(clientOrderId);
    if (!order) return;

    order.status = status;
    order.updatedAt = Date.now();
    if (orderId) order.orderId = orderId;
    if (fee !== undefined) order.fee = fee;

    if (status === 'filled' || status === 'cancelled' || status === 'rejected') {
      order.remainingSize = 0;
    }
  }

  updatePartialFill(clientOrderId: string, filledSize: number): void {
    const order = this.orders.get(clientOrderId);
    if (!order) return;

    order.remainingSize = Math.max(0, order.remainingSize - filledSize);
    order.status = order.remainingSize > 0 ? 'partially_filled' : 'filled';
    order.updatedAt = Date.now();
  }

  getOrder(clientOrderId: string): Order | undefined {
    return this.orders.get(clientOrderId);
  }

  getOpenOrders(): Order[] {
    return Array.from(this.orders.values()).filter(
      (o) => !['filled', 'cancelled', 'rejected'].includes(o.status)
    );
  }

  getAllOrders(): Order[] {
    return Array.from(this.orders.values());
  }
}
