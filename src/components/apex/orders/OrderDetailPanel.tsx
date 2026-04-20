import { ExternalLink, ListOrdered, TriangleAlert } from "lucide-react";
import { Panel } from "@/components/apex/Panel";
import { Pill } from "@/components/apex/Pill";
import { fmt } from "@/components/apex/format";
import type { OrderRecord } from "@/types/orders";

interface OrderDetailPanelProps {
  order: OrderRecord | null;
  onClose?: () => void;
}

export function OrderDetailPanel({ order, onClose }: OrderDetailPanelProps) {
  return (
    <Panel
      header
      pad={0}
      title="Order detail"
      right={order && <span className="mono text-[11px] text-fg-2">{order.id}</span>}
    >
      {!order ? (
        <EmptyState />
      ) : (
        <DetailBody order={order} onClose={onClose} />
      )}
    </Panel>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10">
      <ListOrdered size={28} strokeWidth={1.3} className="text-fg-3" />
      <div className="text-[12px] text-fg-2">Select an order to inspect</div>
    </div>
  );
}

function DetailBody({ order, onClose }: { order: OrderRecord; onClose?: () => void }) {
  const notional = order.qty * (order.fillAvg ?? order.px ?? 0);

  const statusTone =
    order.status === "FILLED"    ? "up" :
    order.status === "PENDING" || order.status === "WORKING" ? "accent" :
    order.status === "REJECTED"  ? "down" :
    order.status === "PARTIAL"   ? "warn" : "default";

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[18px] font-semibold text-fg-0">{order.sym}</span>
            <Pill tone={order.side === "BUY" ? "up" : "down"}>{order.side}</Pill>
            <Pill tone={statusTone}>{order.status}</Pill>
          </div>
          <span className="mono text-[11px] text-fg-2">
            {order.ts} · {order.id} · {order.venue}
          </span>
        </div>
      </div>

      <div className="mt-3 rounded-md border border-obsidian-line bg-obsidian-2 p-3">
        <div className="grid grid-cols-4 gap-3">
          <MiniField label="Type" value={order.type} />
          <MiniField label="Qty" value={fmt(order.qty, 3)} />
          <MiniField label="Limit px" value={order.px != null ? fmt(order.px, 2) : "—"} />
          <MiniField label="Fill avg" value={order.fillAvg != null ? fmt(order.fillAvg, 2) : "—"} />
        </div>
        <div className="my-2 h-px bg-obsidian-line" />
        <div className="grid grid-cols-3 gap-3">
          <MiniField label="Notional" value={`$${fmt(notional, 2)}`} large />
          <MiniField label="Strategy" value={order.strat} />
          <MiniField label="Venue" value={order.venue} />
        </div>
      </div>

      {order.reason && (
        <div
          className="mt-3 rounded-md border p-3"
          style={{
            borderColor: "rgba(255,90,106,0.3)",
            background: "rgba(255,90,106,0.05)",
          }}
        >
          <div className="flex items-center gap-2">
            <TriangleAlert size={12} strokeWidth={1.8} className="text-down" />
            <span className="mono text-[10px] font-medium uppercase tracking-[0.12em] text-down">
              Reject reason
            </span>
          </div>
          <div className="mt-1 text-[12px] text-fg-1">{order.reason}</div>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-1 text-[11px] text-fg-1 hover:bg-obsidian-3 hover:text-fg-0"
          >
            Close
          </button>
        )}
        <button
          type="button"
          className="ml-auto flex items-center gap-1.5 rounded-md border border-obsidian-line bg-obsidian-2 px-2.5 py-1 text-[11px] text-fg-1 hover:bg-obsidian-3 hover:text-fg-0"
        >
          <ExternalLink size={11} strokeWidth={1.6} />
          View trace
        </button>
      </div>
    </div>
  );
}

function MiniField({ label, value, large }: { label: string; value: string; large?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="mono text-[9px] font-medium uppercase tracking-[0.12em] text-fg-2">{label}</span>
      <span className={`mono font-medium text-fg-0 ${large ? "text-[14px]" : "text-[12.5px]"}`}>{value}</span>
    </div>
  );
}
