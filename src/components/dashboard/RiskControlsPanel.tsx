/**
 * RiskControlsPanel - Extended Risk Controls Dashboard
 */

import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AlertTriangle, Shield, TrendingUp, TrendingDown, Ban, CheckCircle } from 'lucide-react';
import {
  useRiskStatus,
  useRiskAnalytics,
  useBlockedSymbols,
  useSoftLaunchStatus,
  useToggleKillSwitch,
  useUnblockSymbol,
  useResetDailyTracking,
  getRiskLevelColor,
  formatPnL,
  formatPercent,
} from '@/hooks/useRiskControls';

function StatBox({ 
  label, 
  value, 
  color, 
  icon: Icon 
}: { 
  label: string; 
  value: string | number; 
  color?: string;
  icon?: React.ElementType;
}) {
  return (
    <div className="flex items-center justify-between p-2 rounded border bg-muted/30">
      <span className="text-xs text-muted-foreground flex items-center gap-1">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </span>
      <span 
        className="font-mono text-sm font-medium"
        style={{ color: color || 'inherit' }}
      >
        {value}
      </span>
    </div>
  );
}

function RiskMeter({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = Math.min(Math.abs(value) / Math.abs(max) * 100, 100);
  const isProfit = value >= 0;
  
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={isProfit ? 'text-green-500' : 'text-red-500'}>
          {formatPnL(value)}
        </span>
      </div>
      <Progress 
        value={percent} 
        className={`h-2 ${isProfit ? '[&>div]:bg-green-500' : '[&>div]:bg-red-500'}`}
      />
      <div className="text-xs text-muted-foreground text-right">
        Limit: {formatPnL(max)}
      </div>
    </div>
  );
}

export function RiskControlsPanel() {
  const { data: status, isLoading: statusLoading, error: statusError } = useRiskStatus();
  const { data: analytics } = useRiskAnalytics();
  const { data: blocked } = useBlockedSymbols();
  const { data: softLaunch } = useSoftLaunchStatus();
  
  const toggleKillSwitch = useToggleKillSwitch();
  const unblockSymbol = useUnblockSymbol();
  const resetDaily = useResetDailyTracking();

  if (statusLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Risk Controls
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-2">
            <div className="h-8 bg-muted rounded" />
            <div className="h-8 bg-muted rounded" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (statusError || !status) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="h-4 w-4" />
            Risk Controls
          </CardTitle>
          <CardDescription className="text-xs">
            Start the engine to view risk status
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-4 text-muted-foreground">
            <Shield className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-xs">Engine not running</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const pnlColor = getRiskLevelColor(status.metrics.dailyPnL, -500);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4" />
            <CardTitle className="text-sm">Risk Controls</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {status.killSwitchActive ? (
              <Badge variant="destructive" className="text-xs animate-pulse">
                <Ban className="h-3 w-3 mr-1" />
                KILL SWITCH
              </Badge>
            ) : status.tradingAllowed ? (
              <Badge variant="outline" className="text-xs border-green-500 text-green-500">
                <CheckCircle className="h-3 w-3 mr-1" />
                Trading OK
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-xs">
                <AlertTriangle className="h-3 w-3 mr-1" />
                Paused
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Daily P&L */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-muted-foreground">Daily P&L</span>
            <span 
              className="font-mono text-lg font-bold"
              style={{ color: pnlColor }}
            >
              {formatPnL(status.metrics.dailyPnL)}
            </span>
          </div>
          <Progress 
            value={Math.min(Math.abs(status.metrics.dailyPnL) / 500 * 100, 100)} 
            className={`h-2 ${status.metrics.dailyPnL >= 0 ? '[&>div]:bg-green-500' : '[&>div]:bg-red-500'}`}
          />
        </div>

        {/* Quick Stats Grid */}
        <div className="grid grid-cols-2 gap-2">
          <StatBox 
            label="Positions" 
            value={`${status.positions.open}/${status.positions.max}`}
            color={status.positions.open >= status.positions.max ? '#ef4444' : undefined}
          />
          <StatBox 
            label="Consecutive L" 
            value={status.metrics.consecutiveLosses}
            color={status.metrics.consecutiveLosses >= 3 ? '#ef4444' : undefined}
          />
          <StatBox 
            label="Exposure" 
            value={`$${status.metrics.currentExposure.toLocaleString()}`}
          />
          <StatBox 
            label="Max DD" 
            value={formatPercent(-status.metrics.maxDrawdown)}
            color={status.metrics.maxDrawdown > 0.05 ? '#ef4444' : undefined}
          />
        </div>

        {/* Session Stats */}
        {analytics && (
          <div className="border-t pt-3 space-y-2">
            <span className="text-xs text-muted-foreground">Session Stats</span>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-2 rounded bg-muted/30">
                <div className="text-lg font-mono font-bold">{analytics.session.trades}</div>
                <div className="text-xs text-muted-foreground">Trades</div>
              </div>
              <div className="p-2 rounded bg-muted/30">
                <div className="text-lg font-mono font-bold text-green-500">
                  {(analytics.session.winRate * 100).toFixed(0)}%
                </div>
                <div className="text-xs text-muted-foreground">Win Rate</div>
              </div>
              <div className="p-2 rounded bg-muted/30">
                <div className="text-lg font-mono font-bold">
                  {analytics.session.profitFactor.toFixed(2)}
                </div>
                <div className="text-xs text-muted-foreground">PF</div>
              </div>
            </div>
          </div>
        )}

        {/* Soft Launch Indicator */}
        {softLaunch?.active && (
          <div className="border border-amber-500/50 rounded p-2 bg-amber-500/10">
            <div className="flex items-center gap-2 text-amber-500 text-xs font-medium">
              <AlertTriangle className="h-3 w-3" />
              Soft Launch Mode
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {softLaunch.tradesDone}/{softLaunch.maxTrades} trades at reduced size
            </div>
          </div>
        )}

        {/* Blocked Symbols */}
        {blocked && blocked.count > 0 && (
          <div className="border-t pt-3 space-y-2">
            <span className="text-xs text-muted-foreground">Blocked Symbols</span>
            <div className="flex flex-wrap gap-1">
              {blocked.blockedSymbols.map((symbol) => (
                <TooltipProvider key={symbol}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge 
                        variant="destructive" 
                        className="text-xs cursor-pointer"
                        onClick={() => unblockSymbol.mutate(symbol)}
                      >
                        <Ban className="h-3 w-3 mr-1" />
                        {symbol}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Click to unblock</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ))}
            </div>
          </div>
        )}

        {/* Control Buttons */}
        <div className="border-t pt-3 flex gap-2">
          <Button
            variant={status.killSwitchActive ? "default" : "destructive"}
            size="sm"
            className="flex-1 text-xs"
            onClick={() => toggleKillSwitch.mutate({ 
              active: !status.killSwitchActive,
              reason: status.killSwitchActive ? 'Manual deactivation' : 'Manual activation',
            })}
            disabled={toggleKillSwitch.isPending}
          >
            {status.killSwitchActive ? 'Resume Trading' : 'Kill Switch'}
          </Button>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => resetDaily.mutate()}
                  disabled={resetDaily.isPending}
                >
                  Reset Day
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Reset daily tracking (P&L, blocks)</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </CardContent>
    </Card>
  );
}

