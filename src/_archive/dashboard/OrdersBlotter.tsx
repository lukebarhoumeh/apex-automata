import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Eye, X } from "lucide-react";
import { useEffect, useState } from "react";

interface Order {
  id: string;
  created_at: string;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  status: string;
  price: number | null;
  quantity: number;
  filled_qty?: number;
  meta_prob: number | null;
  strategy: string;
}

interface OrdersBlotterProps {
  onViewDetails: (orderId: string) => void;
}

export const OrdersBlotter = ({ onViewDetails }: OrdersBlotterProps) => {
  const [orders, setOrders] = useState<Order[]>([]);
  
  const { data, isLoading } = useQuery({
    queryKey: ["orders"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders")
        .select(`
          id,
          created_at,
          symbol,
          side,
          type,
          status,
          price,
          quantity,
          meta_prob,
          strategy
        `)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw error;
      return data as Order[];
    },
    refetchInterval: 3000,
  });

  // Setup realtime subscription
  useEffect(() => {
    if (data) setOrders(data);

    const channel = supabase
      .channel("orders-realtime")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orders",
        },
        (payload) => {
          console.log("Order update:", payload);
          if (payload.eventType === "INSERT") {
            setOrders((prev) => [payload.new as Order, ...prev].slice(0, 50));
          } else if (payload.eventType === "UPDATE") {
            setOrders((prev) =>
              prev.map((o) => (o.id === payload.new.id ? (payload.new as Order) : o))
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [data]);

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "filled":
        return "default";
      case "partial":
        return "secondary";
      case "new":
        return "outline";
      case "cancelled":
      case "rejected":
        return "destructive";
      default:
        return "outline";
    }
  };

  const formatPrice = (price: number | null) =>
    price ? `$${price.toFixed(2)}` : "—";

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="font-mono text-base">Orders Blotter</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm text-muted-foreground">Loading orders...</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="font-mono text-base">Orders Blotter</CardTitle>
          <Badge variant="outline" className="font-mono">
            {orders.length} orders
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="font-mono text-xs">
                <TableHead>Time</TableHead>
                <TableHead>Symbol</TableHead>
                <TableHead>Side</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Prob</TableHead>
                <TableHead>Strategy</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono text-xs">
              {orders.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground">
                    No orders yet
                  </TableCell>
                </TableRow>
              ) : (
                orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="tabular-nums">
                      {formatTime(order.created_at)}
                    </TableCell>
                    <TableCell className="font-semibold">{order.symbol}</TableCell>
                    <TableCell>
                      <Badge
                        variant={order.side === "buy" ? "default" : "secondary"}
                        className="text-xs"
                      >
                        {order.side.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="uppercase">{order.type}</TableCell>
                    <TableCell>
                      <Badge variant={getStatusColor(order.status)} className="text-xs">
                        {order.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPrice(order.price)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {order.quantity}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {order.meta_prob ? `${(order.meta_prob * 100).toFixed(0)}%` : "—"}
                    </TableCell>
                    <TableCell className="uppercase text-muted-foreground">
                      {order.strategy}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onViewDetails(order.id)}
                        className="h-7 w-7 p-0"
                      >
                        <Eye className="h-3 w-3" />
                      </Button>
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
