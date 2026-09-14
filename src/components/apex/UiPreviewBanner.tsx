import { Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { UI_PREVIEW_BANNER } from "@/lib/ui-preview";

/**
 * Global banner for `VITE_UI_PREVIEW=1` builds. Distinct from `DemoBanner`
 * (seeded fixtures on Model/Backtest/Journal). Paper-SoT pages stay honest
 * idle/stopped — this only tells the viewer the runtime is not attached.
 */
export function UiPreviewBanner({ className }: { className?: string }) {
  return (
    <div
      role="status"
      data-testid="ui-preview-banner"
      className={cn(
        "flex items-start gap-3 border-b border-accent/30 bg-accent/10 px-6 py-2.5",
        className,
      )}
    >
      <Eye size={15} className="mt-0.5 shrink-0 text-accent" strokeWidth={1.8} />
      <p className="text-[12.5px] leading-[1.45] text-fg-1">
        <span className="mono font-semibold uppercase tracking-[0.1em] text-accent">UI preview</span>
        <span className="mt-0.5 block text-fg-2">{UI_PREVIEW_BANNER}</span>
      </p>
    </div>
  );
}
