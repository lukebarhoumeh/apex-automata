import { cn } from "@/lib/utils";

type ChipStatus = "ok" | "warn" | "down";

interface StatusChipProps {
  label: string;
  suffix: string;
  status?: ChipStatus;
}

const DOT_CLASSES: Record<ChipStatus, string> = {
  ok: "bg-up shadow-[0_0_0_2px_rgba(57,217,138,0.2)]",
  warn: "bg-warn shadow-[0_0_0_2px_rgba(255,176,32,0.2)]",
  down: "bg-down shadow-[0_0_0_2px_rgba(255,90,106,0.2)]",
};

function StatusChip({ label, suffix, status = "ok" }: StatusChipProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASSES[status])} />
      <span className="mono text-[11px] uppercase tracking-wider text-fg-2">
        {label} · {suffix}
      </span>
    </div>
  );
}

interface FooterProps {
  pid?: number;
  build?: string;
}

export function Footer({ pid = 48291, build = "2.4.1-main-a9f3c" }: FooterProps) {
  return (
    <footer className="flex h-10 items-center justify-between border-t border-obsidian-line bg-obsidian-1 px-4">
      <div className="flex items-center gap-5">
        <StatusChip label="MD_STREAM" suffix="43ms" />
        <StatusChip label="BROKER" suffix="112ms" />
        <StatusChip label="META_MODEL" suffix="READY" />
      </div>
      <div className="mono text-[11px] uppercase tracking-wider text-fg-2">
        PID {pid} · build {build} · 2026
      </div>
    </footer>
  );
}
