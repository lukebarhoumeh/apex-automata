import { useEffect, useState } from "react";
import { fmtDuration } from "@/components/apex/format";

/**
 * Ticks once a second; returns the elapsed time since `startedAt` (the
 * runtime's `sessionStartedAt`) or "—" when there is no active session.
 * Previously measured time since page mount, which is not a session.
 */
export function useSessionUptime(startedAt: number | null | undefined): string {
  const [uptime, setUptime] = useState(() => format(startedAt));

  useEffect(() => {
    const tick = () => setUptime(format(startedAt));
    tick();
    if (!startedAt) return;
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return uptime;
}

function format(startedAt: number | null | undefined): string {
  if (!startedAt || !Number.isFinite(startedAt)) return "—";
  return fmtDuration(Math.max(0, Date.now() - startedAt));
}
