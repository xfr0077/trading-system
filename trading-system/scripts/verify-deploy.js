const { Client } = require('ssh2');
const vpsConfig = require('./vps-config');

async function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('close', (code) => resolve(out.trim()));
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

  console.log('=== Service status ===');
  console.log(await exec(conn, 'cd /opt/trading-system && docker compose ps'));

  console.log('\n=== Dashboard health ===');
  console.log(await exec(conn, 'curl -sf http://localhost:3000/api/status 2>&1'));

  console.log('\n=== gRPC health ===');
  console.log(await exec(conn, 'cd /opt/trading-system && docker compose exec -T ts-engine node -e "require(\'net\').createConnection(50051, \'localhost\').on(\'error\', () => process.exit(1)).on(\'connect\', () => { console.log(\'gRPC OK\'); process.exit(0); })" 2>&1'));

  conn.end();
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
