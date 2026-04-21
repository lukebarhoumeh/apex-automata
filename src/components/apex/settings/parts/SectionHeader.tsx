import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  tone?: "accent" | "up" | "down" | "warn" | "fg-1";
}

const TONE_CLASSES: Record<NonNullable<Props["tone"]>, { text: string; bg: string; border: string }> = {
  accent: { text: "text-accent", bg: "bg-accent/15", border: "border-accent/35" },
  up:     { text: "text-up",     bg: "bg-up/15",     border: "border-up/35" },
  down:   { text: "text-down",   bg: "bg-down/15",   border: "border-down/35" },
  warn:   { text: "text-warn",   bg: "bg-warn/15",   border: "border-warn/35" },
  "fg-1": { text: "text-fg-1",   bg: "bg-obsidian-2", border: "border-obsidian-line" },
};

export function SectionHeader({ icon: Icon, title, subtitle, tone = "accent" }: Props) {
  const cls = TONE_CLASSES[tone];
  return (
    <div className="flex items-center gap-3 border-b border-obsidian-line px-5 py-4">
      <div
        className={cn(
          "grid h-9 w-9 place-items-center rounded-md border",
          cls.text,
          cls.bg,
          cls.border,
        )}
      >
        <Icon size={18} strokeWidth={1.6} />
      </div>
      <div>
        <div className="text-[16px] font-semibold text-fg-0" style={{ letterSpacing: "-0.01em" }}>
          {title}
        </div>
        <div className="mt-0.5 text-[11.5px] text-fg-2">{subtitle}</div>
      </div>
    </div>
  );
}
