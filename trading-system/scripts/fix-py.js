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
    await exec(conn, 'cd /opt/trading-system && docker compose down python-ai');
    await exec(conn, 'docker rmi trading-system-python-ai');
    const build = await exec(conn, 'cd /opt/trading-system && docker compose build python-ai 2>&1');
    console.log('Build:', build.slice(-300));
    await exec(conn, 'cd /opt/trading-system && docker compose up -d python-ai');
    await new Promise(r => setTimeout(r, 5000));
    const logs = await exec(conn, 'cd /opt/trading-system && docker compose logs python-ai --tail 15');
    console.log('Logs:', logs);
  } finally { conn.end(); }
}
main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
