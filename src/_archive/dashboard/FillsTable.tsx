import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { FIXED_USER_ID } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useState, useEffect } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Tables } from "@/integrations/supabase/types";

type Fill = Tables<"fills">;
type Order = Tables<"orders">;

interface FillWithOrder extends Fill {
  order?: Order;
}

export const FillsTable = () => {
  const [fills, setFills] = useState<FillWithOrder[]>([]);
  const [filterOrderId, setFilterOrderId] = useState<string>("all");

  // Fetch fills with order info
  const { data: fillsData, isLoading } = useQuery({
    queryKey: ["fills-with-orders", FIXED_USER_ID],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fills")
        .select(`
          *,
          order:orders(*)
        `)
        .eq("user_id", FIXED_USER_ID)
        .order("filled_at", { ascending: false })
        .limit(200);

      if (error) throw error;
      return data as FillWithOrder[];
    },
    refetchInterval: 5000,
  });

  // Fetch unique orders for filter
  const { data: ordersList } = useQuery({
    queryKey: ["orders-list", FIXED_USER_ID],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders")
        .select("id, symbol, side, created_at")
        .eq("user_id", FIXED_USER_ID)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      return data;
    },
  });

  // Setup realtime subscription
  useEffect(() => {
    if (fillsData) setFills(fillsData);

    const channel = supabase
      .channel("fills-realtime-table")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "fills",
        },
        (payload) => {
          setFills((prev) => [payload.new as FillWithOrder, ...prev].slice(0, 200));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fillsData]);

  const filteredFills = filterOrderId === "all" 
    ? fills 
    : fills.filter(f => f.order_id === filterOrderId);

  // Calculate aggregate stats per order
  const orderStats = fills.reduce((acc, fill) => {
    if (!acc[fill.order_id]) {
      acc[fill.order_id] = {
        totalQty: 0,
        totalValue: 0,
        fillCount: 0,
        totalFees: 0,
        avgSlippage: 0,
        slippageSum: 0,
      };
    }
    acc[fill.order_id].totalQty += Number(fill.quantity);
    acc[fill.order_id].totalValue += Number(fill.quantity) * Number(fill.price);
    acc[fill.order_id].fillCount += 1;
    acc[fill.order_id].totalFees += Number(fill.fee_amount || 0);
    acc[fill.order_id].slippageSum += Number(fill.slippage_bps || 0);
    acc[fill.order_id].avgSlippage = acc[fill.order_id].slippageSum / acc[fill.order_id].fillCount;
    return acc;
  }, {} as Record<string, { totalQty: number; totalValue: number; fillCount: number; totalFees: number; avgSlippage: number; slippageSum: number }>);

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString("en-US", {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const formatPrice = (price: number) => `$${Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="font-mono text-base">Fills Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">Loading fills...</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="font-mono text-base">Fills Breakdown</CardTitle>
          <div className="flex items-center gap-2">
            <Select value={filterOrderId} onValueChange={setFilterOrderId}>
              <SelectTrigger className="w-[200px] h-8 text-xs font-mono">
                <SelectValue placeholder="Filter by order" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Orders</SelectItem>
                {ordersList?.map((order) => (
                  <SelectItem key={order.id} value={order.id} className="font-mono text-xs">
                    {order.symbol} {order.side.toUpperCase()} - {new Date(order.created_at).toLocaleDateString()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Badge variant="outline" className="font-mono">
              {filteredFills.length} fills
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Order Summary Stats */}
        {filterOrderId !== "all" && orderStats[filterOrderId] && (
          <div className="grid grid-cols-4 gap-3 p-3 rounded-lg bg-muted/50">
            <div>
              <div className="text-xs text-muted-foreground">Avg Fill Price</div>
              <div className="font-mono font-semibold">
                {formatPrice(orderStats[filterOrderId].totalValue / orderStats[filterOrderId].totalQty)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Total Filled</div>
              <div className="font-mono font-semibold">
                {orderStats[filterOrderId].totalQty.toFixed(6)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Total Fees</div>
              <div className="font-mono font-semibold">
                ${orderStats[filterOrderId].totalFees.toFixed(4)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Avg Slippage</div>
              <div className="font-mono font-semibold">
                {orderStats[filterOrderId].avgSlippage.toFixed(1)} bps
              </div>
            </div>
          </div>
        )}

        {/* Fills Table */}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="font-mono text-xs">
                <TableHead>Time</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead className="text-right">Fee</TableHead>
                <TableHead className="text-right">Slippage</TableHead>
                <TableHead>Maker</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono text-xs">
              {filteredFills.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                    No fills recorded yet
                  </TableCell>
                </TableRow>
              ) : (
                filteredFills.map((fill) => (
                  <TableRow key={fill.id}>
                    <TableCell className="tabular-nums whitespace-nowrap">
                      {formatTime(fill.filled_at)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {fill.order_id.slice(0, 8)}...
                    </TableCell>
                    <TableCell className="font-semibold">
                      {fill.order?.symbol || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={fill.order?.side === "buy" ? "default" : "secondary"}
                        className="text-xs"
                      >
                        {fill.order?.side?.toUpperCase() || "—"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPrice(fill.price)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(fill.quantity).toFixed(6)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPrice(Number(fill.price) * Number(fill.quantity))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      ${Number(fill.fee_amount || 0).toFixed(4)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      <span className={Number(fill.slippage_bps || 0) > 5 ? "text-destructive" : ""}>
                        {Number(fill.slippage_bps || 0).toFixed(1)} bps
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={fill.maker ? "outline" : "secondary"} className="text-xs">
                        {fill.maker ? "Maker" : "Taker"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
};
