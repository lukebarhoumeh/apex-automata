import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart3, Target, TrendingUp, Clock, Zap, AlertTriangle } from "lucide-react";
import { useSessionStats } from "@/hooks/useSessionStats";
import { formatUsd, formatPercent, formatBps } from "@/lib/utils";

export const SessionStatsPanel = () => {
  const { data: stats, isLoading } = useSessionStats();

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-5 w-40" />
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-4 gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="text-center space-y-1">
                <Skeleton className="h-8 w-12 mx-auto" />
                <Skeleton className="h-3 w-10 mx-auto" />
              </div>
            ))}
          </div>
          <Skeleton className="h-2 w-full" />
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!stats) {
    return (
      <Card>
        <CardContent className="p-4 flex items-center justify-center h-[200px] text-muted-foreground">
          <div className="text-center">
            <AlertTriangle className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>Engine not running</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const formatDuration = (seconds: number) => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  };

  const winRatePct = stats.winRate * 100;
  const profitFactorColor = 
    stats.profitFactor >= 2 ? 'text-success' :
    stats.profitFactor >= 1.5 ? 'text-warning' :
    stats.profitFactor >= 1 ? 'text-foreground' : 'text-destructive';

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base font-mono">
          <BarChart3 className="h-4 w-4" />
          Session Statistics
          <Badge variant="outline" className="ml-auto font-mono text-xs">
            {stats.mode.toUpperCase()}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Trade Summary */}
        <div className="grid grid-cols-4 gap-2 text-center">
          <div>
            <div className="text-2xl font-bold font-mono">{stats.totalTrades}</div>
            <div className="text-xs text-muted-foreground">Trades</div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-success">{stats.winningTrades}</div>
            <div className="text-xs text-muted-foreground">Wins</div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-destructive">{stats.losingTrades}</div>
            <div className="text-xs text-muted-foreground">Losses</div>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono text-muted-foreground">{stats.breakEvenTrades}</div>
            <div className="text-xs text-muted-foreground">B/E</div>
          </div>
        </div>

        {/* Win Rate Progress */}
        <div className="space-y-1">
          <div className="flex justify-between text-sm font-mono">
            <span className="flex items-center gap-1">
              <Target className="h-3 w-3" />
              Win Rate
            </span>
            <span className={winRatePct >= 50 ? 'text-success' : 'text-destructive'}>
              {formatPercent(stats.winRate)}
            </span>
          </div>
          <Progress value={winRatePct} className="h-2" />
        </div>

        {/* Key Metrics Grid */}
        <div className="grid grid-cols-2 gap-3 text-sm font-mono">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Profit Factor</span>
            <span className={profitFactorColor}>
              {Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Expectancy</span>
            <span className={stats.expectancy >= 0 ? 'text-success' : 'text-destructive'}>
              {formatUsd(stats.expectancy)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Avg Win</span>
            <span className="text-success">{formatUsd(stats.avgWin)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Avg Loss</span>
            <span className="text-destructive">{formatUsd(stats.avgLoss)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              Sharpe Est.
            </span>
            <span>{stats.sharpeEstimate.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Sortino Est.</span>
            <span>{stats.sortinoEstimate.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Avg Duration
            </span>
            <span>{formatDuration(stats.avgDuration)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground flex items-center gap-1">
              <Zap className="h-3 w-3" />
              Avg Slippage
            </span>
            <span className={Math.abs(stats.avgSlippageBps) > 10 ? 'text-warning' : ''}>
              {formatBps(stats.avgSlippageBps)}
            </span>
          </div>
        </div>

        {/* P&L Summary */}
        <div className="pt-2 border-t space-y-1">
          <div className="flex justify-between font-mono">
            <span className="text-muted-foreground">Gross Profit</span>
            <span className="text-success">{formatUsd(stats.grossProfit)}</span>
          </div>
          <div className="flex justify-between font-mono">
            <span className="text-muted-foreground">Gross Loss</span>
            <span className="text-destructive">{formatUsd(stats.grossLoss)}</span>
          </div>
          <div className="flex justify-between font-mono font-bold text-lg pt-1">
            <span>Net P&L</span>
            <span className={stats.totalPnl >= 0 ? 'text-success' : 'text-destructive'}>
              {stats.totalPnl >= 0 ? '+' : ''}{formatUsd(stats.totalPnl)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

