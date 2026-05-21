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

  await new Promise(r => setTimeout(r, 12000));

  console.log('=== Latest 20 lines ===');
  console.log(await exec(conn, 'cd /opt/trading-system && docker compose logs ts-engine --tail 20'));

  conn.end();
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
