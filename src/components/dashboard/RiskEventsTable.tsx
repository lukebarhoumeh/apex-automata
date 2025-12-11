import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRiskEvents, useActiveRiskEvents, type RiskEvent } from "@/hooks/useRiskEvents";
import { formatDistanceToNow } from "date-fns";
import { AlertTriangle, ShieldAlert, Clock, TrendingDown, Zap, AlertCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

const getEventIcon = (eventType: string) => {
  switch (eventType) {
    case "kill_switch":
      return <ShieldAlert className="h-4 w-4 text-destructive" />;
    case "daily_stop":
      return <TrendingDown className="h-4 w-4 text-warning" />;
    case "spread_burst":
      return <Zap className="h-4 w-4 text-warning" />;
    case "atr_burst":
      return <AlertTriangle className="h-4 w-4 text-warning" />;
    default:
      return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
  }
};

const getEventBadge = (eventType: string, active: boolean) => {
  const baseClasses = "font-mono text-xs";
  
  if (!active) {
    return (
      <Badge variant="outline" className={`${baseClasses} opacity-50`}>
        {eventType.replace(/_/g, " ").toUpperCase()}
      </Badge>
    );
  }

  switch (eventType) {
    case "kill_switch":
      return (
        <Badge variant="destructive" className={baseClasses}>
          KILL SWITCH
        </Badge>
      );
    case "daily_stop":
      return (
        <Badge className={`${baseClasses} bg-warning text-warning-foreground`}>
          DAILY STOP
        </Badge>
      );
    case "spread_burst":
    case "atr_burst":
      return (
        <Badge variant="secondary" className={baseClasses}>
          {eventType.replace(/_/g, " ").toUpperCase()}
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className={baseClasses}>
          {eventType.replace(/_/g, " ").toUpperCase()}
        </Badge>
      );
  }
};

const formatEventDetails = (details: any): string => {
  if (!details) return "—";
  if (typeof details === "string") return details;
  
  // Extract meaningful info from JSON
  const parts: string[] = [];
  if (details.reason) parts.push(details.reason);
  if (details.spread_pctile) parts.push(`Spread: ${details.spread_pctile}%`);
  if (details.atr_mult) parts.push(`ATR: ${details.atr_mult}x`);
  if (details.daily_loss_r) parts.push(`Loss: ${details.daily_loss_r}R`);
  if (details.drawdown) parts.push(`DD: ${(details.drawdown * 100).toFixed(1)}%`);
  
  return parts.length > 0 ? parts.join(" • ") : JSON.stringify(details).slice(0, 50);
};

export const RiskEventsTable = () => {
  const { data: events, isLoading, error } = useRiskEvents();
  const { data: activeEvents } = useActiveRiskEvents();

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-destructive">
        Failed to load risk events
      </div>
    );
  }

  if (!events || events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-sm text-muted-foreground">
        <ShieldAlert className="h-8 w-8 mb-2 opacity-50" />
        <span>No risk events recorded</span>
      </div>
    );
  }

  return (
    <div className="overflow-auto max-h-[400px]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[50px]">Status</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Details</TableHead>
            <TableHead className="text-right">Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.map((event) => (
            <TableRow 
              key={event.id} 
              className={event.active ? "bg-destructive/5" : "opacity-60"}
            >
              <TableCell>
                {event.active ? (
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-destructive"></span>
                  </span>
                ) : (
                  <span className="flex h-3 w-3 rounded-full bg-muted"></span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  {getEventIcon(event.event_type)}
                  {getEventBadge(event.event_type, event.active)}
                </div>
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground max-w-[200px] truncate">
                {formatEventDetails(event.details)}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  {formatDistanceToNow(new Date(event.triggered_at), { addSuffix: true })}
                </div>
                {event.cleared_at && (
                  <div className="text-xs text-success mt-0.5">
                    Cleared {formatDistanceToNow(new Date(event.cleared_at), { addSuffix: true })}
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
