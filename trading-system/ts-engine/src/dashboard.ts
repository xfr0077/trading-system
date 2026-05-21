import http from 'http';
import { SignalRouter } from './signal-router';
import { MarketData } from './market-data';
import { Config } from './config';

const SSE_KEEPALIVE_MS = 15000;

// --- Rate Limiting ---
const rateLimitMap = new Map<string, number>();

function getRateLimitKey(ip: string): string {
  const minuteBucket = Math.floor(Date.now() / 60000);
  return `${ip}:${minuteBucket}`;
}

function checkRateLimit(ip: string, maxRpm: number): boolean {
  const key = getRateLimitKey(ip);
  const count = rateLimitMap.get(key) || 0;
  if (count >= maxRpm) return false;
  rateLimitMap.set(key, count + 1);
  return true;
}

// Cleanup stale rate limit entries every 2 minutes
setInterval(() => {
  const currentBucket = Math.floor(Date.now() / 60000);
  for (const key of rateLimitMap.keys()) {
    const bucket = parseInt(key.split(':').pop() || '0', 10);
    if (bucket < currentBucket - 1) {
      rateLimitMap.delete(key);
    }
  }
}, 120000);

interface SSEClient {
  id: number;
  res: http.ServerResponse;
}

export function startDashboard(router: SignalRouter, port: number, config?: Config): http.Server {
  let sseId = 0;
  const sseClients = new Map<number, SSEClient>();

  const corsOrigins = config?.corsOrigins || ['*'];
  const dashboardToken = config?.dashboardToken;
  const rateLimitRpm = config?.rateLimitRpm || 60;

  function broadcast(event: string, data: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [id, client] of sseClients) {
      try {
        client.res.write(msg);
      } catch {
        sseClients.delete(id);
      }
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    // --- CORS ---
    const origin = req.headers.origin || '';
    if (corsOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // --- Rate Limiting ---
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(clientIp, rateLimitRpm)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too Many Requests' }));
      return;
    }

    // --- Bearer Token Auth for /api/* routes ---
    if (dashboardToken && path.startsWith('/api/')) {
      const authHeader = req.headers.authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (token !== dashboardToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (path === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const id = ++sseId;
      const client: SSEClient = { id, res };
      sseClients.set(id, client);
      const keepalive = setInterval(() => {
        try { res.write(':keepalive\n\n'); } catch { clearInterval(keepalive); }
      }, SSE_KEEPALIVE_MS);
      req.on('close', () => { sseClients.delete(id); clearInterval(keepalive); });
      return;
    }

    if (path === '/api/status') {
      const mem = process.memoryUsage();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        uptime: process.uptime(),
        memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
        version: process.env.npm_package_version || '0.1.0',
        paperTrading: config?.paperTrading || process.env.PAPER_TRADING === 'true',
        dex: config?.dexProvider || process.env.DEX_PROVIDER || 'unknown',
      }));
      return;
    }

    if (path === '/api/paper-stats') {
      if (process.env.PAPER_TRADING !== 'true') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Paper trading not enabled' }));
        return;
      }
      const dexAdapter = (router as any).dexAdapter;
      const stats = dexAdapter?.getStats?.() || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
      return;
    }

    if (path === '/api/positions') {
      const positions = Array.from(router.getPositionTracker().getPositions().values());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(positions));
      return;
    }

    if (path === '/api/orders') {
      const openOrders = Array.from(router.getPositionTracker().getOpenOrders().values());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(openOrders));
      return;
    }

    if (path === '/api/risk') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        shadowPositions: Object.fromEntries(router.getRiskEngine().getShadowPositions()),
        dailyLoss: router.getRiskEngine().getDailyLoss(),
        margin: router.getMarginMonitor().getStatus(),
      }));
      return;
    }

    if (path === '/api/market') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
      return;
    }

    if (path === '/api/history') {
      const recent = router.getSqliteStore().getRecentOrders(100);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(recent));
      return;
    }

    if (path === '/api/trades') {
      const symbol = url.searchParams.get('symbol') || undefined;
      const limit = parseInt(url.searchParams.get('limit') || '100');
      const trades = router.getSqliteStore().getTradeHistory(symbol, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(trades));
      return;
    }

    if (path === '/api/stats') {
      const stats = router.getSqliteStore().getStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stats));
      return;
    }

    if (path === '/api/sltp') {
      const active = router.getSLTPMonitor().getActiveOrders();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(active));
      return;
    }

    if (path === '/api/signals') {
      const signals = router.getSignalHistory().slice(0, 100);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(signals));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(port, () => {
    console.log(`[Dashboard] http://localhost:${port}`);
  });

  setInterval(async () => {
    const positions = Array.from(router.getPositionTracker().getPositions().values());
    const orders = Array.from(router.getPositionTracker().getOpenOrders().values());
    const sltp = router.getSLTPMonitor().getActiveOrders();
    const stats = router.getSqliteStore().getStats();
    const signals = router.getSignalHistory().slice(0, 20);
    broadcast('positions', positions);
    broadcast('orders', orders);
    broadcast('sltp', sltp);
    broadcast('stats', stats);
    broadcast('signals', signals);
  }, 3000);

  return server;
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>交易引擎 Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f6f8;color:#1a1a2e;padding:0;font-size:13px;min-height:100vh}
.header{background:#fff;border-bottom:1px solid #e2e8f0;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;box-shadow:0 1px 3px rgba(0,0,0,.04)}
.header-left{display:flex;align-items:center;gap:12px}
.header h1{font-size:17px;font-weight:700;color:#1a1a2e}
.header .sub{font-size:11px;color:#94a3b8}
.header-right{display:flex;align-items:center;gap:10px}
.badge{font-size:10px;font-weight:600;padding:3px 10px;border-radius:20px;text-transform:uppercase;letter-spacing:.4px}
.badge-paper{background:#fef3c7;color:#92400e;border:1px solid #fcd34d}
.badge-live{background:#d1fae5;color:#065f46;border:1px solid #6ee7b7}
.content{max-width:1200px;margin:0 auto;padding:16px 24px}
.grid-4{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin-bottom:14px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px}
.card-title{font-size:10px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.card-value{font-size:22px;font-weight:700;font-family:'SF Mono','Fira Code',Consolas,monospace;line-height:1.2;color:#1a1a2e}
.card-sub{font-size:11px;color:#94a3b8;margin-top:3px}
.row{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}
.row>.card{flex:1;min-width:280px}
.row>.card-wide{flex:3;min-width:550px}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.stat-item{padding:8px 10px;background:#f8fafc;border-radius:8px;border:1px solid #eef2f6}
.stat-item .s-label{font-size:10px;color:#94a3b8;margin-bottom:1px}
.stat-item .s-value{font-size:14px;font-weight:600;font-family:'SF Mono','Fira Code',Consolas,monospace;color:#1a1a2e}
.data-table{width:100%;border-collapse:collapse;font-size:12px}
.data-table th{padding:7px 10px;text-align:left;color:#94a3b8;border-bottom:1px solid #e2e8f0;font-weight:600;white-space:nowrap;font-size:10px;text-transform:uppercase;letter-spacing:.4px}
.data-table td{padding:7px 10px;border-bottom:1px solid #f1f5f9;font-family:'SF Mono','Fira Code',Consolas,monospace;white-space:nowrap;font-size:11px}
.data-table tbody tr:hover{background:#f8fafc}
.green{color:#059669}
.red{color:#dc2626}
.yellow{color:#b45309}
.blue{color:#2563eb}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle}
.dot-green{background:#059669}
.dot-red{background:#dc2626}
.pill{display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600}
.pill-pass{background:#d1fae5;color:#065f46}
.pill-fail{background:#fee2e2;color:#991b1b}
.pill-open{background:#dbeafe;color:#1e40af}
.pill-filled{background:#d1fae5;color:#065f46}
.pill-cancel{background:#f1f5f9;color:#64748b}
.empty-state{padding:20px;text-align:center;color:#94a3b8;font-size:12px}
.uptime{font-size:11px;color:#94a3b8}
@media(max-width:768px){.header{padding:12px 16px}.content{padding:12px 16px}.row>.card-wide{min-width:100%}.grid-4{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div class="header">
  <div class="header-left">
    <h1>交易引擎</h1>
    <span class="subtitle">v<span id="sysVersion">-</span></span>
    <span id="modeBadge"></span>
  </div>
  <div class="header-right">
    <span class="uptime"><span class="dot dot-green"></span>运行中 · <span id="sysUptime">-</span></span>
  </div>
</div>
<div class="content">

<div class="grid-4">
  <div class="card">
    <div class="card-title">系统状态</div>
    <div class="card-value" style="font-size:16px"><span class="dot dot-green"></span>运行中</div>
    <div class="card-sub">已运行 <span id="sysUptime2">-</span></div>
  </div>
  <div class="card">
    <div class="card-title">模拟盘余额</div>
    <div class="card-value" id="paperBalance">$10,000</div>
    <div class="card-sub">总盈亏 <span id="paperPnl">$0</span></div>
  </div>
  <div class="card">
    <div class="card-title">风控</div>
    <div class="card-value" id="dailyLoss">$0</div>
    <div class="card-sub" id="marginStatus">日亏限额 $20</div>
  </div>
  <div class="card">
    <div class="card-title">交易统计</div>
    <div class="card-value" id="totalTrades">0</div>
    <div class="card-sub">胜率 <span id="winRateDisplay">-</span> · 持仓 <span id="posCount2">0</span></div>
  </div>
</div>

<div class="row">
  <div class="card">
    <div class="card-title"><span class="dot dot-green"></span>AI 信号</div>
    <table class="data-table"><thead><tr><th>时间</th><th>交易对</th><th>方向</th><th>置信度</th><th>数量</th><th>价格</th><th>结果</th><th>原因</th></tr></thead><tbody id="signalsBody"><tr><td colspan="8" class="empty-state">等待 AI 信号...</td></tr></tbody></table>
  </div>
</div>

<div class="row">
  <div class="card card-wide">
    <div class="card-title">持仓 <span id="posCount" style="font-weight:400;color:#94a3b8;margin-left:4px"></span></div>
    <table class="data-table"><thead><tr><th>交易对</th><th>方向</th><th>数量</th><th>入场价</th><th>标记价</th><th>浮动盈亏</th><th>收益率</th></tr></thead><tbody id="positionsBody"><tr><td colspan="7" class="empty-state">无持仓</td></tr></tbody></table>
  </div>
</div>

<div class="row">
  <div class="card">
    <div class="card-title">挂单</div>
    <table class="data-table"><thead><tr><th>时间</th><th>交易对</th><th>方向</th><th>数量</th><th>价格</th><th>触发价</th><th>状态</th></tr></thead><tbody id="ordersBody"><tr><td colspan="7" class="empty-state">无挂单</td></tr></tbody></table>
  </div>
  <div class="card">
    <div class="card-title">风控详情</div>
    <div class="stat-grid">
      <div class="stat-item"><div class="s-label">日亏限额</div><div class="s-value" id="dailyLoss2">$0</div></div>
      <div class="stat-item"><div class="s-label">影子仓位</div><div class="s-value" id="shadowPos">0</div></div>
      <div class="stat-item"><div class="s-label">保证金</div><div class="s-value" id="marginStatus2">N/A</div></div>
      <div class="stat-item"><div class="s-label">并发信号</div><div class="s-value" id="concurrentSignals">0</div></div>
    </div>
  </div>
</div>

<div class="row">
  <div class="card card-wide">
    <div class="card-title">交易记录</div>
    <table class="data-table"><thead><tr><th>时间</th><th>交易对</th><th>方向</th><th>数量</th><th>价格</th><th>手续费</th><th>盈亏</th><th>状态</th></tr></thead><tbody id="historyBody"></tbody></table>
  </div>
</div>

</div><!-- content -->

<script>
const evtSource = new EventSource('/api/events');
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return '刚刚';
  if (s < 60) return s + '秒前';
  if (s < 3600) return Math.floor(s / 60) + '分钟前';
  return Math.floor(s / 3600) + '小时前';
}

function fmt(n, d) { return (parseFloat(n) || 0).toFixed(d ?? 2); }
function fmtNum(n) { return (parseFloat(n) || 0).toLocaleString('en', {minimumFractionDigits:2,maximumFractionDigits:2}); }

function statusPill(s) {
  const m = { filled: 'pill-filled', cancelled: 'pill-cancel', rejected: 'pill-fail', submitted: 'pill-open', pending: 'pill-open' };
  return '<span class="pill ' + (m[s] || 'pill-open') + '">' + s + '</span>';
}

function updateSignals(signals) {
  const tbody = document.getElementById('signalsBody');
  if (!signals || signals.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">等待 AI 信号...</td></tr>';
    return;
  }
  const aMap = { long: '做多', short: '做空', close: '平仓' };
  tbody.innerHTML = signals.map(s => {
    const ok = s.accepted;
    return '<tr><td>' + timeAgo(s.timestamp) + '</td><td>' + s.symbol + '</td><td class="' + (s.action === 'long' ? 'green' : 'red') + '">' + (aMap[s.action] || s.action) + '</td><td>' + fmt(s.confidence, 0) + '%</td><td>' + s.positionSize + '</td><td>' + fmtNum(s.signalPrice) + '</td><td><span class="pill ' + (ok ? 'pill-pass' : 'pill-fail') + '">' + (ok ? '通过' : '拒绝') + '</span></td><td style="color:' + (ok ? '#059669' : '#dc2626') + '">' + (s.reason || '-') + '</td></tr>';
  }).join('');
}

evtSource.addEventListener('signals', e => updateSignals(JSON.parse(e.data)));

evtSource.addEventListener('positions', e => {
  const positions = JSON.parse(e.data);
  document.getElementById('posCount').textContent = positions.length ? '(' + positions.length + ')' : '';
  document.getElementById('posCount2').textContent = positions.length;
  const tbody = document.getElementById('positionsBody');
  if (!positions.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-state">无持仓</td></tr>'; return; }
  const m = { long: '多头', short: '空头', buy: '买入', sell: '卖出' };
  tbody.innerHTML = positions.map(p => {
    const upnl = parseFloat(p.unrealizedPnl || 0);
    const entry = parseFloat(p.entryPrice || 0);
    const sz = parseFloat(p.size || 1);
    const mark = entry + (p.side === 'long' ? upnl / sz : -upnl / sz);
    const roi = entry > 0 ? (upnl / (entry * sz)) * 100 : 0;
    return '<tr><td>' + p.symbol + '</td><td class="' + (p.side === 'long' || p.side === 'buy' ? 'green' : 'red') + '">' + (m[p.side] || p.side) + '</td><td>' + sz + '</td><td>' + fmtNum(entry) + '</td><td>' + fmtNum(mark) + '</td><td class="' + (upnl >= 0 ? 'green' : 'red') + '">' + (upnl >= 0 ? '+' : '') + fmtNum(upnl) + '</td><td class="' + (roi >= 0 ? 'green' : 'red') + '">' + (roi >= 0 ? '+' : '') + fmt(roi, 2) + '%</td></tr>';
  }).join('');
});

evtSource.addEventListener('orders', e => {
  const orders = JSON.parse(e.data);
  const tbody = document.getElementById('ordersBody');
  if (!orders.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-state">无挂单</td></tr>'; return; }
  const m = { long: '多头', short: '空头', buy: '买入', sell: '卖出' };
  tbody.innerHTML = orders.map(o => '<tr><td>' + timeAgo(o.createdAt) + '</td><td>' + o.symbol + '</td><td class="' + (o.side === 'buy' ? 'green' : 'red') + '">' + (m[o.side] || o.side) + '</td><td>' + o.size + '</td><td>' + fmtNum(o.price) + '</td><td>' + (o.stopLoss ? fmtNum(o.stopLoss) : o.takeProfit ? fmtNum(o.takeProfit) : '-') + '</td><td>' + statusPill(o.status) + '</td></tr>').join('');
});

async function loadStatic() {
  const [status, risk, history, signals] = await Promise.all([
    fetch('/api/status').then(r => r.json()),
    fetch('/api/risk').then(r => r.json()),
    fetch('/api/history').then(r => r.json()),
    fetch('/api/signals').then(r => r.json()),
  ]);

  // Header
  document.getElementById('sysUptime').textContent = Math.floor(status.uptime / 60) + ' 分钟';
  document.getElementById('sysVersion').textContent = status.version;
  document.getElementById('sysUptime2').textContent = Math.floor(status.uptime / 60) + ' 分钟';

  // Risk
  document.getElementById('dailyLoss').textContent = '$' + fmt((risk.dailyLoss || 0), 0);
  const mt = risk.margin || {};
  let msText = '日亏限额 $20';
  if (mt.status) {
    msText = mt.status === 'normal' ? '保证金正常' : mt.status === 'warning' ? '保证金警告' : '保证金危险';
    const pct = fmt((mt.marginRatio || 0) * 100, 1);
    msText += ' (' + pct + '%)';
  }
  document.getElementById('marginStatus').textContent = msText;

  // Mode badge
  const badge = document.getElementById('modeBadge');
  if (status.paperTrading) {
    badge.innerHTML = '<span class="badge badge-paper">PAPER</span>';
    try {
      const ps = await fetch('/api/paper-stats').then(r => r.json());
      document.getElementById('paperBalance').textContent = '$' + fmtNum(ps.balance || 10000);
      const pnl = ps.totalPnl || 0;
      const pnlEl = document.getElementById('paperPnl');
      pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + fmtNum(pnl);
      pnlEl.style.color = pnl >= 0 ? '#059669' : '#dc2626';
      document.getElementById('totalTrades').textContent = ps.totalTrades || 0;
      document.getElementById('winRateDisplay').textContent = ps.winRate ? fmt(ps.winRate * 100, 1) + '%' : '-';
    } catch {}
  } else {
    badge.innerHTML = '<span class="badge badge-live">实盘</span>';
  }

  // Signals
  updateSignals(signals);

  // History
  const m = { long: '多头', short: '空头', buy: '买入', sell: '卖出' };
  const hbody = document.getElementById('historyBody');
  if (history && history.length > 0) {
    hbody.innerHTML = history.map(o => '<tr><td>' + timeAgo(o.updatedAt || o.createdAt) + '</td><td>' + o.symbol + '</td><td class="' + (o.side === 'buy' ? 'green' : 'red') + '">' + (m[o.side] || o.side) + '</td><td>' + o.size + '</td><td>' + fmtNum(parseFloat(o.limitPrice || '0')) + '</td><td>' + (o.fee && o.fee !== '0' ? '$' + fmtNum(parseFloat(o.fee)) : '-') + '</td><td class="' + (parseFloat(o.pnl || 0) >= 0 ? 'green' : 'red') + '">' + (o.pnl && o.pnl !== '0' ? (parseFloat(o.pnl) >= 0 ? '+' : '') + '$' + fmtNum(parseFloat(o.pnl)) : '-') + '</td><td>' + statusPill(o.status) + '</td></tr>').join('');
  } else {
    hbody.innerHTML = '<tr><td colspan="8" class="empty-state">暂无交易记录</td></tr>';
  }
}
loadStatic();
setInterval(loadStatic, 10000);
</script>
</body>
</html>`;