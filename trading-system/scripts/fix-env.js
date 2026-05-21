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

  const REAL_KEY = process.env.VPS_ENV_PRIVATE_KEY;
  if (!REAL_KEY) {
    console.error('Missing VPS_ENV_PRIVATE_KEY env var');
    process.exit(1);
  }

  console.log('Replacing private key in .env...');
  const sedCmd = `sed -i 's/your_evm_wallet_private_key/${REAL_KEY}/' /opt/trading-system/.env`;
  console.log('Running:', sedCmd);
  const result = await exec(conn, sedCmd);
  console.log('sed result:', result);

  const grep = await exec(conn, "grep PRIVATE_KEY /opt/trading-system/.env");
  console.log('After sed:', grep);

  console.log('\nRestarting ts-engine...');
  await exec(conn, 'cd /opt/trading-system && docker compose restart ts-engine 2>&1');

  await new Promise(r => setTimeout(r, 10000));

  console.log('\n--- Latest logs ---');
  const logs = await exec(conn, 'cd /opt/trading-system && docker compose logs ts-engine --tail 25');
  console.log(logs);

  conn.end();
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
