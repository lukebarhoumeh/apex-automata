import { useNavigate } from "react-router-dom";
import { Panel } from "@/components/apex/Panel";
import { Sparkline } from "@/components/apex/Sparkline";
import { fmtSign } from "@/components/apex/format";
import { cn } from "@/lib/utils";
import type { StrategyCardData, StrategyDisabledBy, StrategyStatus } from "@/types/strategy";

interface StrategyCardsProps {
  strategies: readonly StrategyCardData[];
}

const STATUS_COPY: Record<StrategyStatus, { label: string; className: string; dotColor: string }> = {
  on: { label: "Active", className: "text-up", dotColor: "#39d98a" },
  off: { label: "Off",    className: "text-fg-2", dotColor: "#6a7588" },
  cooldown: { label: "Cooldown", className: "text-warn", dotColor: "#ffb020" },
  // Killed in guardrails.yaml `disabled_strategies` — the SoT, not a runtime toggle.
  killed: { label: "Disabled · guardrails", className: "text-warn", dotColor: "#ffb020" },
};

const DISABLED_BY_TITLE: Record<StrategyDisabledBy, string> = {
  guardrails: "Listed in atlas/config/guardrails.yaml → disabled_strategies. Never registered at runtime; no signal reaches order routing.",
  runtime: "Disabled in the runtime StrategyRegistry (POST /api/strategies/:id/disable).",
  "engine-offline": "Engine not running — registration state unknown.",
};

export function StrategyCards({ strategies }: StrategyCardsProps) {
  const navigate = useNavigate();

  return (
    <div className="grid grid-cols-3 gap-4">
      {strategies.map((s) => {
        const status = STATUS_COPY[s.status];
        const label = s.status === "off" && s.disabledBy === "engine-offline" ? "Off · engine stopped" : status.label;
        const up = s.pnlToday >= 0;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => navigate(`/signals?strategy=${s.id}`)}
            title={s.disabledBy ? DISABLED_BY_TITLE[s.disabledBy] : undefined}
            data-testid={`strategy-card-${s.id}`}
            className={cn(
              "group relative flex flex-col gap-3 rounded-[10px] border border-obsidian-line bg-obsidian-1 p-4 text-left transition-colors hover:border-obsidian-line-2 hover:bg-obsidian-2",
              s.status === "killed" && "opacity-70",
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[13px] font-medium text-fg-0">{s.name}</div>
                <div className={cn("mono mt-0.5 inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em]", status.className)}>
                  <span
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ background: status.dotColor, boxShadow: `0 0 6px ${status.dotColor}` }}
                  />
                  {label}
                </div>
              </div>
              <Sparkline
                data={s.sparkline}
                width={80}
                height={22}
                strokeWidth={1.4}
                stroke={up ? "#39d98a" : "#ff5a6a"}
                autoColor={false}
              />
            </div>

            <div className="flex items-end justify-between pt-1">
              <div>
                <div className="label">P&amp;L today</div>
                <div className={cn("mono mt-0.5 text-[18px] font-medium leading-none", up ? "text-up" : "text-down")}>
                  {up ? "+$" : "-$"}
                  {Math.abs(s.pnlToday).toFixed(2)}
                </div>
              </div>
              <div className="flex gap-4 text-right">
                <div>
                  <div className="label">Trades</div>
                  <div className="mono mt-0.5 text-[13px] font-medium text-fg-0">{s.trades}</div>
                </div>
                <div>
                  <div className="label">Win</div>
                  <div className="mono mt-0.5 text-[13px] font-medium text-fg-0">
                    {(s.winRate * 100).toFixed(0)}%
                  </div>
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
