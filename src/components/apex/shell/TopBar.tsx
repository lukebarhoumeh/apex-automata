import { useLocation } from "react-router-dom";
import { ChevronRight, Command, Power, Sliders } from "lucide-react";
import { LiveClock } from "@/components/apex/LiveClock";
import { Segmented } from "@/components/apex/Segmented";
import { TITLE_BY_PATH } from "./nav-config";
import { cn } from "@/lib/utils";
import { useState } from "react";

interface TopBarProps {
  onOpenPalette: () => void;
  onKillSwitch: () => void;
  onToggleTweaks?: () => void;
  tweaksOn?: boolean;
}

type BotMode = "paper" | "live" | "paused";

const MODE_OPTIONS = [
  { value: "paper" as const, label: "Paper", tone: "accent" as const },
  { value: "live" as const, label: "Live", tone: "up" as const },
  { value: "paused" as const, label: "Paused", tone: "warn" as const },
];

export function TopBar({
  onOpenPalette,
  onKillSwitch,
  onToggleTweaks,
  tweaksOn,
}: TopBarProps) {
  const { pathname } = useLocation();
  const title = TITLE_BY_PATH[pathname] ?? "Dashboard";
  const [mode, setMode] = useState<BotMode>("paper");

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-obsidian-line bg-obsidian-1/80 px-4 backdrop-blur-md">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1.5">
        <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-fg-2">
          Apex
        </span>
        <ChevronRight size={12} className="text-fg-3" strokeWidth={1.5} />
        <span className="text-[13px] font-medium text-fg-0">{title}</span>
      </div>

      {/* Command trigger */}
      <button
        type="button"
        onClick={onOpenPalette}
        className={cn(
          "ml-4 flex h-8 w-[320px] items-center justify-between gap-2 rounded-[7px]",
          "border border-obsidian-line bg-obsidian-2 px-2.5 text-left",
          "hover:border-obsidian-line-2 transition-colors",
        )}
      >
        <span className="flex items-center gap-2 text-[12px] text-fg-2">
          <Command size={12} strokeWidth={1.6} />
          Command or search…
        </span>
        <span className="flex items-center gap-0.5">
          <kbd className="kbd">⌘</kbd>
          <kbd className="kbd">K</kbd>
        </span>
      </button>

      <div className="flex-1" />

      <LiveClock />

      <span className="h-5 w-px bg-obsidian-line" aria-hidden />

      <Segmented
        size="sm"
        options={MODE_OPTIONS}
        value={mode}
        onChange={(v) => setMode(v as BotMode)}
      />

      <button
        type="button"
        onClick={onKillSwitch}
        className={cn(
          "flex items-center gap-1.5 rounded-md border border-down/40 bg-down/[0.08]",
          "px-2.5 py-1.5 text-down transition-colors",
          "hover:bg-down/[0.16] hover:border-down/60",
        )}
      >
        <Power size={13} strokeWidth={1.8} />
        <span className="mono text-[11px] font-semibold uppercase tracking-wider">
          Kill
        </span>
      </button>

      <span className="h-5 w-px bg-obsidian-line" aria-hidden />

      {onToggleTweaks && (
        <button
          type="button"
          onClick={onToggleTweaks}
          aria-pressed={tweaksOn}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
            tweaksOn
              ? "bg-accent/[0.16] text-accent"
              : "text-fg-2 hover:bg-obsidian-2 hover:text-fg-1",
          )}
          aria-label="Toggle tweaks"
        >
          <Sliders size={13} strokeWidth={1.6} />
        </button>
      )}

      <Avatar initials="JD" />
    </header>
  );
}

function Avatar({ initials }: { initials: string }) {
  return (
    <div
      className="flex h-7 w-7 items-center justify-center rounded-full text-[10.5px] font-semibold text-white"
      style={{
        background:
          "radial-gradient(circle at 30% 30%, hsl(var(--accent-2)), hsl(var(--accent)))",
        boxShadow: "0 0 0 1px rgba(255,255,255,0.08)",
      }}
    >
      {initials}
    </div>
  );
}
