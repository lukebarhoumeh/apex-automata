import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { List, ArrowUpRight, ArrowDownRight, Clock, DollarSign } from "lucide-react";
import { useRecentTrades, TradeRecord } from "@/hooks/useRecentTrades";

const TradeRow = ({ trade }: { trade: TradeRecord }) => {
  const isWin = trade.outcome === 'win';
  const isLoss = trade.outcome === 'loss';
  const isClosed = !!trade.exitTime;
  
  const formatCurrency = (val: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(val);

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '-';
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
  };

  const formatTime = (isoString?: string) => {
    if (!isoString) return '-';
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  };

  const pnl = trade.realizedPnl ?? trade.unrealizedPnl;
  const pnlColor = pnl >= 0 ? 'text-success' : 'text-destructive';

  return (
    <div className="flex items-center gap-2 py-2 px-2 hover:bg-muted/50 rounded-md transition-colors text-sm font-mono">
      {/* Side indicator */}
      <div className={`flex items-center ${trade.side === 'long' ? 'text-success' : 'text-destructive'}`}>
        {trade.side === 'long' ? (
          <ArrowUpRight className="h-4 w-4" />
        ) : (
          <ArrowDownRight className="h-4 w-4" />
        )}
      </div>

      {/* Symbol */}
      <div className="w-20 font-semibold truncate">
        {trade.symbol.replace('-USD', '')}
      </div>

      {/* Entry price */}
      <div className="w-20 text-muted-foreground text-xs">
        @{trade.entryPrice.toFixed(2)}
      </div>

      {/* Status / Outcome */}
      <div className="w-16">
        {isClosed ? (
          <Badge 
            variant={isWin ? "default" : isLoss ? "destructive" : "secondary"}
            className={`text-xs ${isWin ? 'bg-success' : ''}`}
          >
            {trade.outcome?.toUpperCase() || 'CLOSED'}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-xs">
            OPEN
          </Badge>
        )}
      </div>

      {/* Duration */}
      <div className="w-12 text-xs text-muted-foreground flex items-center gap-1">
        <Clock className="h-3 w-3" />
        {formatDuration(trade.duration)}
      </div>

      {/* P&L */}
      <div className={`w-20 text-right ${pnlColor} font-semibold`}>
        {pnl >= 0 ? '+' : ''}{formatCurrency(pnl)}
      </div>

      {/* Time */}
      <div className="w-20 text-xs text-muted-foreground text-right">
        {formatTime(trade.exitTime || trade.entryTime)}
      </div>
    </div>
  );
};

export const TradeLogPanel = () => {
  const { data: trades = [], isLoading } = useRecentTrades(15);

  const totalPnl = trades.reduce((sum, t) => sum + (t.realizedPnl ?? t.unrealizedPnl), 0);
  const wins = trades.filter(t => t.outcome === 'win').length;
  const losses = trades.filter(t => t.outcome === 'loss').length;

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(val);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-mono">
            <List className="h-4 w-4" />
            Recent Trades
          </CardTitle>
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className="text-success">{wins}W</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-destructive">{losses}L</span>
            <span className="text-muted-foreground mx-1">|</span>
            <span className={totalPnl >= 0 ? 'text-success' : 'text-destructive'}>
              {totalPnl >= 0 ? '+' : ''}{formatCurrency(totalPnl)}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-4 text-center text-muted-foreground">
            Loading trades...
          </div>
        ) : trades.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground">
            <DollarSign className="h-8 w-8 mx-auto mb-2 opacity-50" />
            No trades yet
          </div>
        ) : (
          <ScrollArea className="h-[300px]">
            <div className="px-2 pb-2">
              {/* Header */}
              <div className="flex items-center gap-2 py-1 px-2 text-xs text-muted-foreground font-mono border-b">
                <div className="w-4"></div>
                <div className="w-20">Symbol</div>
                <div className="w-20">Entry</div>
                <div className="w-16">Status</div>
                <div className="w-12">Dur.</div>
                <div className="w-20 text-right">P&L</div>
                <div className="w-20 text-right">Time</div>
              </div>
              {/* Trade rows */}
              {trades.map((trade) => (
                <TradeRow key={trade.id} trade={trade} />
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
};

