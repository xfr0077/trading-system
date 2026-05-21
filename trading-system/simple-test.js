const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');

const protoPath = '/app/proto/signal.proto';
const packageDefinition = protoLoader.loadSync(protoPath, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});
const signalProto = grpc.loadPackageDefinition(packageDefinition).signal;

const client = new signalProto.SignalService('localhost:50051', grpc.credentials.createInsecure());

const signal = {
  signal_id: 'test-signal-' + Date.now(),
  symbol: 'BTC_USDT_Perp',
  action: 'long',
  stop_loss: 60000,
  take_profit: 75000,
  confidence: 85,
  position_size: 0.01,
  timestamp: Date.now(),
  signal_price: 66666,
  max_slippage_bps: 10,
  order_type: 'limit',
  order_ttl_ms: 5000
};

console.log('Sending signal:', JSON.stringify(signal, null, 2));

client.SendSignal(signal, (err, response) => {
  if (err) {
    console.error('RPC error:', err);
  } else {
    console.log('Response:', response);
  }
  client.close();
});