import { Play, Settings as SettingsIcon } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { cn } from "@/lib/utils";
import type { BacktestConfig } from "@/types/backtest";

const AVAILABLE_SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD", "AVAX-USD", "LINK-USD", "ARB-USD"];

interface Props {
  config: BacktestConfig;
  preset: string;
}

function ConfigField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="mono text-[10px] uppercase tracking-[0.12em] text-fg-2">{label}</span>
      {children}
    </div>
  );
}

function ConfigSlider({
  label,
  value,
  min,
  max,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  format?: (v: number) => string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="mb-1.5 flex justify-between">
        <span className="mono text-[10px] uppercase tracking-[0.12em] text-fg-2">{label}</span>
        <span className="mono text-[11px] text-fg-0">{format ? format(value) : value}</span>
      </div>
      <div className="relative h-1 rounded-full bg-obsidian-3">
        <div
          className="absolute left-0 top-0 h-full rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function ConfigPanel({ config, preset }: Props) {
  return (
    <Panel
      header
      pad={0}
      title="CONFIGURATION"
      right={
        <div className="flex items-center gap-2">
          <SettingsIcon size={14} className="text-accent" strokeWidth={1.6} />
          <span className="mono text-[11px] text-fg-2">{preset}</span>
        </div>
      }
    >
      <div
        className="grid items-end gap-4 p-5"
        style={{ gridTemplateColumns: "repeat(4, 1fr) auto" }}
      >
        <ConfigField label="STRATEGY">
          <div className="rounded-md border border-obsidian-line bg-obsidian-2 px-3 py-2 text-[12px] text-fg-0">
            {config.strategy}
          </div>
        </ConfigField>
        <ConfigField label="SYMBOLS">
          <div className="flex flex-wrap gap-1.5">
            {AVAILABLE_SYMBOLS.map((s) => {
              const on = config.symbols.includes(s);
              return (
                <span
                  key={s}
                  className={cn(
                    "mono rounded-md px-2 py-1 text-[10px] uppercase",
                    on
                      ? "bg-accent/15 text-accent border border-accent/30"
                      : "bg-obsidian-3 text-fg-2 border border-obsidian-line",
                  )}
                >
                  {s.split("-")[0]}
                </span>
              );
            })}
          </div>
        </ConfigField>
        <ConfigField label="DATE RANGE">
          <div className="mono flex items-center gap-2 text-[11px] text-fg-0">
            <span className="rounded-md border border-obsidian-line bg-obsidian-2 px-2 py-1.5">
              {config.from}
            </span>
            <span className="text-fg-2">→</span>
            <span className="rounded-md border border-obsidian-line bg-obsidian-2 px-2 py-1.5">
              {config.to}
            </span>
          </div>
        </ConfigField>
        <ConfigField label="INITIAL CAPITAL">
          <div className="mono rounded-md border border-obsidian-line bg-obsidian-2 px-3 py-2 text-[12px] text-fg-0">
            ${config.initialCapital.toLocaleString()}
          </div>
        </ConfigField>
        <button className="inline-flex h-10 items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-5 text-[12px] font-semibold uppercase tracking-wider text-accent hover:bg-accent/20">
          <Play size={14} strokeWidth={2} /> RUN BACKTEST
        </button>
      </div>
      <div className="grid grid-cols-4 gap-4 border-t border-obsidian-line px-5 pb-5 pt-4">
        <ConfigSlider
          label="RISK PER TRADE"
          value={config.riskPerTrade}
          min={0.1}
          max={2.0}
          format={(v) => `${v.toFixed(1)}%`}
        />
        <ConfigSlider
          label="META THRESHOLD"
          value={config.metaThreshold}
          min={0.5}
          max={0.9}
          format={(v) => `${(v * 100).toFixed(0)}%`}
        />
        <ConfigSlider
          label="SLIPPAGE (BPS)"
          value={config.slippageBps}
          min={0}
          max={10}
          format={(v) => `${v.toFixed(1)}bp`}
        />
        <ConfigSlider
          label="FEE (BPS)"
          value={config.feeBps}
          min={0}
          max={30}
          format={(v) => `${v.toFixed(1)}bp`}
        />
      </div>
    </Panel>
  );
}
