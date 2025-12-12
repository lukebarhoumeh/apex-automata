import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Activity, ArrowUp, ArrowDown } from "lucide-react";
import { useRuntimeEvents } from "@/hooks/useRuntimeEvents";
import { format } from "date-fns";

interface Signal {
  id: string;
  symbol: string;
  strategy: string;
  direction: "buy" | "sell";
  strength: number;
  price: number;
  stopLoss?: number;
  takeProfit?: number;
  metaLabel?: number;
  timestamp: number;
  reason?: string;
}

export const LiveSignalsTable = () => {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [filter, setFilter] = useState<string>("all");

  const handleSignal = useCallback((data: unknown) => {
    const signalData = data as {
      symbol: string;
      strategy: string;
      direction: "buy" | "sell";
      strength: number;
      price: number;
      stopLoss?: number;
      takeProfit?: number;
      metaLabel?: number;
      metadata?: { reason?: string };
    };

    const newSignal: Signal = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      symbol: signalData.symbol,
      strategy: signalData.strategy,
      direction: signalData.direction,
      strength: signalData.strength,
      price: signalData.price,
      stopLoss: signalData.stopLoss,
      takeProfit: signalData.takeProfit,
      metaLabel: signalData.metaLabel,
      timestamp: Date.now(),
      reason: signalData.metadata?.reason,
    };

    setSignals((prev) => [newSignal, ...prev].slice(0, 100));
  }, []);

  const { isConnected } = useRuntimeEvents({
    onSignal: handleSignal,
  });

  const filteredSignals =
    filter === "all"
      ? signals
      : signals.filter((s) => s.strategy.toLowerCase() === filter.toLowerCase());

  const formatPrice = (price: number) =>
    `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-mono">
            <Activity className="h-4 w-4 text-primary" />
            Live Signals
            {isConnected && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-7 px-2 text-xs font-mono rounded border bg-background"
            >
              <option value="all">All Strategies</option>
              <option value="breakout">Breakout</option>
              <option value="vwap_mr">VWAP MR</option>
              <option value="momentum">Momentum</option>
            </select>
            <Badge variant="outline" className="font-mono">
              {filteredSignals.length}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[300px]">
          <Table>
            <TableHeader>
              <TableRow className="font-mono text-xs">
                <TableHead>Time</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Strategy</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead className="text-right">Strength</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">SL</TableHead>
                <TableHead className="text-right">TP</TableHead>
                <TableHead className="text-right">Meta</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono text-xs">
              {filteredSignals.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                    {isConnected
                      ? "Waiting for signals..."
                      : "Connect to backend to receive signals"}
                  </TableCell>
                </TableRow>
              ) : (
                filteredSignals.map((signal) => (
                  <TableRow key={signal.id}>
                    <TableCell className="tabular-nums whitespace-nowrap">
                      {format(new Date(signal.timestamp), "HH:mm:ss")}
                    </TableCell>
                    <TableCell className="font-semibold">{signal.symbol}</TableCell>
                    <TableCell className="uppercase text-muted-foreground">
                      {signal.strategy}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={signal.direction === "buy" ? "default" : "secondary"}
                        className="gap-1"
                      >
                        {signal.direction === "buy" ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        )}
                        {signal.direction.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div
                        className="w-full h-1.5 rounded-full bg-muted overflow-hidden"
                        title={`${(signal.strength * 100).toFixed(0)}%`}
                      >
                        <div
                          className={`h-full ${
                            signal.strength > 0.7
                              ? "bg-success"
                              : signal.strength > 0.5
                              ? "bg-warning"
                              : "bg-muted-foreground"
                          }`}
                          style={{ width: `${signal.strength * 100}%` }}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPrice(signal.price)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-destructive">
                      {signal.stopLoss ? formatPrice(signal.stopLoss) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-success">
                      {signal.takeProfit ? formatPrice(signal.takeProfit) : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {signal.metaLabel !== undefined
                        ? `${(signal.metaLabel * 100).toFixed(0)}%`
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
};
