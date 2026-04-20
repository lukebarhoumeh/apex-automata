import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PanelProps {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  pad?: number;
  header?: boolean;
  tone?: "default" | "accent";
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

export function Panel({
  title,
  subtitle,
  right,
  pad = 16,
  header = true,
  tone = "default",
  className,
  bodyClassName,
  children,
}: PanelProps) {
  const showHeader = header && (title || subtitle || right);
  return (
    <div
      className={cn(
        "bg-obsidian-1 border rounded-[10px] overflow-hidden",
        tone === "accent"
          ? "border-accent/40 shadow-accent-glow"
          : "border-obsidian-line",
        className,
      )}
    >
      {showHeader && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-obsidian-line">
          <div className="flex items-baseline gap-2 min-w-0">
            {title && (
              <span className="font-mono text-[10px] font-medium tracking-[0.09em] uppercase text-fg-2">
                {title}
              </span>
            )}
            {subtitle && (
              <span className="text-xs text-fg-2 truncate">{subtitle}</span>
            )}
          </div>
          {right && <div className="flex items-center gap-2">{right}</div>}
        </div>
      )}
      <div className={cn(bodyClassName)} style={{ padding: pad }}>
        {children}
      </div>
    </div>
  );
}
