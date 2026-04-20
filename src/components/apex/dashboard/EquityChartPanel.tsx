import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Panel } from "@/components/apex/Panel";
import { Segmented } from "@/components/apex/Segmented";
import { fmt } from "@/components/apex/format";
import { cn } from "@/lib/utils";
import type { EquityPoint, EquityRange } from "@/types/equity";

interface EquityChartPanelProps {
  data: readonly EquityPoint[];
  range: EquityRange;
  onChangeRange: (r: EquityRange) => void;
  className?: string;
}

const RANGE_OPTIONS: ReadonlyArray<{ value: EquityRange; label: string }> = [
  { value: "1D", label: "1D" },
  { value: "1W", label: "1W" },
  { value: "1M", label: "1M" },
  { value: "ALL", label: "All" },
];

export function EquityChartPanel({
  data,
  range,
  onChangeRange,
  className,
}: EquityChartPanelProps) {
  const first = data[0]?.v ?? 0;
  const last = data[data.length - 1]?.v ?? 0;
  const delta = last - first;
  const deltaPct = first ? (delta / first) * 100 : 0;
  const up = delta >= 0;

  const color = up ? "#39d98a" : "#ff5a6a";

  return (
    <Panel
      header
      pad={0}
      title="Equity curve"
      subtitle={`$${fmt(last, 0)}`}
      right={
        <div className="flex items-center gap-3">
          <span className={cn("mono text-[11px] font-medium", up ? "text-up" : "text-down")}>
            {up ? "▲" : "▼"} {up ? "+" : ""}
            {fmt(delta, 2)} ({up ? "+" : ""}
            {deltaPct.toFixed(2)}%)
          </span>
          <Segmented
            size="sm"
            options={RANGE_OPTIONS}
            value={range}
            onChange={(v) => onChangeRange(v as EquityRange)}
          />
        </div>
      }
      className={className}
    >
      <div className="h-[240px] w-full px-2 pb-3 pt-4">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={[...data]}
            margin={{ top: 8, right: 32, bottom: 8, left: 8 }}
          >
            <defs>
              <linearGradient id="equity-gradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              stroke="#1a2030"
              strokeDasharray="2 4"
              vertical={false}
            />
            <XAxis
              dataKey="t"
              tick={{
                fontFamily: "Geist Mono",
                fontSize: 9.5,
                fill: "#6a7588",
              }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={48}
            />
            <YAxis
              tick={{
                fontFamily: "Geist Mono",
                fontSize: 9.5,
                fill: "#6a7588",
              }}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(v: number) =>
                "$" + (v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(0))
              }
              domain={["dataMin - 500", "dataMax + 500"]}
            />
            <Tooltip
              cursor={{ stroke: "#222a3b", strokeDasharray: "2 2" }}
              contentStyle={{
                background: "#0a0d14",
                border: "1px solid #1a2030",
                borderRadius: 6,
                fontFamily: "Geist Mono",
                fontSize: 11,
                padding: "6px 10px",
              }}
              labelStyle={{ color: "#6a7588" }}
              itemStyle={{ color: "#e8ecf2" }}
              formatter={(v: number) => [`$${fmt(v, 2)}`, "equity"]}
            />
            <Area
              type="monotone"
              dataKey="v"
              stroke={color}
              strokeWidth={1.6}
              fill="url(#equity-gradient)"
              isAnimationActive={false}
              activeDot={{
                r: 4,
                stroke: color,
                strokeWidth: 2,
                fill: "#06080c",
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}
