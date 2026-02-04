/**
 * Trading State Pill
 * 
 * Sprint 1.6: Always-visible trading state indicator.
 * Shows at-a-glance truth about trading engine status.
 */

import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { 
  PlayCircle, 
  PauseCircle, 
  AlertTriangle, 
  XCircle, 
  WifiOff,
  Clock
} from 'lucide-react';
import type { TradingUiState } from '@/runtime/state/tradingState';
import { getTradingStateDisplay } from '@/runtime/state/tradingState';

interface TradingStatePillProps {
  state: TradingUiState;
  className?: string;
}

export function TradingStatePill({ state, className }: TradingStatePillProps) {
  const display = getTradingStateDisplay(state);

  const getIcon = () => {
    switch (state.state) {
      case 'RUNNING':
        return <PlayCircle className="h-3.5 w-3.5" />;
      case 'PAUSED':
        return <PauseCircle className="h-3.5 w-3.5" />;
      case 'KILL_SWITCH':
        return <AlertTriangle className="h-3.5 w-3.5" />;
      case 'STOPPED_UNEXPECTED':
        return <XCircle className="h-3.5 w-3.5" />;
      case 'DISCONNECTED':
        return <WifiOff className="h-3.5 w-3.5" />;
      case 'STALE':
        return <Clock className="h-3.5 w-3.5" />;
    }
  };

  const getVariantClasses = () => {
    switch (display.variant) {
      case 'success':
        return 'bg-success/20 text-success border-success/30 hover:bg-success/30';
      case 'warning':
        return 'bg-warning/20 text-warning border-warning/30 hover:bg-warning/30';
      case 'destructive':
        return 'bg-destructive/20 text-destructive border-destructive/30 hover:bg-destructive/30';
      case 'muted':
        return 'bg-muted/50 text-muted-foreground border-muted hover:bg-muted/70';
    }
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge 
            variant="outline" 
            className={`
              font-mono text-xs font-semibold gap-1.5 px-3 py-1 cursor-default
              transition-colors duration-200
              ${getVariantClasses()}
              ${state.state === 'KILL_SWITCH' || state.state === 'STOPPED_UNEXPECTED' ? 'animate-pulse' : ''}
              ${className || ''}
            `}
          >
            {getIcon()}
            <span>{display.label}</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent 
          side="bottom" 
          className="max-w-xs font-mono text-xs"
        >
          <div className="space-y-1">
            <p className={`font-semibold ${
              display.variant === 'success' ? 'text-success' :
              display.variant === 'warning' ? 'text-warning' : 
              display.variant === 'destructive' ? 'text-destructive' : ''
            }`}>
              {display.label}
            </p>
            <p className="text-muted-foreground">{display.description}</p>
            {state.state === 'KILL_SWITCH' && state.reasons.length > 0 && (
              <div className="pt-1 border-t border-border mt-1">
                <p className="text-destructive">Reasons:</p>
                <ul className="list-disc list-inside text-muted-foreground">
                  {state.reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
