import { ArrowRight, ArrowUp, ArrowDown } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { fmt } from "@/components/apex/format";
import { computePositionPnl, computeStopTargetProgress } from "@/lib/position-pnl";
import { cn } from "@/lib/utils";
import type { LiveMarks } from "@/hooks/apex/useLiveMarks";
import type { Position, PositionSource } from "@/types/positions";

interface ActivePositionsStripProps {
  positions: readonly Position[];
  /** engine → GET /api/positions (running session); book → Supabase rows while stopped. */
  source?: PositionSource;
  /** Real marks from the runtime (WS ticker / engine). Absent symbol → "—". */
  marks?: LiveMarks;
  onViewAll?: () => void;
}

const NO_MARKS: LiveMarks = {};

function markFor(position: Position, marks: LiveMarks): number | undefined {
  return marks[position.sym]?.price ?? position.mark;
}

/**
 * Active positions valued at the runtime's real marks. Cards are derived from
 * props on every render — no local ticking state, no synthetic jitter.
 */
export function ActivePositionsStrip({ positions, source = "engine", marks = NO_MARKS, onViewAll }: ActivePositionsStripProps) {
  const markedCount = positions.filter((p) => markFor(p, marks) !== undefined).length;
  const feedLive = source === "engine" && positions.length > 0 && markedCount === positions.length;

  return (
    <Panel header={false} pad={0}>
      {/* Custom header — needs inline dot + label + pill + right-aligned action */}
      <div className="flex items-center justify-between border-b border-obsidian-line px-4 py-3">
        <div className="flex items-center gap-3">
          <span className={feedLive ? "dot-live" : "inline-block h-1.5 w-1.5 rounded-full bg-fg-3"} />
          <span className="label">Active positions</span>
          <Pill tone={source === "book" ? "warn" : "accent"}>
            {positions.length} {source === "book" ? "ON BOOK" : "OPEN"}
          </Pill>
          {source === "book" && (
            <span className="mono text-[10px] uppercase tracking-[0.09em] text-warn/90">
              engine stopped · no live marks
            </span>
          )}
          {source === "engine" && positions.length > 0 && !feedLive && (
            <span className="mono text-[10px] uppercase tracking-[0.09em] text-fg-3">
              marks {markedCount}/{positions.length}
            </span>
          )}
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
        {positions.map((p) => (
          <PositionCard key={p.id} position={p} mark={markFor(p, marks)} />
        ))}
      </div>
    </Panel>
  );
}

function PositionCard({ position, mark }: { position: Position; mark: number | undefined }) {
  const live = computePositionPnl(position.side, position.entry, position.qty, mark);
  const up = live ? live.pnl >= 0 : null;
  const pnlTone = up === null ? "text-fg-3" : up ? "text-up" : "text-down";
  const progress = computeStopTargetProgress(
    position.side,
    position.entry,
    position.stop,
    position.target,
    mark,
  );

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
          <span className={cn("mono text-[18px] font-medium leading-none", pnlTone)}>
            {live ? `${up ? "+$" : "-$"}${fmt(Math.abs(live.pnl), 2)}` : "—"}
          </span>
          <span className={cn("mono text-[11px]", pnlTone)}>
            {live ? `${up ? "+" : ""}${live.pnlPct.toFixed(2)}%` : "no live mark"}
          </span>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="mono text-[9px] font-medium uppercase tracking-[0.12em] text-fg-2">LAST</span>
          <span className={cn("mono text-[14px]", live ? "text-fg-0" : "text-fg-3")}>
            {live ? `$${fmt(live.mark, 2)}` : "—"}
          </span>
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
