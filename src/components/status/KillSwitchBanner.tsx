/**
 * Kill Switch Banner
 * 
 * Sprint 1.6: Persistent banner shown when kill switch is active.
 * Cannot be dismissed - stays until kill switch is reset.
 */

import { AlertTriangle, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import type { TradingUiState } from '@/runtime/state/tradingState';

interface KillSwitchBannerProps {
  state: TradingUiState;
}

export function KillSwitchBanner({ state }: KillSwitchBannerProps) {
  // Only show for KILL_SWITCH or STOPPED_UNEXPECTED states
  if (state.state !== 'KILL_SWITCH' && state.state !== 'STOPPED_UNEXPECTED') {
    return null;
  }

  const isKillSwitch = state.state === 'KILL_SWITCH';
  const title = isKillSwitch ? 'Kill Switch Active' : 'Engine Stopped Unexpectedly';
  const reasons = isKillSwitch 
    ? (state.reasons.length > 0 ? state.reasons.join(', ') : state.reasonCode || 'Unknown')
    : state.reason || 'Check backend logs for details';

  return (
    <div 
      className={`
        w-full px-4 py-3 
        ${isKillSwitch ? 'bg-destructive/15' : 'bg-warning/15'}
        border-b 
        ${isKillSwitch ? 'border-destructive/30' : 'border-warning/30'}
      `}
    >
      <div className="container mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <AlertTriangle 
            className={`h-5 w-5 ${isKillSwitch ? 'text-destructive' : 'text-warning'} animate-pulse`} 
          />
          <div>
            <p className={`font-semibold ${isKillSwitch ? 'text-destructive' : 'text-warning'}`}>
              {title}
            </p>
            <p className="text-sm text-muted-foreground">
              {isKillSwitch 
                ? `Trading halted for safety. Reason: ${reasons}. Manual reset required to resume.`
                : `Reason: ${reasons}`
              }
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-2 ml-8 sm:ml-0">
          <Button 
            variant="outline" 
            size="sm" 
            className="text-xs"
            asChild
          >
            <Link to="/risk">
              <ExternalLink className="h-3 w-3 mr-1" />
              Risk Controls
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
