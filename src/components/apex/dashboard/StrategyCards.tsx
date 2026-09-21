import { useNavigate } from "react-router-dom";
import { Sparkline } from "@/components/apex/Sparkline";
import { cn } from "@/lib/utils";
import { RATE_UNDEFINED_TITLE, formatWinRate, strategyCardFooter } from "@/lib/strategy-session-counts";
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

const TITLES = {
  pnlClosed:
    "Realized P&L of this strategy's CLOSED trades in the active session (TradeAnalytics). Open positions are not included.",
  pnlOpen: "Engine unrealized P&L over this strategy's open positions, at the PositionTracker's own mark.",
  signals:
    "Signals this strategy EMITTED in the active session (sessionStats.signalsGenerated — cleared every gate; mirrors /api/signals). Not trades.",
  closed: "Positions opened AND closed in the active session, attributed to this strategy.",
  open:
    "Open positions (live) attributed to this strategy — engine PositionTracker, including positions hydrated from a prior session.",
  win: "Win rate over this session's closed trades.",
} as const;

function signedUsd(v: number): string {
  return `${v >= 0 ? "+$" : "-$"}${Math.abs(v).toFixed(2)}`;
}

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
        const winRate = formatWinRate(s.winRate, s.closed);
        const showOpenPnl = !inert && s.open !== null && s.open > 0 && s.pnlOpen !== null;
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

            <div className="flex items-end justify-between gap-3 pt-1">
              <div title={TITLES.pnlClosed}>
                <div className="label">P&amp;L · closed (session)</div>
                <div
                  className={cn(
                    "mono mt-0.5 text-[18px] font-medium leading-none",
                    inert ? "text-fg-3" : up ? "text-up" : "text-down",
                  )}
                  data-testid={`strategy-card-${s.id}-pnl`}
                >
                  {inert ? "—" : signedUsd(s.pnlSession)}
                </div>
                {showOpenPnl && (
                  <div
                    className={cn("mono mt-1 text-[10.5px]", (s.pnlOpen as number) >= 0 ? "text-up/80" : "text-down/80")}
                    title={TITLES.pnlOpen}
                    data-testid={`strategy-card-${s.id}-pnl-open`}
                  >
                    open P&amp;L {signedUsd(s.pnlOpen as number)} · engine mark
                  </div>
                )}
              </div>
              <div title={TITLES.win} className="text-right">
                <div className="label">Win</div>
                <div
                  className={cn("mono mt-0.5 text-[13px] font-medium", winRate === "—" ? "text-fg-3" : "text-fg-0")}
                  title={winRate === "—" ? RATE_UNDEFINED_TITLE : undefined}
                  data-testid={`strategy-card-${s.id}-win`}
                >
                  {inert ? "—" : winRate}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 border-t border-obsidian-line pt-2.5">
              <Metric
                label="Signals emitted"
                value={inert || s.signals === null ? "—" : String(s.signals)}
                title={TITLES.signals}
                testId={`strategy-card-${s.id}-signals-emitted`}
              />
              <Metric
                label="Closed (session)"
                value={inert ? "—" : String(s.closed)}
                title={TITLES.closed}
                testId={`strategy-card-${s.id}-closed`}
              />
              <Metric
                label="Open (live)"
                value={inert || s.open === null ? "—" : String(s.open)}
                sub={!inert && s.hydratedOpen !== null && s.hydratedOpen > 0 ? `${s.hydratedOpen} hydrated` : undefined}
                title={TITLES.open}
                testId={`strategy-card-${s.id}-open`}
              />
            </div>

            <div
              className="mono text-[10px] text-fg-3"
              title={
                s.status === "killed"
                  ? DISABLED_BY_TITLE.guardrails
                  : "Signals emitted this session · closed trades · open positions (hydrated = carried from a prior session)"
              }
              data-testid={`strategy-card-${s.id}-signals`}
            >
              {s.status === "killed"
                ? "never registered — emits no signals"
                : !s.sessionScoped
                  ? "no session ledger"
                  : strategyCardFooter(s)}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  title,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  title: string;
  testId: string;
}) {
  return (
    <div title={title}>
      <div className="mono text-[9px] font-medium uppercase tracking-[0.1em] text-fg-2">{label}</div>
      <div className={cn("mono mt-0.5 text-[13px] font-medium", value === "—" ? "text-fg-3" : "text-fg-0")} data-testid={testId}>
        {value}
        {sub && <span className="ml-1 text-[9.5px] font-normal text-fg-2">({sub})</span>}
      </div>
    </div>
  );
}
