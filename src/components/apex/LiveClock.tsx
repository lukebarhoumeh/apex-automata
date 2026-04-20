import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface LiveClockProps {
  className?: string;
  showDot?: boolean;
}

function formatUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

export function LiveClock({ className, showDot = true }: LiveClockProps) {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {showDot && <span className="dot-live" />}
      <span className="mono text-[11px] font-medium text-fg-1">
        {formatUtc(now)}
      </span>
    </div>
  );
}
