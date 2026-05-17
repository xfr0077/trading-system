import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import * as path from 'path';

const protoPath = path.join(__dirname, '../../proto/signal.proto');
const protoDefinition = loadSync(protoPath);
const protoDescriptor = grpc.loadPackageDefinition(protoDefinition) as any;

const VALID_ACTIONS = new Set(['long', 'short', 'close']);

interface TradingSignal {
  signal_id: string;
  symbol: string;
  action: string;
  stop_loss: number;
  take_profit: number;
  confidence: number;
  position_size: number;
  timestamp: number;
  signal_price: number;
  max_slippage_bps: number;
}

interface SignalInput {
  signalId: string;
  symbol: string;
  action: string;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  positionSize: number;
  timestamp: number;
  signalPrice: number;
  maxSlippageBps: number;
}

export class SignalRouter {
  private seenSignals = new Map<string, number>();
  private readonly TTL_MS = 5 * 60 * 1000;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanupExpiredSignals(), 60 * 1000);
    this.cleanupInterval.unref();
  }

  private cleanupExpiredSignals(): void {
    const now = Date.now();
    for (const [id, timestamp] of this.seenSignals.entries()) {
      if (now - timestamp >= this.TTL_MS) {
        this.seenSignals.delete(id);
      }
    }
  }

  private validateSignal(signal: SignalInput): string | null {
    if (!signal.signalId || signal.signalId.trim() === '') {
      return 'signalId is required';
    }
    if (!signal.symbol || signal.symbol.trim() === '') {
      return 'symbol is required';
    }
    if (!signal.action || !VALID_ACTIONS.has(signal.action)) {
      return `action must be one of: ${Array.from(VALID_ACTIONS).join(', ')}`;
    }
    if (signal.confidence < 0 || signal.confidence > 100) {
      return 'confidence must be between 0 and 100';
    }
    if (signal.positionSize <= 0) {
      return 'positionSize must be greater than 0';
    }
    if (signal.stopLoss <= 0) {
      return 'stopLoss must be greater than 0';
    }
    if (signal.takeProfit <= 0) {
      return 'takeProfit must be greater than 0';
    }
    if (signal.signalPrice <= 0) {
      return 'signalPrice must be greater than 0';
    }
    if (signal.maxSlippageBps < 0) {
      return 'maxSlippageBps must be non-negative';
    }
    return null;
  }

  async handleSignal(signal: SignalInput): Promise<{ accepted: boolean; reason: string }> {
    const validationError = this.validateSignal(signal);
    if (validationError) {
      throw new Error(`INVALID_ARGUMENT: ${validationError}`);
    }

    const now = Date.now();
    const lastSeen = this.seenSignals.get(signal.signalId);
    if (lastSeen && now - lastSeen < this.TTL_MS) {
      return { accepted: false, reason: 'DUPLICATE_SIGNAL' };
    }

    this.seenSignals.set(signal.signalId, now);

    return { accepted: true, reason: '' };
  }

  async startServer(port: number): Promise<grpc.Server> {
    const server = new grpc.Server();
    server.addService(protoDescriptor.signal.SignalService.service, {
      SendSignal: async (call: grpc.ServerUnaryCall<TradingSignal, any>, callback: grpc.sendUnaryData<any>) => {
        try {
          const result = await this.handleSignal({
            signalId: call.request.signal_id,
            symbol: call.request.symbol,
            action: call.request.action,
            stopLoss: call.request.stop_loss,
            takeProfit: call.request.take_profit,
            confidence: call.request.confidence,
            positionSize: call.request.position_size,
            timestamp: call.request.timestamp,
            signalPrice: call.request.signal_price,
            maxSlippageBps: call.request.max_slippage_bps,
          });
          callback(null, { signal_id: call.request.signal_id, accepted: result.accepted, reason: result.reason });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[SignalRouter] SendSignal error: ${message}`);
          if (message.startsWith('INVALID_ARGUMENT:')) {
            callback({ code: grpc.status.INVALID_ARGUMENT, details: message.replace('INVALID_ARGUMENT: ', '') }, null);
          } else {
            callback({ code: grpc.status.INTERNAL, details: message }, null);
          }
        }
      },
      HealthCheck: async (_call: any, callback: grpc.sendUnaryData<any>) => {
        callback(null, { healthy: true, version: '0.1.0' });
      },
    });

    return new Promise<grpc.Server>((resolve, reject) => {
      server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
        if (err) {
          console.error(`[SignalRouter] Failed to bind server on port ${port}: ${err.message}`);
          reject(err);
          return;
        }
        console.log(`SignalRouter gRPC server listening on port ${boundPort}`);
        resolve(server);
      });
    });
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
