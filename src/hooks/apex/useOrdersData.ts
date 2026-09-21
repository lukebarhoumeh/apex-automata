import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type {
  OrderRecord,
  OrderSide,
  OrderType,
  OrderStatus,
  FillRecord,
  OrderStats,
} from "@/types/orders";
import { fetchSessionBlotterRows } from "@/lib/session-blotter-fetch";
import { hasActiveSession, sessionKey, type SessionScope } from "@/lib/session-scope";
import { useActiveSession } from "@/runtime/session";

// ============================================================
// Orders — active session via GET /api/orders (session_id SoT), Supabase fallback
// ============================================================

interface OrderRow {
  id: string;
  external_order_id: string | null;
  symbol: string;
  side: string;
  type: string | null;
  status: string | null;
  price: number | string | null;
  quantity: number | string | null;
  strategy: string | null;
  created_at: string | null;
  updated_at: string | null;
}

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function numOrNull(v: unknown): number | null {
  const n = num(v);
  return n === 0 && (v === null || v === undefined || v === "") ? null : n;
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(11, 19);
}

const ORDER_STATUS_MAP: Record<string, OrderStatus> = {
  filled: "FILLED",
  FILLED: "FILLED",
  pending: "PENDING",
  PENDING: "PENDING",
  working: "WORKING",
  WORKING: "WORKING",
  open: "WORKING",
  OPEN: "WORKING",
  partial: "PARTIAL",
  PARTIAL: "PARTIAL",
  partially_filled: "PARTIAL",
  cancelled: "CANCELLED",
  CANCELLED: "CANCELLED",
  canceled: "CANCELLED",
  CANCELED: "CANCELLED",
  rejected: "REJECTED",
  REJECTED: "REJECTED",
};

function mapOrderStatus(raw: string | null | undefined): OrderStatus {
  if (!raw) return "PENDING";
  return ORDER_STATUS_MAP[raw] ?? "PENDING";
}

function mapOrderType(raw: string | null | undefined): OrderType {
  const v = (raw ?? "").toUpperCase();
  if (v === "MARKET" || v === "MKT") return "MKT";
  if (v === "LIMIT" || v === "LMT") return "LMT";
  if (v === "STOP" || v === "STOP_LIMIT") return "STOP";
  return "LMT";
}

function mapOrderSide(raw: string | null | undefined): OrderSide {
  return (raw ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY";
}

function mapOrder(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    ts: formatTime(row.created_at),
    sym: row.symbol,
    side: mapOrderSide(row.side),
    type: mapOrderType(row.type),
    qty: num(row.quantity),
    px: numOrNull(row.price),
    fillAvg: null, // filled at is tracked on fills; derivation in useOrderStats if needed
    status: mapOrderStatus(row.status),
    strat: row.strategy ?? "—",
    venue: "Coinbase",
  };
}

/** Orders for the active session (`session_id` match or legacy window); `[]` with no session. */
export async function fetchSessionOrders(
  scope: SessionScope & { mode?: "paper" | "live" | null },
  limit = 100,
): Promise<OrderRecord[]> {
  const rows = await fetchSessionBlotterRows("orders", scope, limit, {
    select: "id,external_order_id,symbol,side,type,status,price,quantity,strategy,created_at,updated_at",
    orderColumn: "created_at",
  });
  return (rows as OrderRow[]).map(mapOrder);
}

export function useOrders() {
  const scope = useActiveSession();
  return useQuery<readonly OrderRecord[]>({
    queryKey: ["apex", "orders", sessionKey(scope)],
    queryFn: () => fetchSessionOrders(scope),
    staleTime: 2_000,
    refetchInterval: hasActiveSession(scope) ? 15_000 : false,
    placeholderData: keepPreviousData,
  });
}

// ============================================================
// Fills — Supabase public.fills (joined to orders for symbol)
// ============================================================

interface FillRow {
  id: string;
  order_id: string;
  price: number | string | null;
  quantity: number | string | null;
  fee_amount: number | string | null;
  slippage_bps: number | string | null;
  filled_at: string | null;
  orders: { symbol: string; side: string } | null;
}

function mapFill(row: FillRow): FillRecord {
  return {
    id: row.id,
    ts: formatTime(row.filled_at),
    sym: row.orders?.symbol ?? "—",
    side: mapOrderSide(row.orders?.side),
    qty: num(row.quantity),
    px: num(row.price),
    fee: num(row.fee_amount),
    slip: num(row.slippage_bps),
  };
}

/** Fills for the active session; `[]` with no session. */
export async function fetchSessionFills(
  scope: SessionScope & { mode?: "paper" | "live" | null },
  limit = 50,
): Promise<FillRecord[]> {
  const rows = await fetchSessionBlotterRows("fills", scope, limit, {
    select: "id,order_id,price,quantity,fee_amount,slippage_bps,filled_at,orders!inner(symbol,side)",
    orderColumn: "filled_at",
  });
  return (rows as (Omit<FillRow, "orders"> & { orders: FillRow["orders"] | FillRow["orders"][] })[]).map((r) =>
    mapFill({
      ...r,
      orders: Array.isArray(r.orders) ? r.orders[0] ?? null : r.orders,
    }),
  );
}

export function useFills() {
  const scope = useActiveSession();
  return useQuery<readonly FillRecord[]>({
    queryKey: ["apex", "fills", sessionKey(scope)],
    queryFn: () => fetchSessionFills(scope),
    staleTime: 2_000,
    refetchInterval: hasActiveSession(scope) ? 15_000 : false,
    placeholderData: keepPreviousData,
  });
}

// ============================================================
// Order stats — derived
// ============================================================

export function useOrderStats(orders: readonly OrderRecord[] | undefined): OrderStats {
  return useMemo(() => {
    const total = orders?.length ?? 0;
    const filled = orders?.filter((o) => o.status === "FILLED").length ?? 0;
    const pending =
      orders?.filter((o) => o.status === "PENDING" || o.status === "WORKING" || o.status === "PARTIAL").length ?? 0;
    const cancelled = orders?.filter((o) => o.status === "CANCELLED").length ?? 0;
    const rejected = orders?.filter((o) => o.status === "REJECTED").length ?? 0;
    return {
      total,
      filled,
      pending,
      cancelled,
      rejected,
      fillRate: total > 0 ? filled / total : 0,
    };
  }, [orders]);
}
