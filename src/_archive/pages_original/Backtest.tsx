import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { Calendar, Play, Download, Activity } from "lucide-react";
import { useRunBacktest, useExportBacktest, BacktestResult } from "@/hooks/useBacktest";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

const Backtest = () => {
  const { runBacktest, isRunning, progress } = useRunBacktest();
  const exportBacktest = useExportBacktest();

  const [config, setConfig] = useState({
    startDate: "2024-01-01",
    endDate: "2024-12-31",
    symbols: ["BTC-USD"],
    strategies: ["breakout", "vwap_mr"],
    initialCapital: 100000,
  });

  const [result, setResult] = useState<BacktestResult | null>(null);

  const handleRun = async () => {
    try {
      const backtestResult = await runBacktest(config);
      setResult(backtestResult);
    } catch (error) {
      console.error("Backtest failed:", error);
    }
  };

  const handleExport = (format: "csv" | "md") => {
    if (result) {
      exportBacktest.mutate({ result, format });
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight font-mono">Backtest Engine</h1>
        <p className="text-muted-foreground mt-1">
          Historical simulation with full strategy and risk parameters
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Configuration */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Calendar className="h-5 w-5 text-primary" />
              <div>
                <CardTitle className="font-mono">Configuration</CardTitle>
                <CardDescription>Set backtest parameters</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Date Range */}
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="startDate" className="font-mono text-sm">
                  Start Date
                </Label>
                <Input
                  id="startDate"
                  type="date"
                  value={config.startDate}
                  onChange={(e) => setConfig({ ...config, startDate: e.target.value })}
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate" className="font-mono text-sm">
                  End Date
                </Label>
                <Input
                  id="endDate"
                  type="date"
                  value={config.endDate}
                  onChange={(e) => setConfig({ ...config, endDate: e.target.value })}
                  className="font-mono"
                />
              </div>
            </div>

            <Separator />

            {/* Symbols */}
            <div className="space-y-2">
              <Label className="font-mono text-sm">Symbols</Label>
              <div className="space-y-2">
                {["BTC-USD", "ETH-USD"].map((symbol) => (
                  <div key={symbol} className="flex items-center space-x-2">
                    <Checkbox
                      id={symbol}
                      checked={config.symbols.includes(symbol)}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setConfig({ ...config, symbols: [...config.symbols, symbol] });
                        } else {
                          setConfig({
                            ...config,
                            symbols: config.symbols.filter((s) => s !== symbol),
                          });
                        }
                      }}
                    />
                    <label htmlFor={symbol} className="text-sm font-mono cursor-pointer">
                      {symbol}
                    </label>
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            {/* Strategies */}
            <div className="space-y-2">
              <Label className="font-mono text-sm">Strategies</Label>
              <div className="space-y-2">
                {[
                  { id: "breakout", name: "Breakout + Volume" },
                  { id: "vwap_mr", name: "VWAP Mean Reversion" },
                ].map((strategy) => (
                  <div key={strategy.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={strategy.id}
                      checked={config.strategies.includes(strategy.id)}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setConfig({ ...config, strategies: [...config.strategies, strategy.id] });
                        } else {
                          setConfig({
                            ...config,
                            strategies: config.strategies.filter((s) => s !== strategy.id),
                          });
                        }
                      }}
                    />
                    <label htmlFor={strategy.id} className="text-sm cursor-pointer">
                      {strategy.name}
                    </label>
                  </div>
                ))}
              </div>
            </div>

            <Separator />

            {/* Initial Capital */}
            <div className="space-y-2">
              <Label htmlFor="capital" className="font-mono text-sm">
                Initial Capital ($)
              </Label>
              <Input
                id="capital"
                type="number"
                value={config.initialCapital}
                onChange={(e) =>
                  setConfig({ ...config, initialCapital: parseInt(e.target.value) || 0 })
                }
                className="font-mono tabular-nums"
              />
            </div>

            <Button
              onClick={handleRun}
              disabled={isRunning || config.symbols.length === 0 || config.strategies.length === 0}
              className="w-full gap-2 font-mono"
            >
              <Play className="h-4 w-4" />
              {isRunning ? "Running..." : "Run Backtest"}
            </Button>

            {isRunning && (
              <div className="space-y-2">
                <Progress value={progress} className="h-2" />
                <p className="text-xs text-center text-muted-foreground font-mono">
                  {progress}% complete
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Results */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Activity className="h-5 w-5 text-success" />
                <div>
                  <CardTitle className="font-mono">Results</CardTitle>
                  <CardDescription>Performance metrics and trade analysis</CardDescription>
                </div>
              </div>
              {result && (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExport("csv")}
                    className="gap-2 font-mono"
                  >
                    <Download className="h-4 w-4" />
                    CSV
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleExport("md")}
                    className="gap-2 font-mono"
                  >
                    <Download className="h-4 w-4" />
                    Report
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {!result ? (
              <div className="flex flex-col items-center justify-center py-16 space-y-3 text-center">
                <Activity className="h-16 w-16 text-muted-foreground" />
                <div>
                  <p className="font-semibold">No Results Yet</p>
                  <p className="text-sm text-muted-foreground">
                    Configure parameters and run a backtest
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                {/* KPI Grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="text-center">
                    <div className={`text-2xl font-bold font-mono tabular-nums ${
                      result.results.totalReturn >= 0 ? 'text-success' : 'text-destructive'
                    }`}>
                      ${result.results.totalReturn.toLocaleString()}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Total Return</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono tabular-nums text-primary">
                      {result.results.sharpeRatio.toFixed(2)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Sharpe Ratio</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono tabular-nums text-destructive">
                      {result.results.maxDrawdown.toFixed(1)}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Max Drawdown</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono tabular-nums">
                      {result.results.winRate.toFixed(1)}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Win Rate</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono tabular-nums text-success">
                      {result.results.profitFactor.toFixed(2)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Profit Factor</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono tabular-nums">
                      {result.results.totalTrades}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Total Trades</div>
                  </div>
                  <div className="text-center">
                    <div className="text-sm font-mono tabular-nums">
                      <div className="text-success">↑ {result.results.avgWinR.toFixed(2)}R</div>
                      <div className="text-destructive">↓ {result.results.avgLossR.toFixed(2)}R</div>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Avg Win/Loss</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold font-mono tabular-nums text-primary">
                      {result.results.expectancyR.toFixed(2)}R
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">Expectancy</div>
                  </div>
                </div>

                <Separator />

                {/* Equity Curve */}
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold font-mono">Equity Curve</h4>
                  <ResponsiveContainer width="100%" height={250}>
                    <AreaChart data={result.results.equityCurve}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis
                        dataKey="date"
                        className="text-xs"
                        tick={{ fill: "hsl(var(--muted-foreground))" }}
                      />
                      <YAxis
                        className="text-xs"
                        tick={{ fill: "hsl(var(--muted-foreground))" }}
                        tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "6px",
                        }}
                        formatter={(value: number) => [`$${value.toLocaleString()}`, "Equity"]}
                      />
                      <Area
                        type="monotone"
                        dataKey="equity"
                        stroke="hsl(var(--primary))"
                        fill="hsl(var(--primary) / 0.2)"
                        strokeWidth={2}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Backtest;
