const { Client } = require('ssh2');
const vpsConfig = require('./scripts/vps-config');

const conn = new Client();
conn.on('ready', () => {
  console.log('SSH connected');

  conn.exec('docker compose exec -T ts-engine echo "Container is reachable"', (err, stream) => {
    if (err) {
      console.error('Failed to exec into container:', err);
      conn.end();
      return;
    }
    let output = '';
    stream.on('close', (code) => {
      if (code !== 0) {
        console.error('Container exec failed with code:', code);
        conn.end();
        return;
      }
      console.log('Container is reachable');

      const testScript = `
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
`;

      conn.exec(`echo '${testScript.replace(/'/g, "'\\''")}' > /opt/test-signal.js`, (err2, stream2) => {
        if (err2) {
          console.error('Failed to write test script:', err2);
          conn.end();
          return;
        }
        stream2.on('close', (code2) => {
          if (code2 !== 0) {
            console.error('Failed to write test script, exit code:', code2);
            conn.end();
            return;
          }
          console.log('Test script written');

          conn.exec('docker compose exec -T ts-engine node /opt/test-signal.js', (err3, stream3) => {
            if (err3) {
              console.error('Failed to run test script:', err3);
              conn.end();
              return;
            }
            let output3 = '';
            stream3.on('close', (code3) => {
              console.log('Test script exit code:', code3);
              if (code3 !== 0) {
                console.error('Test script failed');
              }
              conn.end();
            });
            stream3.on('data', (d) => { output3 += d.toString(); });
            stream3.stderr.on('data', (d) => { output3 += d.toString(); });
          });
        });
        stream2.on('data', (d) => { });
        stream2.stderr.on('data', (d) => { });
      });
    });
    stream.on('data', (d) => { output += d.toString(); });
    stream.stderr.on('data', (d) => { output += d.toString(); });
  });
}).connect(vpsConfig);
