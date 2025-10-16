import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { X, TrendingUp, TrendingDown, Target, Shield } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

interface PositionDetailsDrawerProps {
  positionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClosePosition?: (positionId: string) => void;
}

export const PositionDetailsDrawer = ({
  positionId,
  open,
  onOpenChange,
  onClosePosition,
}: PositionDetailsDrawerProps) => {
  const { data: position } = useQuery({
    queryKey: ["position", positionId],
    queryFn: async () => {
      if (!positionId) return null;
      
      const { data, error } = await supabase
        .from("positions")
        .select("*")
        .eq("id", positionId)
        .single();

      if (error) throw error;
      return data;
    },
    enabled: !!positionId && open,
  });

  const { data: fills } = useQuery({
    queryKey: ["fills", positionId],
    queryFn: async () => {
      if (!positionId) return [];
      
      // Get orders for this position, then their fills
      const { data: orders } = await supabase
        .from("orders")
        .select("id")
        .eq("signal_id", positionId);

      if (!orders || orders.length === 0) return [];

      const orderIds = orders.map((o) => o.id);
      const { data, error } = await supabase
        .from("fills")
        .select("*")
        .in("order_id", orderIds)
        .order("filled_at", { ascending: true });

      if (error) throw error;
      return data;
    },
    enabled: !!positionId && open,
  });

  if (!position) return null;

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
    }).format(val);

  const riskAtEntry = Math.abs(position.entry_price - position.stop_price_at_entry) * position.qty_open;
  const currentPnL = position.realized_pnl_usd || 0;
  const isProfitable = currentPnL >= 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <div className="flex items-start justify-between">
            <div>
              <SheetTitle className="font-mono text-xl">
                {position.symbol}
              </SheetTitle>
              <SheetDescription className="font-mono">
                Position ID: {position.id.slice(0, 8)}...
              </SheetDescription>
            </div>
            <Badge
              variant={position.side === "long" ? "default" : "secondary"}
              className="font-mono"
            >
              {position.side.toUpperCase()}
            </Badge>
          </div>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* Entry Details */}
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground mb-3 font-mono">
              ENTRY DETAILS
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Strategy</div>
                <div className="font-mono text-sm font-semibold uppercase">
                  {position.strategy}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Quantity</div>
                <div className="font-mono text-sm font-semibold tabular-nums">
                  {position.qty_open}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Entry Price</div>
                <div className="font-mono text-sm font-semibold tabular-nums">
                  {formatCurrency(position.entry_price)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Opened At</div>
                <div className="font-mono text-sm tabular-nums">
                  {new Date(position.opened_at).toLocaleString()}
                </div>
              </div>
            </div>
          </div>

          <Separator />

          {/* Risk Management */}
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground mb-3 font-mono flex items-center gap-2">
              <Shield className="h-4 w-4" />
              RISK PARAMETERS
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Stop Price</div>
                <div className="font-mono text-sm font-semibold text-destructive tabular-nums">
                  {formatCurrency(position.stop_price_at_entry)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Take Profit</div>
                <div className="font-mono text-sm font-semibold text-success tabular-nums">
                  {position.take_profit_price
                    ? formatCurrency(position.take_profit_price)
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">Risk at Entry</div>
                <div className="font-mono text-sm font-semibold tabular-nums">
                  {formatCurrency(riskAtEntry)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">R Multiple</div>
                <div className="font-mono text-sm font-semibold tabular-nums">
                  {position.realized_r ? `${position.realized_r.toFixed(2)}R` : "—"}
                </div>
              </div>
            </div>
          </div>

          <Separator />

          {/* P&L */}
          <div>
            <h3 className="text-sm font-semibold text-muted-foreground mb-3 font-mono flex items-center gap-2">
              {isProfitable ? (
                <TrendingUp className="h-4 w-4 text-success" />
              ) : (
                <TrendingDown className="h-4 w-4 text-destructive" />
              )}
              PROFIT & LOSS
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-muted-foreground mb-1">Unrealized P&L</div>
                <div
                  className={`font-mono text-lg font-bold tabular-nums ${
                    isProfitable ? "text-success profit-glow" : "text-destructive loss-glow"
                  }`}
                >
                  {formatCurrency(currentPnL)}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">R Multiple</div>
                <div
                  className={`font-mono text-lg font-bold tabular-nums ${
                    isProfitable ? "text-success" : "text-destructive"
                  }`}
                >
                  {position.realized_r ? `${position.realized_r.toFixed(2)}R` : "0.00R"}
                </div>
              </div>
            </div>
          </div>

          {/* Fills Timeline */}
          {fills && fills.length > 0 && (
            <>
              <Separator />
              <div>
                <h3 className="text-sm font-semibold text-muted-foreground mb-3 font-mono">
                  FILLS TIMELINE
                </h3>
                <div className="space-y-2">
                  {fills.map((fill, idx) => (
                    <div
                      key={fill.id}
                      className="flex items-center justify-between p-2 rounded-md bg-muted/30 text-xs font-mono"
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          #{idx + 1}
                        </Badge>
                        <span className="tabular-nums">
                          {new Date(fill.filled_at).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="tabular-nums">
                          {fill.quantity} @ {formatCurrency(fill.price)}
                        </span>
                        {fill.slippage_bps && (
                          <span className="text-muted-foreground">
                            {fill.slippage_bps.toFixed(1)} bps
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Actions */}
          {!position.closed_at && onClosePosition && (
            <>
              <Separator />
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  className="flex-1 font-mono"
                  onClick={() => onClosePosition(position.id)}
                >
                  <X className="h-4 w-4 mr-2" />
                  Close Position
                </Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};
