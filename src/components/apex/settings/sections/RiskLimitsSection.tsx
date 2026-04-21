import { Shield } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { SectionHeader } from "@/components/apex/settings/parts/SectionHeader";
import { ToggleSwitch } from "@/components/apex/settings/parts/ToggleSwitch";
import type { RiskLimits } from "@/types/settings";

interface Props {
  limits: RiskLimits;
  onChange: (next: RiskLimits) => void;
}

function RiskSlider({
  label,
  value,
  min,
  max,
  unit,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  hint?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const display = unit === "$" ? `$${value.toLocaleString()}` : `${value}${unit}`;
  return (
    <div>
      <div className="mb-1 flex justify-between">
        <span className="mono text-[10px] uppercase tracking-[0.12em] text-fg-2">{label}</span>
        <span className="mono text-[13px] font-medium text-down">{display}</span>
      </div>
      <div className="relative h-1 w-full rounded-full bg-obsidian-3">
        <div
          className="absolute left-0 top-0 h-full rounded-full bg-down"
          style={{ width: `${pct}%` }}
        />
      </div>
      {hint && <div className="mt-1 text-[11px] leading-[1.4] text-fg-2">{hint}</div>}
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  on,
  onChange,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      className="grid items-center gap-3 border-b border-obsidian-line py-2.5 last:border-b-0"
      style={{ gridTemplateColumns: "1fr auto" }}
    >
      <div>
        <div className="text-[12.5px] font-medium text-fg-0">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-fg-2">{hint}</div>}
      </div>
      <ToggleSwitch on={on} onChange={onChange} />
    </div>
  );
}

export function RiskLimitsSection({ limits, onChange }: Props) {
  const set = (patch: Partial<RiskLimits>) => onChange({ ...limits, ...patch });
  return (
    <Panel header={false} pad={0}>
      <SectionHeader
        icon={Shield}
        title="Risk limits"
        subtitle="Hard ceilings the engine will not cross"
        tone="down"
      />
      <div className="grid gap-5 p-5 md:grid-cols-2">
        <RiskSlider
          label="MAX PORTFOLIO HEAT"
          value={limits.maxPortfolioHeatPct}
          min={0.5}
          max={5}
          unit="%"
          hint="Sum of open-risk across all positions."
        />
        <RiskSlider
          label="MAX DRAWDOWN"
          value={limits.maxDrawdownPct}
          min={2}
          max={20}
          unit="%"
          hint="Flatten all when exceeded."
        />
        <RiskSlider
          label="MAX POSITION SIZE"
          value={limits.maxPositionPct}
          min={5}
          max={80}
          unit="%"
          hint="% of portfolio per single symbol."
        />
        <RiskSlider
          label="MAX CONSEC LOSSES"
          value={limits.maxConsecLosses}
          min={2}
          max={10}
          unit=""
          hint="Pause strategy on threshold."
        />
        <RiskSlider
          label="MAX DAILY LOSS"
          value={limits.maxDailyLoss}
          min={500}
          max={10_000}
          unit="$"
          hint="Stop trading for the day."
        />
      </div>
      <div className="border-t border-obsidian-line px-5 py-3">
        <ToggleRow
          label="Allow short selling"
          hint="If off, engine will only take long positions."
          on={limits.allowShort}
          onChange={(v) => set({ allowShort: v })}
        />
        <ToggleRow
          label="Allow overnight positions"
          hint="If off, engine will flatten positions before session close."
          on={limits.allowOvernight}
          onChange={(v) => set({ allowOvernight: v })}
        />
      </div>
    </Panel>
  );
}
