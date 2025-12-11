import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { FIXED_USER_ID } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ComposedChart,
  Bar,
} from "recharts";

interface EquityDataPoint {
  date: string;
  equity: number;
  dailyPnl: number;
  drawdown: number;
  drawdownPct: number;
}

export const EquityCurveChart = () => {
  // Fetch account metrics history
  const { data: metricsData, isLoading } = useQuery({
    queryKey: ["equity-curve", FIXED_USER_ID],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("account_metrics")
        .select("date, total_equity, daily_pnl, daily_pnl_r")
        .eq("user_id", FIXED_USER_ID)
        .order("date", { ascending: true })
        .limit(90);

      if (error) throw error;
      return data;
    },
    refetchInterval: 30000,
  });

  // Calculate equity curve with drawdown
  const chartData = useMemo(() => {
    if (!metricsData?.length) return [];

    let peakEquity = 0;
    
    return metricsData.map((m) => {
      const equity = Number(m.total_equity);
      peakEquity = Math.max(peakEquity, equity);
      const drawdown = peakEquity - equity;
      const drawdownPct = peakEquity > 0 ? (drawdown / peakEquity) * 100 : 0;

      return {
        date: m.date,
        equity,
        dailyPnl: Number(m.daily_pnl),
        dailyPnlR: Number(m.daily_pnl_r),
        drawdown,
        drawdownPct,
      };
    });
  }, [metricsData]);

  // Calculate summary stats
  const stats = useMemo(() => {
    if (!chartData.length) return null;

    const latestEquity = chartData[chartData.length - 1]?.equity || 0;
    const startEquity = chartData[0]?.equity || 0;
    const totalReturn = startEquity > 0 ? ((latestEquity - startEquity) / startEquity) * 100 : 0;
    const maxDrawdown = Math.max(...chartData.map((d) => d.drawdownPct));
    const currentDrawdown = chartData[chartData.length - 1]?.drawdownPct || 0;
    const winningDays = chartData.filter((d) => d.dailyPnl > 0).length;
    const losingDays = chartData.filter((d) => d.dailyPnl < 0).length;
    const winRate = chartData.length > 0 ? (winningDays / chartData.length) * 100 : 0;

    return {
      latestEquity,
      totalReturn,
      maxDrawdown,
      currentDrawdown,
      winningDays,
      losingDays,
      winRate,
    };
  }, [chartData]);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  const formatCurrency = (value: number) =>
    `$${value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="font-mono text-base">Equity Curve</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[300px] flex items-center justify-center text-muted-foreground">
            Loading equity data...
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!chartData.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="font-mono text-base">Equity Curve</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[300px] flex items-center justify-center text-muted-foreground">
            No equity data available yet
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stats Summary */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="font-mono text-base">Equity & Performance</CardTitle>
            {stats && (
              <div className="flex gap-2">
                <Badge variant={stats.totalReturn >= 0 ? "default" : "destructive"} className="font-mono">
                  {stats.totalReturn >= 0 ? "+" : ""}{stats.totalReturn.toFixed(2)}% Total
                </Badge>
                <Badge variant={stats.currentDrawdown > 5 ? "destructive" : "secondary"} className="font-mono">
                  -{stats.currentDrawdown.toFixed(2)}% DD
                </Badge>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {stats && (
            <div className="grid grid-cols-6 gap-4 mb-4">
              <div>
                <div className="text-xs text-muted-foreground">Current Equity</div>
                <div className="font-mono font-semibold text-lg">{formatCurrency(stats.latestEquity)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Total Return</div>
                <div className={`font-mono font-semibold text-lg ${stats.totalReturn >= 0 ? "text-green-500" : "text-destructive"}`}>
                  {stats.totalReturn >= 0 ? "+" : ""}{stats.totalReturn.toFixed(2)}%
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Max Drawdown</div>
                <div className="font-mono font-semibold text-lg text-destructive">
                  -{stats.maxDrawdown.toFixed(2)}%
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Current DD</div>
                <div className={`font-mono font-semibold text-lg ${stats.currentDrawdown > 5 ? "text-destructive" : "text-muted-foreground"}`}>
                  -{stats.currentDrawdown.toFixed(2)}%
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Win Rate</div>
                <div className="font-mono font-semibold text-lg">{stats.winRate.toFixed(0)}%</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">W/L Days</div>
                <div className="font-mono font-semibold text-lg">
                  <span className="text-green-500">{stats.winningDays}</span>
                  <span className="text-muted-foreground">/</span>
                  <span className="text-destructive">{stats.losingDays}</span>
                </div>
              </div>
            </div>
          )}

          {/* Equity Curve Chart */}
          <div className="h-[250px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={10}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  formatter={(value: number, name: string) => [
                    name === "equity" ? formatCurrency(value) : `${value.toFixed(2)}%`,
                    name === "equity" ? "Equity" : "Drawdown",
                  ]}
                  labelFormatter={formatDate}
                />
                <Area
                  type="monotone"
                  dataKey="equity"
                  stroke="hsl(var(--primary))"
                  fill="url(#equityGradient)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Drawdown Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="font-mono text-base">Drawdown & Daily PnL</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={10}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="left"
                  tickFormatter={(v) => `${v.toFixed(0)}%`}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  domain={["dataMin", 0]}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tickFormatter={(v) => `$${v.toFixed(0)}`}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    fontSize: "12px",
                  }}
                  formatter={(value: number, name: string) => {
                    if (name === "drawdownPct") return [`-${value.toFixed(2)}%`, "Drawdown"];
                    return [formatCurrency(value), "Daily PnL"];
                  }}
                  labelFormatter={formatDate}
                />
                <ReferenceLine yAxisId="left" y={0} stroke="hsl(var(--border))" />
                <Area
                  yAxisId="left"
                  type="monotone"
                  dataKey="drawdownPct"
                  stroke="hsl(var(--destructive))"
                  fill="hsl(var(--destructive))"
                  fillOpacity={0.2}
                  strokeWidth={1}
                  // Invert to show below zero
                  data={chartData.map((d) => ({ ...d, drawdownPct: -d.drawdownPct }))}
                />
                <Bar
                  yAxisId="right"
                  dataKey="dailyPnl"
                  fill="hsl(var(--primary))"
                  opacity={0.6}
                  radius={[2, 2, 0, 0]}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
