import { useEffect, useState } from "react";
import { fmtDuration } from "@/components/apex/format";

/** Ticks once a second; returns uptime since the hook first mounted (proxy for session). */
export function useSessionUptime(): string {
  const [startedAt] = useState(() => Date.now());
  const [uptime, setUptime] = useState(() => fmtDuration(0));

  useEffect(() => {
    const tick = () => setUptime(fmtDuration(Date.now() - startedAt));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return uptime;
}
