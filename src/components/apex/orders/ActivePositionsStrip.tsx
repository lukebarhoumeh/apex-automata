import { useEffect, useState } from "react";
import { ArrowRight, ArrowUp, ArrowDown } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { fmt } from "@/components/apex/format";
import { cn } from "@/lib/utils";
import type { Position } from "@/types/positions";

interface ActivePositionsStripProps {
  positions: readonly Position[];
  onViewAll?: () => void;
}

/** Tiny live-mark jitter so the progress bar moves. */
function useLiveMarks(initial: readonly Position[]): Position[] {
  const [rows, setRows] = useState<Position[]>(() => initial.map((p) => ({ ...p })));
  useEffect(() => {
    const id = window.setInterval(() => {
      setRows((prev) =>
        prev.map((p) => {
          const base = p.mark ?? p.entry;
          const mark = base + (Math.random() - 0.5) * base * 0.0006;
          return { ...p, mark };
        }),
      );
    }, 1400);
    return () => window.clearInterval(id);
  }, []);
  return rows;
}

export function ActivePositionsStrip({ positions, onViewAll }: ActivePositionsStripProps) {
  const rows = useLiveMarks(positions);

  return (
    <Panel header={false} pad={0}>
      {/* Custom header — needs inline dot + label + pill + right-aligned action */}
      <div className="flex items-center justify-between border-b border-obsidian-line px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="dot-live" />
          <span className="label">Active positions</span>
          <Pill tone="accent">{rows.length} OPEN</Pill>
        </div>
        <button
          type="button"
          onClick={onViewAll}
          className="flex items-center gap-1 text-[11.5px] text-fg-1 transition-colors hover:text-fg-0"
        >
          View all
          <ArrowRight size={12} strokeWidth={1.6} />
        </button>
      </div>

      <div className="grid grid-cols-3 divide-x divide-obsidian-line">
        {rows.map((p) => (
          <PositionCard key={p.id} position={p} />
        ))}
      </div>
    </Panel>
  );
}

function PositionCard({ position }: { position: Position }) {
  const last = position.mark ?? position.entry;
  const pnl =
    position.side === "LONG"
      ? (last - position.entry) * position.qty
      : (position.entry - last) * position.qty;
  const pnlPct = (pnl / (position.entry * position.qty)) * 100;
  const up = pnl >= 0;

  // Progress along SL—ENTRY—TP; -100..+100
  const tp = Math.abs(position.target - position.entry);
  const sl = Math.abs(position.entry - position.stop);
  const moved = position.side === "LONG" ? last - position.entry : position.entry - last;
  const progress = Math.max(-100, Math.min(100, (moved / (moved >= 0 ? tp : sl)) * 100));

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-semibold text-fg-0">{position.sym}</span>
          <Pill tone={position.side === "LONG" ? "up" : "down"}>
            {position.side === "LONG" ? (
              <ArrowUp size={9} strokeWidth={2.2} />
            ) : (
              <ArrowDown size={9} strokeWidth={2.2} />
            )}
            {position.side}
          </Pill>
        </div>
        <Pill tone="default">{position.strat.replace("_", " ")}</Pill>
      </div>

      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="mono text-[9px] font-medium uppercase tracking-[0.12em] text-fg-2">
            UNREAL P&amp;L
          </span>
          <span className={cn("mono text-[18px] font-medium leading-none", up ? "text-up" : "text-down")}>
            {up ? "+$" : "-$"}
            {fmt(Math.abs(pnl), 2)}
          </span>
          <span className={cn("mono text-[11px]", up ? "text-up" : "text-down")}>
            {up ? "+" : ""}
            {pnlPct.toFixed(2)}%
          </span>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="mono text-[9px] font-medium uppercase tracking-[0.12em] text-fg-2">LAST</span>
          <span className="mono text-[14px] text-fg-0">${fmt(last, 2)}</span>
          <span className="mono text-[11px] text-fg-2">qty {fmt(position.qty, 4)}</span>
        </div>
      </div>

      <div>
        <SlEntryTpBar progress={progress} />
        <div className="mono mt-1 flex justify-between text-[10px]">
          <span className="text-down">SL {fmt(position.stop, 2)}</span>
          <span className="text-fg-2">ENTRY {fmt(position.entry, 2)}</span>
          <span className="text-up">TP {fmt(position.target, 2)}</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-1 text-[11px] text-fg-1 transition-colors hover:bg-obsidian-3 hover:text-fg-0"
        >
          Flatten
        </button>
        <button
          type="button"
          className="rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-1 text-[11px] text-fg-1 transition-colors hover:bg-obsidian-3 hover:text-fg-0"
        >
          Move SL
        </button>
        <span className="mono ml-auto text-[10.5px] uppercase tracking-[0.09em] text-fg-2">
          {position.opened}
        </span>
      </div>
    </div>
  );
}

function SlEntryTpBar({ progress }: { progress: number }) {
  const up = progress >= 0;
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-obsidian-3">
      <div
        aria-hidden
        className="absolute left-1/2 top-0 h-full w-[2px] -translate-x-1/2 bg-fg-2/80"
      />
      <div
        className={cn("absolute inset-y-0 rounded-full", up ? "bg-up" : "bg-down")}
        style={{
          left: up ? "50%" : `${50 + progress / 2}%`,
          width: `${Math.abs(progress) / 2}%`,
          boxShadow: up
            ? "0 0 8px rgba(57,217,138,0.45)"
            : "0 0 8px rgba(255,90,106,0.45)",
        }}
      />
    </div>
  );
}
