import { cn } from "@/lib/utils";

interface Props {
  on: boolean;
  onChange: (v: boolean) => void;
}

export function ToggleSwitch({ on, onChange }: Props) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-4 w-7 rounded-full border transition-colors",
        on
          ? "border-up bg-up shadow-[0_0_6px_hsl(var(--up)/0.45)]"
          : "border-obsidian-line-2 bg-obsidian-2",
      )}
      aria-pressed={on}
    >
      <span
        className="absolute top-[1px] h-3 w-3 rounded-full bg-white transition-[left]"
        style={{ left: on ? 13 : 1 }}
      />
    </button>
  );
}
