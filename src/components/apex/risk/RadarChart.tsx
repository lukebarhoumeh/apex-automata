import type { RiskRadarAxis } from "@/types/risk";

interface Props {
  axes: readonly RiskRadarAxis[];
  size?: number;
}

export function RadarChart({ axes, size = 280 }: Props) {
  const n = axes.length;
  const cx = size / 2;
  const cy = size / 2;
  const rMax = size / 2 - 30;
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i: number, v: number): [number, number] => [
    cx + Math.cos(angle(i)) * rMax * (v / 100),
    cy + Math.sin(angle(i)) * rMax * (v / 100),
  ];
  const rings = [0.25, 0.5, 0.75, 1];
  const dataPath =
    axes
      .map((a, i) => pt(i, a.v))
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
      .join(" ") + " Z";

  return (
    <svg width={size} height={size} className="block">
      {rings.map((r) => (
        <polygon
          key={r}
          points={axes
            .map((_, i) => {
              const [x, y] = [
                cx + Math.cos(angle(i)) * rMax * r,
                cy + Math.sin(angle(i)) * rMax * r,
              ];
              return `${x},${y}`;
            })
            .join(" ")}
          fill="none"
          stroke="hsl(var(--obsidian-line))"
          strokeDasharray={r === 1 ? "" : "2 4"}
        />
      ))}
      {axes.map((_, i) => {
        const [x, y] = pt(i, 100);
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            stroke="hsl(var(--obsidian-line))"
            strokeWidth="0.8"
          />
        );
      })}
      <path
        d={dataPath}
        fill="hsl(var(--down))"
        fillOpacity="0.13"
        stroke="hsl(var(--down))"
        strokeWidth="1.5"
        style={{ filter: "drop-shadow(0 0 6px hsl(var(--down) / 0.45))" }}
      />
      {axes.map((a, i) => {
        const [x, y] = pt(i, a.v);
        return <circle key={i} cx={x} cy={y} r="3" fill="hsl(var(--down))" />;
      })}
      {axes.map((a, i) => {
        const [x, y] = [
          cx + Math.cos(angle(i)) * (rMax + 18),
          cy + Math.sin(angle(i)) * (rMax + 18),
        ];
        return (
          <text
            key={i}
            x={x}
            y={y}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="10.5"
            fontFamily="var(--font-mono, ui-monospace)"
            fill="hsl(var(--fg-1))"
          >
            {a.k.toUpperCase()}
          </text>
        );
      })}
    </svg>
  );
}
