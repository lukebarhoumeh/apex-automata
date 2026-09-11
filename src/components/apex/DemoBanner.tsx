import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

interface DemoBannerProps {
  /** What on this page is seeded, and where the real source of truth lives. */
  detail: React.ReactNode;
  className?: string;
}

/**
 * Quarantine banner for pages still fed by `src/hooks/apex/mock/seed-data.ts`.
 * Every number below it is a design fixture — not the active paper session,
 * not Supabase history, not a live venue or key. Paper-SoT views (Dashboard,
 * Orders, Signals, Risk) must never render this component.
 */
export function DemoBanner({ detail, className }: DemoBannerProps) {
  return (
    <div
      role="note"
      data-testid="demo-banner"
      className={cn(
        "flex items-start gap-3 rounded-md border border-warn/40 bg-warn/10 px-4 py-3",
        className,
      )}
    >
      <FlaskConical size={16} className="mt-0.5 shrink-0 text-warn" strokeWidth={1.8} />
      <div className="text-[12.5px] leading-[1.5] text-fg-1">
        <span className="mono font-semibold uppercase tracking-[0.1em] text-warn">
          Demo data — seeded fixtures, not the paper session
        </span>
        <div className="mt-1 text-fg-2">{detail}</div>
      </div>
    </div>
  );
}

/** Compact chip for nav / breadcrumbs / heroes of demo-only surfaces. */
export function DemoPill({ className, label = "DEMO" }: { className?: string; label?: string }) {
  return (
    <span
      data-testid="demo-pill"
      title="Seeded demo fixtures (src/hooks/apex/mock/seed-data.ts) — not wired to the runtime or Supabase"
      className={cn(
        "mono inline-flex items-center rounded-full border border-warn/40 bg-warn/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.12em] text-warn",
        className,
      )}
    >
      {label}
    </span>
  );
}
