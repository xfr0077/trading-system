const { Client } = require('ssh2');
const vpsConfig = require('./vps-config');

async function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '', errOut = '';
      stream.on('close', () => resolve({ out: out.trim(), err: errOut.trim() }));
      stream.on('data', (d) => { out += d.toString(); });
      stream.stderr.on('data', (d) => { errOut += d.toString(); });
    });
  });
}

async function main() {
  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect(vpsConfig);
  });

  let r;
  r = await exec(conn, 'grep PRIVATE_KEY /opt/trading-system/.env');
  console.log('.env PRIVATE_KEY:', r.out || '(empty)');

  r = await exec(conn, 'grep GRVT_PRIVATE_KEY /opt/trading-system/.env');
  console.log('.env GRVT_PRIVATE_KEY:', r.out || '(empty)');

  r = await exec(conn, 'echo "HOST_PRIV=$PRIVATE_KEY"');
  console.log('Host PRIVATE_KEY env var:', r.out);

  r = await exec(conn, 'docker compose exec -T ts-engine printenv PRIVATE_KEY 2>&1');
  console.log('Container PRIVATE_KEY:', r.out);

  r = await exec(conn, 'docker compose exec -T ts-engine printenv GRVT_PRIVATE_KEY 2>&1');
  console.log('Container GRVT_PRIVATE_KEY:', r.out);

  conn.end();
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
