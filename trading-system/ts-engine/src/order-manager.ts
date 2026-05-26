/**
 * Order lifecycle managed by xstate state machine.
 *
 * Replaces hand-rolled state tracking with a formal finite state machine.
 * Invalid transitions (e.g. filled → cancelled) are rejected at the framework level.
 * `updateStatus` and `updatePartialFill` return the fresh Order snapshot.
 *
 * States: pending → submitted → partially_filled → filled
 *                        → cancelled
 *                        → rejected
 */

import { createMachine, createActor, Actor, assign } from 'xstate';
import { v4 as uuidv4 } from 'uuid';

// ---- Public types (unchanged) ----

export type OrderStatus =
  | 'pending'
  | 'submitted'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'partially_filled';

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
  orderType: 'limit' | 'market';
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

// ---- xstate machine ----

type OrderContext = Omit<Order, 'status'>;

type OrderEvent =
  | { type: 'SUBMIT'; orderId: string }
  | { type: 'FILL'; orderId?: string; fee?: number }
  | { type: 'PARTIAL_FILL'; filledSize: number; fee?: number }
  | { type: 'CANCEL' }
  | { type: 'REJECT' };

type OrderActor = Actor<typeof orderMachine>;

const STATUS_TO_EVENT: Record<OrderStatus, OrderEvent['type'] | null> = {
  pending: null,
  submitted: 'SUBMIT',
  filled: 'FILL',
  cancelled: 'CANCEL',
  rejected: 'REJECT',
  partially_filled: 'PARTIAL_FILL',
};

const orderMachine = createMachine({
  id: 'order',
  initial: 'pending',
  types: {} as {
    context: OrderContext;
    input: OrderContext;
    events: OrderEvent;
  },
  context: ({ input }) => ({ ...input }),
  states: {
    pending: {
      on: {
        SUBMIT: {
          target: 'submitted',
          actions: assign(({ context, event }) => ({
            ...context,
            orderId: event.orderId,
            updatedAt: Date.now(),
          })),
        },
        CANCEL: {
          target: 'cancelled',
          actions: assign(({ context }) => ({
            ...context,
            remainingSize: 0,
            updatedAt: Date.now(),
          })),
        },
        REJECT: {
          target: 'rejected',
          actions: assign(({ context }) => ({
            ...context,
            remainingSize: 0,
            updatedAt: Date.now(),
          })),
        },
      },
    },
    submitted: {
      on: {
        FILL: {
          target: 'filled',
          actions: assign(({ context, event }) => ({
            ...context,
            orderId: event.orderId || context.orderId,
            fee: event.fee ?? context.fee,
            remainingSize: 0,
            status: 'filled' as const,
            updatedAt: Date.now(),
          })),
        },
        PARTIAL_FILL: {
          target: 'partially_filled',
          actions: assign(({ context, event }) => ({
            ...context,
            remainingSize: Math.max(0, context.remainingSize - event.filledSize),
            fee: event.fee ?? context.fee,
            status: 'partially_filled' as const,
            updatedAt: Date.now(),
          })),
        },
        CANCEL: {
          target: 'cancelled',
          actions: assign(({ context }) => ({
            ...context,
            remainingSize: 0,
            status: 'cancelled' as const,
            updatedAt: Date.now(),
          })),
        },
        REJECT: {
          target: 'rejected',
          actions: assign(({ context }) => ({
            ...context,
            remainingSize: 0,
            status: 'rejected' as const,
            updatedAt: Date.now(),
          })),
        },
      },
    },
    partially_filled: {
      on: {
        FILL: {
          target: 'filled',
          actions: assign(({ context, event }) => ({
            ...context,
            orderId: event.orderId || context.orderId,
            fee: event.fee ?? context.fee,
            remainingSize: 0,
            status: 'filled' as const,
            updatedAt: Date.now(),
          })),
        },
        CANCEL: {
          target: 'cancelled',
          actions: assign(({ context }) => ({
            ...context,
            remainingSize: 0,
            status: 'cancelled' as const,
            updatedAt: Date.now(),
          })),
        },
      },
    },
    filled: { type: 'final' },
    cancelled: { type: 'final' },
    rejected: { type: 'final' },
  },
});

// ---- Helpers ----

