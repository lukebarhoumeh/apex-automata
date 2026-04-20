import { Panel } from "@/components/apex/Panel";
import { cn } from "@/lib/utils";
import type { MarketRegime, RegimeMeter } from "@/types/regime";

interface RegimeCardProps {
  regime: MarketRegime;
  className?: string;
}

const TONE_BAR: Record<RegimeMeter["tone"], string> = {
  up: "bg-up",
  down: "bg-down",
  warn: "bg-warn",
  info: "bg-info",
  default: "bg-fg-2",
};

const TONE_TEXT: Record<RegimeMeter["tone"], string> = {
  up: "text-up",
  down: "text-down",
  warn: "text-warn",
  info: "text-info",
  default: "text-fg-1",
};

export function RegimeCard({ regime, className }: RegimeCardProps) {
  return (
    <Panel
      header
      pad={20}
      title={`Regime · ${regime.timeframe}`}
      className={cn("h-full", className)}
    >
      <div className="flex flex-col gap-5">
        <div
          className="serif-ital text-fg-0"
          style={{ fontSize: 40, lineHeight: 1, fontWeight: 500, letterSpacing: "-0.015em" }}
        >
          {regime.label}
        </div>

        <div className="flex flex-col gap-3">
          {regime.meters.map((m) => (
            <Meter key={m.key} meter={m} />
          ))}
        </div>
      </div>
    </Panel>
  );
}

function Meter({ meter }: { meter: RegimeMeter }) {
  const pct = Math.max(0, Math.min(meter.value / meter.cap, 1)) * 100;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
          {meter.label}
        </span>
        <span className={cn("mono text-[11px] font-medium", TONE_TEXT[meter.tone])}>
          {meter.display}
        </span>
      </div>
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-obsidian-3">
        <div
          className={cn("absolute inset-y-0 left-0 rounded-full", TONE_BAR[meter.tone])}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
