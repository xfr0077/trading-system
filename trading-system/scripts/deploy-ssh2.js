const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TAR_PATH = path.join(process.env.TEMP || __dirname, 'trading-deploy.tar.gz');

async function execSSH(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('close', (code) => {
        if (code !== 0) reject(new Error(`Exit ${code}: ${out}`));
        else resolve(out.trim());
      });
      stream.on('data', (d) => { out += d.toString(); });
      stream.stderr.on('data', (d) => { out += d.toString(); });
    });
  });
}

async function deploy() {
  const requiredEnvVars = ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_PASS'];
  const missing = requiredEnvVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error('[Deploy] ERROR: Missing required environment variables:');
    missing.forEach((v) => console.error(`  - ${v}`));
    console.error('\nSet them before running deploy, e.g.:');
    console.error('  DEPLOY_HOST=your-server-ip DEPLOY_USER=your-user DEPLOY_PASS=your-password node scripts/deploy-ssh2.js');
    process.exit(1);
  }

  const host = process.env.DEPLOY_HOST;
  const user = process.env.DEPLOY_USER;
  const pass = process.env.DEPLOY_PASS;

  // Build tar archive
  console.log('[Deploy] Building tar archive...');
  execSync(
    `tar czf "${TAR_PATH}" --exclude node_modules --exclude ".env" --exclude ".git" --exclude "*.db" -C "${ROOT}" docker-compose.yml ts-engine/src ts-engine/package.json ts-engine/tsconfig.json ts-engine/Dockerfile python-ai/src python-ai/requirements.txt python-ai/Dockerfile python-ai/.env .env.production.example proto scripts/nginx.conf CLAUDE.md`,
    { stdio: 'pipe' }
  );
  const stat = fs.statSync(TAR_PATH);
  console.log(`[Deploy] Archive size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

  const conn = new Client();
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect({ host, port: 22, username: user, password: pass });
  });

  try {
    console.log('[Deploy] Connected to', host);

    // Upload tar
    await new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        const ws = sftp.createWriteStream('/opt/trading-system/deploy.tar.gz');
        ws.on('close', resolve);
        ws.on('error', reject);
        fs.createReadStream(TAR_PATH).pipe(ws);
      });
    });
    console.log('[Deploy] Upload done');

    // Extract and deploy
    await execSSH(conn, 'mkdir -p /opt/trading-system && cd /opt/trading-system && tar xzf deploy.tar.gz && rm deploy.tar.gz');
    console.log('[Deploy] Extracted');

    // Check docker
    const dockerCheck = await execSSH(conn, 'which docker && docker compose version').catch(() => '');
    if (!dockerCheck) {
      console.log('[Deploy] Installing Docker...');
      await execSSH(conn, 'curl -fsSL https://get.docker.com | sh');
    } else {
      console.log('[Deploy] Docker OK');
    }

    // Create .env if missing
    await execSSH(conn, 'cd /opt/trading-system && [ ! -f .env ] && cp .env.production.example .env || true');

    // Build and start
    console.log('[Deploy] Building Docker image...');
    const buildOut = await execSSH(conn, 'cd /opt/trading-system && docker compose build ts-engine 2>&1');
    console.log('[Deploy] Build:', buildOut.slice(-200));

    console.log('[Deploy] Starting containers...');
    await execSSH(conn, 'cd /opt/trading-system && docker compose up -d 2>&1');

    // Verify
    const status = await execSSH(conn, 'cd /opt/trading-system && docker compose ps');
    console.log('[Deploy] Services:\n' + status);

    const health = await execSSH(conn, 'curl -sf http://localhost:3000/api/status || echo "Dashboard not ready"').catch(() => 'check later');
    console.log('[Deploy] Dashboard:', health);

    console.log('[Deploy] SUCCESS');
  } finally {
    conn.end();
    try { fs.unlinkSync(TAR_PATH); } catch {}
  }
}

deploy().catch((err) => {
  console.error('[Deploy] FAILED:', err.message);
  process.exit(1);
});
