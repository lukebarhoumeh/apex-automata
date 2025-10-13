import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TrendingUp, TrendingDown, X, Target } from "lucide-react";
import { Progress } from "@/components/ui/progress";

interface Position {
  id?: string;
  symbol: string;
  side: "long" | "short";
  entry_price: number;
  current_price: number;
  size: number;
  pnl: number;
  pnl_r: number;
  meta_prob: number | null;
  strategy: string;
  time_opened: string;
  stop_loss: number;
  take_profit: number;
  risk_progress: number;
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
                  <TableHead className="font-semibold">Entry → Current</TableHead>
                  <TableHead className="font-semibold">P&L</TableHead>
                  <TableHead className="font-semibold">Progress</TableHead>
                  <TableHead className="font-semibold">Meta</TableHead>
                  <TableHead className="font-semibold">Strategy</TableHead>
                  <TableHead className="font-semibold">Time</TableHead>
                  <TableHead className="text-right font-semibold">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayPositions.map((pos, idx) => {
                  const timeFormatted = new Date(pos.time_opened).toLocaleTimeString('en-US', { 
                    hour: '2-digit', 
                    minute: '2-digit',
                    hour12: false 
                  });
                  
                  return (
                  <TableRow 
                    key={pos.id || idx} 
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
                      <div className="space-y-0.5">
                        <div className="font-mono text-xs text-muted-foreground">
                          ${pos.entry_price.toLocaleString()}
                        </div>
                        <div className="font-mono text-sm font-semibold">
                          ${pos.current_price.toLocaleString()}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className={pos.pnl >= 0 ? "text-success" : "text-destructive"}>
                        <div className={`font-bold ${pos.pnl >= 0 ? 'profit-glow' : 'loss-glow'}`}>
                          {pos.pnl >= 0 ? "+" : ""}${pos.pnl.toFixed(2)}
                        </div>
                        <div className="text-xs font-medium">
                          {pos.pnl_r >= 0 ? "+" : ""}{pos.pnl_r.toFixed(2)}R
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1.5 min-w-[100px]">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">SL → TP</span>
                          <span className="font-medium">{pos.risk_progress}%</span>
                        </div>
                        <Progress value={pos.risk_progress} className="h-1.5" />
                        <div className="flex items-center justify-between text-xs font-mono">
                          <span className="text-destructive">${pos.stop_loss}</span>
                          <Target className="h-3 w-3 text-muted-foreground" />
                          <span className="text-success">${pos.take_profit}</span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge 
                        variant="outline" 
                        className={`font-mono text-xs ${
                          (pos.meta_prob || 0) >= 0.7 
                            ? 'bg-success/10 border-success/40 text-success' 
                            : (pos.meta_prob || 0) >= 0.6
                            ? 'bg-warning/10 border-warning/40 text-warning'
                            : 'bg-muted'
                        }`}
                      >
                        {pos.meta_prob ? ((pos.meta_prob || 0) * 100).toFixed(0) : '-'}%
                      </Badge>
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
