import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { fmt, fmtSign } from "@/components/apex/format";
import type { FillRecord } from "@/types/orders";

interface RecentFillsPanelProps {
  fills: readonly FillRecord[];
}

export function RecentFillsPanel({ fills }: RecentFillsPanelProps) {
  return (
    <Panel
      header
      pad={0}
      title="Recent fills"
      right={<Pill tone="default">{fills.length}</Pill>}
    >
      <div className="max-h-[240px] overflow-y-auto">
        {fills.map((f) => (
          <FillRow key={f.id} fill={f} />
        ))}
      </div>
    </Panel>
  );
}

function FillRow({ fill }: { fill: FillRecord }) {
  const notional = fill.qty * fill.px;
  return (
    <div className="grid grid-cols-[70px_1fr_auto] items-center gap-3 border-b border-obsidian-line px-4 py-2">
      <span className="mono text-[10.5px] text-fg-2">{fill.ts.slice(0, 8)}</span>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-fg-0">{fill.sym}</span>
          <Pill tone={fill.side === "BUY" ? "up" : "down"}>{fill.side}</Pill>
        </div>
        <span className="mono text-[10.5px] text-fg-2">
          {fmt(fill.qty, 3)} @ {fmt(fill.px, 2)} · slip {fmtSign(fill.slip, 2)}bp
        </span>
      </div>
      <span className="mono text-[11px] text-fg-1">${fmt(notional, 2)}</span>
    </div>
  );
}
