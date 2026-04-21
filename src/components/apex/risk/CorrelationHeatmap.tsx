import { useState } from "react";

interface Props {
  labels: readonly string[];
  matrix: readonly (readonly number[])[];
}

function color(v: number): string {
  if (v > 0) return `rgba(255, 90, 106, ${0.15 + v * 0.7})`;
  const t = Math.abs(v);
  return `rgba(59, 130, 246, ${0.15 + t * 0.7})`;
}

export function CorrelationHeatmap({ labels, matrix }: Props) {
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const cellSize = 48;
  const padL = 40;
  const padT = 18;
  const n = labels.length;

  return (
    <div className="flex flex-col gap-2">
      <svg
        width={padL + n * cellSize + 10}
        height={padT + n * cellSize + 10}
        className="block"
        onMouseLeave={() => setHover(null)}
      >
        {labels.map((l, i) => (
          <text
            key={`c${i}`}
            x={padL + i * cellSize + cellSize / 2}
            y={12}
            textAnchor="middle"
            fontSize="10"
            fontFamily="var(--font-mono, ui-monospace)"
            fill="hsl(var(--fg-2))"
          >
            {l}
          </text>
        ))}
        {labels.map((l, i) => (
          <text
            key={`r${i}`}
            x={padL - 6}
            y={padT + i * cellSize + cellSize / 2 + 3}
            textAnchor="end"
            fontSize="10"
            fontFamily="var(--font-mono, ui-monospace)"
            fill="hsl(var(--fg-2))"
          >
            {l}
          </text>
        ))}
        {matrix.map((row, i) =>
          row.map((v, j) => (
            <g key={`${i}-${j}`} onMouseEnter={() => setHover({ i, j })}>
              <rect
                x={padL + j * cellSize}
                y={padT + i * cellSize}
                width={cellSize - 2}
                height={cellSize - 2}
                fill={color(v)}
                rx="3"
                stroke={i === j ? "hsl(var(--accent))" : "transparent"}
                strokeWidth="1"
              />
              <text
                x={padL + j * cellSize + cellSize / 2}
                y={padT + i * cellSize + cellSize / 2 + 4}
                textAnchor="middle"
                fontSize="10"
                fontFamily="var(--font-mono, ui-monospace)"
                fill={Math.abs(v) > 0.5 ? "white" : "hsl(var(--fg-1))"}
                fontWeight={i === j ? 600 : 500}
              >
                {v.toFixed(2)}
              </text>
            </g>
          )),
        )}
      </svg>
      {hover && (
        <div className="mono text-[11px] text-fg-2">
          {labels[hover.i]} × {labels[hover.j]} = {matrix[hover.i][hover.j].toFixed(2)}
        </div>
      )}
    </div>
  );
}
