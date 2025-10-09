import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TrendingUp, TrendingDown } from "lucide-react";

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
    timeOpen: "14:23"
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
    timeOpen: "15:07"
  }
];

export const PositionsPanel = () => {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Open Positions</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead>Side</TableHead>
              <TableHead>Entry</TableHead>
              <TableHead>Current</TableHead>
              <TableHead>P&L</TableHead>
              <TableHead>Meta</TableHead>
              <TableHead>Strategy</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {mockPositions.map((pos, idx) => (
              <TableRow key={idx} className="cursor-pointer hover:bg-muted/50">
                <TableCell className="font-medium">{pos.symbol}</TableCell>
                <TableCell>
                  <Badge 
                    variant={pos.side === "long" ? "default" : "secondary"}
                    className="capitalize"
                  >
                    {pos.side === "long" ? (
                      <TrendingUp className="h-3 w-3 mr-1" />
                    ) : (
                      <TrendingDown className="h-3 w-3 mr-1" />
                    )}
                    {pos.side}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-sm">${pos.entry.toLocaleString()}</TableCell>
                <TableCell className="font-mono text-sm">${pos.current.toLocaleString()}</TableCell>
                <TableCell>
                  <div className={pos.pnl >= 0 ? "text-success" : "text-destructive"}>
                    <div className="font-semibold">
                      {pos.pnl >= 0 ? "+" : ""}${pos.pnl.toFixed(2)}
                    </div>
                    <div className="text-xs">
                      {pos.pnlR >= 0 ? "+" : ""}{pos.pnlR.toFixed(2)}R
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono text-xs">
                    {(pos.metaProb * 100).toFixed(0)}%
                  </Badge>
                </TableCell>
                <TableCell className="text-sm">{pos.strategy}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{pos.timeOpen}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
};
