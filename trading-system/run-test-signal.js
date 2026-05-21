const { Client } = require('ssh2');
const fs = require('fs');
const vpsConfig = require('./scripts/vps-config');

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
  const genResult = await exec(conn, 'cd /opt/trading-system/ts-engine && npm run proto:generate 2>&1');
  console.log('Proto generation:', genResult);

  console.log('Running test signal...');
  const result = await exec(conn, 'cd /opt/trading-system/ts-engine && node /opt/test-signal.js 2>&1');
  console.log('Result:', result);

  conn.end();
}

main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
