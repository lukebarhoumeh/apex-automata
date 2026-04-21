import { AlertTriangle } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { KillLadderRow } from "@/types/risk";

interface Props {
  rows: readonly KillLadderRow[];
}

export function KillSwitchLadder({ rows }: Props) {
  return (
    <Panel header={false} pad={0}>
      <div className="flex items-center justify-between border-b border-obsidian-line px-4 py-3">
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className="text-warn" strokeWidth={1.6} />
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            KILL-SWITCH LADDER
          </span>
        </div>
        <span className="mono text-[10px] uppercase text-fg-2">{rows.length} RULES</span>
      </div>
      <div>
        {rows.map((k, i) => (
          <div
            key={k.lvl}
            className={cn(
              "grid items-center gap-3 px-4 py-3",
              i < rows.length - 1 && "border-b border-obsidian-line",
            )}
            style={{ gridTemplateColumns: "32px 1fr auto" }}
          >
            <div
              className={cn(
                "grid h-7 w-7 place-items-center rounded-full border font-mono text-[12px] font-semibold",
                k.tripped
                  ? "border-down bg-down/15 text-down"
                  : "border-obsidian-line-2 bg-obsidian-2 text-fg-1",
              )}
            >
              {k.lvl}
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium text-fg-0">{k.action}</span>
              <span className="mono text-[11px] text-fg-2">{k.at}</span>
            </div>
            <Pill tone={k.tripped ? "down" : "default"}>{k.tripped ? "TRIPPED" : "ARMED"}</Pill>
          </div>
        ))}
      </div>
    </Panel>
  );
}
