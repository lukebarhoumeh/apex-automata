import { FlaskConical } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { cn } from "@/lib/utils";
import type { BacktestResults, BacktestConfig } from "@/types/backtest";

interface Props {
  config: BacktestConfig;
  results: BacktestResults;
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex justify-between text-[11.5px]">
      <span className="mono text-[10px] uppercase text-fg-2">{k}</span>
      <span className={cn("mono", tone || "text-fg-0")}>{v}</span>
    </div>
  );
}

export function BacktestHero({ config, results }: Props) {
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
          background: "radial-gradient(circle, hsl(var(--up) / 0.28) 0%, transparent 70%)",
          opacity: 0.5,
        }}
      />
      <div className="relative grid gap-7 p-7" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Pill tone="up">
              <FlaskConical size={10} strokeWidth={2} /> BACKTEST ENGINE
            </Pill>
            <Pill tone="default">v2.4.1</Pill>
          </div>
          <div
            className="serif-ital text-fg-0"
            style={{ fontSize: 38, lineHeight: 1.05, fontWeight: 500, letterSpacing: "-0.02em" }}
          >
            <span className="text-up">Test</span> before
            <br />
            you <span className="text-fg-1">trust.</span>
          </div>
          <p className="max-w-[380px] text-[12.5px] leading-[1.55] text-fg-1">
            Simulated <span className="mono text-fg-0">{results.trades}</span> trades across{" "}
            <span className="mono text-fg-0">{config.symbols.length}</span> symbols over{" "}
            <span className="mono text-fg-0">90 days</span>. Fees and slippage modeled.
          </p>
        </div>

        <div className="flex flex-col gap-3 border-l border-obsidian-line px-6">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            RETURN · SHARPE · DD
          </span>
          <div>
            <div
              className="mono text-[48px] font-medium text-up leading-none"
              style={{ textShadow: "0 0 24px hsl(var(--up) / 0.45)" }}
            >
              +{results.totalReturn.toFixed(2)}%
            </div>
            <div className="mono mt-1 text-[10px] uppercase text-fg-2">TOTAL RETURN · 90D</div>
          </div>
          <div className="mt-1 flex gap-5">
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">SHARPE</div>
              <div className="mono text-[17px] text-up">{results.sharpe.toFixed(2)}</div>
            </div>
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">SORTINO</div>
              <div className="mono text-[17px] text-fg-0">{results.sortino.toFixed(2)}</div>
            </div>
            <div>
              <div className="mono text-[10px] uppercase text-fg-2">MAX DD</div>
              <div className="mono text-[17px] text-down">-{results.maxDD.toFixed(1)}%</div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 border-l border-obsidian-line px-6">
          <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
            TRADE ECONOMICS
          </span>
          <Row k="WIN RATE" v={`${(results.winRate * 100).toFixed(1)}%`} />
          <Row k="AVG R" v={`${results.avgR.toFixed(2)}R`} tone="text-up" />
          <Row k="PROFIT FACTOR" v={results.profitFactor.toFixed(2)} />
          <Row k="TRADES" v={`${results.trades}`} />
          <Row k="AVG HOLD" v={`${results.avgHoldHrs}h`} />
          <Row k="TURNOVER" v={`${results.turnover}×`} />
        </div>
      </div>
    </Panel>
  );
}
