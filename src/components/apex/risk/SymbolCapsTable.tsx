import { Shield } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { SymbolCap } from "@/types/risk";

interface Props {
  caps: readonly SymbolCap[];
}

export function SymbolCapsTable({ caps }: Props) {
  return (
    <Panel header={false} pad={0}>
      <div className="flex items-center justify-between border-b border-obsidian-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Shield size={14} className="text-up" strokeWidth={1.6} />
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            PER-SYMBOL EXPOSURE CAPS
          </span>
        </div>
      </div>
      <table className="w-full">
        <thead>
          <tr className="border-b border-obsidian-line">
            {["SYMBOL", "USED", "CAP", "UTILIZATION", "%", "STATUS"].map((h) => (
              <th
                key={h}
                className="mono px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.1em] text-fg-2"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {caps.map((c) => {
            // null → no per-symbol source (or no configured cap): render "—",
            // never a $0 / 0.0% that reads as "nothing on".
            const pct = c.pct;
            const barTone = pct !== null && pct > 70 ? "bg-warn" : pct !== null && pct > 50 ? "bg-accent" : "bg-up";
            const high = pct !== null && pct > 70;
            return (
              <tr key={c.s} className="border-b border-obsidian-line/60" data-testid={`symbol-cap-${c.s}`}>
                <td className="px-3 py-2 text-[12.5px] font-medium text-fg-0">{c.s}</td>
                <td
                  className={cn("mono px-3 py-2 text-[11.5px]", c.used === null && "text-fg-3")}
                  title={c.used === null ? "Per-symbol open notional not available from the runtime" : "Open notional at the engine mark (/api/positions)"}
                >
                  {c.used === null ? "—" : `$${c.used.toLocaleString()}`}
                </td>
                <td className="mono px-3 py-2 text-[11.5px] text-fg-2">
                  {c.cap === null ? "—" : `$${c.cap.toLocaleString()}`}
                </td>
                <td className="px-3 py-2" style={{ width: "40%" }}>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-obsidian-3">
                    <div
                      className={cn("h-full rounded-full", barTone)}
                      style={{ width: `${Math.min(100, pct ?? 0)}%` }}
                    />
                  </div>
                </td>
                <td
                  className={cn(
                    "mono px-3 py-2 text-right text-[11.5px]",
                    pct === null ? "text-fg-3" : high ? "text-warn" : "text-fg-0",
                  )}
                >
                  {pct === null ? "—" : `${pct.toFixed(1)}%`}
                </td>
                <td className="px-3 py-2">
                  {pct === null ? (
                    <Pill tone="default">—</Pill>
                  ) : (
                    <Pill tone={high ? "warn" : "default"}>{high ? "HIGH" : "OK"}</Pill>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
