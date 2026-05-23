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
    const logs = await exec(conn, 'cd /opt/trading-system && docker compose logs python-ai --tail 20');
    console.log('=== Python AI logs ===');
    console.log(logs.slice(0, 3000));
  } finally { conn.end(); }
}
main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
