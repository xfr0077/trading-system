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

  console.log('=== Container status ===');
  console.log(await exec(conn, 'cd /opt/trading-system && docker compose ps'));

  console.log('\n=== Latest 30 lines ===');
  console.log(await exec(conn, 'cd /opt/trading-system && docker compose logs ts-engine --tail 30'));

  console.log('\n=== Check .env in container ===');
  const r = await exec(conn, 'cd /opt/trading-system && docker compose exec -T ts-engine cat /app/.env 2>&1 | grep PRIVATE_KEY || echo "not found"');
  console.log('Container /app/.env:', r);

  conn.end();
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
