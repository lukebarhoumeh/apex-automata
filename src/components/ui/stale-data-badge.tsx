import { Badge } from "@/components/ui/badge";
import { AlertTriangle } from "lucide-react";
import { isStale, formatRelativeTime } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface StaleDataBadgeProps {
  lastUpdate: string | Date | null | undefined;
  thresholdSeconds?: number;
  className?: string;
}

export function StaleDataBadge({ 
  lastUpdate, 
  thresholdSeconds = 30,
  className 
}: StaleDataBadgeProps) {
  if (!isStale(lastUpdate, thresholdSeconds)) {
    return null;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge 
            variant="outline" 
            className={`bg-warning/10 border-warning/50 text-warning gap-1 ${className}`}
          >
            <AlertTriangle className="h-3 w-3" />
            DATA STALE
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="font-mono text-xs">
          <p>Last update: {formatRelativeTime(lastUpdate)}</p>
          <p className="text-muted-foreground">Data may be outdated</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
