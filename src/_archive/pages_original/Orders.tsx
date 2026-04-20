import { OrdersBlotter } from "@/components/dashboard/OrdersBlotter";
import { PositionsPanelConnected } from "@/components/dashboard/PositionsPanelConnected";
import { FillsTable } from "@/components/dashboard/FillsTable";
import { EquityCurveChart } from "@/components/dashboard/EquityCurveChart";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
          Live blotter with order flow, fills, and equity performance
        </p>
      </div>

      <Tabs defaultValue="blotter" className="space-y-4">
        <TabsList className="font-mono">
          <TabsTrigger value="blotter">Orders & Positions</TabsTrigger>
          <TabsTrigger value="fills">Fills</TabsTrigger>
          <TabsTrigger value="equity">Equity Curve</TabsTrigger>
        </TabsList>

        <TabsContent value="blotter" className="space-y-4">
          <OrdersBlotter onViewDetails={handleViewDetails} />
          <PositionsPanelConnected />
        </TabsContent>

        <TabsContent value="fills">
          <FillsTable />
        </TabsContent>

        <TabsContent value="equity">
          <EquityCurveChart />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default Orders;
