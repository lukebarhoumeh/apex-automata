import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { Activity } from "lucide-react";

interface CalibrationChartProps {
  data: Array<{ predicted: number; actual: number }> | null;
}

export const CalibrationChart = ({ data }: CalibrationChartProps) => {
  if (!data || data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-mono flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Calibration Plot
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center h-[200px] text-sm text-muted-foreground">
            No calibration data available
          </div>
        </CardContent>
      </Card>
    );
  }

  // Sort data by predicted probability
  const sortedData = [...data].sort((a, b) => a.predicted - b.predicted);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-mono flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Calibration Plot
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={sortedData}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis
              dataKey="predicted"
              domain={[0, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              className="text-xs"
              tick={{ fill: "hsl(var(--muted-foreground))" }}
            />
            <YAxis
              domain={[0, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              className="text-xs"
              tick={{ fill: "hsl(var(--muted-foreground))" }}
            />
            <Tooltip
              formatter={(value: number) => `${(value * 100).toFixed(1)}%`}
              labelFormatter={(label: number) => `Predicted: ${(label * 100).toFixed(1)}%`}
              contentStyle={{
                backgroundColor: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: "6px",
              }}
            />
            {/* Perfect calibration line */}
            <ReferenceLine
              stroke="hsl(var(--muted-foreground))"
              strokeDasharray="3 3"
              segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]}
            />
            {/* Actual calibration */}
            <Line
              type="monotone"
              dataKey="actual"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={false}
              name="Actual"
            />
            <Line
              type="monotone"
              dataKey="predicted"
              stroke="hsl(var(--muted-foreground))"
              strokeWidth={1}
              strokeDasharray="3 3"
              dot={false}
              name="Predicted"
            />
          </LineChart>
        </ResponsiveContainer>
        <p className="text-xs text-muted-foreground text-center mt-2">
          Closer to diagonal = better calibrated
        </p>
      </CardContent>
    </Card>
  );
};
