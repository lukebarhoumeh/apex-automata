import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TrendingUp, TrendingDown, X, Target } from "lucide-react";
import { Progress } from "@/components/ui/progress";

interface Position {
  symbol: string;
  side: "long" | "short";
  entry: number;
  current: number;
  size: number;
  pnl: number;
  pnlR: number;
  metaProb: number;
  strategy: string;
  timeOpen: string;
  stopLoss: number;
  takeProfit: number;
  riskProgress: number;
}

const mockPositions: Position[] = [
  {
    symbol: "BTC-USD",
    side: "long",
    entry: 63800,
    current: 64215,
    size: 0.15,
    pnl: 62.25,
    pnlR: 0.82,
    metaProb: 0.68,
    strategy: "Breakout",
    timeOpen: "14:23",
    stopLoss: 63425,
    takeProfit: 64575,
    riskProgress: 68
  },
  {
    symbol: "ETH-USD",
    side: "long",
    entry: 3420,
    current: 3445,
    size: 2.5,
    pnl: 62.50,
    pnlR: 0.95,
    metaProb: 0.71,
    strategy: "VWAP MR",
    timeOpen: "15:07",
    stopLoss: 3385,
    takeProfit: 3472,
    riskProgress: 82
  }
];

export const PositionsPanel = () => {
  return (
    <Card className="card-glow">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            Open Positions
            <Badge variant="outline" className="ml-2 bg-primary/10 border-primary/40">
              {mockPositions.length} Active
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
              {mockPositions.map((pos, idx) => (
                <TableRow 
                  key={idx} 
                  className="cursor-pointer hover:bg-muted/30 transition-colors border-border/50"
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
                        ${pos.entry.toLocaleString()}
                      </div>
                      <div className="font-mono text-sm font-semibold">
                        ${pos.current.toLocaleString()}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className={pos.pnl >= 0 ? "text-success" : "text-destructive"}>
                      <div className={`font-bold ${pos.pnl >= 0 ? 'profit-glow' : 'loss-glow'}`}>
                        {pos.pnl >= 0 ? "+" : ""}${pos.pnl.toFixed(2)}
                      </div>
                      <div className="text-xs font-medium">
                        {pos.pnlR >= 0 ? "+" : ""}{pos.pnlR.toFixed(2)}R
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1.5 min-w-[100px]">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">SL → TP</span>
                        <span className="font-medium">{pos.riskProgress}%</span>
                      </div>
                      <Progress value={pos.riskProgress} className="h-1.5" />
                      <div className="flex items-center justify-between text-xs font-mono">
                        <span className="text-destructive">${pos.stopLoss}</span>
                        <Target className="h-3 w-3 text-muted-foreground" />
                        <span className="text-success">${pos.takeProfit}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge 
                      variant="outline" 
                      className={`font-mono text-xs ${
                        pos.metaProb >= 0.7 
                          ? 'bg-success/10 border-success/40 text-success' 
                          : pos.metaProb >= 0.6
                          ? 'bg-warning/10 border-warning/40 text-warning'
                          : 'bg-muted'
                      }`}
                    >
                      {(pos.metaProb * 100).toFixed(0)}%
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs bg-card/50">
                      {pos.strategy}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground font-mono">
                    {pos.timeOpen}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
};
