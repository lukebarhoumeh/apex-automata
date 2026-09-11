import { Check, CircleX, ListOrdered, TriangleAlert, Activity, type LucideIcon } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { cn } from "@/lib/utils";
import type { OrderStats } from "@/types/orders";

interface MetricTile {
  label: string;
  value: number;
  tone: "neutral" | "up" | "accent" | "warn" | "down";
  sub?: string;
  icon: LucideIcon;
}

const TONE_TEXT: Record<MetricTile["tone"], string> = {
  neutral: "text-fg-0",
  up: "text-up",
  accent: "text-accent",
  warn: "text-fg-1",
  down: "text-down",
};

const TONE_ICON: Record<MetricTile["tone"], string> = {
  neutral: "text-fg-2",
  up: "text-up",
  accent: "text-accent",
  warn: "text-fg-2",
  down: "text-down",
};

interface OrdersKpiStripProps {
  stats: OrderStats;
  /** What window the counts describe, e.g. "this session" or "recent · engine stopped". */
  scopeLabel?: string;
}

export function OrdersKpiStrip({ stats, scopeLabel = "this session" }: OrdersKpiStripProps) {
  const tiles: MetricTile[] = [
    { label: `Orders · ${scopeLabel}`, value: stats.total, tone: "neutral", icon: ListOrdered },
    {
      label: "Filled",
      value: stats.filled,
      tone: "up",
      sub: `${(stats.fillRate * 100).toFixed(0)}%`,
      icon: Check,
    },
    { label: "Pending", value: stats.pending, tone: "accent", icon: Activity },
    { label: "Cancelled", value: stats.cancelled, tone: "warn", icon: CircleX },
    { label: "Rejected", value: stats.rejected, tone: "down", icon: TriangleAlert },
  ];

  return (
    <div className="grid grid-cols-5 gap-4">
      {tiles.map((t) => {
        const Icon = t.icon;
        return (
          <Panel key={t.label} header={false} pad={14}>
            <div className="flex items-center justify-between">
              <span className="label">{t.label}</span>
              <Icon size={14} strokeWidth={1.6} className={cn(TONE_ICON[t.tone], "opacity-70")} />
            </div>
            <div className={cn("mono mt-1.5 text-[22px] font-medium leading-none", TONE_TEXT[t.tone])}>
              {t.value}
            </div>
            {t.sub && <div className="mt-0.5 text-[11px] text-fg-2">{t.sub}</div>}
          </Panel>
        );
      })}
    </div>
  );
}
