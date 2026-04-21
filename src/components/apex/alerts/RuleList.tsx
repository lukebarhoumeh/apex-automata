import { Plus } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { AlertRule } from "@/types/alerts";

interface Props {
  rules: readonly AlertRule[];
  selectedId: string;
  onSelect: (id: string) => void;
}

export function RuleList({ rules, selectedId, onSelect }: Props) {
  return (
    <Panel
      header
      pad={0}
      title="RULES"
      right={
        <button className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/20">
          <Plus size={12} /> New rule
        </button>
      }
    >
      <div>
        {rules.map((r) => {
          const selected = selectedId === r.id;
          return (
            <button
              key={r.id}
              onClick={() => onSelect(r.id)}
              className={cn(
                "block w-full border-b border-obsidian-line px-4 py-3 text-left transition-colors",
                selected ? "bg-accent/5 border-l-2 border-l-accent" : "border-l-2 border-l-transparent hover:bg-obsidian-2",
              )}
            >
              <div className="mb-1 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span
                    className={cn(
                      "inline-block h-2 w-2 rounded-full",
                      r.enabled ? "bg-up shadow-[0_0_6px_hsl(var(--up)/0.45)]" : "bg-fg-3",
                    )}
                  />
                  <span
                    className={cn(
                      "text-[13px] font-medium",
                      r.enabled ? "text-fg-0" : "text-fg-2",
                    )}
                  >
                    {r.name}
                  </span>
                </div>
                {r.fired > 0 && (
                  <Pill tone={r.fired >= 3 ? "down" : "warn"}>{r.fired}×</Pill>
                )}
              </div>
              <div className="mono pl-4 text-[10.5px] text-fg-2">
                {r.when.metric} {r.when.op} {r.when.value}
                {r.when.unit} · last fired {r.lastFired}
              </div>
            </button>
          );
        })}
      </div>
    </Panel>
  );
}
