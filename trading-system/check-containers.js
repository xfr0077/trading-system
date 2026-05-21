const { Client } = require('ssh2');
const vpsConfig = require('./scripts/vps-config');

const conn = new Client();
conn.on('ready', () => {
  conn.exec('docker ps', (err, stream) => {
    if (err) throw err;
    let out = '';
    stream.on('close', (code) => {
      console.log('Exit code:', code);
      console.log('Output:', out);
      conn.end();
    });
    stream.on('data', (d) => { out += d.toString(); });
    stream.stderr.on('data', (d) => { out += d.toString(); });
  });
}).connect(vpsConfig);
