import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import type { CalibrationPoint } from "@/types/model";

interface Props {
  data: readonly CalibrationPoint[];
}

export function CalibrationChart({ data }: Props) {
  const width = 380;
  const height = 240;
  const padL = 36;
  const padT = 12;
  const padR = 12;
  const padB = 28;
  const iw = width - padL - padR;
  const ih = height - padT - padB;
  const x = (v: number) => padL + v * iw;
  const y = (v: number) => padT + ih - v * ih;
  const path = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(d.pred)},${y(d.obs)}`).join(" ");

  return (
    <Panel
      header
      pad={16}
      title="CALIBRATION CURVE"
      right={<Pill tone="accent">WELL CALIBRATED</Pill>}
    >
      <svg width={width} height={height} className="block">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line
              x1={padL}
              y1={y(t)}
              x2={padL + iw}
              y2={y(t)}
              stroke="hsl(var(--obsidian-line))"
              strokeDasharray="2 3"
            />
            <line
              x1={x(t)}
              y1={padT}
              x2={x(t)}
              y2={padT + ih}
              stroke="hsl(var(--obsidian-line))"
              strokeDasharray="2 3"
            />
            <text
              x={padL - 6}
              y={y(t) + 3}
              textAnchor="end"
              fontSize="9"
              fontFamily="var(--font-mono, ui-monospace)"
              fill="hsl(var(--fg-2))"
            >
              {(t * 100).toFixed(0)}
            </text>
            <text
              x={x(t)}
              y={padT + ih + 14}
              textAnchor="middle"
              fontSize="9"
              fontFamily="var(--font-mono, ui-monospace)"
              fill="hsl(var(--fg-2))"
            >
              {(t * 100).toFixed(0)}
            </text>
          </g>
        ))}
        <line
          x1={x(0)}
          y1={y(0)}
          x2={x(1)}
          y2={y(1)}
          stroke="hsl(var(--fg-2))"
          strokeDasharray="4 4"
          opacity="0.6"
        />
        <path
          d={path}
          fill="none"
          stroke="hsl(var(--accent))"
          strokeWidth="2"
          style={{ filter: "drop-shadow(0 0 4px hsl(var(--accent-glow)))" }}
        />
        {data.map((d, i) => (
          <circle key={i} cx={x(d.pred)} cy={y(d.obs)} r="3.5" fill="hsl(var(--accent))" />
        ))}
        <text
          x={padL + iw / 2}
          y={height - 4}
          textAnchor="middle"
          fontSize="10"
          fontFamily="var(--font-mono, ui-monospace)"
          fill="hsl(var(--fg-2))"
        >
          PREDICTED %
        </text>
        <text
          x={8}
          y={padT + ih / 2}
          textAnchor="middle"
          fontSize="10"
          fontFamily="var(--font-mono, ui-monospace)"
          fill="hsl(var(--fg-2))"
          transform={`rotate(-90, 8, ${padT + ih / 2})`}
        >
          OBSERVED %
        </text>
      </svg>
      <p className="mt-2 text-[11.5px] leading-[1.5] text-fg-2">
        When the model predicts X%, outcomes actually occur at ≈X%. Divergence from the diagonal =
        miscalibration.
      </p>
    </Panel>
  );
}
