import { Panel } from "@/components/apex/Panel";
import { Sparkline } from "@/components/apex/Sparkline";
import { cn } from "@/lib/utils";
import type { KpiTile } from "@/types/kpi";

interface KpiRowProps {
  tiles: readonly KpiTile[];
}

const TONE_COLOR: Record<KpiTile["tone"], string> = {
  up: "text-up",
  down: "text-down",
  accent: "text-accent",
  neutral: "text-fg-0",
};

const TONE_SPARK: Record<KpiTile["tone"], string> = {
  up: "#39d98a",
  down: "#ff5a6a",
  accent: "hsl(var(--accent))",
  neutral: "#7aa4ff",
};

export function KpiRow({ tiles }: KpiRowProps) {
  return (
    <div className="grid grid-cols-4 gap-4">
      {tiles.map((tile) => (
        <Panel key={tile.key} header={false} pad={16} className="relative overflow-hidden">
          <div className="label">{tile.label}</div>
          <div className={cn("mono mt-1 text-[26px] font-medium leading-none", TONE_COLOR[tile.tone])}>
            {tile.value}
          </div>
          <div className="mt-1.5 text-[11px] text-fg-2">{tile.delta}</div>
          {tile.sparkline && tile.sparkline.length > 0 && (
            <div className="pointer-events-none absolute bottom-3 right-3 opacity-90">
              <Sparkline
                data={tile.sparkline}
                width={96}
                height={28}
                strokeWidth={1.4}
                stroke={TONE_SPARK[tile.tone]}
                autoColor={false}
              />
            </div>
          )}
        </Panel>
      ))}
    </div>
  );
}
