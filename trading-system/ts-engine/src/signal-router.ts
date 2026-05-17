import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import * as path from 'path';

const protoPath = path.join(__dirname, '../../proto/signal.proto');
const protoDefinition = loadSync(protoPath);
const protoDescriptor = grpc.loadPackageDefinition(protoDefinition) as any;

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

  async handleSignal(signal: SignalInput): Promise<{ accepted: boolean; reason: string }> {
    const now = Date.now();
    const lastSeen = this.seenSignals.get(signal.signalId);
    if (lastSeen && now - lastSeen < this.TTL_MS) {
      return { accepted: false, reason: 'DUPLICATE_SIGNAL' };
    }

    this.seenSignals.set(signal.signalId, now);

    return { accepted: true, reason: '' };
  }

  startServer(port: number): grpc.Server {
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
          callback(err as Error, null);
        }
      },
      HealthCheck: async (_call: any, callback: grpc.sendUnaryData<any>) => {
        callback(null, { healthy: true, version: '0.1.0' });
      },
    });
    server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), () => {
      server.start();
      console.log(`SignalRouter gRPC server listening on port ${port}`);
    });
    return server;
  }
}
