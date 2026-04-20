export type OrderSide = "BUY" | "SELL";
export type OrderType = "MKT" | "LMT" | "STOP";
export type OrderStatus = "FILLED" | "PENDING" | "WORKING" | "PARTIAL" | "CANCELLED" | "REJECTED";

export interface OrderRecord {
  id: string;
  ts: string;
  sym: string;
  side: OrderSide;
  type: OrderType;
  qty: number;
  px: number | null;
  fillAvg: number | null;
  status: OrderStatus;
  strat: string;
  venue: string;
  reason?: string;
}

export interface FillRecord {
  id: string;
  ts: string;
  sym: string;
  side: OrderSide;
  qty: number;
  px: number;
  fee: number;
  slip: number;
}

export interface OrderStats {
  total: number;
  filled: number;
  pending: number;
  cancelled: number;
  rejected: number;
  fillRate: number;
}
