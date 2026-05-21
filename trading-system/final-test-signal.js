const { Client } = require('ssh2');
const fs = require('fs');
const vpsConfig = require('./scripts/vps-config');

async function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('close', (code) => resolve({ code, out: out.trim() }));
      stream.on('data', (d) => { out += d.toString(); });
      stream.stderr.on('data', (d) => { out += d.toString(); });
    });
  });
}

async function main() {
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect(vpsConfig);
  });

  console.log('Connected to VPS');

  console.log('Checking proto file in container...');
  const lsResult = await exec(conn, 'docker compose exec -T ts-engine ls -la /app/proto/');
  console.log('Proto directory listing:');
  console.log(lsResult.out);

  const existsResult = await exec(conn, 'docker compose exec -T ts-engine node -e \"const fs = require(\"fs\"); console.log(fs.existsSync(\"/app/proto/signal.proto\"))\"');
  console.log('Proto file exists:', existsResult.out);

  if (existsResult.out !== 'true') {
    console.error('Proto file not found in container!');
    conn.end();
    return;
  }

  console.log('Testing signal sending...');
  const testSignal = await exec(conn, `
    docker compose exec -T ts-engine node -e "
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
    
    return new Promise((resolve, reject) => {
      client.SendSignal(signal, (err, response) => {
        if (err) {
          console.error('RPC error:', err);
          reject(err);
        } else {
          console.log('Response:', response);
          resolve(response);
        }
        client.close();
      });
    });
  `);

  console.log('Signal test exit code:', testSignal.code);
  console.log('Signal test output:', testSignal.out);

  conn.end();
}

main().catch(err => { 
  console.error('FAILED:', err.message); 
  process.exit(1); 
});
