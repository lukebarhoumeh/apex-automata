import { useMemo } from "react";

interface SparklineProps {
  data: readonly number[];
  width?: number;
  height?: number;
  stroke?: string;
  strokeWidth?: number;
  /** Auto-color green/red based on first vs last value; ignored if stroke is provided. */
  autoColor?: boolean;
  className?: string;
}

export function Sparkline({
  data,
  width = 46,
  height = 16,
  stroke,
  strokeWidth = 1.25,
  autoColor = true,
  className,
}: SparklineProps) {
  const { path, color } = useMemo(() => {
    if (data.length === 0) return { path: "", color: stroke ?? "#6a7588" };

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const stepX = data.length > 1 ? width / (data.length - 1) : 0;

    const points = data.map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return [x, y] as const;
    });

    const d = points
      .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
      .join(" ");

    const dir = data[data.length - 1]! - data[0]!;
    const resolvedColor =
      stroke ?? (autoColor ? (dir >= 0 ? "#39d98a" : "#ff5a6a") : "#7aa4ff");

    return { path: d, color: resolvedColor };
  }, [data, width, height, stroke, autoColor]);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
