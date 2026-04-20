import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  size?: number;
}

export function Logo({ className, size = 28 }: LogoProps) {
  return (
    <div
      className={cn(
        "relative flex items-center justify-center rounded-[7px]",
        className,
      )}
      style={{
        width: size,
        height: size,
        background:
          "radial-gradient(circle at 30% 30%, hsl(var(--accent-2)), hsl(var(--accent)))",
        boxShadow:
          "0 0 0 1px rgba(255,255,255,0.08), 0 6px 16px -4px hsl(var(--accent-glow))",
      }}
      aria-hidden
    >
      <svg
        width={size * 0.6}
        height={size * 0.6}
        viewBox="0 0 24 24"
        fill="none"
        stroke="white"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 20L12 4L20 20" />
        <path d="M8 14H16" />
      </svg>
    </div>
  );
}
