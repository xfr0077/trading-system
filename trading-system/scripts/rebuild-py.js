const { Client } = require('ssh2');

async function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('close', () => resolve(out.trim()));
      stream.on('data', d => out += d.toString());
      stream.stderr.on('data', d => out += d.toString());
    });
  });
}

async function main() {
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect({ host: '43.247.132.103', port: 22, username: 'root', password: '1TvHidSDi4eKJSoi' });
  });
  try {
    // Force rebuild without cache
    console.log(await exec(conn, 'cd /opt/trading-system && docker compose build --no-cache python-ai 2>&1 | tail -5'));
    console.log(await exec(conn, 'cd /opt/trading-system && docker compose up -d python-ai 2>&1'));
    await new Promise(r => setTimeout(r, 3000));
    console.log(await exec(conn, 'cd /opt/trading-system && docker compose logs python-ai --tail 10'));
  } finally { conn.end(); }
}
main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
