/**
 * Footer health chips derived from real runtime state (TASK_016 U5).
 *
 * Inputs are the GET /api/status snapshot (merged with the WS StatusUpdate
 * stream), the frontend connectivity state machine and the meta-filter
 * status. Nothing here is hard-coded green: an unknown value renders as
 * "—" / idle rather than a plausible-looking number.
 */

import type { RuntimeConnectivity } from "@/runtime/connectivity/types";
import type { RuntimeStatus } from "@/services/runtimeClient";

export type ChipStatus = "ok" | "warn" | "down" | "idle";

export interface FooterChip {
  key: "md" | "broker" | "meta";
  label: string;
  suffix: string;
  status: ChipStatus;
  title: string;
}

export interface FooterChipInputs {
  status: RuntimeStatus | null | undefined;
  connectivity: RuntimeConnectivity;
  /** null → engine stopped / unknown. */
  metaFilterEnabled: boolean | null | undefined;
  /** Local clock (ms) — injected for deterministic tests. */
  now: number;
}

/** Market data older than this while the engine runs is flagged. */
export const MARKET_DATA_STALE_MS = 30_000;

const TRANSPORT_DOWN: ReadonlySet<RuntimeConnectivity["state"]> = new Set(["DISCONNECTED", "BACKEND_DOWN"]);

function ms(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? `${Math.round(value)}ms` : null;
}

function marketDataChip(i: FooterChipInputs): FooterChip {
  const base = { key: "md" as const, label: "MD_STREAM" };
  if (TRANSPORT_DOWN.has(i.connectivity.state)) {
    return { ...base, suffix: "NO LINK", status: "down", title: "Frontend has no WebSocket link to the runtime" };
  }
  if (i.connectivity.state === "STALE") {
    const age = Math.round(i.connectivity.ageMs / 1000);
    return { ...base, suffix: `STALE ${age}s`, status: "warn", title: `No runtime heartbeat for ${age}s` };
  }
  if (!i.status) {
    return { ...base, suffix: "—", status: "idle", title: "Waiting for /api/status" };
  }
  if (!i.status.engineRunning) {
    return { ...base, suffix: "OFF", status: "idle", title: "Engine stopped — no exchange market-data subscription" };
  }
  const ws = i.status.ws;
  if (ws && ws.connected === false) {
    return { ...base, suffix: "EXCH WS DOWN", status: "down", title: "Exchange WebSocket disconnected (reconnecting)" };
  }
  if (ws?.isStalled) {
    return { ...base, suffix: "STALLED", status: "warn", title: "Exchange WebSocket open but no messages" };
  }
  const lastMd = i.status.lastMarketDataAt;
  if (typeof lastMd === "number" && lastMd > 0) {
    const age = i.now - lastMd;
    if (age > MARKET_DATA_STALE_MS) {
      return { ...base, suffix: `${Math.round(age / 1000)}s AGO`, status: "warn", title: "Last market data tick is stale" };
    }
  }
  const latency = ms(i.status.wsLatencyMs);
  return {
    ...base,
    suffix: latency ?? "LIVE",
    status: "ok",
    title: latency ? "Exchange WebSocket message latency (runtime-measured)" : "Exchange WebSocket streaming; latency not yet measured",
  };
}

function brokerChip(i: FooterChipInputs): FooterChip {
  const base = { key: "broker" as const, label: "BROKER" };
  if (TRANSPORT_DOWN.has(i.connectivity.state)) {
    return { ...base, suffix: "—", status: "down", title: "Runtime unreachable — broker health unknown" };
  }
  if (!i.status) {
    return { ...base, suffix: "—", status: "idle", title: "Waiting for /api/status" };
  }
  if (!i.status.engineRunning) {
    return { ...base, suffix: "OFF", status: "idle", title: "Engine stopped — no exchange adapter attached" };
  }
  const rest = i.status.rest;
  const exchange = i.status.exchangeHealth;
  if (rest?.circuitOpen) {
    return { ...base, suffix: "CIRCUIT OPEN", status: "down", title: "Exchange REST circuit breaker open" };
  }
  if (rest?.rateLimited) {
    return { ...base, suffix: "RATE LIMITED", status: "warn", title: "Exchange REST rate limited" };
  }
  if (rest?.degraded || exchange?.degraded) {
    const reasons = [...(rest?.degradedReasons ?? []), ...(exchange?.degradedReasons ?? [])];
    return { ...base, suffix: "DEGRADED", status: "warn", title: reasons.length ? reasons.join(", ") : "Exchange adapter degraded" };
  }
  const latency = ms(i.status.restLatencyMs);
  return {
    ...base,
    suffix: latency ?? "OK",
    status: "ok",
    title: latency ? "Exchange REST latency (runtime-measured)" : "Exchange REST healthy; latency not yet measured",
  };
}

function metaFilterChip(i: FooterChipInputs): FooterChip {
  // Rule-based gate (cold-streak, time-of-day, ATR/strength/volume). There is
  // no ML model in this codebase, so the chip is labelled as a filter.
  const base = { key: "meta" as const, label: "META_FILTER" };
  if (TRANSPORT_DOWN.has(i.connectivity.state)) {
    return { ...base, suffix: "—", status: "down", title: "Runtime unreachable" };
  }
  if (!i.status?.engineRunning) {
    return { ...base, suffix: "OFF", status: "idle", title: "Engine stopped — signal processor not running" };
  }
  if (i.metaFilterEnabled === true) {
    return { ...base, suffix: "RULES", status: "ok", title: "Rule-based meta-filter gating signals (no ML model loaded)" };
  }
  if (i.metaFilterEnabled === false) {
    return { ...base, suffix: "BYPASSED", status: "warn", title: "Meta-filter disabled — signals are not quality-gated" };
  }
  return { ...base, suffix: "—", status: "idle", title: "Meta-filter status not reported yet" };
}

export function deriveFooterChips(inputs: FooterChipInputs): FooterChip[] {
  return [marketDataChip(inputs), brokerChip(inputs), metaFilterChip(inputs)];
}

/** Right-hand footer text: session identity + status freshness. */
export function deriveFooterSessionText(
  status: RuntimeStatus | null | undefined,
  connectivity: RuntimeConnectivity,
  now: number,
): string {
  if (TRANSPORT_DOWN.has(connectivity.state)) return "runtime unreachable";
  if (!status) return "awaiting runtime status";
  const parts: string[] = [];
  if (status.engineRunning) {
    parts.push((status.mode ?? "unknown mode").toUpperCase());
    parts.push(status.sessionId ? `session …${status.sessionId.slice(-6)}` : "session id pending");
  } else {
    parts.push("no active session");
  }
  if (typeof status.timestamp === "number" && status.timestamp > 0) {
    parts.push(`status ${Math.max(0, Math.round((now - status.timestamp) / 1000))}s ago`);
  }
  return parts.join(" · ");
}
