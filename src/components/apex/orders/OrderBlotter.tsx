import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Check,
  CircleX,
  Download,
  TriangleAlert,
  Activity,
  type LucideIcon,
} from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { Segmented } from "@/components/apex/Segmented";
import { fmt } from "@/components/apex/format";
import { cn } from "@/lib/utils";
import type { OrderRecord, OrderStatus, OrderSide } from "@/types/orders";

interface OrderBlotterProps {
  orders: readonly OrderRecord[];
  selectedId?: string | null;
  onSelect: (order: OrderRecord) => void;
}

type SideFilter = "ALL" | "BUY" | "SELL";
type StatusFilter = "ALL" | OrderStatus;

const SIDE_OPTIONS: ReadonlyArray<{ value: SideFilter; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "BUY", label: "Buy" },
  { value: "SELL", label: "Sell" },
];

const STATUS_META: Record<
  OrderStatus,
  { tone: "up" | "accent" | "down" | "default" | "warn"; icon: LucideIcon }
> = {
  FILLED:    { tone: "up",      icon: Check },
  PENDING:   { tone: "accent",  icon: Activity },
  WORKING:   { tone: "accent",  icon: Activity },
  PARTIAL:   { tone: "warn",    icon: Activity },
  CANCELLED: { tone: "default", icon: CircleX },
  REJECTED:  { tone: "down",    icon: TriangleAlert },
};

export function OrderBlotter({ orders, selectedId, onSelect }: OrderBlotterProps) {
  const [sideFilter, setSideFilter] = useState<SideFilter>("ALL");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [symbolFilter, setSymbolFilter] = useState<string>("ALL");

  const symbols = useMemo(() => Array.from(new Set(orders.map((o) => o.sym))).sort(), [orders]);

  const filtered = useMemo(
    () =>
      orders.filter(
        (o) =>
          (sideFilter === "ALL" || o.side === sideFilter) &&
          (statusFilter === "ALL" || o.status === statusFilter) &&
          (symbolFilter === "ALL" || o.sym === symbolFilter),
      ),
    [orders, sideFilter, statusFilter, symbolFilter],
  );

  return (
    <Panel header={false} pad={0}>
      <div className="flex items-center justify-between gap-3 border-b border-obsidian-line px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="label">Order blotter</span>
          <div className="flex items-center gap-1.5">
            <span className="dot-live" />
            <span className="mono text-[10.5px] uppercase tracking-[0.12em] text-fg-2">streaming</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Segmented
            size="sm"
            options={SIDE_OPTIONS}
            value={sideFilter}
            onChange={(v) => setSideFilter(v as SideFilter)}
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="mono h-7 rounded-md border border-obsidian-line bg-obsidian-2 px-2 text-[11px] uppercase tracking-wider text-fg-1 hover:border-obsidian-line-2"
          >
            <option value="ALL">All status</option>
            <option value="FILLED">Filled</option>
            <option value="PENDING">Pending</option>
            <option value="CANCELLED">Cancelled</option>
            <option value="REJECTED">Rejected</option>
          </select>
          <select
            value={symbolFilter}
            onChange={(e) => setSymbolFilter(e.target.value)}
            className="mono h-7 rounded-md border border-obsidian-line bg-obsidian-2 px-2 text-[11px] uppercase tracking-wider text-fg-1 hover:border-obsidian-line-2"
          >
            <option value="ALL">All symbols</option>
            {symbols.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-obsidian-2 hover:text-fg-1"
            aria-label="Export CSV"
          >
            <Download size={13} strokeWidth={1.6} />
          </button>
        </div>
      </div>

      <div className="max-h-[500px] overflow-y-auto">
        <table className="w-full text-left">
          <thead className="sticky top-0 bg-obsidian-1">
            <tr className="border-b border-obsidian-line">
              <Th>Time</Th>
              <Th>ID</Th>
              <Th>Symbol</Th>
              <Th>Side</Th>
              <Th>Type</Th>
              <Th align="right">Qty</Th>
              <Th align="right">Price</Th>
              <Th align="right">Fill avg</Th>
              <Th>Status</Th>
              <Th>Strategy</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={11} className="py-10 text-center text-[12px] text-fg-2">
                  No orders match the current filters.
                </td>
              </tr>
            ) : (
              filtered.map((o) => (
                <OrderRow
                  key={o.id}
                  order={o}
                  selected={o.id === selectedId}
                  onSelect={onSelect}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function Th({ children, align = "left" }: { children?: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={cn(
        "mono px-3 py-2.5 text-[10px] font-medium uppercase tracking-[0.09em] text-fg-2",
        align === "right" && "text-right",
      )}
    >
      {children}
    </th>
  );
}

function OrderRow({
  order,
  selected,
  onSelect,
}: {
  order: OrderRecord;
  selected: boolean;
  onSelect: (o: OrderRecord) => void;
}) {
  const status = STATUS_META[order.status];
  const StatusIcon = status.icon;
  const sideLabel = order.side as OrderSide;

  return (
    <tr
      onClick={() => onSelect(order)}
      className={cn(
        "h-9 cursor-pointer border-b border-obsidian-line transition-colors hover:bg-obsidian-2",
        selected && "bg-obsidian-2",
      )}
    >
      <td className="mono px-3 text-[11px] text-fg-2">{order.ts}</td>
      <td className="mono px-3 text-[11px] text-fg-2">{order.id}</td>
      <td className="px-3 text-[12.5px] font-medium text-fg-0">{order.sym}</td>
      <td className="px-3">
        <Pill tone={sideLabel === "BUY" ? "up" : "down"}>
          {sideLabel === "BUY" ? (
            <ArrowUp size={8} strokeWidth={2.5} />
          ) : (
            <ArrowDown size={8} strokeWidth={2.5} />
          )}
          {sideLabel}
        </Pill>
      </td>
      <td className="mono px-3 text-[11px] text-fg-1">{order.type}</td>
      <td className="mono px-3 text-right text-[12.5px] text-fg-0">{fmt(order.qty, 3)}</td>
      <td className="mono px-3 text-right text-[12.5px] text-fg-1">{order.px != null ? fmt(order.px, 2) : "—"}</td>
      <td className="mono px-3 text-right text-[12.5px] text-fg-0">
        {order.fillAvg != null ? fmt(order.fillAvg, 2) : "—"}
      </td>
      <td className="px-3">
        <Pill tone={status.tone}>
          <StatusIcon size={9} strokeWidth={2.2} />
          {order.status}
        </Pill>
      </td>
      <td className="mono px-3 text-[11px] text-fg-1">{order.strat}</td>
      <td className="px-3 text-right">
        <ChevronRight size={12} strokeWidth={1.6} className="text-fg-3" />
      </td>
    </tr>
  );
}