function snapshotToOrder(ctx: OrderContext, status: OrderStatus): Order {
  return {
    orderId: ctx.orderId,
    clientOrderId: ctx.clientOrderId,
    signalId: ctx.signalId,
    symbol: ctx.symbol,
    side: ctx.side,
    size: ctx.size,
    remainingSize: ctx.remainingSize,
    limitPrice: ctx.limitPrice,
    stopLoss: ctx.stopLoss,
    takeProfit: ctx.takeProfit,
    status,
    orderType: ctx.orderType,
    fee: ctx.fee,
    createdAt: ctx.createdAt,
    updatedAt: ctx.updatedAt,
  };
}

function readActor(actor: OrderActor): Order | undefined {
  try {
    const snapshot = actor.getSnapshot();
    return snapshotToOrder(
      snapshot.context as OrderContext,
      snapshot.value as OrderStatus,
    );
  } catch {
    return undefined;
  }
}

// ---- Public OrderManager ----

const FINAL_STATES = new Set(['filled', 'cancelled', 'rejected']);

export class OrderManager {
  private actors = new Map<string, OrderActor>();
  private readonly MAX_ORDERS = 1000;
  private readonly CLEANUP_THRESHOLD = 800;

  // -- Factory --

  createOrder(input: CreateOrderInput): Order {
    if (this.actors.size >= this.CLEANUP_THRESHOLD) {
      this.cleanupTerminalActors();
    }

    const ctx: OrderContext = {
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
      orderType: 'market',
      fee: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const actor = createActor(orderMachine, { input: ctx });
    actor.start();
    this.actors.set(ctx.clientOrderId, actor);

    return snapshotToOrder(ctx, 'pending');
  }

  // -- State transitions (return fresh Order snapshot) --

  updateStatus(
    clientOrderId: string,
    status: OrderStatus,
    orderId?: string,
    fee?: number,
  ): Order | undefined {
    const actor = this.actors.get(clientOrderId);
    if (!actor) return undefined;

    const snapshot = actor.getSnapshot();
    if (FINAL_STATES.has(snapshot.value as string)) {
      console.log(
        `[OrderManager] Order ${clientOrderId} already in terminal state ${snapshot.value}, ignoring update to ${status}`,
      );
      return readActor(actor);
    }

    const eventType = STATUS_TO_EVENT[status];
    if (!eventType) return readActor(actor); // 'pending' → no-op

    try {
      actor.send({ type: eventType, orderId, fee } as OrderEvent);
    } catch {
      console.warn(
        `[OrderManager] Invalid transition for ${clientOrderId}: ${snapshot.value} → ${status}`,
      );
    }

    return readActor(actor);
  }

  updatePartialFill(clientOrderId: string, filledSize: number): Order | undefined {
    const actor = this.actors.get(clientOrderId);
    if (!actor) return undefined;

    const snapshot = actor.getSnapshot();
    if (FINAL_STATES.has(snapshot.value as string)) return readActor(actor);

    try {
      actor.send({ type: 'PARTIAL_FILL', filledSize } as OrderEvent);
    } catch {
      console.warn(
        `[OrderManager] Invalid PARTIAL_FILL for ${clientOrderId} in state ${snapshot.value}`,
      );
    }

    return readActor(actor);
  }

  // -- Queries --

  getOrder(clientOrderId: string): Order | undefined {
    const actor = this.actors.get(clientOrderId);
    return actor ? readActor(actor) : undefined;
  }

  getOpenOrders(): Order[] {
    const result: Order[] = [];
    for (const actor of this.actors.values()) {
      const snapshot = actor.getSnapshot();
      if (!FINAL_STATES.has(snapshot.value as string)) {
        const order = readActor(actor);
        if (order) result.push(order);
      }
    }
    return result;
  }

  getAllOrders(): Order[] {
    const result: Order[] = [];
    for (const actor of this.actors.values()) {
      const order = readActor(actor);
      if (order) result.push(order);
    }
    return result;
  }

  // -- Maintenance --

  cleanup(): number {
    return this.cleanupTerminalActors();
  }

  private cleanupTerminalActors(): number {
    let cleaned = 0;
    for (const [id, actor] of this.actors) {
      const snapshot = actor.getSnapshot();
      if (FINAL_STATES.has(snapshot.value as string)) {
        actor.stop();
        this.actors.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(
        `[OrderManager] Cleaned up ${cleaned} terminal orders (${this.actors.size} remaining)`,
      );
    }
    return cleaned;
  }
}
