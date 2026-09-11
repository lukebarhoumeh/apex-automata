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
import { supabase } from "@/integrations/supabase/client";

// ============================================================
// Orders — Supabase public.orders table
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

/** ISO lower bound for session-scoped reads; null when no session is active. */
function sinceIso(sessionStartedAt: number | null | undefined): string | null {
  if (!sessionStartedAt || !Number.isFinite(sessionStartedAt)) return null;
  const d = new Date(sessionStartedAt);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Orders written by the paper session. Scoped to `created_at >= sessionStartedAt`
 * while a session is active so the blotter and KPI strip describe THIS run;
 * with no session they show the most recent rows, labelled as such by the page.
 */
export function useOrders(sessionStartedAt: number | null = null) {
  const since = sinceIso(sessionStartedAt);
  return useQuery<readonly OrderRecord[]>({
    queryKey: ["apex", "orders", since],
    queryFn: async () => {
      let query = supabase
        .from("orders")
        .select("id,external_order_id,symbol,side,type,status,price,quantity,strategy,created_at,updated_at")
        .order("created_at", { ascending: false })
        .limit(100);
      if (since) query = query.gte("created_at", since);
      const { data, error } = await query;
      if (error) throw new Error(`orders fetch: ${error.message}`);
      return (data as OrderRow[] | null)?.map(mapOrder) ?? [];
    },
    staleTime: 2_000,
    refetchInterval: 15_000,
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

export function useFills(sessionStartedAt: number | null = null) {
  const since = sinceIso(sessionStartedAt);
  return useQuery<readonly FillRecord[]>({
    queryKey: ["apex", "fills", since],
    queryFn: async () => {
      let query = supabase
        .from("fills")
        .select("id,order_id,price,quantity,fee_amount,slippage_bps,filled_at,orders!inner(symbol,side)")
        .order("filled_at", { ascending: false })
        .limit(50);
      if (since) query = query.gte("filled_at", since);
      const { data, error } = await query;
      if (error) throw new Error(`fills fetch: ${error.message}`);
      // Supabase joins return the embedded table as an object (for !inner with
      // a single FK) or an array; normalize to object form for mapFill.
      const rows = (data as unknown as (Omit<FillRow, "orders"> & { orders: FillRow["orders"] | FillRow["orders"][] })[] | null) ?? [];
      return rows.map((r) =>
        mapFill({
          ...r,
          orders: Array.isArray(r.orders) ? r.orders[0] ?? null : r.orders,
        }),
      );
    },
    staleTime: 2_000,
    refetchInterval: 15_000,
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
