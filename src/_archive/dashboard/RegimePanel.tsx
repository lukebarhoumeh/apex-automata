/**
 * RegimePanel - Displays real-time market regime detection status
 */

import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useRegimeStates,
  RegimeState,
  getRegimeColor,
  getRegimeLabel,
  getRegimeIcon,
  getTrendDirectionIcon,
} from '@/hooks/useRegimeState';

interface RegimeIndicatorProps {
  label: string;
  value: number;
  maxValue: number;
  thresholds?: { low: number; high: number };
  unit?: string;
  description?: string;
}

function RegimeIndicator({
  label,
  value,
  maxValue,
  thresholds,
  unit = '',
  description,
}: RegimeIndicatorProps) {
  const percentage = Math.min(100, (value / maxValue) * 100);
  
  let color = 'bg-blue-500';
  if (thresholds) {
    if (value < thresholds.low) color = 'bg-amber-500';
    else if (value > thresholds.high) color = 'bg-emerald-500';
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-mono">
                {value.toFixed(1)}{unit}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full ${color} transition-all duration-300`}
                style={{ width: `${percentage}%` }}
              />
            </div>
          </div>
        </TooltipTrigger>
        {description && (
          <TooltipContent>
            <p className="text-xs">{description}</p>
          </TooltipContent>
        )}
      </Tooltip>
    </TooltipProvider>
  );
}

interface SymbolRegimeCardProps {
  symbol: string;
  state: RegimeState;
}

function SymbolRegimeCard({ symbol, state }: SymbolRegimeCardProps) {
  const regimeColor = getRegimeColor(state.regime);
  const regimeSinceMs = new Date(state.regimeSince).getTime();
  const durationMin = Math.round((Date.now() - regimeSinceMs) / 60000);

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{symbol}</span>
          <span className="text-lg">{getTrendDirectionIcon(state.trendDirection)}</span>
        </div>
        <Badge
          style={{ 
            backgroundColor: `${regimeColor}20`, 
            color: regimeColor,
            borderColor: regimeColor,
          }}
          variant="outline"
        >
          {getRegimeIcon(state.regime)} {getRegimeLabel(state.regime)}
        </Badge>
      </div>

      {/* Confidence */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Confidence</span>
          <span className="font-mono">{(state.confidence * 100).toFixed(0)}%</span>
        </div>
        <Progress value={state.confidence * 100} className="h-1.5" />
      </div>

      {/* Key Metrics Grid */}
      <div className="grid grid-cols-2 gap-3">
        <RegimeIndicator
          label="ADX"
          value={state.adx}
          maxValue={100}
          thresholds={{ low: 20, high: 35 }}
          description="Average Directional Index: >35 strong trend, <20 no trend"
        />
        <RegimeIndicator
          label="Chop"
          value={state.choppiness}
          maxValue={100}
          thresholds={{ low: 38.2, high: 61.8 }}
          description="Choppiness Index: >61.8 choppy, <38.2 trending"
        />
        <RegimeIndicator
          label="ATR%"
          value={state.atrPercent * 100}
          maxValue={5}
          thresholds={{ low: 0.5, high: 2 }}
          unit="%"
          description="Volatility as % of price"
        />
        <RegimeIndicator
          label="BB Width"
          value={state.bbWidth}
          maxValue={10}
          thresholds={{ low: 2, high: 5 }}
          unit="%"
          description="Bollinger Band width: squeeze or expansion"
        />
      </div>

      {/* MTF Alignment */}
      <div className="space-y-1">
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">MTF Alignment</span>
          <span className="font-mono">
            {state.mtfAlignment >= 0 ? '+' : ''}{(state.mtfAlignment * 100).toFixed(0)}%
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden flex">
          <div
            className="h-full bg-red-500 transition-all duration-300"
            style={{ width: `${50 - state.mtfAlignment * 50}%` }}
          />
          <div
            className="h-full bg-emerald-500 transition-all duration-300"
            style={{ width: `${50 + state.mtfAlignment * 50}%` }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>Bearish</span>
          <span>Neutral</span>
          <span>Bullish</span>
        </div>
      </div>

      {/* Direction Consistency */}
      <div className="flex justify-between text-xs pt-1 border-t">
        <span className="text-muted-foreground">Direction</span>
        <span className="font-mono">
          {(state.directionConsistency * 100).toFixed(0)}% consistent
        </span>
      </div>

      {/* Regime Duration */}
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">Regime Duration</span>
        <span className="font-mono text-muted-foreground">
          {durationMin < 60 ? `${durationMin}m` : `${Math.round(durationMin / 60)}h ${durationMin % 60}m`}
        </span>
      </div>
    </div>
  );
}

export function RegimePanel() {
  const { data, isLoading, error } = useRegimeStates();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Market Regime</CardTitle>
          <CardDescription>Loading regime detection...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-3">
            <div className="h-32 bg-muted rounded-lg" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Market Regime</CardTitle>
          <CardDescription>
            Start the trading engine to see regime detection
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6 text-muted-foreground">
            <span className="text-4xl">📊</span>
            <p className="mt-2 text-sm">Engine not running</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const symbols = Object.keys(data.states);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Market Regime</CardTitle>
            <CardDescription>
              Real-time regime detection with ADX, Choppiness, and MTF alignment
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {data.summary.trending.length > 0 && (
              <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500">
                {data.summary.trending.length} Trending
              </Badge>
            )}
            {data.summary.ranging.length > 0 && (
              <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500">
                {data.summary.ranging.length} Ranging
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {symbols.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <span className="text-4xl">📊</span>
            <p className="mt-2 text-sm">Waiting for market data...</p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {symbols.map((symbol) => (
              <SymbolRegimeCard
                key={symbol}
                symbol={symbol}
                state={data.states[symbol]}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

