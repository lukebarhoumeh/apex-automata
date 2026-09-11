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
        const up = s.pnlSession >= 0;
        // Killed / stopped strategies own no session activity; a "0" would
        // still read as a runnable strategy sitting idle, so render "—".
        const inert = s.status === "killed" || !s.sessionScoped;
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
              <div title="Realized P&L of this strategy's closed trades in the active session (TradeAnalytics)">
                <div className="label">P&amp;L session</div>
                <div
                  className={cn(
                    "mono mt-0.5 text-[18px] font-medium leading-none",
                    inert ? "text-fg-3" : up ? "text-up" : "text-down",
                  )}
                  data-testid={`strategy-card-${s.id}-pnl`}
                >
                  {inert ? "—" : `${up ? "+$" : "-$"}${Math.abs(s.pnlSession).toFixed(2)}`}
                </div>
              </div>
              <div className="flex gap-4 text-right">
                <div title="Closed trades attributed to this strategy in the active session — not signals">
                  <div className="label">Trades</div>
                  <div className="mono mt-0.5 text-[13px] font-medium text-fg-0" data-testid={`strategy-card-${s.id}-trades`}>
                    {inert ? "—" : s.trades}
                  </div>
                </div>
                <div title="Win rate over this session's closed trades">
                  <div className="label">Win</div>
                  <div className="mono mt-0.5 text-[13px] font-medium text-fg-0">
                    {inert || s.trades === 0 ? "—" : `${(s.winRate * 100).toFixed(0)}%`}
                  </div>
                </div>
              </div>
            </div>
            <div
              className="mono text-[10px] text-fg-3"
              title="Signals the plugin emitted this run (StrategyRegistry counter). Most are filtered by risk / meta-filter before any order is routed."
              data-testid={`strategy-card-${s.id}-signals`}
            >
              {s.status === "killed"
                ? "never registered — emits no signals"
                : !s.sessionScoped
                  ? "no session ledger"
                  : `${s.signals} ${s.signals === 1 ? "signal" : "signals"} emitted · ${s.trades} routed to ${s.trades === 1 ? "a trade" : "trades"}`}
            </div>
          </button>
        );
      })}
    </div>
  );
}
