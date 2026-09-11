import { Check, CircleX, ListOrdered, TriangleAlert, Activity, type LucideIcon } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { cn } from "@/lib/utils";
import { hasActiveSession, type SessionScope } from "@/lib/session-scope";
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
  /** Active runtime session the counts are scoped to (from /api/status). */
  session: SessionScope;
}

export function OrdersKpiStrip({ stats, session }: OrdersKpiStripProps) {
  const active = hasActiveSession(session);
  const tiles: MetricTile[] = [
    { label: "Orders · session", value: stats.total, tone: "neutral", icon: ListOrdered },
    {
      label: "Filled",
      value: stats.filled,
      tone: "up",
      sub: active && stats.total > 0 ? `${(stats.fillRate * 100).toFixed(0)}%` : undefined,
      icon: Check,
    },
    { label: "Pending", value: stats.pending, tone: "accent", icon: Activity },
    { label: "Cancelled", value: stats.cancelled, tone: "warn", icon: CircleX },
    { label: "Rejected", value: stats.rejected, tone: "down", icon: TriangleAlert },
  ];

  return (
    <div className="grid grid-cols-5 gap-4" data-testid="orders-kpi-strip">
      {tiles.map((t) => {
        const Icon = t.icon;
        return (
          <Panel key={t.label} header={false} pad={14}>
            <div className="flex items-center justify-between">
              <span className="label">{t.label}</span>
              <Icon size={14} strokeWidth={1.6} className={cn(TONE_ICON[t.tone], "opacity-70")} />
            </div>
            <div
              className={cn("mono mt-1.5 text-[22px] font-medium leading-none", active ? TONE_TEXT[t.tone] : "text-fg-3")}
              title={active ? "Counted over this session's orders" : "No active session"}
            >
              {active ? t.value : "—"}
            </div>
            {t.sub && <div className="mt-0.5 text-[11px] text-fg-2">{t.sub}</div>}
          </Panel>
        );
      })}
    </div>
  );
}
