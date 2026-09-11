import { MoreHorizontal, X } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { Sparkline } from "@/components/apex/Sparkline";
import { fmt, fmtSign } from "@/components/apex/format";
import { computePositionPnl } from "@/lib/position-pnl";
import { cn } from "@/lib/utils";
import type { LiveMarks } from "@/hooks/apex/useLiveMarks";
import type { Position, PositionSource } from "@/types/positions";

interface PositionsTableProps {
  positions: readonly Position[];
  /** engine → GET /api/positions (running session); book → Supabase rows while stopped. */
  source?: PositionSource;
  /** Real marks from the runtime (WS ticker / engine). Absent symbol → "—". */
  marks?: LiveMarks;
}

const NO_MARKS: LiveMarks = {};

/** Freshest real mark: WS tick first, then the engine's last polled mark. */
function markFor(position: Position, marks: LiveMarks): number | undefined {
  return marks[position.sym]?.price ?? position.mark;
}

function markStatusLabel(rows: readonly Position[], marks: LiveMarks, source: PositionSource): string {
  if (rows.length === 0) return source === "book" ? "engine stopped" : "";
  const marked = rows.filter((p) => markFor(p, marks) !== undefined).length;
  const prefix = source === "book" ? "book · engine stopped · " : "";
  if (marked === 0) return `${prefix}no live marks`;
  if (marked === rows.length) return `${prefix}live marks`;
  return `${prefix}marks ${marked}/${rows.length}`;
}

/**
 * Open positions valued at the runtime's real marks. Rows are derived from
 * props on every render — no local ticking state, no synthetic jitter.
 */
export function PositionsTable({ positions, source = "engine", marks = NO_MARKS }: PositionsTableProps) {
  return (
    <Panel
      header
      pad={0}
      title="Open positions"
      subtitle={`${positions.length} ${source === "book" ? "on book" : "active"}`}
      right={
        <span className={cn("mono text-[10.5px]", source === "book" ? "text-warn/90" : "text-fg-2")}>
          {markStatusLabel(positions, marks, source)}
        </span>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-obsidian-line">
              <Th>Symbol</Th>
              <Th>Side</Th>
              <Th align="right">Qty</Th>
              <Th align="right">Entry</Th>
              <Th align="right">Mark</Th>
              <Th align="right">P&amp;L</Th>
              <Th align="right">P&amp;L%</Th>
              <Th align="right">Stop</Th>
              <Th align="right">Target</Th>
              <Th>Strategy</Th>
              <Th>Spark</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <PositionRow key={p.id} position={p} mark={markFor(p, marks)} />
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Th({
  children,
  align = "left",
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={cn(
        "mono px-3 py-2.5 text-[10px] font-medium uppercase tracking-[0.09em] text-fg-2",
        align === "right" && "text-right",
      )}
    >
      {children}
    </th>
  );
}

function PositionRow({ position, mark }: { position: Position; mark: number | undefined }) {
  const live = computePositionPnl(position.side, position.entry, position.qty, mark);
  const pnlUp = live ? live.pnl >= 0 : null;
  const pnlTone = pnlUp === null ? "text-fg-3" : pnlUp ? "text-up" : "text-down";

  return (
    <tr className="group h-9 border-b border-obsidian-line transition-colors hover:bg-obsidian-2">
      <td className="px-3 text-[12.5px] font-medium text-fg-0">{position.sym}</td>
      <td className="px-3">
        <Pill tone={position.side === "LONG" ? "up" : "down"} className="!text-[9.5px]">
          {position.side}
        </Pill>
      </td>
      <td className="mono px-3 text-right text-[12.5px] text-fg-0">{fmt(position.qty, 4)}</td>
      <td className="mono px-3 text-right text-[12.5px] text-fg-1">{fmt(position.entry, 2)}</td>
      <td
        className={cn("mono px-3 text-right text-[12.5px]", live ? "text-fg-0" : "text-fg-3")}
        title={live ? undefined : "No live mark from runtime yet"}
      >
        {live ? fmt(live.mark, 2) : "—"}
      </td>
      <td className={cn("mono px-3 text-right text-[12.5px] font-medium", pnlTone)}>
        {live ? `${pnlUp ? "+" : "-"}$${fmt(Math.abs(live.pnl), 2)}` : "—"}
      </td>
      <td className={cn("mono px-3 text-right text-[12.5px]", pnlTone)}>
        {live ? `${fmtSign(live.pnlPct, 2)}%` : "—"}
      </td>
      <td className="mono px-3 text-right text-[12.5px] text-fg-1">{fmt(position.stop, 2)}</td>
      <td className="mono px-3 text-right text-[12.5px] text-fg-1">{fmt(position.target, 2)}</td>
      <td className="px-3">
        <span className="mono text-[10.5px] uppercase tracking-[0.09em] text-fg-2">{position.strat}</span>
      </td>
      <td className="px-3">
        {position.sparkline && position.sparkline.length >= 2 && (
          <Sparkline
            data={position.sparkline}
            width={80}
            height={22}
            strokeWidth={1.3}
            autoColor
          />
        )}
      </td>
      <td className="px-3 text-right">
        <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-2 hover:bg-obsidian-3 hover:text-fg-0"
            aria-label="Edit position"
          >
            <MoreHorizontal size={13} strokeWidth={1.6} />
          </button>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-2 hover:bg-down/10 hover:text-down"
            aria-label="Close position"
          >
            <X size={13} strokeWidth={1.6} />
          </button>
        </div>
      </td>
    </tr>
  );
}
