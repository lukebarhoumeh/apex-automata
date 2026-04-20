import { useEffect, useState } from "react";
import { MoreHorizontal, X } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { Sparkline } from "@/components/apex/Sparkline";
import { fmt, fmtSign } from "@/components/apex/format";
import { cn } from "@/lib/utils";
import type { Position } from "@/types/positions";

interface PositionsTableProps {
  positions: readonly Position[];
}

/** Tiny jitter on live mark so the flashes have something to react to. */
function useTickingMarks(initial: readonly Position[]): Position[] {
  const [rows, setRows] = useState<Position[]>(() => initial.map((p) => ({ ...p })));
  useEffect(() => {
    const id = window.setInterval(() => {
      setRows((prev) =>
        prev.map((p) => {
          const base = p.mark ?? p.entry;
          const jitter = (Math.random() - 0.5) * base * 0.0006;
          const mark = base + jitter;
          const pnl = p.side === "LONG" ? (mark - p.entry) * p.qty : (p.entry - mark) * p.qty;
          const pnlPct = p.side === "LONG" ? ((mark - p.entry) / p.entry) * 100 : ((p.entry - mark) / p.entry) * 100;
          return { ...p, mark, pnl, pnlPct };
        }),
      );
    }, 1400);
    return () => window.clearInterval(id);
  }, []);
  return rows;
}

export function PositionsTable({ positions }: PositionsTableProps) {
  const rows = useTickingMarks(positions);

  return (
    <Panel
      header
      pad={0}
      title="Open positions"
      subtitle={`${rows.length} active`}
      right={
        <span className="mono text-[10.5px] text-fg-2">real-time</span>
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
            {rows.map((p) => (
              <PositionRow key={p.id} position={p} />
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

function PositionRow({ position }: { position: Position }) {
  const pnlUp = (position.pnl ?? 0) >= 0;
  const mark = position.mark ?? position.entry;

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
      <td className="mono px-3 text-right text-[12.5px] text-fg-0">{fmt(mark, 2)}</td>
      <td className={cn("mono px-3 text-right text-[12.5px] font-medium", pnlUp ? "text-up" : "text-down")}>
        {pnlUp ? "+" : "-"}${fmt(Math.abs(position.pnl ?? 0), 2)}
      </td>
      <td className={cn("mono px-3 text-right text-[12.5px]", pnlUp ? "text-up" : "text-down")}>
        {fmtSign(position.pnlPct ?? 0, 2)}%
      </td>
      <td className="mono px-3 text-right text-[12.5px] text-fg-1">{fmt(position.stop, 2)}</td>
      <td className="mono px-3 text-right text-[12.5px] text-fg-1">{fmt(position.target, 2)}</td>
      <td className="px-3">
        <span className="mono text-[10.5px] uppercase tracking-[0.09em] text-fg-2">{position.strat}</span>
      </td>
      <td className="px-3">
        {position.sparkline && (
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
