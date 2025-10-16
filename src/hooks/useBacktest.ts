import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

export interface BacktestConfig {
  startDate: string;
  endDate: string;
  symbols: string[];
  strategies: string[];
  initialCapital: number;
}

export interface BacktestResult {
  id: string;
  config: BacktestConfig;
  results: {
    totalReturn: number;
    totalReturnPct: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    profitFactor: number;
    totalTrades: number;
    avgWinR: number;
    avgLossR: number;
    expectancyR: number;
    equityCurve: Array<{ date: string; equity: number; drawdown: number }>;
    trades: Array<{
      symbol: string;
      strategy: string;
      side: string;
      entryDate: string;
      exitDate: string;
      entryPrice: number;
      exitPrice: number;
      qty: number;
      pnl: number;
      pnlR: number;
    }>;
  };
  status: "running" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
}

export const useRunBacktest = () => {
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const queryClient = useQueryClient();

  const runBacktest = async (config: BacktestConfig): Promise<BacktestResult> => {
    setIsRunning(true);
    setProgress(0);

    try {
      // Call runtime API to start backtest
      const response = await fetch("http://localhost:3001/api/backtest/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        throw new Error("Failed to start backtest");
      }

      // Simulate progress updates (in real implementation, this would come from WebSocket)
      const progressInterval = setInterval(() => {
        setProgress((prev) => Math.min(prev + 10, 90));
      }, 500);

      const result = await response.json();
      clearInterval(progressInterval);
      setProgress(100);

      // Store result in Supabase for history (optional - table needs to be created)
      // For now, just return the result
      queryClient.invalidateQueries({ queryKey: ["backtest-history"] });
      
      toast({
        title: "Backtest Complete",
        description: `${result.results.totalTrades} trades analyzed`,
      });

      return result;
    } catch (error) {
      toast({
        title: "Backtest Failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
      throw error;
    } finally {
      setIsRunning(false);
      setProgress(0);
    }
  };

  return { runBacktest, isRunning, progress };
};

export const useBacktestHistory = () => {
  return useQuery({
    queryKey: ["backtest-history"],
    queryFn: async () => {
      // TODO: Implement when backtest_results table is created
      return [];
    },
  });
};

export const useExportBacktest = () => {
  return useMutation({
    mutationFn: async ({ result, format }: { result: BacktestResult; format: "csv" | "md" }) => {
      if (format === "csv") {
        // Export trades to CSV
        const header = "Symbol,Strategy,Side,Entry Date,Exit Date,Entry Price,Exit Price,Qty,P&L,P&L (R)\n";
        const rows = result.results.trades.map((t) =>
          [
            t.symbol,
            t.strategy,
            t.side,
            t.entryDate,
            t.exitDate,
            t.entryPrice,
            t.exitPrice,
            t.qty,
            t.pnl,
            t.pnlR,
          ].join(",")
        );
        const csv = header + rows.join("\n");
        
        const blob = new Blob([csv], { type: "text/csv" });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `backtest_${new Date().toISOString().split("T")[0]}.csv`;
        a.click();
        window.URL.revokeObjectURL(url);
      } else {
        // Export to Markdown report
        const md = `# Backtest Report
**Date Range:** ${result.config.startDate} to ${result.config.endDate}
**Symbols:** ${result.config.symbols.join(", ")}
**Strategies:** ${result.config.strategies.join(", ")}

## Key Metrics
- **Total Return:** $${result.results.totalReturn.toFixed(2)} (${result.results.totalReturnPct.toFixed(2)}%)
- **Sharpe Ratio:** ${result.results.sharpeRatio.toFixed(2)}
- **Max Drawdown:** ${result.results.maxDrawdown.toFixed(2)}%
- **Win Rate:** ${result.results.winRate.toFixed(2)}%
- **Profit Factor:** ${result.results.profitFactor.toFixed(2)}
- **Total Trades:** ${result.results.totalTrades}
- **Expectancy:** ${result.results.expectancyR.toFixed(2)}R

## Trade Summary
| Symbol | Strategy | Side | Entry | Exit | P&L | P&L (R) |
|--------|----------|------|-------|------|-----|---------|
${result.results.trades.map(t => 
  `| ${t.symbol} | ${t.strategy} | ${t.side} | ${t.entryDate} | ${t.exitDate} | $${t.pnl.toFixed(2)} | ${t.pnlR.toFixed(2)}R |`
).join("\n")}
`;
        
        const blob = new Blob([md], { type: "text/markdown" });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `backtest_report_${new Date().toISOString().split("T")[0]}.md`;
        a.click();
        window.URL.revokeObjectURL(url);
      }

      toast({
        title: "Export Complete",
        description: `Backtest exported as ${format.toUpperCase()}`,
      });
    },
  });
};
