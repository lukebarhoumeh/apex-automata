import { FlaskConical, RefreshCw } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { TrainingRun } from "@/types/model";

interface Props {
  runs: readonly TrainingRun[];
}

export function TrainingRunsTable({ runs }: Props) {
  return (
    <Panel
      header
      pad={0}
      title="TRAINING RUNS · VERSION HISTORY"
      right={
        <div className="flex items-center gap-2">
          <FlaskConical size={14} className="text-warn" strokeWidth={1.6} />
          <button className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/20">
            <RefreshCw size={12} /> New run
          </button>
        </div>
      }
    >
      <table className="w-full">
        <thead>
          <tr className="border-b border-obsidian-line">
            {["VERSION", "DATE", "ROC AUC", "PRECISION", "TRADES", "NOTE", ""].map((h) => (
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
          {runs.map((r) => (
            <tr key={r.v} className="border-b border-obsidian-line/60">
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={cn("mono font-medium", r.live ? "text-accent" : "text-fg-0")}>
                    {r.v}
                  </span>
                  {r.live && <Pill tone="accent">LIVE</Pill>}
                </div>
              </td>
              <td className="mono px-3 py-2 text-[11.5px] text-fg-2">{r.date}</td>
              <td className="mono px-3 py-2 text-right text-[11.5px]">
                <span className={r.live ? "text-up" : "text-fg-1"}>
                  {(r.auc * 100).toFixed(1)}%
                </span>
              </td>
              <td className="mono px-3 py-2 text-right text-[11.5px]">
                {(r.prec * 100).toFixed(1)}%
              </td>
              <td className="mono px-3 py-2 text-right text-[11.5px]">
                {r.trades.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-[12px] text-fg-1">{r.note}</td>
              <td className="px-3 py-2 text-right">
                {!r.live && (
                  <button className="rounded-md border border-obsidian-line bg-obsidian-2 px-2 py-1 text-[10.5px] text-fg-1 hover:bg-obsidian-3">
                    Rollback
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
