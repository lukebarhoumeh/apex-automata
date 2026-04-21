import { mulberry32 } from "@/hooks/apex/mock/rng";

interface Props {
  seed: number;
  entry: number;
  exit: number;
  side: "LONG" | "SHORT";
  win: boolean;
}

export function MiniTradeChart({ seed, entry, exit, win }: Props) {
  const rnd = mulberry32(seed);
  const pts: number[] = [];
  const range = entry * 0.04;
  let v = entry - range * 0.3;
  const target = exit;
  const steps = 30;
  for (let i = 0; i < steps; i++) {
    const progress = i / (steps - 1);
    const drift = (target - entry) * progress * 0.9;
    v = entry + drift + (rnd() - 0.5) * range * 0.6;
    pts.push(v);
  }
  const min = Math.min(...pts, entry, exit);
  const max = Math.max(...pts, entry, exit);
  const span = max - min || 1;
  const W = 120;
  const H = 38;
  const x = (i: number) => (i / (steps - 1)) * W;
  const y = (val: number) => H - ((val - min) / span) * H;
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p)}`).join(" ");
  const entryY = y(entry);
  const exitY = y(exit);
  const color = win ? "hsl(var(--up))" : "hsl(var(--down))";

  return (
    <svg width={W} height={H} className="block">
      <line
        x1="0"
        x2={W}
        y1={entryY}
        y2={entryY}
        stroke="hsl(var(--fg-3))"
        strokeDasharray="2 2"
        opacity="0.6"
      />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        style={{ filter: win ? "drop-shadow(0 0 3px hsl(var(--up) / 0.45))" : undefined }}
      />
      <circle cx={0} cy={entryY} r="2.5" fill="hsl(var(--fg-1))" />
      <circle cx={W} cy={exitY} r="2.5" fill={color} />
    </svg>
  );
}
