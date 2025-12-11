import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSignals, useRealtimeSignals, useSignalDetails, type Signal, type SignalFilters } from "@/hooks/useSignals";
import { formatDistanceToNow } from "date-fns";
import { Activity, TrendingUp, TrendingDown, Filter, ExternalLink, Zap, X, CheckCircle2, XCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

export const SignalsTable = () => {
  const { toast } = useToast();
  const [filters, setFilters] = useState<SignalFilters>({});
  const [showFilters, setShowFilters] = useState(false);
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);

  const { data: signals, isLoading, refetch } = useSignals(filters);
  const { data: signalDetails } = useSignalDetails(selectedSignalId);

  // Real-time updates
  useRealtimeSignals(useCallback((signal) => {
    toast({
      title: `New ${signal.strategy} Signal`,
      description: `${signal.side.toUpperCase()} ${signal.symbol} - ${signal.allowed ? "ALLOWED" : "REJECTED"}`,
    });
    refetch();
  }, [toast, refetch]));

  const getStrategyColor = (strategy: string) => {
    switch (strategy) {
      case "breakout": return "bg-primary/10 text-primary border-primary/20";
      case "vwap_mr": return "bg-info/10 text-info border-info/20";
      case "obi_scalper": return "bg-warning/10 text-warning border-warning/20";
      case "momentum": return "bg-success/10 text-success border-success/20";
      default: return "bg-muted text-muted-foreground";
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Signals
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-primary" />
              Signal History
              {signals && signals.length > 0 && (
                <Badge variant="outline" className="ml-2 font-mono">
                  {signals.length}
                </Badge>
              )}
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
              className="gap-2"
            >
              <Filter className="h-4 w-4" />
              Filters
            </Button>
          </div>

          {/* Filters */}
          {showFilters && (
            <div className="flex flex-wrap gap-3 pt-4 border-t mt-4">
              <Select
                value={filters.symbol || "all"}
                onValueChange={(v) => setFilters(f => ({ ...f, symbol: v === "all" ? undefined : v }))}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Symbol" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Symbols</SelectItem>
                  <SelectItem value="BTC-USD">BTC-USD</SelectItem>
                  <SelectItem value="ETH-USD">ETH-USD</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={filters.strategy || "all"}
                onValueChange={(v) => setFilters(f => ({ ...f, strategy: v === "all" ? undefined : v }))}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Strategy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Strategies</SelectItem>
                  <SelectItem value="breakout">Breakout</SelectItem>
                  <SelectItem value="vwap_mr">VWAP MR</SelectItem>
                  <SelectItem value="obi_scalper">OBI Scalper</SelectItem>
                  <SelectItem value="momentum">Momentum</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={filters.allowed === undefined ? "all" : filters.allowed ? "allowed" : "rejected"}
                onValueChange={(v) => setFilters(f => ({ 
                  ...f, 
                  allowed: v === "all" ? undefined : v === "allowed" 
                }))}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="allowed">Allowed</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>

              <Input
                type="date"
                placeholder="From"
                className="w-[150px]"
                onChange={(e) => setFilters(f => ({ ...f, dateFrom: e.target.value || undefined }))}
              />

              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFilters({})}
              >
                <X className="h-4 w-4 mr-1" />
                Clear
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {!signals || signals.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Zap className="h-8 w-8 mb-2 opacity-50" />
              <span>No signals found</span>
            </div>
          ) : (
            <div className="overflow-auto max-h-[500px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Strategy</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                    <TableHead className="text-right">Meta Prob</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {signals.map((signal) => (
                    <TableRow 
                      key={signal.id}
                      className={!signal.allowed ? "opacity-60" : ""}
                    >
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(signal.decided_at), { addSuffix: true })}
                      </TableCell>
                      <TableCell className="font-mono font-semibold">
                        {signal.symbol}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={getStrategyColor(signal.strategy)}>
                          {signal.strategy.replace("_", " ").toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {signal.side === "long" ? (
                            <TrendingUp className="h-4 w-4 text-success" />
                          ) : (
                            <TrendingDown className="h-4 w-4 text-destructive" />
                          )}
                          <span className={signal.side === "long" ? "text-success" : "text-destructive"}>
                            {signal.side.toUpperCase()}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {signal.score.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {signal.meta_prob ? `${(signal.meta_prob * 100).toFixed(0)}%` : "—"}
                      </TableCell>
                      <TableCell>
                        {signal.allowed ? (
                          <Badge className="bg-success/10 text-success border-success/20 gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            ALLOWED
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1">
                            <XCircle className="h-3 w-3" />
                            REJECTED
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelectedSignalId(signal.id)}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Signal Details Dialog */}
      <Dialog open={!!selectedSignalId} onOpenChange={() => setSelectedSignalId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Signal Details
            </DialogTitle>
          </DialogHeader>
          {signalDetails && (
            <div className="space-y-4">
              {/* Signal Info */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <span className="text-sm text-muted-foreground">Symbol</span>
                  <p className="font-mono font-semibold">{signalDetails.signal.symbol}</p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Strategy</span>
                  <p>
                    <Badge variant="outline" className={getStrategyColor(signalDetails.signal.strategy)}>
                      {signalDetails.signal.strategy}
                    </Badge>
                  </p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Side</span>
                  <p className={signalDetails.signal.side === "long" ? "text-success" : "text-destructive"}>
                    {signalDetails.signal.side.toUpperCase()}
                  </p>
                </div>
                <div>
                  <span className="text-sm text-muted-foreground">Score / Confidence</span>
                  <p className="font-mono">
                    {signalDetails.signal.score.toFixed(2)} / {(signalDetails.signal.confidence * 100).toFixed(0)}%
                  </p>
                </div>
              </div>

              {/* Features */}
              {signalDetails.signal.features && (
                <div>
                  <span className="text-sm text-muted-foreground mb-2 block">Features at Entry</span>
                  <div className="bg-muted/30 rounded-lg p-3 font-mono text-xs overflow-auto max-h-[200px]">
                    <pre>{JSON.stringify(signalDetails.signal.features, null, 2)}</pre>
                  </div>
                </div>
              )}

              {/* Related Orders */}
              {signalDetails.orders.length > 0 && (
                <div>
                  <span className="text-sm text-muted-foreground mb-2 block">Related Orders</span>
                  <div className="space-y-2">
                    {signalDetails.orders.map((order: any) => (
                      <div key={order.id} className="flex items-center justify-between p-2 bg-muted/20 rounded">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{order.type}</Badge>
                          <span className="font-mono">{order.quantity} @ {order.price || "MKT"}</span>
                        </div>
                        <Badge>{order.status}</Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Reason */}
              {signalDetails.signal.reason && (
                <div>
                  <span className="text-sm text-muted-foreground">Reason</span>
                  <p className="text-sm">{signalDetails.signal.reason}</p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
