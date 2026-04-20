import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type PillTone = "default" | "up" | "down" | "warn" | "accent" | "info";

const TONE_CLASSES: Record<PillTone, string> = {
  default: "bg-obsidian-3 text-fg-1 border-obsidian-line-2",
  up: "bg-up/[0.08] text-up border-up/20",
  down: "bg-down/[0.08] text-down border-down/20",
  warn: "bg-warn/[0.08] text-warn border-warn/20",
  info: "bg-info/[0.08] text-info border-info/20",
  accent: "bg-accent/[0.12] text-accent border-accent/30",
};

interface PillProps {
  tone?: PillTone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
}

export function Pill({ tone = "default", dot, children, className }: PillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px]",
        "font-mono text-[10.5px] font-medium uppercase tracking-wider",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {dot && (
        <span
          className={cn(
            "inline-block w-[5px] h-[5px] rounded-full",
            tone === "up" && "bg-up shadow-[0_0_0_2px_rgba(57,217,138,0.25)]",
            tone === "down" && "bg-down shadow-[0_0_0_2px_rgba(255,90,106,0.25)]",
            tone === "warn" && "bg-warn",
            tone === "info" && "bg-info",
            tone === "accent" && "bg-accent",
            tone === "default" && "bg-fg-2",
          )}
        />
      )}
      {children}
    </span>
  );
}
