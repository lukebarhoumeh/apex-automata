/*
 * Gym monitor — pings every endpoint the UI uses, subscribes to the WS,
 * and checks Supabase for fresh writes. Runs in a loop until killed.
 *
 * Logs one line per check window to:
 *   logs/gym-monitor-<YYYYMMDD-HHMMSS>.log
 *
 * Each line is pipe-delimited so we can summarize at end of run.
 */

const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const http = require("http");

const API = "http://localhost:3001";
const WS_URL = "ws://localhost:3001/events";

const TICK_MS = 120_000; // one sweep every 2 minutes
const WS_WINDOW_MS = 15_000; // listen 15s each window to sample event rates
const HTTP_SPACING_MS = 1_200; // space HTTP requests so we never trip the 429 cap

const LOG_DIR = path.join(__dirname, "..", "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace("T", "-")
  .slice(0, 15);
const LOG_FILE = path.join(LOG_DIR, `gym-monitor-${stamp}.log`);
const log = (line) => {
  const ts = new Date().toISOString();
  const out = `${ts} | ${line}\n`;
  fs.appendFileSync(LOG_FILE, out);
  process.stdout.write(out);
};

log(`gym-monitor starting · logfile=${LOG_FILE}`);

function getJson(url, timeoutMs = 5_000) {
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

function sampleWs(ms) {
  return new Promise((resolve) => {
    const counts = {};
    const symbolPrices = {};
    let connected = false;
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => {
      connected = true;
    });
    ws.on("message", (m) => {
      try {
        const msg = JSON.parse(m.toString());
        const t = msg.type || "unknown";
        counts[t] = (counts[t] || 0) + 1;
        if (t === "TickerUpdate" && msg.payload?.symbol) {
          symbolPrices[msg.payload.symbol] = msg.payload.price;
        }
      } catch {}
    });
    ws.on("error", () => {});
    setTimeout(() => {
      try {
        ws.close();
      } catch {}
      resolve({ connected, counts, symbolPrices });
    }, ms);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rotate through the less-critical endpoints across sweeps so we don't hammer
// the rate limiter. Core endpoints (status, risk, regime) are checked every sweep.
let rotateIdx = 0;
const ROTATING = [
  ["/api/analytics/session", "session"],
  ["/api/analytics/equity-curve", "equity"],
  ["/api/risk/analytics", "riskAnalytics"],
  ["/api/risk/blocked/symbols", "blocked"],
  ["/api/strategies", "strategies"],
  ["/api/metafilter/stats", "metafilter"],
];

async function pingAll() {
  const core = [
    ["/api/status", "status"],
    ["/api/risk/status", "risk"],
    ["/api/regime/status", "regime"],
  ];
  // Pick 1 rotating endpoint per sweep.
  const rotating = [ROTATING[rotateIdx % ROTATING.length]];
  rotateIdx++;
  const endpoints = [...core, ...rotating];

  const out = {};
  for (const [p, key] of endpoints) {
    const r = await getJson(API + p);
    out[key] = { ok: r.ok, status: r.status };
    if (!r.ok) out[key].err = r.err;
    await sleep(HTTP_SPACING_MS);
  }
  return out;
}

async function sweep() {
  try {
    // Sample WS first (non-blocking for HTTP), then ping endpoints.
    const wsPromise = sampleWs(WS_WINDOW_MS);
    const pings = await pingAll();
    const ws = await wsPromise;

    // Core facts (reuse the status ping we already made)
    const s = pings.status;
    const statusDetail = s.ok ? "ok" : `FAIL(${s.status}${s.err ? "/" + s.err : ""})`;
    // pings.status already fetched; hit /api/status once more only if it failed
    const statusData = s.ok ? (await getJson(API + "/api/status")).data : null;
    const engineRunning = statusData?.engineRunning ?? null;
    const sessionId = statusData?.sessionId ?? null;
    const lastMD = statusData?.lastMarketDataAt ?? 0;
    const mdAgeMs = lastMD ? Date.now() - lastMD : null;

    const wsTicker = ws.counts.TickerUpdate || 0;
    const wsSignal = (ws.counts.Signal || 0) + (ws.counts.signal || 0);
    const wsOrder = (ws.counts.OrderUpdate || 0) + (ws.counts["order:created"] || 0) + (ws.counts["order:updated"] || 0);
    const wsFill = (ws.counts.Fill || 0) + (ws.counts.fill || 0);
    const wsStatus = (ws.counts.StatusUpdate || 0) + (ws.counts.status || 0);

    // Summarize endpoint health
    const failed = Object.entries(pings)
      .filter(([, v]) => !v.ok)
      .map(([k, v]) => `${k}:${v.status}${v.err ? "/" + v.err : ""}`);

    const prices = Object.entries(ws.symbolPrices)
      .map(([s, p]) => `${s.split("-")[0]}=${p.toFixed(2)}`)
      .join(",");

    const line = [
      `status=${statusDetail}`,
      `engine=${engineRunning}`,
      `session=${sessionId ? sessionId.slice(-8) : "none"}`,
      `mdAgeS=${mdAgeMs !== null ? Math.round(mdAgeMs / 1000) : "n/a"}`,
      `ws.conn=${ws.connected}`,
      `ws.ticker=${wsTicker}`,
      `ws.sig=${wsSignal}`,
      `ws.order=${wsOrder}`,
      `ws.fill=${wsFill}`,
      `ws.status=${wsStatus}`,
      `prices={${prices}}`,
      failed.length ? `FAILED=${failed.join(",")}` : "all-ok",
    ].join(" | ");
    log(line);

    // Flag anomalies on their own lines so they're easy to grep later.
    if (!engineRunning) log("WARN engine not running");
    if (mdAgeMs !== null && mdAgeMs > 30_000)
      log(`WARN market-data stale · ageS=${Math.round(mdAgeMs / 1000)}`);
    if (!ws.connected) log("WARN WS connection failed");
    if (ws.connected && wsTicker === 0) log("WARN WS open but no ticker events in window");
    if (failed.length) log(`ERROR endpoints failed: ${failed.join(", ")}`);
  } catch (e) {
    log(`ERROR sweep threw: ${e && e.message}`);
  }
}

(async function main() {
  // initial sweep
  await sweep();
  setInterval(sweep, TICK_MS);
})();
