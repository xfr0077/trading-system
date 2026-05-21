const assert = require('assert');

const required = ['VPS_HOST', 'VPS_USER', 'VPS_PASSWORD'];
for (const key of required) {
  assert.ok(process.env[key], `Missing required env var: ${key}. Set it in .env.vps or shell environment.`);
}

module.exports = {
  host: process.env.VPS_HOST,
  port: parseInt(process.env.VPS_PORT || '22', 10),
  username: process.env.VPS_USER,
  password: process.env.VPS_PASSWORD,
};
