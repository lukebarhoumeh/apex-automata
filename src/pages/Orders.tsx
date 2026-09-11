import { useState } from "react";
import { OrdersKpiStrip } from "@/components/apex/orders/OrdersKpiStrip";
import { ActivePositionsStrip } from "@/components/apex/orders/ActivePositionsStrip";
import { OrderBlotter } from "@/components/apex/orders/OrderBlotter";
import { OrderDetailPanel } from "@/components/apex/orders/OrderDetailPanel";
import { RecentFillsPanel } from "@/components/apex/orders/RecentFillsPanel";
import { useOrders, useFills, useOrderStats } from "@/hooks/apex/useOrdersData";
import { useOpenPositions } from "@/hooks/apex/useDashboardData";
import { useLiveMarks } from "@/hooks/apex/useLiveMarks";
import type { OrderRecord } from "@/types/orders";

export default function Orders() {
  const orders = useOrders();
  const fills = useFills();
  const positions = useOpenPositions();
  const marks = useLiveMarks();
  const stats = useOrderStats(orders.data);

  const [selected, setSelected] = useState<OrderRecord | null>(null);

  if (!orders.data || !fills.data || !positions.data) return null;

  return (
    <div className="flex flex-col gap-4 p-6">
      <OrdersKpiStrip stats={stats} />

      <ActivePositionsStrip positions={positions.data} marks={marks} />

      <div className="grid gap-4" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)" }}>
        <OrderBlotter
          orders={orders.data}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
        <div className="flex flex-col gap-4">
          <OrderDetailPanel order={selected} onClose={() => setSelected(null)} />
          <RecentFillsPanel fills={fills.data} />
        </div>
      </div>
    </div>
  );
}
