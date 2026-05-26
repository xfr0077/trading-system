/**
 * Dashboard HTTP server backed by Hono.
 *
 * REST endpoints use Hono for declarative routing, CORS middleware, and auth.
 * SSE endpoint uses raw Node.js response (global broadcast pattern).
 */

import http from 'http';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getRequestListener } from '@hono/node-server';
import { SignalRouter } from './signal-router';
import { Config } from './config';

const SSE_KEEPALIVE_MS = 15000;

// ---- Rate Limiting (unchanged) ----

const rateLimitMap = new Map<string, number>();

function getRateLimitKey(ip: string): string {
  return `${ip}:${Math.floor(Date.now() / 60000)}`;
}

function checkRateLimit(ip: string, maxRpm: number): boolean {
  const key = getRateLimitKey(ip);
  const count = rateLimitMap.get(key) || 0;
  if (count >= maxRpm) return false;
  rateLimitMap.set(key, count + 1);
  return true;
}

setInterval(() => {
  const currentBucket = Math.floor(Date.now() / 60000);
  for (const key of rateLimitMap.keys()) {
    const bucket = parseInt(key.split(':').pop() || '0', 10);
    if (bucket < currentBucket - 1) rateLimitMap.delete(key);
  }
}, 120000).unref();

// ---- Main ----

