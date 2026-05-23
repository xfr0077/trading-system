const { Client } = require('ssh2');

async function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('close', (code) => {
        if (code !== 0) reject(new Error(`Exit ${code}: ${out.trim().slice(-300)}`));
        else resolve(out.trim());
      });
      stream.on('data', d => out += d.toString());
      stream.stderr.on('data', d => out += d.toString());
    });
  });
}

async function main() {
  const host = '43.247.132.103';
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect({ host, port: 22, username: 'root', password: '1TvHidSDi4eKJSoi' });
  });
  try {
    console.log('[Deploy] Rebuilding python-ai...');
    const build = await exec(conn, 'cd /opt/trading-system && docker compose build python-ai 2>&1');
    console.log('[Deploy] Build done');
    const up = await exec(conn, 'cd /opt/trading-system && docker compose up -d python-ai 2>&1');
    console.log('[Deploy] Restarted:', up.slice(-200));
    const ps = await exec(conn, 'cd /opt/trading-system && docker compose ps');
    console.log(ps);
  } finally {
    conn.end();
  }
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
