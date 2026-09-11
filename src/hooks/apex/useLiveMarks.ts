import { useEffect, useRef, useState } from "react";
import { useRuntimeWs } from "@/runtime/ws";
import type { PositionPayload, StatusPayload, TickerPayload } from "@/runtime/ws/types";

export type MarkSource = "ticker" | "engine";

export interface LiveMark {
  price: number;
  /** Local receipt time (ms). Used for staleness, not for P&L. */
  ts: number;
  source: MarkSource;
}

export type LiveMarks = Readonly<Record<string, LiveMark>>;

/** Batch WS ticks into one React commit per window. */
const COMMIT_INTERVAL_MS = 400;
/** A mark older than this is dropped so the UI falls back to "—". */
export const MARK_STALE_MS = 60_000;
const SWEEP_INTERVAL_MS = 10_000;

const EMPTY_MARKS: LiveMarks = Object.freeze({});

/**
 * Real mark prices keyed by symbol, sourced ONLY from the runtime:
 *
 * - `market:ticker` — exchange ticks (spot symbols) relayed by the backend WS.
 * - `position:opened` / `position:updated` — the PositionTracker's own
 *   `marketPrice`, which also covers perps symbols the paper engine marks via
 *   the spot proxy. This is the exact mark the engine's unrealized P&L uses.
 *
 * No synthetic movement is ever generated. Marks are dropped when the engine
 * reports it is not running and after MARK_STALE_MS without an update, so a
 * dead feed reads as "—" rather than a frozen-but-plausible number.
 */
export function useLiveMarks(): LiveMarks {
  const { on } = useRuntimeWs();
  const [marks, setMarks] = useState<LiveMarks>(EMPTY_MARKS);
  const pendingRef = useRef<Record<string, LiveMark>>({});
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const flush = () => {
      timerRef.current = null;
      const batch = pendingRef.current;
      pendingRef.current = {};
      if (Object.keys(batch).length === 0) return;
      setMarks((prev) => ({ ...prev, ...batch }));
    };

    const stage = (symbol: string, price: number, source: MarkSource) => {
      if (!symbol || !Number.isFinite(price) || price <= 0) return;
      pendingRef.current[symbol] = { price, ts: Date.now(), source };
      if (timerRef.current === null) {
        timerRef.current = window.setTimeout(flush, COMMIT_INTERVAL_MS);
      }
    };

    const offTicker = on("market:ticker", (event) => {
      const t = event.payload as TickerPayload;
      stage(t.symbol, t.price, "ticker");
    });

    const onPosition = (event: { payload: unknown }) => {
      const p = event.payload as PositionPayload;
      if (p.marketPrice !== undefined) stage(p.symbol, p.marketPrice, "engine");
    };
    const offOpened = on("position:opened", onPosition);
    const offUpdated = on("position:updated", onPosition);

    const offStatus = on("status", (event) => {
      const s = event.payload as StatusPayload;
      if (s.engineRunning === false) {
        pendingRef.current = {};
        setMarks((prev) => (Object.keys(prev).length === 0 ? prev : EMPTY_MARKS));
      }
    });

    const sweep = window.setInterval(() => {
      const cutoff = Date.now() - MARK_STALE_MS;
      setMarks((prev) => {
        const entries = Object.entries(prev).filter(([, m]) => m.ts >= cutoff);
        return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
      });
    }, SWEEP_INTERVAL_MS);

    return () => {
      offTicker();
      offOpened();
      offUpdated();
      offStatus();
      window.clearInterval(sweep);
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pendingRef.current = {};
    };
  }, [on]);

  return marks;
}
