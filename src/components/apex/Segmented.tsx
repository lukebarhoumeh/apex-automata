import { cn } from "@/lib/utils";

interface SegmentedOption<T extends string = string> {
  value: T;
  label: string;
  tone?: "default" | "up" | "down" | "warn" | "accent";
}

interface SegmentedProps<T extends string = string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (v: T) => void;
  className?: string;
  size?: "sm" | "md";
}

const TONE_ACTIVE: Record<NonNullable<SegmentedOption["tone"]>, string> = {
  default: "bg-obsidian-4 text-fg-0",
  up: "bg-up/[0.12] text-up",
  down: "bg-down/[0.12] text-down",
  warn: "bg-warn/[0.12] text-warn",
  accent: "bg-accent/[0.16] text-accent",
};

export function Segmented<T extends string = string>({
  options,
  value,
  onChange,
  className,
  size = "md",
}: SegmentedProps<T>) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-[7px] bg-obsidian-2 border border-obsidian-line p-0.5",
        className,
      )}
      role="tablist"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const tone = opt.tone ?? "default";
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "mono tracking-wider uppercase rounded-[5px] transition-colors",
              size === "sm" ? "text-[10px] px-2 py-1" : "text-[11px] px-2.5 py-1.5",
              active
                ? cn(TONE_ACTIVE[tone], "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]")
                : "text-fg-2 hover:text-fg-1",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
