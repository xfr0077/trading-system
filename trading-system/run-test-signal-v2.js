const { Client } = require('ssh2');
const fs = require('fs');
const vpsConfig = require('./scripts/vps-config');

async function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('close', (code) => resolve({ code, out: out.trim() }));
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

  console.log('Connected to VPS');

  console.log('Checking node and npm...');
  const nodeCheck = await exec(conn, 'docker compose exec -T ts-engine node --version');
  const npmCheck = await exec(conn, 'docker compose exec -T ts-engine npm --version');
  console.log('Node version:', nodeCheck.out);
  console.log('NPM version:', npmCheck.out);

  console.log('Copying test signal script...');
  const script = fs.readFileSync('D:/opencodex/trading-system/trading-system/test-signal.js', 'utf8');
  await new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = sftp.createWriteStream('/opt/test-signal.js');
      ws.on('close', resolve);
      ws.on('error', reject);
      ws.end(script);
    });
  });

  console.log('Generating proto files...');
  const genResult = await exec(conn, 'docker compose exec -T ts-engine sh -c \"cd /opt/trading-system/ts-engine && npm run proto:generate\"');
  console.log('Proto generation exit code:', genResult.code);
  console.log('Proto generation output:', genResult.out);

  console.log('Running test signal...');
  const testResult = await exec(conn, 'docker compose exec -T ts-engine node /opt/test-signal.js');
  console.log('Test signal exit code:', testResult.code);
  console.log('Test signal output:', testResult.out);

  conn.end();
}

main().catch(err => { 
  console.error('FAILED:', err.message); 
  process.exit(1); 
});
