import type { BacktestEquityPoint } from "@/types/backtest";

interface Props {
  data: readonly BacktestEquityPoint[];
  width?: number;
  height?: number;
}

export function EquityWithDD({ data, width = 760, height = 280 }: Props) {
  const padL = 50;
  const padR = 40;
  const padT = 14;
  const padB = 22;
  const iw = width - padL - padR;
  const ih = height - padT - padB;
  const vMin = Math.min(...data.map((d) => d.v)) * 0.99;
  const vMax = Math.max(...data.map((d) => d.v)) * 1.01;
  const vSpan = vMax - vMin || 1;
  const ddMin = Math.min(...data.map((d) => d.dd));
  const step = iw / (data.length - 1);
  const yE = (v: number) => padT + ih * 0.7 - ((v - vMin) / vSpan) * ih * 0.7;
  const yD = (d: number) =>
    padT + ih * 0.72 + (Math.abs(d) / Math.abs(ddMin || 1)) * (ih * 0.26);

  const eqD = data.map((d, i) => `${i === 0 ? "M" : "L"}${padL + i * step},${yE(d.v)}`).join(" ");
  const ddD = data.map((d, i) => `${i === 0 ? "M" : "L"}${padL + i * step},${yD(d.dd)}`).join(" ");
  const ddFill = `${ddD} L${padL + (data.length - 1) * step},${padT + ih * 0.72} L${padL},${padT + ih * 0.72} Z`;
  const eqFill = `${eqD} L${padL + (data.length - 1) * step},${padT + ih * 0.7} L${padL},${padT + ih * 0.7} Z`;

  return (
    <svg width={width} height={height} className="block">
      <defs>
        <linearGradient id="bt-eq-gradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="hsl(var(--up))" stopOpacity="0.3" />
          <stop offset="100%" stopColor="hsl(var(--up))" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75].map((t) => (
        <line
          key={t}
          x1={padL}
          x2={padL + iw}
          y1={padT + ih * 0.7 * t}
          y2={padT + ih * 0.7 * t}
          stroke="hsl(var(--obsidian-line))"
          strokeDasharray="2 3"
        />
      ))}
      {[vMax, (vMax + vMin) / 2, vMin].map((v, i) => (
        <text
          key={i}
          x={padL - 6}
          y={yE(v) + 3}
          textAnchor="end"
          fontSize="9.5"
          fontFamily="var(--font-mono, ui-monospace)"
          fill="hsl(var(--fg-2))"
        >
          ${Math.round(v / 1000).toLocaleString()}k
        </text>
      ))}
      <path d={eqFill} fill="url(#bt-eq-gradient)" />
      <path d={eqD} fill="none" stroke="hsl(var(--up))" strokeWidth="1.6" />
      <line
        x1={padL}
        x2={padL + iw}
        y1={padT + ih * 0.72}
        y2={padT + ih * 0.72}
        stroke="hsl(var(--obsidian-line-2))"
      />
      <text
        x={padL + 4}
        y={padT + ih * 0.72 + 12}
        fontSize="9"
        fontFamily="var(--font-mono, ui-monospace)"
        fill="hsl(var(--fg-2))"
      >
        DRAWDOWN
      </text>
      <path d={ddFill} fill="hsl(var(--down))" fillOpacity="0.22" />
      <path d={ddD} fill="none" stroke="hsl(var(--down))" strokeWidth="1.2" />
      <text
        x={padL - 6}
        y={padT + ih - 4}
        textAnchor="end"
        fontSize="9.5"
        fontFamily="var(--font-mono, ui-monospace)"
        fill="hsl(var(--down))"
      >
        {ddMin.toFixed(1)}%
      </text>
    </svg>
  );
}
