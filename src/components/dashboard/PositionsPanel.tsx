import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TrendingUp, TrendingDown, X, Target } from "lucide-react";
import { Progress } from "@/components/ui/progress";

interface Position {
  id: string;
  user_id: string;
  symbol: string;
  strategy: string;
  side: "long" | "short";
  qty_open: number;
  entry_price: number;
  stop_price_at_entry: number;
  take_profit_price: number | null;
  opened_at: string;
  closed_at: string | null;
  exit_price: number | null;
  exit_reason: string | null;
  realized_pnl_usd: number | null;
  realized_r: number | null;
  created_at: string;
}

interface PositionsPanelProps {
  positions?: Position[];
}

export const PositionsPanel = ({ positions = [] }: PositionsPanelProps) => {
  const displayPositions = positions.length > 0 ? positions : [];
  const isEmpty = displayPositions.length === 0;
  return (
    <Card className="card-glow">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            Open Positions
            <Badge variant="outline" className="ml-2 bg-primary/10 border-primary/40 animate-fade-in">
              {displayPositions.length} Active
            </Badge>
          </CardTitle>
          <div className="flex gap-2">
            <Badge variant="outline" className="text-xs">
              Total Risk: 2.1%
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center py-12 space-y-4 animate-fade-in">
            <div className="p-4 rounded-full bg-muted/30 border-2 border-dashed border-border">
              <TrendingUp className="h-8 w-8 text-muted-foreground" />
            </div>
            <div className="text-center space-y-1">
              <p className="text-sm font-medium text-foreground">No Open Positions</p>
              <p className="text-xs text-muted-foreground">Positions will appear here when the bot opens trades</p>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-border/50 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead className="font-semibold">Symbol</TableHead>
                  <TableHead className="font-semibold">Side</TableHead>
                  <TableHead className="font-semibold">Entry Price</TableHead>
                  <TableHead className="font-semibold">Qty</TableHead>
                  <TableHead className="font-semibold">P&L</TableHead>
                  <TableHead className="font-semibold">Progress</TableHead>
                  <TableHead className="font-semibold">Strategy</TableHead>
                  <TableHead className="font-semibold">Time</TableHead>
                  <TableHead className="text-right font-semibold">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayPositions.map((pos, idx) => {
                  const timeFormatted = new Date(pos.opened_at).toLocaleTimeString('en-US', { 
                    hour: '2-digit', 
                    minute: '2-digit',
                    hour12: false 
                  });
                  
                  const pnl = pos.realized_pnl_usd || 0;
                  const rValue = pos.realized_r || 0;
                  
                  return (
                  <TableRow 
                    key={pos.id} 
                    className="cursor-pointer hover:bg-muted/30 transition-all duration-200 border-border/50 animate-slide-up hover:scale-[1.01]"
                    style={{ animationDelay: `${idx * 50}ms` }}
                  >
                    <TableCell className="font-bold">{pos.symbol}</TableCell>
                  <TableCell>
                    <Badge 
                      variant="outline"
                      className={pos.side === "long" 
                        ? "bg-success/10 text-success border-success/40" 
                        : "bg-destructive/10 text-destructive border-destructive/40"
                      }
                    >
                      {pos.side === "long" ? (
                        <TrendingUp className="h-3 w-3 mr-1" />
                      ) : (
                        <TrendingDown className="h-3 w-3 mr-1" />
                      )}
                      {pos.side.toUpperCase()}
                    </Badge>
                  </TableCell>
                    <TableCell>
                      <div className="font-mono text-sm font-semibold">
                        ${pos.entry_price.toLocaleString()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-sm">
                        {pos.qty_open}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className={pnl >= 0 ? "text-success" : "text-destructive"}>
                        <div className={`font-bold ${pnl >= 0 ? 'profit-glow' : 'loss-glow'}`}>
                          {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                        </div>
                        <div className="text-xs font-medium">
                          {rValue >= 0 ? "+" : ""}{rValue.toFixed(2)}R
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1.5 min-w-[100px]">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">SL → TP</span>
                          <span className="font-medium">0%</span>
                        </div>
                        <Progress value={0} className="h-1.5" />
                        <div className="flex items-center justify-between text-xs font-mono">
                          <span className="text-destructive">${pos.stop_price_at_entry}</span>
                          <Target className="h-3 w-3 text-muted-foreground" />
                          <span className="text-success">${pos.take_profit_price || '-'}</span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs bg-card/50">
                        {pos.strategy}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground font-mono">
                      {timeFormatted}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10 transition-all hover:scale-110"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