export function startDashboard(
  router: SignalRouter,
  port: number,
  config?: Config,
): http.Server {
  const corsOrigins = config?.corsOrigins || ['*'];
  const dashboardToken = config?.dashboardToken;
  const rateLimitRpm = config?.rateLimitRpm || 60;

  // SSE state
  let sseId = 0;
  const sseClients = new Map<number, http.ServerResponse>();

  function broadcast(event: string, data: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [id, client] of sseClients) {
      try { client.write(msg); } catch { sseClients.delete(id); }
    }
  }

  // ---- Hono app ----

  const app = new Hono();

  app.use('*', cors({ origin: corsOrigins as any }));

  app.use('*', async (c, next) => {
    const ip = c.req.header('x-forwarded-for') || '127.0.0.1';
    if (!checkRateLimit(ip, rateLimitRpm)) {
      return c.json({ error: 'Too Many Requests' }, 429);
    }
    await next();
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/ping') return await next();
    if (dashboardToken) {
      const auth = c.req.header('authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (token !== dashboardToken) return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // ---- Routes ----

  app.get('/', (c) => c.html(DASHBOARD_HTML));

  app.get('/api/ping', (c) => {
    router.ping();
    return c.json({ ok: true, timestamp: Date.now() });
  });

  app.get('/api/status', (c) => {
    const mem = process.memoryUsage();
    return c.json({
      uptime: process.uptime(),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
      version: process.env.npm_package_version || '0.1.0',
      paperTrading: config?.paperTrading || process.env.PAPER_TRADING === 'true',
      dex: config?.dexProvider || process.env.DEX_PROVIDER || 'unknown',
    });
  });

  app.get('/api/modules', (c) => {
    const mem = process.memoryUsage();
    const lastPing = router.getLastPythonAiPing();
    const lastPingAge = lastPing !== null ? Math.floor((Date.now() - lastPing) / 1000) : null;
    let pyStatus = 'offline';
    if (lastPingAge !== null && lastPingAge < 60) pyStatus = 'online';
    else if (lastPingAge !== null && lastPingAge < 300) pyStatus = 'warning';

    const mktStatus = router.getMarketData()?.getConnectionStatus() || 'unknown';
    const margin = router.getMarginMonitor().getStatus();
    const signals = router.getSignalHistory();
    const sltp = router.getSLTPMonitor().getActiveOrders();

    return c.json({
      tsEngine: { status: 'healthy', uptime: process.uptime(), version: process.env.npm_package_version || '0.1.0', memoryRss: mem.rss, memoryHeapUsed: mem.heapUsed },
      pythonAi: { status: pyStatus, lastPingAge, symbols: router.getSymbols(), confidenceThreshold: 55, featureWindow: 100, useLegacyFeatures: false },
      marketData: { status: mktStatus, symbols: router.getSymbols() },
      dex: { provider: config?.dexProvider || process.env.DEX_PROVIDER || 'lighter', paperTrading: config?.paperTrading || process.env.PAPER_TRADING === 'true', accountIndex: process.env.LIGHTER_ACCOUNT_INDEX || '-' },
      riskEngine: {
        status: margin.status === 'critical' ? 'critical' : margin.status === 'warning' ? 'warning' : 'normal',
        dailyLoss: router.getRiskEngine().getDailyLoss(), dailyLossLimit: 20,
        marginStatus: margin.status, marginRatio: margin.marginRatio || 0,
        activeSLTP: sltp.length, totalSignals: signals.length,
        acceptedSignals: signals.filter((s: any) => s.accepted).length,
      },
    });
  });

  app.get('/api/ai', (c) => {
    const binSize = parseInt(c.req.query('binSize') || '5', 10);
    const allSignals = router.getSignalHistory();
    const dist = router.getConfidenceDistribution(binSize);
    const perSymbol: Record<string, any> = {};
    for (const sym of router.getSymbols()) {
      const symSignals = allSignals.filter((s: any) => s.symbol === sym);
      const lastSym = router.getLastSignalTimestamp(sym);
      perSymbol[sym] = { totalSignals: symSignals.length, acceptedSignals: symSignals.filter((s: any) => s.accepted).length, lastSignalAction: symSignals.length > 0 ? symSignals[0].action : null, lastSignalAgo: lastSym !== null ? Math.floor((Date.now() - lastSym) / 1000) : null };
    }
    return c.json({ signalStats: router.getSignalStats(), confidenceDistribution: dist, recentSignals: allSignals.slice(0, 50), perSymbol });
  });

  app.get('/api/risk', (c) => {
    return c.json({ shadowPositions: Object.fromEntries(router.getRiskEngine().getShadowPositions()), dailyLoss: router.getRiskEngine().getDailyLoss(), margin: router.getMarginMonitor().getStatus() });
  });

  app.get('/api/signals', (c) => c.json(router.getSignalHistory().slice(0, 100)));

  app.get('/api/positions', (c) => {
    const tracker = router.getPositionTracker();
    const positions = Array.from(tracker.getPositions().values()).map((p: any) => ({ symbol: p.symbol, side: p.side, size: p.size, entryPrice: p.entryPrice, unrealizedPnl: p.unrealizedPnl, realizedPnl: p.realizedPnl, updatedAt: p.updatedAt }));
    const openOrders = Array.from(tracker.getOpenOrders().values()).map((o: any) => ({ orderId: o.orderId, symbol: o.symbol, side: o.side, size: o.size, price: o.price, status: o.status, createdAt: o.createdAt }));
    return c.json({ positions, openOrders });
  });

  app.get('/api/trades', (c) => {
    const limit = parseInt(c.req.query('limit') || '50', 10);
    return c.json(router.getSqliteStore().getTradeHistory(undefined, limit));
  });

  app.get('/api/summary', async (c) => {
    try {
      const tradeHistory = router.getSqliteStore().getTradeHistory(undefined, 10000);
      const positions = Array.from(router.getPositionTracker().getPositions().values()) as any[];
      const allSignals = router.getSignalHistory();
      const acceptedSignals = allSignals.filter((s: any) => s.accepted).length;
      const totalTrades = tradeHistory.length;
      const profitableTrades = tradeHistory.filter((t: any) => parseFloat(t.pnl || '0') > 0).length;
      const totalPnl = tradeHistory.reduce((sum: number, t: any) => sum + parseFloat(t.pnl || '0'), 0);
      const unrealizedPnl = positions.reduce((sum: number, p: any) => sum + (p.unrealizedPnl || 0), 0);
      const todayStart = Date.now() - 24 * 60 * 60 * 1000;
      const todayTrades = tradeHistory.filter((t: any) => t.timestamp >= todayStart);
      const todayPnl = todayTrades.reduce((sum: number, t: any) => sum + parseFloat(t.pnl || '0'), 0);
      let balance = 0;
      try { const acct = await router.getDexAdapter().getAccount?.(); balance = acct?.totalBalance || 0; } catch {}
      return c.json({ totalPnl: parseFloat(totalPnl.toFixed(2)), unrealizedPnl: parseFloat(unrealizedPnl.toFixed(2)), totalPnlInclUnrealized: parseFloat((totalPnl + unrealizedPnl).toFixed(2)), todayPnl: parseFloat(todayPnl.toFixed(2)), winRate: totalTrades > 0 ? parseFloat((profitableTrades / totalTrades * 100).toFixed(1)) : 0, totalTrades, todayTrades: todayTrades.length, openPositions: positions.filter((p: any) => p.size > 0).length, balance: parseFloat(balance.toFixed(2)), signalAcceptRate: allSignals.length > 0 ? parseFloat((acceptedSignals / allSignals.length * 100).toFixed(1)) : 0, dailyLoss: router.getRiskEngine().getDailyLoss() });
    } catch (err) { return c.json({ error: String(err) }, 500); }
  });

  // ---- Raw HTTP server (Hono routes + SSE handled manually) ----

  const honoHandler = getRequestListener(app.fetch);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/events') {
      // SSE — manual
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const id = ++sseId;
      sseClients.set(id, res);
      const keepalive = setInterval(() => { try { res.write(':keepalive\n\n'); } catch { clearInterval(keepalive); } }, SSE_KEEPALIVE_MS);
      req.on('close', () => { sseClients.delete(id); clearInterval(keepalive); });
      return;
    }
    // Delegate to Hono
    honoHandler(req, res);
  });

  server.listen(port, () => {
    console.log(`[Dashboard] http://localhost:${port}`);
  });

  // ---- SSE broadcast timer ----

  const broadcastTimer = setInterval(async () => {
    const lastPing = router.getLastPythonAiPing();
    const lastPingAge = lastPing !== null ? Math.floor((Date.now() - lastPing) / 1000) : null;
    const margin = router.getMarginMonitor().getStatus();
    const signals = router.getSignalHistory();
    const sltp = router.getSLTPMonitor().getActiveOrders();

    try {
      const tradeHistory = router.getSqliteStore().getTradeHistory(undefined, 10000);
      const positions = Array.from(router.getPositionTracker().getPositions().values()) as any[];
      const totalPnl = tradeHistory.reduce((sum: number, t: any) => sum + parseFloat(t.pnl || '0'), 0);
      const unrealizedPnl = positions.reduce((sum: number, p: any) => sum + (p.unrealizedPnl || 0), 0);
      const todayStart = Date.now() - 24 * 60 * 60 * 1000;
      const todayPnl = tradeHistory.filter((t: any) => t.timestamp >= todayStart).reduce((sum: number, t: any) => sum + parseFloat(t.pnl || '0'), 0);
      const profitableTrades = tradeHistory.filter((t: any) => parseFloat(t.pnl || '0') > 0).length;
      let balance = 0;
      try { const acct = await router.getDexAdapter().getAccount?.(); balance = acct?.totalBalance || 0; } catch {}

      broadcast('summary', {
        totalPnl: parseFloat(totalPnl.toFixed(2)), unrealizedPnl: parseFloat(unrealizedPnl.toFixed(2)),
        totalPnlInclUnrealized: parseFloat((totalPnl + unrealizedPnl).toFixed(2)),
        todayPnl: parseFloat(todayPnl.toFixed(2)),
        winRate: tradeHistory.length > 0 ? parseFloat((profitableTrades / tradeHistory.length * 100).toFixed(1)) : 0,
        totalTrades: tradeHistory.length, openPositions: positions.filter((p: any) => p.size > 0).length,
        balance: parseFloat(balance.toFixed(2)), activeSLTP: sltp.length,
        marginStatus: margin.status, marginRatio: margin.marginRatio || 0,
        dailyLoss: router.getRiskEngine().getDailyLoss(),
        pyOnline: lastPingAge !== null && lastPingAge < 60,
        uptime: process.uptime(), version: process.env.npm_package_version || '0.1.0',
      });
    } catch {}

    const perSymbol: Record<string, any> = {};
    for (const sym of router.getSymbols()) {
      const symSignals = signals.filter((s: any) => s.symbol === sym);
      const lastSym = router.getLastSignalTimestamp(sym);
      perSymbol[sym] = { totalSignals: symSignals.length, acceptedSignals: symSignals.filter((s: any) => s.accepted).length, lastSignalAction: symSignals.length > 0 ? symSignals[0].action : null, lastSignalAgo: lastSym !== null ? Math.floor((Date.now() - lastSym) / 1000) : null };
    }

    broadcast('ai', { signalStats: router.getSignalStats(), confidenceDistribution: router.getConfidenceDistribution(5), recentSignals: signals.slice(0, 50), perSymbol });
  }, 5000).unref();

  return server;
}

