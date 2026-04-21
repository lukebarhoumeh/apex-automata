import { TrendingUp, Activity } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { cn } from "@/lib/utils";
import type { StrategyConfig } from "@/types/strategy";

interface Props {
  strat: StrategyConfig;
}

export function StrategyConfigCard({ strat }: Props) {
  const Icon = strat.kind === "trend" ? TrendingUp : Activity;
  const accentClass =
    strat.kind === "trend"
      ? "text-up bg-up/10 ring-up/20"
      : "text-warn bg-warn/10 ring-warn/20";

  return (
    <Panel header={false} pad={0} className={cn(strat.enabled ? "" : "opacity-60")}>
      <div className="flex items-center justify-between border-b border-obsidian-line px-4 py-3">
        <div className="flex items-center gap-3">
          <div className={cn("grid h-8 w-8 place-items-center rounded-md ring-1", accentClass)}>
            <Icon size={15} strokeWidth={1.6} />
          </div>
          <div className="flex flex-col">
            <span className="text-[13.5px] font-semibold text-fg-0">{strat.name}</span>
            <span className="text-[11px] text-fg-2">{strat.desc}</span>
          </div>
        </div>
        <span
          className={cn(
            "mono text-[10px] px-2 py-0.5 rounded-full border uppercase",
            strat.enabled
              ? "bg-up/10 text-up border-up/20"
              : "bg-obsidian-3 text-fg-2 border-obsidian-line-2",
          )}
        >
          {strat.enabled ? "ENABLED" : "DISABLED"}
        </span>
      </div>

      <div className="flex flex-col gap-4 p-4">
        {strat.params.map((p) => (
          <div key={p.key}>
            <div className="mb-1.5 flex items-center justify-between text-[12px]">
              <span className="mono text-[10px] uppercase tracking-[0.12em] text-fg-2">{p.label}</span>
              <span className="mono text-[12px] text-fg-0">{p.format(p.val)}</span>
            </div>
            <div className="relative h-1 rounded-full bg-obsidian-3">
              <div
                className="absolute left-0 top-0 h-full rounded-full bg-accent"
                style={{ width: `${((p.val - p.min) / (p.max - p.min)) * 100}%` }}
              />
            </div>
            <div className="mono mt-1 flex justify-between text-[9.5px] text-fg-3">
              <span>{p.format(p.min)}</span>
              <span>{p.format(p.max)}</span>
            </div>
          </div>
        ))}

        <div className="border-t border-obsidian-line pt-3">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">WIN RATE</div>
              <div className="mono text-[17px] text-fg-0">{(strat.stats.winRate * 100).toFixed(1)}%</div>
            </div>
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">AVG R</div>
              <div className="mono text-[17px] text-up">{strat.stats.avgR.toFixed(2)}R</div>
            </div>
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">TRADES</div>
              <div className="mono text-[17px] text-fg-0">{strat.stats.trades}</div>
            </div>
          </div>
          <div className="mt-3">
            <div className="mono text-[10px] uppercase text-fg-2">LAST 12 R</div>
            <div className="mt-1 flex gap-1">
              {strat.stats.lastR.map((r, i) => (
                <div
                  key={i}
                  className={cn("h-3 w-3 rounded-sm", r > 0 ? "bg-up" : "bg-down")}
                  style={{ opacity: 0.4 + Math.min(Math.abs(r), 2.5) / 3 }}
                  title={`${r.toFixed(2)}R`}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}
