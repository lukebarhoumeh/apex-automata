import { OrdersBlotter } from "@/components/dashboard/OrdersBlotter";
import { PositionsPanelConnected } from "@/components/dashboard/PositionsPanelConnected";
import { useState } from "react";

const Orders = () => {
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

  const handleViewDetails = (orderId: string) => {
    setSelectedOrderId(orderId);
    console.log("View order details:", orderId);
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight font-mono">Orders & Positions</h1>
        <p className="text-muted-foreground mt-1">
          Live blotter with order flow and open positions
        </p>
      </div>

      <OrdersBlotter onViewDetails={handleViewDetails} />
      <PositionsPanelConnected />
    </div>
  );
};

export default Orders;
