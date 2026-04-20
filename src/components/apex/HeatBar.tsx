import { cn } from "@/lib/utils";

interface HeatBarProps {
  value: number;
  cap?: number;
  warn?: number;
  className?: string;
}

export function HeatBar({ value, cap = 1, warn = 0.7, className }: HeatBarProps) {
  const clamped = Math.max(0, Math.min(value, cap));
  const pct = (clamped / cap) * 100;
  const over = clamped / cap > warn;
  return (
    <div
      className={cn(
        "relative h-1 w-full overflow-hidden rounded-full bg-obsidian-3",
        className,
      )}
    >
      <div
        className={cn(
          "absolute inset-y-0 left-0 rounded-full transition-all duration-300",
          over ? "bg-warn" : "bg-up",
        )}
        style={{
          width: `${pct}%`,
          boxShadow: over
            ? "0 0 8px -1px rgba(255,176,32,0.45)"
            : "0 0 8px -1px rgba(57,217,138,0.45)",
        }}
      />
    </div>
  );
}
