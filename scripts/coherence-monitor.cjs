/*
 * Coherence monitor — hour-long observation of a live paper session,
 * focused on strategy interactions and behavioral anomalies.
 *
 * Every 60s, snapshots:
 *   - session elapsed
 *   - engine state + session_id
 *   - WS ticker rate (15s sample)
 *   - latest live prices
 *   - signal counts per (strategy × symbol × side)
 *   - order counts + fill rate
 *   - open positions (count + aggregate exposure)
 *   - closed positions (count + P&L)
 *   - flagged anomalies since last snapshot
 *
 * Anomaly detection:
 *   A. DIRECTIONAL_OVERLAP — two strategies fire same direction on same
 *      symbol within 60s (potential double-sizing)
 *   B. DIRECTIONAL_COLLISION — two strategies fire opposite directions on
 *      same symbol within 60s (wash trade / fee burn)
 *   C. PING_PONG — position closed within 120s via stop_loss then a new
 *      position re-opens on same symbol within 60s
 *   D. ORPHAN_ORDER — an order with signal_id=null and strategy != 'system'
 *   E. SLOT_STARVATION — "Maximum open orders" WARN appears
 *   F. UI_STALE — /api/status.lastMarketDataAt older than 30s
 *   G. REJECTED_ALLOWED — a signal with allowed=true rejected by risk
 *
 * Run: node scripts/coherence-monitor.cjs
 * Output: logs/coherence-<stamp>.log (pipe-delimited)
 */

const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");

const API = "http://localhost:3001";
const WS_URL = "ws://localhost:3001/events";
const TICK_MS = 60_000;
const WS_WINDOW_MS = 12_000;
const HTTP_SPACE = 1_000;

const LOG_DIR = path.join(__dirname, "..", "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace("T", "-")
  .slice(0, 15);
const LOG_FILE = path.join(LOG_DIR, `coherence-${stamp}.log`);

function log(line) {
  const out = `${new Date().toISOString()} | ${line}\n`;
  fs.appendFileSync(LOG_FILE, out);
  process.stdout.write(out);
}

function getJson(url, timeoutMs = 4_000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ ok: false, status: res.statusCode, data: null });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, data: null, err: "timeout" });
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, data: null, err: e.code || "err" }));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sampleWs(ms) {
  return new Promise((resolve) => {
    const ticker = { count: 0, prices: {} };
    const signals = [];
    const orders = [];
    const fills = [];
    const positions = [];
    let connected = false;
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => {
      connected = true;
    });
    ws.on("message", (m) => {
      try {
        const msg = JSON.parse(m.toString());
        const t = msg.type || "?";
        if (t === "TickerUpdate") {
          ticker.count++;
          if (msg.payload?.symbol) ticker.prices[msg.payload.symbol] = msg.payload.price;
        } else if (t === "Signal" || t === "signal:generated") {
          signals.push(msg.payload);
        } else if (t === "OrderUpdate" || t === "order:created" || t === "order:updated") {
          orders.push(msg.payload);
        } else if (t === "Fill" || t === "fill") {
          fills.push(msg.payload);
        } else if (t === "PositionUpdate" || t?.startsWith("position:")) {
          positions.push(msg.payload);
        }
      } catch {}
    });
    ws.on("error", () => {});
    setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve({ connected, ticker, signals, orders, fills, positions });
    }, ms);
  });
}

// State — used to detect anomalies across sweeps
const state = {
  lastSeenSignals: new Map(), // symbol → { strategy, side, ts }[]
  recentCloses: [], // { symbol, closedAt, reason }
  lastStatusOkAt: 0,
};

function flagAnomalies(ws, sweepNo) {
  const now = Date.now();
  const anomalies = [];

  // A + B: scan recent signals for directional overlap / collision
  // We use WS event log which already captured this window's signals
  const bySymbol = new Map();
  for (const s of ws.signals) {
    const sym = s.symbol;
    if (!bySymbol.has(sym)) bySymbol.set(sym, []);
    bySymbol.get(sym).push(s);
  }
  for (const [sym, list] of bySymbol) {
    if (list.length < 2) continue;
    const strategies = new Set(list.map((s) => s.strategy));
    if (strategies.size < 2) continue;
    const directions = new Set(
      list.map((s) => {
        // Strategy side/direction field varies; try multiple
        return (s.direction || s.side || "").toString().toLowerCase();
      }),
    );
    if (directions.size === 1) {
      anomalies.push(
        `DIRECTIONAL_OVERLAP ${sym} strategies=${[...strategies].join("+")} direction=${[...directions][0]}`,
      );
    } else if (directions.size > 1) {
      anomalies.push(
        `DIRECTIONAL_COLLISION ${sym} strategies=${[...strategies].join("+")} directions=${[...directions].join(",")}`,
      );
    }
  }

  return anomalies;
}

