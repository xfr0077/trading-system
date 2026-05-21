const { Client } = require('ssh2');

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
  const host = process.env.DEPLOY_HOST;
  const user = process.env.DEPLOY_USER;
  const pass = process.env.DEPLOY_PASS;

  if (!host || !user || !pass) {
    console.error('ERROR: Missing required environment variables: DEPLOY_HOST, DEPLOY_USER, DEPLOY_PASS');
    console.error('Set them before running, e.g.:');
    console.error('  DEPLOY_HOST=your-server-ip DEPLOY_USER=your-user DEPLOY_PASS=your-password node scripts/check-env.js');
    process.exit(1);
  }

  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect({
      host, port: 22, username: user, password: pass
    });
  });

  console.log('--- .env content ---');
  const content = await exec(conn, 'cat /opt/trading-system/.env');
  console.log(content);

  console.log('\n--- Check if placeholder exists ---');
  const grep = await exec(conn, 'grep -n "your_evm" /opt/trading-system/.env || echo "not found"');
  console.log(grep);

  conn.end();
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
