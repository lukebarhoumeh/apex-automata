import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface StatProps {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  tone?: "up" | "down" | "accent" | "neutral";
  large?: boolean;
  right?: ReactNode;
  className?: string;
}

const TONE_CLASSES = {
  up: "text-up",
  down: "text-down",
  accent: "text-accent",
  neutral: "text-fg-0",
} as const;

export function Stat({
  label,
  value,
  delta,
  tone = "neutral",
  large,
  right,
  className,
}: StatProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] font-medium tracking-[0.09em] uppercase text-fg-2">
          {label}
        </span>
        {right}
      </div>
      <div
        className={cn(
          "mono font-medium leading-none",
          large ? "text-[26px]" : "text-[20px]",
          TONE_CLASSES[tone],
        )}
      >
        {value}
      </div>
      {delta && (
        <div className="text-[11px] text-fg-2 mt-0.5">{delta}</div>
      )}
    </div>
  );
}