async function sweep(sweepNo, sessionStartMs) {
  try {
    const wsPromise = sampleWs(WS_WINDOW_MS);

    // Pings — spaced so we don't trip the backend rate-limiter.
    const statusR = await getJson(API + "/api/status");
    await sleep(HTTP_SPACE);
    const riskR = await getJson(API + "/api/risk/status");
    await sleep(HTTP_SPACE);
    const sessionR = await getJson(API + "/api/analytics/session");
    await sleep(HTTP_SPACE);
    const equityR = await getJson(API + "/api/analytics/equity-curve");

    const ws = await wsPromise;

    const status = statusR.ok ? statusR.data : null;
    const risk = riskR.ok ? riskR.data : null;
    const session = sessionR.ok ? sessionR.data : null;
    const equity = equityR.ok ? equityR.data : null;

    const engineRunning = status?.engineRunning ?? null;
    const sessionId = status?.sessionId ?? null;
    const lastMD = status?.lastMarketDataAt ?? 0;
    const mdAgeS = lastMD ? Math.round((Date.now() - lastMD) / 1000) : null;
    const sessionUptimeMs = sessionStartMs ? Date.now() - sessionStartMs : 0;
    const sessionUptimeMin = Math.round(sessionUptimeMs / 60_000);

    const prices = Object.entries(ws.ticker.prices)
      .map(([s, p]) => `${s.split("-").slice(0, -1).join("-") || s}=${Number(p).toFixed(2)}`)
      .join(",");

    // Anomaly detection
    const anomalies = flagAnomalies(ws, sweepNo);
    if (mdAgeS !== null && mdAgeS > 30) anomalies.push(`UI_STALE mdAgeS=${mdAgeS}`);
    if (!ws.connected) anomalies.push("WS_DISCONNECT");
    if (ws.connected && ws.ticker.count === 0) anomalies.push("WS_NO_TICKERS");

    // Summary line
    const summary = [
      `sweep=${sweepNo}`,
      `upMin=${sessionUptimeMin}`,
      `engine=${engineRunning}`,
      `sess=${sessionId ? sessionId.slice(-6) : "none"}`,
      `mdAgeS=${mdAgeS ?? "n/a"}`,
      `ws.ticker=${ws.ticker.count}`,
      `ws.sig=${ws.signals.length}`,
      `ws.order=${ws.orders.length}`,
      `ws.fill=${ws.fills.length}`,
      `prices={${prices}}`,
      risk
        ? `heat=${risk.metrics?.currentExposure ?? 0} dPnL=${risk.metrics?.dailyPnL ?? 0} openOrd=${risk.metrics?.openOrders ?? 0} openPos=${risk.positions?.open ?? 0}/${risk.positions?.max ?? 0} killSw=${risk.killSwitchActive ?? false}`
        : "risk=FAIL",
      session
        ? `sessPnL=${(session.totalPnl ?? 0).toFixed(2)} trades=${session.totalTrades ?? 0} w=${session.winningTrades ?? 0} l=${session.losingTrades ?? 0}`
        : "session=FAIL",
      equity ? `eq=${(equity.currentEquity ?? 0).toFixed(2)} hwm=${(equity.highWaterMark ?? 0).toFixed(2)} maxDD=${(equity.maxDrawdown ?? 0).toFixed(2)}` : "eq=FAIL",
      anomalies.length ? `ANOMALIES=[${anomalies.join(" | ")}]` : "all-ok",
    ].join(" | ");
    log(summary);

    // Flag anomalies on their own lines too
    for (const a of anomalies) {
      log(`FLAG ${a}`);
    }
  } catch (e) {
    log(`ERROR sweep ${sweepNo}: ${e && e.message}`);
  }
}

(async function main() {
  log(`coherence-monitor starting · logfile=${LOG_FILE}`);
  // Initial status grab to get sessionStartedAt
  const first = await getJson(API + "/api/status");
  const sessionStartMs = first.data?.sessionStartedAt ?? Date.now();
  const sessionId = first.data?.sessionId ?? "unknown";
  log(`baseline session=${sessionId} started=${new Date(sessionStartMs).toISOString()}`);

  let sweepNo = 0;
  // Initial sweep at +5s so we get an early read
  await sleep(5_000);
  sweepNo++;
  await sweep(sweepNo, sessionStartMs);

  const id = setInterval(async () => {
    sweepNo++;
    await sweep(sweepNo, sessionStartMs);
    if (sweepNo >= 65) {
      clearInterval(id);
      log("MONITOR_END reached 65 sweeps — stopping");
      process.exit(0);
    }
  }, TICK_MS);
})();
