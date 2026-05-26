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
    const head = await exec(conn, 'grep -n "runtime_version" /opt/trading-system/python-ai/src/proto/signal_pb2.py');
    console.log('=== runtime_version in file ===');
    console.log(head || '(not found)');
    const ver = await exec(conn, 'docker compose exec -T python-ai python3 -c "import google.protobuf; print(google.protobuf.__version__)"');
    console.log('=== Container protobuf version ===');
    console.log(ver);
  } finally { conn.end(); }
}
main().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
