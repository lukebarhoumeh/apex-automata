import { Play, Pause, ExternalLink, Zap } from "lucide-react";
import { Pill } from "@/components/apex/Pill";
import { Sparkline } from "@/components/apex/Sparkline";
import { HeatBar } from "@/components/apex/HeatBar";
import { fmt } from "@/components/apex/format";
import { cn } from "@/lib/utils";
import type { SessionStats } from "@/types/session";
import type { MarketRegime } from "@/types/regime";
import type { EquityPoint } from "@/types/equity";

interface HeroStatePanelProps {
  session: SessionStats;
  regime: MarketRegime;
  intradayEquity: readonly EquityPoint[];
}

interface ModeCopy {
  label: string;
  subtitle: string;
  dotColor: string;
  /** Hero headline: "The engine is {verb} …" */
  verb: string;
  scanning: boolean;
}

const MODE_COPY: Record<SessionStats["mode"], ModeCopy> = {
  paper:   { label: "PAPER",   subtitle: "Simulated capital — no real orders",                                   dotColor: "hsl(var(--accent))", verb: "scanning", scanning: true },
  live:    { label: "LIVE",    subtitle: "Executing real orders on Coinbase",                                    dotColor: "#ff5a6a",            verb: "scanning", scanning: true },
  paused:  { label: "PAUSED",  subtitle: "New entries halted — positions held",                                  dotColor: "#ffb020",            verb: "paused on", scanning: true },
  halted:  { label: "HALTED",  subtitle: "Kill switch active — trading blocked, positions NOT auto-closed",      dotColor: "#ff5a6a",            verb: "halted", scanning: false },
  stopped: { label: "STOPPED", subtitle: "No active session — engine idle",                                      dotColor: "#6a7588",            verb: "stopped", scanning: false },
};

