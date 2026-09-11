import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useConnectivity } from "@/runtime/connectivity";
import { useRuntimeStatus } from "@/hooks/useRuntimeStatus";
import { useMetaFilterStatus } from "@/hooks/apex/useDashboardData";
import {
  deriveFooterChips,
  deriveFooterSessionText,
  type ChipStatus,
  type FooterChip,
} from "./footer-chips";

const DOT_CLASSES: Record<ChipStatus, string> = {
  ok: "bg-up shadow-[0_0_0_2px_rgba(57,217,138,0.2)]",
  warn: "bg-warn shadow-[0_0_0_2px_rgba(255,176,32,0.2)]",
  down: "bg-down shadow-[0_0_0_2px_rgba(255,90,106,0.2)]",
  idle: "bg-fg-3",
};

function StatusChip({ chip }: { chip: FooterChip }) {
  return (
    <div className="flex items-center gap-1.5" title={chip.title} data-testid={`footer-chip-${chip.key}`}>
      <span className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASSES[chip.status])} />
      <span className={cn("mono text-[11px] uppercase tracking-wider", chip.status === "idle" ? "text-fg-3" : "text-fg-2")}>
        {chip.label} · {chip.suffix}
      </span>
    </div>
  );
}

/** Coarse clock so "Ns ago" labels tick without re-deriving on every render. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Footer health strip. Every chip is derived from GET /api/status (merged
 * with the WS StatusUpdate stream), the connectivity state machine and the
 * meta-filter status — see footer-chips.ts. No seeded PID/build/latency.
 */
export function Footer() {
  const { data: status } = useRuntimeStatus();
  const connectivity = useConnectivity();
  const { data: metaFilter } = useMetaFilterStatus();
  const now = useNow(5_000);

  const chips = deriveFooterChips({
    status,
    connectivity,
    metaFilterEnabled: metaFilter?.enabled,
    now,
  });

  return (
    <footer className="flex h-10 items-center justify-between border-t border-obsidian-line bg-obsidian-1 px-4">
      <div className="flex items-center gap-5">
        {chips.map((chip) => (
          <StatusChip key={chip.key} chip={chip} />
        ))}
      </div>
      <div className="mono text-[11px] uppercase tracking-wider text-fg-2" data-testid="footer-session">
        {deriveFooterSessionText(status, connectivity, now)}
      </div>
    </footer>
  );
}
