import { useEffect, useMemo, useState } from "react";
import { useLiveTicker } from "@/hooks/useLiveTicker";
import type { TickerItem } from "@/components/apex/shell/TickerTape";

const SPARK_LEN = 24;

/**
 * Adapts the live WS ticker stream (`market:ticker` events) into the
 * `TickerItem[]` shape the TickerTape expects. Maintains a rolling price
 * history per symbol for the mini sparkline and derives `changePct`
 * against the first price we saw in this session.
 */
export function useTickerFeed(): TickerItem[] {
  const { tickers } = useLiveTicker([]);
  const [history, setHistory] = useState<Record<string, number[]>>({});
  const [anchor, setAnchor] = useState<Record<string, number>>({});

  useEffect(() => {
    setHistory((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [sym, t] of Object.entries(tickers)) {
        const hist = next[sym] ?? [];
        const last = hist[hist.length - 1];
        if (last !== t.price) {
          next[sym] = [...hist, t.price].slice(-SPARK_LEN);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    setAnchor((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [sym, t] of Object.entries(tickers)) {
        if (next[sym] === undefined) {
          next[sym] = t.price;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tickers]);

  return useMemo(() => {
    return Object.keys(tickers)
      .sort()
      .map<TickerItem>((sym) => {
        const t = tickers[sym];
        const hist = history[sym] ?? [];
        const first = anchor[sym] ?? t.price;
        const changePct = first > 0 ? ((t.price - first) / first) * 100 : 0;
        const spark = hist.length >= 2 ? hist : [t.price, t.price];
        return {
          symbol: sym,
          price: t.price,
          changePct,
          spark,
        };
      });
  }, [tickers, history, anchor]);
}
