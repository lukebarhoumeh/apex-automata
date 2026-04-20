import { useMemo } from "react";
import { Sparkline } from "@/components/apex/Sparkline";
import { fmtPct } from "@/components/apex/format";

export interface TickerItem {
  symbol: string;
  price: number;
  changePct: number;
  spark: readonly number[];
}

interface TickerTapeProps {
  items: readonly TickerItem[];
}

export function TickerTape({ items }: TickerTapeProps) {
  // Duplicate items so the -50% translate wraps seamlessly.
  const doubled = useMemo(() => [...items, ...items], [items]);

  if (items.length === 0) {
    return (
      <div className="h-[34px] border-b border-obsidian-line bg-obsidian-1" />
    );
  }

  return (
    <div
      className="h-[34px] overflow-hidden border-b border-obsidian-line bg-obsidian-1"
      style={{
        maskImage:
          "linear-gradient(to right, transparent 0, black 3%, black 97%, transparent 100%)",
        WebkitMaskImage:
          "linear-gradient(to right, transparent 0, black 3%, black 97%, transparent 100%)",
      }}
    >
      <div
        className="flex h-full w-max items-center gap-8 pl-6 animate-ticker-scroll will-change-transform"
        aria-hidden
      >
        {doubled.map((item, i) => (
          <TickerCell key={`${item.symbol}-${i}`} item={item} />
        ))}
      </div>
    </div>
  );
}

function TickerCell({ item }: { item: TickerItem }) {
  const up = item.changePct >= 0;
  return (
    <div className="flex items-center gap-2.5 whitespace-nowrap">
      <span className="mono text-[11px] font-medium text-fg-1">
        {item.symbol}
      </span>
      <span className="mono text-[12px] font-medium text-fg-0">
        {item.price.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </span>
      <span
        className={`mono text-[11px] font-medium ${up ? "text-up" : "text-down"}`}
      >
        {up ? "▲" : "▼"} {fmtPct(item.changePct)}
      </span>
      <Sparkline data={item.spark} width={46} height={16} />
    </div>
  );
}
