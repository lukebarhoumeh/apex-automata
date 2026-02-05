import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders },
  });
}

function getAdmin() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

type Body = {
  order: Record<string, unknown>;
  order_legs?: Record<string, unknown>[];
  fills?: Record<string, unknown>[];
  dedupe_key?: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const requestId = crypto.randomUUID();
  const started = Date.now();

  try {
    const body = (await req.json()) as Partial<Body>;
    if (!body.order || typeof body.order !== "object") return json({ error: "order is required" }, 400);

    const order = body.order as Record<string, unknown>;
    if (!order.id || typeof order.id !== "string") return json({ error: "order.id is required" }, 400);
    if (!order.user_id || typeof order.user_id !== "string") return json({ error: "order.user_id is required" }, 400);

    const admin = getAdmin();

    const { error: orderError } = await admin
      .from("orders")
      .upsert(order, { onConflict: "id" });
    if (orderError) return json({ error: orderError.message, requestId }, 500);

    let orderLegsCount = 0;
    if (Array.isArray(body.order_legs) && body.order_legs.length > 0) {
      const { error: legsError } = await admin
        .from("order_legs")
        .upsert(body.order_legs, { onConflict: "id" });
      if (legsError) return json({ error: legsError.message, requestId }, 500);
      orderLegsCount = body.order_legs.length;
    }

    let fillsCount = 0;
    if (Array.isArray(body.fills) && body.fills.length > 0) {
      const { error: fillsError } = await admin
        .from("fills")
        .upsert(body.fills, { onConflict: "id" });
      if (fillsError) return json({ error: fillsError.message, requestId }, 500);
      fillsCount = body.fills.length;
    }

    return json({
      ok: true,
      id: order.id,
      order_legs: orderLegsCount,
      fills: fillsCount,
      requestId,
      ms: Date.now() - started,
    }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unknown error", requestId }, 500);
  }
});