export function HeroStatePanel({ session, regime, intradayEquity }: HeroStatePanelProps) {
  // Session P&L now reads straight from the backend; no fake drift.
  // Mock-era animation (random-walk tick every 1.1s) removed 2026-04-22.
  const pnl = session.pnl;
  const unreal = session.unrealized;

  const mode = MODE_COPY[session.mode];
  const sparkData = intradayEquity.slice(-60).map((p) => p.v);
  const pnlUp = pnl >= 0;
  const heatPctLabel = `${session.heat.toFixed(1)}% / ${session.heatCap.toFixed(1)}%`;

  return (
    <div
      className="relative overflow-hidden rounded-[10px] border"
      style={{
        borderColor: "rgba(59,130,246,0.18)",
        background:
          "linear-gradient(135deg, hsl(var(--card)) 0%, #0d121c 60%, hsl(var(--card)) 100%)",
      }}
    >
      {/* Grid background overlay */}
      <div className="gridbg pointer-events-none absolute inset-0" />
      {/* Corner accent glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-[120px] -top-[120px] h-[360px] w-[360px] rounded-full"
        style={{
          background:
            "radial-gradient(circle, hsl(var(--accent-glow)) 0%, transparent 70%)",
          opacity: 0.55,
        }}
      />

      <div className="relative grid gap-7 px-8 pb-6 pt-7" style={{ gridTemplateColumns: "1.05fr 1fr 1fr" }}>
        {/* Col 1 — state + narrative */}
        <div className="flex flex-col gap-3.5">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center gap-2 rounded-full bg-obsidian-0 px-3 py-[5px]"
              style={{ boxShadow: `0 0 12px -4px ${mode.dotColor}` }}
            >
              <span
                className="inline-block h-[7px] w-[7px] rounded-full"
                style={{ background: mode.dotColor, boxShadow: `0 0 10px ${mode.dotColor}` }}
              />
              <span
                className="mono font-semibold uppercase tracking-[0.12em]"
                style={{ color: mode.dotColor, fontSize: 11 }}
              >
                {mode.label} MODE
              </span>
            </span>
            <Pill tone="accent">
              <Zap size={10} strokeWidth={2} className="-ml-0.5 mr-0.5" />
              ENGINE {session.engineVersion}
            </Pill>
          </div>

          <div>
            <div className="label mb-1.5">Current session</div>
            <div
              className="serif-ital text-fg-0"
              style={{ fontSize: 44, lineHeight: 1, fontWeight: 500, letterSpacing: "-0.02em" }}
            >
              The engine is{" "}
              <span style={{ color: mode.scanning ? "hsl(var(--accent-2))" : mode.dotColor }}>{mode.verb}</span>
              <br />
              {mode.scanning ? (
                <>
                  <span className="text-fg-1">{session.markets} markets</span> for edge.
                </>
              ) : (
                <span className="text-fg-1">— no markets streaming.</span>
              )}
            </div>
          </div>

          <p className="max-w-[380px] text-[12.5px] leading-[1.55] text-fg-1">
            {mode.subtitle}. Meta model gating at{" "}
            <span className="mono text-fg-0">p ≥ {session.metaThreshold.toFixed(2)}</span>.
            Ran <span className="mono text-fg-0">{session.signalsSeen}</span> candidates · took{" "}
            <span className="mono" style={{ color: "hsl(var(--accent-2))" }}>
              {session.signalsTaken}
            </span>{" "}
            this session.
          </p>

          <div className="mt-1 flex items-center gap-2">
            <HeroButton variant="primary">
              <Play size={11} strokeWidth={1.8} />
              Intervene
            </HeroButton>
            <HeroButton>
              <Pause size={11} strokeWidth={1.6} />
              Pause engine
            </HeroButton>
            <HeroButton>
              <ExternalLink size={11} strokeWidth={1.6} />
              Logs
            </HeroButton>
          </div>
        </div>

        {/* Col 2 — session P&L */}
        <div className="flex flex-col justify-center gap-1 border-l border-obsidian-line pl-7">
          <div className="label">Session P&amp;L</div>
          <div className="flex items-baseline gap-2">
            <div
              className="mono"
              style={{
                fontSize: 56,
                lineHeight: 1,
                fontWeight: 500,
                letterSpacing: "-0.03em",
                color: pnlUp ? "#39d98a" : "#ff5a6a",
                textShadow: pnlUp
                  ? "0 0 32px rgba(57,217,138,0.3)"
                  : "0 0 32px rgba(255,90,106,0.3)",
              }}
            >
              {pnlUp ? "+" : "-"}${fmt(Math.abs(pnl), 2)}
            </div>
          </div>

          <div className="mt-2.5 flex items-start gap-5 text-[12px]">
            <MiniStat label="Realized" value={`$${fmt(session.realized, 2)}`} />
            <MiniStat
              label="Unrealized"
              value={unreal === null ? "—" : `${unreal >= 0 ? "+" : "-"}$${fmt(Math.abs(unreal), 2)}`}
              tone={unreal === null ? "muted" : unreal >= 0 ? "up" : "down"}
              title={unreal === null ? "No PositionTracker snapshot — engine stopped" : "Open-position P&L from the runtime PositionTracker"}
            />
            <MiniStat
              label="In R"
              value={`+${session.pnlR.toFixed(2)}R`}
              tone="accent"
            />
          </div>

          <div className="mt-3.5">
            <Sparkline
              data={sparkData}
              width={320}
              height={32}
              strokeWidth={1.5}
              stroke={pnlUp ? "#39d98a" : "#ff5a6a"}
              autoColor={false}
              className="block"
            />
            <div className="mt-1 flex justify-between text-[10px] text-fg-3 mono">
              <span>{session.openedAt.slice(0, 5)}</span>
              <span>NOW</span>
            </div>
          </div>
        </div>

        {/* Col 3 — Heat + quick stats */}
        <div className="flex flex-col gap-2.5 border-l border-obsidian-line pl-7">
          <div className="flex items-center justify-between">
            <div className="label">Portfolio heat</div>
            <span className="mono text-[11px] text-fg-1">{heatPctLabel}</span>
          </div>
          <div className="relative">
            <HeatBar value={session.heat} cap={session.heatCap} warn={0.66} />
            <span
              aria-hidden
              className="absolute top-[-2px] h-2 w-px bg-warn"
              style={{ left: "66%" }}
            />
          </div>
          <div className="mono text-[10.5px] text-fg-3">0% — 2% — CAP 3%</div>

          <div className="my-1.5 h-px bg-obsidian-line" />

          <div className="flex flex-wrap gap-x-5 gap-y-3">
            <QuickStat label="Win rate" value={`${(session.winRate * 100).toFixed(1)}%`} tone="up" />
            <QuickStat label="Trades" value={String(session.trades)} />
            <QuickStat label="W/L" value={`${session.wins}/${session.losses}`} />
            <QuickStat label="Regime" value={regime.label} small />
            <QuickStat label="TF" value={regime.timeframe} />
            <QuickStat label="Uptime" value={session.uptime} />
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone = "neutral",
  title,
}: {
  label: string;
  value: string;
  tone?: "up" | "down" | "accent" | "neutral" | "muted";
  title?: string;
}) {
  const COLOR: Record<typeof tone, string> = {
    up: "text-up",
    down: "text-down",
    accent: "text-accent",
    neutral: "text-fg-0",
    muted: "text-fg-3",
  } as const;
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="mono text-[9px] font-medium uppercase tracking-[0.12em] text-fg-2">
        {label}
      </span>
      <span className={cn("mono font-medium", COLOR[tone])}>{value}</span>
    </div>
  );
}

function QuickStat({
  label,
  value,
  tone,
  small,
}: {
  label: string;
  value: string;
  tone?: "up" | "down" | "accent";
  small?: boolean;
}) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "accent" ? "text-accent" : "text-fg-0";
  return (
    <div className="flex flex-col gap-0.5" style={{ minWidth: small ? 84 : 56 }}>
      <span className="mono text-[9px] font-medium uppercase tracking-[0.12em] text-fg-2">
        {label}
      </span>
      <span
        className={cn("mono font-medium", color)}
        style={{ fontSize: small ? 11 : 15, letterSpacing: small ? "0.04em" : "-0.01em" }}
      >
        {value}
      </span>
    </div>
  );
}

function HeroButton({
  variant,
  children,
}: {
  variant?: "primary";
  children: React.ReactNode;
}) {
  if (variant === "primary") {
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11.5px] font-medium text-accent-ink transition-colors hover:bg-accent-2 shadow-accent-glow"
      >
        {children}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-md border border-obsidian-line bg-obsidian-2 px-3 py-1.5 text-[11.5px] font-medium text-fg-1 transition-colors hover:bg-obsidian-3 hover:text-fg-0"
    >
      {children}
    </button>
  );
}