// ---- HTML ----

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>系统监控 Dashboard</title>
<style>
:root{--bg:#1a1a2e;--bg-card:#16213e;--border:#0f3460;--text:#e0e0e0;--text-dim:#8892b0;--cyan:#00d2ff;--green:#00e676;--red:#ff6b6b;--yellow:#ffa726;--radius:8px}
html[data-theme="light"]{--bg:#f5f5f5;--bg-card:#ffffff;--border:#d0d0d0;--text:#1a1a2e;--text-dim:#888;--cyan:#0099cc;--green:#00a854;--red:#d32f2f;--yellow:#e65100}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);font-size:13px;line-height:1.5;min-height:100vh;overflow-x:hidden}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
a{color:var(--cyan);text-decoration:none}
.header{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;background:var(--bg-card);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}
.header-left{display:flex;align-items:center;gap:12px}
.header h1{font-size:16px;font-weight:700;color:var(--cyan);letter-spacing:.3px}
.version{font-size:11px;color:var(--text-dim);font-family:'SF Mono',Consolas,monospace}
.badge{font-size:9px;font-weight:700;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:.5px}
.badge-paper{background:rgba(255,167,38,.15);color:var(--yellow);border:1px solid rgba(255,167,38,.3)}
.badge-live{background:rgba(0,230,118,.12);color:var(--green);border:1px solid rgba(0,230,118,.3)}
.header-right{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--text-dim)}
.content{max-width:1400px;margin:0 auto;padding:16px 20px}
.cards-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
@media(max-width:600px){.cards-grid{grid-template-columns:1fr 1fr}}
.metric-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;transition:border-color .2s}
.metric-card:hover{border-color:var(--cyan)}
.metric-card .metric-label{font-size:10px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.metric-card .metric-value{font-size:26px;font-weight:700;font-family:'SF Mono',Consolas,monospace;margin-bottom:6px;line-height:1.2}
.metric-card .metric-sub{display:flex;gap:16px;font-size:10px;color:var(--text-dim)}
.metric-card .metric-sub span{display:inline-flex;align-items:center;gap:3px}
.metric-card .metric-sub b{font-family:'SF Mono',Consolas,monospace;color:var(--text);font-weight:600}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
.dot-green{background:var(--green);box-shadow:0 0 6px rgba(0,230,118,.4)}
.dot-yellow{background:var(--yellow);box-shadow:0 0 6px rgba(255,167,38,.4)}
.dot-red{background:var(--red);box-shadow:0 0 6px rgba(255,107,107,.4)}
.dot-cyan{background:var(--cyan);box-shadow:0 0 6px rgba(0,210,255,.4)}
.section-title{font-size:14px;font-weight:700;color:var(--text);margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.filters select{background:var(--bg-card);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:4px;font-size:11px;cursor:pointer;outline:none;min-width:100px;font-family:inherit}
.filters select:focus{border-color:var(--cyan)}
.filters select option{background:var(--bg-card);color:var(--text)}
.ai-grid{display:grid;grid-template-columns:320px 1fr;gap:10px;margin-bottom:14px}
.card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius);padding:14px}
.card h3{font-size:11px;font-weight:600;color:var(--text-dim);text-transform:uppercase;letter-spacing:.4px;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid var(--border)}
.stats-summary{display:flex;gap:14px;margin-bottom:10px}
.stats-summary .stat-box{flex:1;text-align:center;padding:8px 4px;background:rgba(255,255,255,.03);border-radius:4px}
.stats-summary .stat-box .num{font-size:18px;font-weight:700;font-family:'SF Mono',Consolas,monospace}
.stats-summary .stat-box .lbl{font-size:9px;color:var(--text-dim);margin-top:2px}
.num-cyan{color:var(--cyan)}
.num-green{color:var(--green)}
.num-red{color:var(--red)}
.stats-breakdown{font-size:11px;margin-top:8px}
.stats-breakdown .break-row{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04)}
.stats-breakdown .break-row .b-label{color:var(--text-dim)}
.stats-breakdown .break-row .b-value{font-family:'SF Mono',Consolas,monospace;font-weight:600}
.stats-scroll{max-height:180px;overflow-y:auto;margin-top:4px}
.chart-area{padding:2px 0}
.chart-row{display:flex;align-items:center;gap:6px;margin-bottom:3px;font-size:10px}
.chart-label{width:48px;text-align:right;color:var(--text-dim);flex-shrink:0;font-family:'SF Mono',Consolas,monospace;font-size:9px}
.chart-bar-wrap{flex:1;height:16px;background:rgba(255,255,255,.05);border-radius:3px;overflow:hidden;position:relative}
.chart-bar-fill{height:100%;background:rgba(255,255,255,.08);border-radius:3px;position:relative;transition:width .3s}
.chart-bar-accepted{position:absolute;left:0;top:0;height:100%;background:var(--green);border-radius:3px;transition:width .3s}
.chart-count{width:28px;text-align:right;font-family:'SF Mono',Consolas,monospace;color:var(--text)}
.chart-accepted{width:30px;text-align:right;font-family:'SF Mono',Consolas,monospace;color:var(--text-dim);font-size:9px}
.data-table{width:100%;border-collapse:collapse;font-size:11px}
.data-table th{padding:6px 8px;text-align:left;color:var(--text-dim);border-bottom:1px solid var(--border);font-weight:600;white-space:nowrap;font-size:9px;text-transform:uppercase;letter-spacing:.4px}
.data-table td{padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.04);font-family:'SF Mono',Consolas,monospace;white-space:nowrap;font-size:11px}
.data-table tbody tr:hover{background:rgba(0,210,255,.04)}
.data-table .empty-state{padding:24px;text-align:center;color:var(--text-dim);font-size:11px;font-family:inherit}
.signal-action{font-weight:600}
.action-long{color:var(--green)}
.action-short{color:var(--red)}
.action-close{color:var(--text-dim)}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}
.pos-long{color:var(--green)}.pos-short{color:var(--red)}
.trade-filled{color:var(--green)}.trade-cancelled{color:var(--text-dim)}.trade-rejected{color:var(--red)}
@media(max-width:900px){.two-col{grid-template-columns:1fr}}
.conf-bar{display:inline-block;width:50px;height:6px;background:rgba(255,255,255,.08);border-radius:3px;vertical-align:middle;margin-right:6px;position:relative;overflow:hidden}
.conf-bar-fill{height:100%;border-radius:3px;transition:width .3s}
.conf-bar-fill.high{background:var(--green)}
.conf-bar-fill.mid{background:var(--yellow)}
.conf-bar-fill.low{background:var(--red)}
.footer{text-align:center;padding:12px;font-size:10px;color:var(--text-dim);border-top:1px solid var(--border);margin-top:16px;display:flex;justify-content:center;gap:20px}
.footer span{display:inline-flex;align-items:center;gap:4px}
.conn-status{color:var(--green)}
.conn-disconnected{color:var(--red)}
.loading-pulse{animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
@media(max-width:1000px){.cards-grid{grid-template-columns:repeat(3,1fr)}.ai-grid{grid-template-columns:1fr}}
@media(max-width:600px){.cards-grid{grid-template-columns:1fr 1fr}.header{padding:10px 14px;flex-wrap:wrap}.content{padding:10px 12px}.filters select{min-width:80px;font-size:10px}}
@media(max-width:400px){.cards-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="header">
<div class="header-left"><h1>系统监控 Dashboard</h1><span class="version">v<span id="versionVal">-</span></span><span id="modeBadge"></span></div>
<div class="header-right"><span id="themeToggle" style="cursor:pointer;user-select:none" onclick="toggleTheme()">🌙 暗色</span></div>
</div>
<div class="content">
<div class="cards-grid" id="cardsGrid">
<div class="metric-card"><div class="metric-label">总盈亏</div><div class="metric-value" id="sTotalPnl" style="color:var(--text-dim)">--</div><div class="metric-sub"><span>已实现 <b id="sRealizedPnl">--</b></span><span>未实现 <b id="sUnrealizedPnl">--</b></span></div></div>
<div class="metric-card"><div class="metric-label">今日</div><div class="metric-value" id="sTodayPnl" style="color:var(--text-dim)">--</div><div class="metric-sub"><span>交易 <b id="sTodayTrades">0</b> 笔</span><span>胜率 <b id="sWinRate">--</b></span></div></div>
<div class="metric-card"><div class="metric-label">持仓</div><div class="metric-value" id="sOpenPositions" style="color:var(--cyan)">0</div><div class="metric-sub"><span>余额 <b id="sBalance">--</b></span><span>总交易 <b id="sTotalTrades">0</b> 笔</span></div></div>
<div class="metric-card"><div class="metric-label">系统</div><div class="metric-value" style="display:flex;align-items:center;gap:8px;font-size:20px"><span class="dot" id="sStatusDot"></span><span id="sStatusText">--</span></div><div class="metric-sub"><span>风控 <b id="sRiskStatus">--</b></span><span>运行 <b id="sUptime">--:--:--</b></span></div></div>
</div>
<div class="section-title">AI 分析</div>
<div class="filters">
<select id="filterSymbol"><option value="all">币种: 全部</option></select>
<select id="filterAction"><option value="all">动作: 全部</option><option value="long">long</option><option value="short">short</option><option value="close">close</option></select>
<select id="filterConfidence"><option value="all">置信度: 全部</option><option value="50">>=50%</option><option value="60">>=60%</option><option value="70">>=70%</option><option value="80">>=80%</option></select>
<select id="filterTime"><option value="all">时间: 全部</option><option value="1">最近1小时</option><option value="6">最近6小时</option><option value="24">最近24小时</option></select>
</div>
<div class="ai-grid">
<div class="card" id="signalStatsCard"><h3>信号统计</h3><div class="stats-summary" id="statsSummary"><div class="stat-box"><div class="num num-cyan" id="statTotal">0</div><div class="lbl">总数</div></div><div class="stat-box"><div class="num num-green" id="statAccepted">0</div><div class="lbl">已接受</div></div><div class="stat-box"><div class="num num-red" id="statRejected">0</div><div class="lbl">被拒绝</div></div></div><div class="stats-breakdown"><div class="break-row"><span class="b-label">按动作</span><span class="b-value" id="statsByAction">-</span></div><div class="break-row"><span class="b-label">按币种</span><span class="b-value" id="statsBySymbol">-</span></div></div></div>
<div class="card"><h3>置信度分布</h3><div class="chart-area" id="confidenceChart"><div class="loading-pulse" style="text-align:center;color:var(--text-dim);padding:20px">加载中...</div></div></div>
</div>
<div class="card" style="margin-top:10px"><h3>最近信号</h3><div style="max-height:520px;overflow-y:auto"><table class="data-table"><thead><tr><th>时间</th><th>币种</th><th>动作</th><th>置信度</th><th>接受</th><th>信号价格</th></tr></thead><tbody id="signalsBody"><tr><td colspan="6" class="empty-state">等待信号数据...</td></tr></tbody></table></div></div>
<div class="section-title" style="margin-top:16px">持仓与交易</div>
<div class="two-col">
<div class="card"><h3>当前持仓 <span style="font-weight:400;font-size:11px;color:var(--text-dim)" id="posCount"></span></h3><div style="max-height:300px;overflow-y:auto"><table class="data-table"><thead><tr><th>币种</th><th>方向</th><th>数量</th><th>开仓价</th><th>未实现盈亏</th><th>已实现盈亏</th></tr></thead><tbody id="positionsBody"><tr><td colspan="6" class="empty-state">暂无持仓</td></tr></tbody></table></div></div>
<div class="card"><h3>交易记录 <span style="font-weight:400;font-size:11px;color:var(--text-dim)" id="tradeCount"></span></h3><div style="max-height:300px;overflow-y:auto"><table class="data-table"><thead><tr><th>时间</th><th>币种</th><th>方向</th><th>数量</th><th>价格</th><th>盈亏(PnL)</th></tr></thead><tbody id="tradesBody"><tr><td colspan="6" class="empty-state">暂无交易</td></tr></tbody></table></div></div>
</div></div>
<div class="footer"><span class="conn-status" id="connStatus">已连接</span><span>刷新: <span id="refreshAgo">刚刚</span></span><span>最后更新: <span id="lastUpdateTime">--:--:--</span></span></div>
<script>
var summaryData=null,aiData=null,currentTheme=localStorage.getItem('dashboardTheme')||'dark';document.documentElement.setAttribute('data-theme',currentTheme);document.getElementById('themeToggle').textContent=currentTheme==='dark'?'🌙 暗色':'☀️ 亮色';
function toggleTheme(){currentTheme=currentTheme==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',currentTheme);localStorage.setItem('dashboardTheme',currentTheme);document.getElementById('themeToggle').textContent=currentTheme==='dark'?'🌙 暗色':'☀️ 亮色'}
var filterSymbol='all',filterAction='all',filterConfidence='all',filterTime='all',lastRefresh=Date.now();
function timeAgo(ts){var s=Math.floor((Date.now()-ts)/1000);if(s<5)return'刚刚';if(s<60)return s+'秒前';if(s<3600)return Math.floor(s/60)+'分钟前';if(s<86400)return Math.floor(s/3600)+'小时前';return Math.floor(s/86400)+'天前'}
function fmtNum(n){return(parseFloat(n)||0).toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2})}
function fmt(n,d){if(d===undefined)d=2;return(parseFloat(n)||0).toFixed(d)}
function formatUptime(sec){var h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=Math.floor(sec%60);return(h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(s<10?'0':'')+s}
function updateSummary(){if(!summaryData)return;var s=summaryData,tv=document.getElementById('sTotalPnl'),tvNum=s.totalPnlInclUnrealized||0;tv.textContent=(tvNum>=0?'+':'')+tvNum.toFixed(2);tv.style.color=tvNum>=0?'var(--green)':'var(--red)';document.getElementById('sRealizedPnl').textContent=(s.totalPnl>=0?'+':'')+s.totalPnl.toFixed(2);document.getElementById('sUnrealizedPnl').textContent=(s.unrealizedPnl>=0?'+':'')+s.unrealizedPnl.toFixed(2);var td=document.getElementById('sTodayPnl'),tdNum=s.todayPnl||0;td.textContent=(tdNum>=0?'+':'')+tdNum.toFixed(2);td.style.color=tdNum>=0?'var(--green)':'var(--red)';document.getElementById('sTodayTrades').textContent=s.todayTrades||0;document.getElementById('sWinRate').textContent=(s.winRate||0)+'%';document.getElementById('sOpenPositions').textContent=s.openPositions||0;document.getElementById('sBalance').textContent=s.balance?fmtNum(s.balance):'-';document.getElementById('sTotalTrades').textContent=s.totalTrades||0;var dot=document.getElementById('sStatusDot'),st=document.getElementById('sStatusText');dot.className=s.pyOnline?'dot dot-green':'dot dot-red';st.textContent=s.pyOnline?'AI在线':'AI离线';var rs=document.getElementById('sRiskStatus');rs.textContent=s.marginStatus==='critical'?'⚠️ 危险':s.marginStatus==='warning'?'⚠️ 警告':'正常';rs.style.color=s.marginStatus==='critical'?'var(--red)':s.marginStatus==='warning'?'var(--yellow)':'var(--green)';document.getElementById('sUptime').textContent=s.uptime?formatUptime(s.uptime):'-';document.getElementById('versionVal').textContent=s.version||'-';var badgeEl=document.getElementById('modeBadge');if(s.balance>0&&s.balance<50000){badgeEl.innerHTML='<span class="badge badge-paper">PAPER</span>'}else{badgeEl.innerHTML='<span class="badge badge-live">LIVE</span>'}}
function updateSymbolFilter(symbols){if(!symbols||symbols.length===0)return;var sel=document.getElementById('filterSymbol'),current=sel.value;sel.innerHTML='<option value="all">币种: 全部</option>';for(var i=0;i<symbols.length;i++){var opt=document.createElement('option');opt.value=symbols[i];opt.textContent=symbols[i];sel.appendChild(opt)}if(current!=='all'){var found=false;for(var j=0;j<sel.options.length;j++){if(sel.options[j].value===current){found=true;break}}sel.value=found?current:'all'}}
function getFilteredSignals(){if(!aiData||!aiData.recentSignals)return[];var sigs=aiData.recentSignals.slice();if(filterSymbol!=='all')sigs=sigs.filter(function(s){return s.symbol===filterSymbol});if(filterAction!=='all')sigs=sigs.filter(function(s){return s.action===filterAction});if(filterConfidence!=='all'){var minConf=parseInt(filterConfidence,10);sigs=sigs.filter(function(s){return s.confidence>=minConf})}if(filterTime!=='all'){var hours=parseInt(filterTime,10),cutoff=Date.now()-hours*3600000;sigs=sigs.filter(function(s){return s.timestamp>=cutoff})}return sigs}
function renderStats(signals){var total=signals.length,accepted=0,byAction={},acceptedByAction={},bySymbol={},acceptedBySymbol={};for(var i=0;i<signals.length;i++){var s=signals[i];byAction[s.action]=(byAction[s.action]||0)+1;bySymbol[s.symbol]=(bySymbol[s.symbol]||0)+1;if(s.accepted){accepted++;acceptedByAction[s.action]=(acceptedByAction[s.action]||0)+1;acceptedBySymbol[s.symbol]=(acceptedBySymbol[s.symbol]||0)+1}}var rejected=total-accepted;document.getElementById('statTotal').textContent=total;document.getElementById('statAccepted').textContent=accepted;document.getElementById('statRejected').textContent=rejected;var actionParts=[],actions=['long','short','close'];for(var a=0;a<actions.length;a++){var act=actions[a],actTotal=byAction[act]||0,actAcc=acceptedByAction[act]||0;if(actTotal>0)actionParts.push(act+' '+actTotal+' ('+actAcc+')')}document.getElementById('statsByAction').textContent=actionParts.length>0?actionParts.join(', '):'-';var symParts=[],symKeys=Object.keys(bySymbol);symKeys.sort();for(var k=0;k<symKeys.length;k++){var sym=symKeys[k],symTotal=bySymbol[sym],symAcc=acceptedBySymbol[sym]||0;symParts.push(sym+' '+symTotal+' ('+symAcc+')')}document.getElementById('statsBySymbol').textContent=symParts.length>0?symParts.join(', '):'-'}
function renderConfidenceChart(signals){var binSize=5,numBins=Math.ceil(100/binSize),bins=[];for(var i=0;i<numBins;i++)bins.push({min:i*binSize,max:Math.min((i+1)*binSize,100),count:0,accepted:0});for(var j=0;j<signals.length;j++){var s=signals[j],idx=Math.min(Math.floor(s.confidence/binSize),numBins-1);bins[idx].count++;if(s.accepted)bins[idx].accepted++}var maxCount=1;for(var b=0;b<bins.length;b++){if(bins[b].count>maxCount)maxCount=bins[b].count}var html='';for(var c=0;c<bins.length;c++){var bin=bins[c],pct=(bin.count/maxCount)*100,acceptPct=bin.count>0?(bin.accepted/bin.count)*100:0;html+='<div class="chart-row"><span class="chart-label">'+bin.min+'-'+bin.max+'</span><div class="chart-bar-wrap"><div class="chart-bar-fill" style="width:'+pct.toFixed(1)+'%"><div class="chart-bar-accepted" style="width:'+acceptPct.toFixed(1)+'%"></div></div></div><span class="chart-count">'+bin.count+'</span><span class="chart-accepted">['+bin.accepted+']</span></div>'}document.getElementById('confidenceChart').innerHTML=html}
function renderSignalsTable(signals){var tbody=document.getElementById('signalsBody');if(!signals||signals.length===0){tbody.innerHTML='<tr><td colspan="6" class="empty-state">无匹配信号</td></tr>';return}var aMap={long:'做多',short:'做空',close:'平仓'};tbody.innerHTML='';for(var i=0;i<signals.length;i++){var s=signals[i],tr=document.createElement('tr'),td1=document.createElement('td');td1.textContent=timeAgo(s.timestamp);tr.appendChild(td1);var td2=document.createElement('td');td2.textContent=s.symbol;tr.appendChild(td2);var actionClass=s.action==='long'?'action-long':s.action==='short'?'action-short':'action-close',td3=document.createElement('td');td3.className='signal-action '+actionClass;td3.textContent=aMap[s.action]||s.action;tr.appendChild(td3);var confInt=Math.round(s.confidence),confClass=confInt>=70?'high':confInt>=50?'mid':'low',td4=document.createElement('td'),confBar=document.createElement('div');confBar.className='conf-bar';var confFill=document.createElement('div');confFill.className='conf-bar-fill '+confClass;confFill.style.width=confInt+'%';confBar.appendChild(confFill);td4.appendChild(confBar);td4.appendChild(document.createTextNode(confInt+'%'));tr.appendChild(td4);var td5=document.createElement('td');td5.textContent=s.accepted?'✅':'❌';tr.appendChild(td5);var td6=document.createElement('td');td6.textContent=s.signalPrice?fmtNum(s.signalPrice):'-';tr.appendChild(td6);tbody.appendChild(tr)}}
function fetchPositionsAndTrades(){fetch('/api/positions').then(function(r){return r.json()}).then(function(d){var pos=d.positions||[],tbody=document.getElementById('positionsBody');document.getElementById('posCount').textContent='('+pos.length+')';if(pos.length===0){tbody.innerHTML='<tr><td colspan="6" class="empty-state">暂无持仓</td></tr>'}else{tbody.innerHTML='';for(var i=0;i<pos.length;i++){var p=pos[i],tr=document.createElement('tr'),pnlCls=p.realizedPnl>=0?'pos-long':'pos-short';tr.innerHTML='<td>'+p.symbol+'</td><td class="pos-'+p.side+'">'+p.side+'</td><td>'+p.size+'</td><td>'+fmtNum(p.entryPrice)+'</td><td>'+(p.unrealizedPnl?fmt(p.unrealizedPnl,4):'0')+'</td><td class="'+pnlCls+'">'+fmt(p.realizedPnl,4)+'</td>';tbody.appendChild(tr)}}}).catch(function(){});fetch('/api/trades?limit=20').then(function(r){return r.json()}).then(function(d){var trades=d||[],tbody=document.getElementById('tradesBody');document.getElementById('tradeCount').textContent='('+trades.length+')';if(trades.length===0){tbody.innerHTML='<tr><td colspan="6" class="empty-state">暂无交易记录</td></tr>'}else{tbody.innerHTML='';for(var i=0;i<trades.length;i++){var t=trades[i],tr=document.createElement('tr'),pnlVal=parseFloat(t.pnl||'0'),pnlCls=pnlVal>=0?'pos-long':'pos-short';tr.innerHTML='<td>'+timeAgo(t.timestamp)+'</td><td>'+t.symbol+'</td><td>'+t.side+'</td><td>'+t.size+'</td><td>'+fmtNum(parseFloat(t.price))+'</td><td class="'+pnlCls+'">'+fmt(pnlVal,4)+'</td>';tbody.appendChild(tr)}}}).catch(function(){})}
function renderAI(){if(!aiData)return;var signals=getFilteredSignals();renderStats(signals);renderConfidenceChart(signals);renderSignalsTable(signals)}
function updateFooter(){var now=new Date(),h=now.getHours(),mi=now.getMinutes(),s=now.getSeconds();document.getElementById('lastUpdateTime').textContent=(h<10?'0':'')+h+':'+(mi<10?'0':'')+mi+':'+(s<10?'0':'')+s}
function updateRefreshAgo(){document.getElementById('refreshAgo').textContent=timeAgo(lastRefresh)}
function setupFilters(){var ids=['filterSymbol','filterAction','filterConfidence','filterTime'];for(var i=0;i<ids.length;i++){var el=document.getElementById(ids[i]);if(el){el.addEventListener('change',function(){filterSymbol=document.getElementById('filterSymbol').value;filterAction=document.getElementById('filterAction').value;filterConfidence=document.getElementById('filterConfidence').value;filterTime=document.getElementById('filterTime').value;renderAI()})}}}
document.addEventListener('DOMContentLoaded',function(){setupFilters();Promise.all([fetch('/api/summary').then(function(r){return r.json()}),fetch('/api/ai').then(function(r){return r.json()})]).then(function(results){summaryData=results[0];aiData=results[1];lastRefresh=Date.now();updateSummary();updateSymbolFilter(null);renderAI();fetchPositionsAndTrades();updateFooter();updateRefreshAgo()})['catch'](function(err){console.error('Initial load failed',err)})});
var connStatus=document.getElementById('connStatus'),evtSource=new EventSource('/api/events');
evtSource.onerror=function(){if(connStatus){connStatus.textContent='断开连接';connStatus.className='conn-status conn-disconnected'}};
evtSource.addEventListener('summary',function(e){try{summaryData=JSON.parse(e.data)}catch(err){console.error('Invalid summary event data',err);return}lastRefresh=Date.now();updateSummary();updateSymbolFilter(null);updateFooter();updateRefreshAgo();if(connStatus){connStatus.textContent='已连接';connStatus.className='conn-status'}fetchPositionsAndTrades()});
evtSource.addEventListener('ai',function(e){try{aiData=JSON.parse(e.data)}catch(err){console.error('Invalid ai event data',err);return}lastRefresh=Date.now();renderAI();updateFooter();updateRefreshAgo();if(connStatus){connStatus.textContent='已连接';connStatus.className='conn-status'}});
window.addEventListener('beforeunload',function(){evtSource.close()});
setInterval(function(){updateRefreshAgo()},10000);
</script>
</body></html>`;
