/**
 * MetaFilterPanel - Displays meta-filter status and strategy performance
 */

import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useMetaFilterStats,
  useStrategyPerformance,
  getWinRateColor,
  getColdStreakColor,
} from '@/hooks/useMetaFilter';

interface StrategyCardProps {
  strategy: string;
  perf: {
    totalTrades: number;
    wins?: number;
    losses?: number;
    winRate: number;
    consecutiveLosses: number;
    avgWinningStrength: number;
    profitFactor: number;
  };
  coldStreakActive: boolean;
}

function StrategyCard({ strategy, perf, coldStreakActive }: StrategyCardProps) {
  const winRateColor = getWinRateColor(perf.winRate);
  const coldStreakColor = getColdStreakColor(coldStreakActive);

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm capitalize">{strategy}</span>
        {coldStreakActive && (
          <Badge variant="destructive" className="text-xs">
            ❄️ Cold Streak
          </Badge>
        )}
      </div>

      {/* Win Rate */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Win Rate</span>
          <span className="font-mono" style={{ color: winRateColor }}>
            {(perf.winRate * 100).toFixed(1)}%
          </span>
        </div>
        <Progress 
          value={perf.winRate * 100} 
          className="h-1.5"
        />
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Trades</span>
                <span className="font-mono">{perf.totalTrades}</span>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              <p>
                {perf.wins ?? '?'}W / {perf.losses ?? '?'}L
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <div className="flex justify-between">
          <span className="text-muted-foreground">Consec L</span>
          <span 
            className="font-mono"
            style={{ color: perf.consecutiveLosses >= 3 ? '#ef4444' : 'inherit' }}
          >
            {perf.consecutiveLosses}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-muted-foreground">Avg Str</span>
          <span className="font-mono">{perf.avgWinningStrength.toFixed(2)}</span>
        </div>

        <div className="flex justify-between">
          <span className="text-muted-foreground">PF</span>
          <span 
            className="font-mono"
            style={{ color: perf.profitFactor >= 1.5 ? '#10b981' : perf.profitFactor >= 1 ? '#84cc16' : '#ef4444' }}
          >
            {perf.profitFactor.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function MetaFilterPanel() {
  const { data: stats, isLoading: statsLoading, error: statsError } = useMetaFilterStats();
  const { data: perfData, isLoading: perfLoading } = useStrategyPerformance();

  const isLoading = statsLoading || perfLoading;

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Trade Quality Filter</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-2">
            <div className="h-16 bg-muted rounded" />
            <div className="h-16 bg-muted rounded" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (statsError || !stats) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Trade Quality Filter</CardTitle>
          <CardDescription className="text-xs">
            Start the engine to see filter stats
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4 text-muted-foreground">
            <span className="text-2xl">🎯</span>
            <p className="mt-1 text-xs">Engine not running</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const strategies = Object.keys(stats.strategies);
  const totalColdStreaks = Object.values(stats.coldStreaks).filter(Boolean).length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm">Trade Quality Filter</CardTitle>
            <CardDescription className="text-xs">
              Rule-based signal filtering
            </CardDescription>
          </div>
          <div className="flex gap-1">
            <Badge 
              variant={stats.enabled ? 'default' : 'secondary'}
              className="text-xs"
            >
              {stats.enabled ? 'Active' : 'Disabled'}
            </Badge>
            {totalColdStreaks > 0 && (
              <Badge variant="destructive" className="text-xs">
                {totalColdStreaks} Cold
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Filter Config Summary */}
        <div className="grid grid-cols-3 gap-2 text-xs border-b pb-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="text-center">
                  <div className="text-muted-foreground">Min Score</div>
                  <div className="font-mono font-medium">
                    {(stats.config.minQualityScore * 100).toFixed(0)}%
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>Minimum quality score to pass filter</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="text-center">
                  <div className="text-muted-foreground">Cold Thresh</div>
                  <div className="font-mono font-medium">
                    {stats.config.coldStreakThreshold} losses
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>Consecutive losses before blocking</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="text-center">
                  <div className="text-muted-foreground">Log Size</div>
                  <div className="font-mono font-medium">
                    {stats.decisionLogSize}
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>Buffered decisions for ML training</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        {/* Strategy Performance */}
        {strategies.length === 0 ? (
          <div className="text-center py-4 text-muted-foreground">
            <p className="text-xs">No strategy data yet</p>
          </div>
        ) : (
          <div className="space-y-2">
            {strategies.map((strategy) => (
              <StrategyCard
                key={strategy}
                strategy={strategy}
                perf={{
                  ...stats.strategies[strategy],
                  wins: perfData?.strategies[strategy]?.wins,
                  losses: perfData?.strategies[strategy]?.losses,
                }}
                coldStreakActive={stats.coldStreaks[strategy] || false}
              />
            ))}
          </div>
        )}

        {/* Filter Rules Status */}
        <div className="border-t pt-2">
          <div className="text-xs text-muted-foreground mb-1">Active Rules</div>
          <div className="flex flex-wrap gap-1">
            {stats.config.coldStreakEnabled && (
              <Badge variant="outline" className="text-xs">Cold Streak</Badge>
            )}
            {stats.config.strengthFilterEnabled && (
              <Badge variant="outline" className="text-xs">Strength</Badge>
            )}
            {stats.config.volumeConfirmEnabled && (
              <Badge variant="outline" className="text-xs">Volume</Badge>
            )}
            {stats.config.timeFilterEnabled && (
              <Badge variant="outline" className="text-xs">Time</Badge>
            )}
            {stats.config.crossConfirmEnabled && (
              <Badge variant="outline" className="text-xs">MTF</Badge>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

