import { AlertTriangle } from "lucide-react";
import { useActiveSession } from "@/runtime/session";

interface DemoDataBannerProps {
  /** What the page shows, e.g. "backtest results". */
  subject: string;
}

/**
 * Marks a page whose content comes from seeded fixtures
 * (`hooks/apex/mock/seed-data.ts`), not from the runtime or Supabase, so it
 * can never be mistaken for the live paper session — especially while one is
 * running (TASK_016 step 7 / P6).
 */
export function DemoDataBanner({ subject }: DemoDataBannerProps) {
  const { engineRunning, mode } = useActiveSession();
  return (
    <div
      className="flex items-start gap-3 rounded-md border border-warn/30 bg-warn/10 px-4 py-3"
      role="note"
      data-testid="demo-data-banner"
    >
      <AlertTriangle size={16} className="mt-0.5 text-warn" strokeWidth={1.8} />
      <div className="text-[12.5px] leading-[1.5] text-fg-1">
        <span className="mono font-semibold uppercase tracking-[0.1em] text-warn">Demo data — not the paper session</span>
        <span className="mx-2 text-fg-3">·</span>
        The {subject} on this page are seeded design fixtures. They are not read from the runtime API or
        Supabase and do not change when the engine trades.
        {engineRunning && (
          <>
            {" "}
            A <span className="mono uppercase text-fg-0">{mode ?? "paper"}</span> session is running right now —
            use the Dashboard, Orders, Signals and Risk pages for its real state.
          </>
        )}
      </div>
    </div>
  );
}
