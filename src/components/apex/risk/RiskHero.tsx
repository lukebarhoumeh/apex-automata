import { Power } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { PortfolioRisk, KillLadderRow } from "@/types/risk";

interface Props {
  portfolio: PortfolioRisk;
  killLadder: readonly KillLadderRow[];
}

function CircuitBar({
  label,
  v,
  cap,
  unit,
  tone,
}: {
  label: string;
  v: number;
  cap: number;
  unit: string;
  tone: string;
}) {
  const pct = Math.min(100, (v / cap) * 100);
  return (
    <div>
      <div className="mb-0.5 flex justify-between text-[11px]">
        <span className="mono text-[10px] uppercase tracking-[0.12em] text-fg-2">{label}</span>
        <span className="mono text-[11px]">
          <span className="text-fg-0">
            {v.toFixed(1)}
            {unit}
          </span>
          <span className="text-fg-3">
            {" "}
            / {cap}
            {unit}
          </span>
        </span>
      </div>
      <div className="h-[5px] w-full overflow-hidden rounded-full bg-obsidian-3">
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function RiskHero({ portfolio, killLadder }: Props) {
  const tripped = killLadder.filter((l) => l.tripped).length;

  return (
    <Panel header={false} pad={0} className="relative overflow-hidden" tone="default">
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          background:
            "linear-gradient(135deg, hsl(var(--obsidian-1)) 0%, #0d121c 60%, hsl(var(--obsidian-1)) 100%)",
        }}
      />
      <div
        className="pointer-events-none absolute"
        style={{
          top: -120,
          right: -120,
          width: 360,
          height: 360,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(255,90,106,0.16) 0%, transparent 70%)",
        }}
      />
      <div className="relative grid gap-7 p-7" style={{ gridTemplateColumns: "1.1fr 1fr 1fr" }}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Pill tone="down" dot>
              RISK DESK
            </Pill>
            <Pill tone="default">ARMED · {tripped}/5 TRIPPED</Pill>
          </div>
          <div
            className="serif-ital text-fg-0"
            style={{ fontSize: 40, lineHeight: 1.05, fontWeight: 500, letterSpacing: "-0.02em" }}
          >
            <span className="text-down">Risk is what</span>
            <br />
            we <span className="text-fg-1">refuse to take.</span>
          </div>
          <p className="max-w-[380px] text-[12.5px] leading-[1.55] text-fg-1">
            Exposure <span className="mono text-fg-0">${portfolio.exposure.toLocaleString()}</span> on{" "}
            <span className="mono text-fg-0">${portfolio.equity.toLocaleString()}</span> equity. Heat at{" "}
            <span className="mono text-accent">{portfolio.heat.toFixed(2)}%</span>, drawdown{" "}
            <span className="mono text-up">{portfolio.dd.toFixed(1)}%</span>.
          </p>
          <div className="flex gap-2">
            <button className="inline-flex items-center gap-1.5 rounded-md border border-down/40 bg-down/10 px-3 py-1.5 text-[12px] font-medium text-down hover:bg-down/20">
              <Power size={12} /> KILL ALL
            </button>
            <button className="inline-flex items-center gap-1.5 rounded-md border border-obsidian-line bg-obsidian-2 px-3 py-1.5 text-[12px] text-fg-1 hover:bg-obsidian-3">
              Edit limits
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-l border-obsidian-line px-6">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            VaR · 95% · 99%
          </span>
          <div>
            <div
              className="mono text-[36px] font-medium text-down"
              style={{ textShadow: "0 0 24px rgba(255,90,106,0.25)" }}
            >
              -${portfolio.var95.toLocaleString()}
            </div>
            <div className="mono mt-0.5 text-[10px] uppercase text-fg-2">1-DAY 95% VaR</div>
          </div>
          <div className="flex gap-5">
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">99% VaR</div>
              <div className="mono text-[15px] text-down">-${portfolio.var99.toLocaleString()}</div>
            </div>
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">EXP. SHORTFALL</div>
              <div className="mono text-[15px] text-down">
                -${portfolio.expectedShortfall.toLocaleString()}
              </div>
            </div>
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">NET BETA</div>
              <div className="mono text-[15px] text-fg-0">{portfolio.netBeta.toFixed(2)}</div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 border-l border-obsidian-line px-6">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            CIRCUIT BREAKERS
          </span>
          <CircuitBar
            label="Portfolio Heat"
            v={portfolio.heat}
            cap={portfolio.heatCap}
            unit="%"
            tone="bg-accent"
          />
          <CircuitBar
            label="Drawdown"
            v={portfolio.dd}
            cap={portfolio.ddCap}
            unit="%"
            tone="bg-warn"
          />
          <CircuitBar
            label="Consec Losses"
            v={portfolio.consecLosses}
            cap={portfolio.consecCap}
            unit=""
            tone="bg-down"
          />
        </div>
      </div>
    </Panel>
  );
}
