/**
 * Static UI-preview mode (`VITE_UI_PREVIEW=1`).
 *
 * Serves a shareable frontend without talking to the live runtime, Coinbase,
 * or the production Supabase project. Paper-SoT pages render the honest
 * idle/stopped terminal (no fabricated trades, P&L, or fills). Strategy
 * cards come from the same guardrails policy the desk actually runs.
 *
 * Never enable this flag in a paper/live trading build.
 */

export const UI_PREVIEW_BANNER =
  "UI preview — static shell, no live runtime, no trading keys. Not a paper session.";

/**
 * True when the bundle was built (or Vite-served) with `VITE_UI_PREVIEW=1`.
 */
export function isUiPreview(): boolean {
  return import.meta.env.VITE_UI_PREVIEW === "1" || import.meta.env.VITE_UI_PREVIEW === "true";
}

/** Stopped-engine `/api/status` payload. No session, no P&L snapshot. */
export const PREVIEW_RUNTIME_STATUS = {
  engineRunning: false,
  mode: null,
  sessionId: null,
  sessionStartedAt: null,
  paused: false,
  dailyStopHit: false,
  killSwitch: { active: false, reasons: [] as string[] },
  wsLatencyMs: 0,
  restLatencyMs: 0,
  spreadPctile: 0,
  regime: "chop" as const,
  engineState: "stopped",
  activeSymbols: [] as string[],
  candlesBuffered: {} as Record<string, number>,
  pnl: null,
  ws: null,
  rest: null,
  exchangeHealth: null,
};

/**
 * Guardrails policy mirror for the preview (must match
 * `atlas/config/guardrails.yaml` `disabled_strategies`).
 */
export const PREVIEW_STRATEGY_POLICY = {
  source: "atlas/config/guardrails.yaml",
  disabledStrategies: ["vwap_mr", "breakout", "momentum"],
  perSymbolDisabledStrategies: {} as Record<string, readonly string[]>,
  strategies: [
    {
      id: "trend_follow",
      name: "Trend Follow",
      description: "EMA crossover + MTF alignment",
      category: "trend",
      disabledByGuardrails: false,
    },
    {
      id: "momentum",
      name: "Momentum",
      description: "RSI/MACD momentum",
      category: "momentum",
      disabledByGuardrails: true,
    },
    {
      id: "vwap_mr",
      name: "VWAP Mean Reversion",
      description: "VWAP mean reversion",
      category: "mean-reversion",
      disabledByGuardrails: true,
    },
    {
      id: "breakout",
      name: "Breakout",
      description: "Donchian breakout",
      category: "trend",
      disabledByGuardrails: true,
    },
  ],
};

export type PreviewFetchResult = { status: number; body: unknown };

/**
 * Pathname of a Request URL, including relative `/api/...` strings.
 */
export function previewRequestPath(url: string): string {
  try {
    return new URL(url, "http://preview.local").pathname;
  } catch {
    const q = url.indexOf("?");
    return q >= 0 ? url.slice(0, q) : url;
  }
}

/**
 * Decide whether a fetch should be answered locally in UI-preview mode.
 * Returns `null` when the request should hit the network (fonts, etc.).
 *
 * @param url - Absolute or relative request URL
 * @param method - HTTP method (defaults to GET)
 */
export function resolvePreviewFetch(url: string, method = "GET"): PreviewFetchResult | null {
  const verb = method.toUpperCase();
  const path = previewRequestPath(url);
  const isApi = path === "/health" || path.startsWith("/api/") || /:3001(?:\/|$)/.test(url);
  const isSupabaseRest = path.includes("/rest/v1/") || url.includes("preview.invalid");

  if (!isApi && !isSupabaseRest) return null;

  if (isSupabaseRest) {
    return { status: 200, body: [] };
  }

  if (verb !== "GET" && verb !== "HEAD" && verb !== "OPTIONS") {
    return {
      status: 403,
      body: { error: "UI preview — engine is not connected" },
    };
  }

  if (path === "/health" || path === "/api/health") {
    return { status: 200, body: { ok: true, preview: true } };
  }
  if (path === "/api/status") {
    return { status: 200, body: PREVIEW_RUNTIME_STATUS };
  }
  if (path === "/api/strategies/policy") {
    return { status: 200, body: PREVIEW_STRATEGY_POLICY };
  }
  if (path === "/api/strategies") {
    return { status: 200, body: { strategies: [] } };
  }
  if (path === "/api/metafilter/stats") {
    return { status: 200, body: { enabled: false } };
  }
  if (path === "/api/regime/status") {
    return { status: 200, body: { regimes: {} } };
  }
  // Engine-not-running empties (same codes the real API uses).
  if (path === "/api/pnl") return { status: 503, body: { error: "engine not running" } };
  if (path.startsWith("/api/analytics/") || path.startsWith("/api/risk/")) {
    return { status: 400, body: { error: "engine not running" } };
  }

  return { status: 404, body: { error: "UI preview — unknown endpoint" } };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Install a window.fetch interceptor that answers runtime + Supabase REST
 * calls from {@link resolvePreviewFetch}. No-op when preview is off.
 */
export function installUiPreviewFetch(): void {
  if (!isUiPreview()) return;
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  if ((window as Window & { __apexUiPreviewFetch?: boolean }).__apexUiPreviewFetch) return;

  const orig = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (typeof input === "object" && !(input instanceof URL) ? input.method : "GET");
    const preview = resolvePreviewFetch(url, method || "GET");
    if (preview) return Promise.resolve(jsonResponse(preview.status, preview.body));
    return orig(input, init);
  };
  (window as Window & { __apexUiPreviewFetch?: boolean }).__apexUiPreviewFetch = true;
}
