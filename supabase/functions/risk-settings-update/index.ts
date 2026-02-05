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
  user_id: string;
  per_trade_risk?: number;
  max_heat?: number;
  daily_stop_r?: number;
  kill_switch_enabled?: boolean;
  spread_threshold?: number;
  atr_burst_multiplier?: number;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const requestId = crypto.randomUUID();
  const started = Date.now();

  try {
    const body = (await req.json()) as Partial<Body>;
    if (!body.user_id || typeof body.user_id !== "string") return json({ error: "user_id is required" }, 400);

    const settings: Record<string, unknown> = { user_id: body.user_id };
    if (body.per_trade_risk !== undefined) settings.per_trade_risk = body.per_trade_risk;
    if (body.max_heat !== undefined) settings.max_heat = body.max_heat;
    if (body.daily_stop_r !== undefined) settings.daily_stop_r = body.daily_stop_r;
    if (body.kill_switch_enabled !== undefined) settings.kill_switch_enabled = body.kill_switch_enabled;
    if (body.spread_threshold !== undefined) settings.spread_threshold = body.spread_threshold;
    if (body.atr_burst_multiplier !== undefined) settings.atr_burst_multiplier = body.atr_burst_multiplier;

    if (Object.keys(settings).length <= 1) return json({ error: "No settings provided" }, 400);

    const admin = getAdmin();
    const { data, error } = await admin
      .from("risk_settings")
      .upsert(settings, { onConflict: "user_id" })
      .select("id")
      .single();

    if (error) return json({ error: error.message, requestId }, 500);

    return json({ ok: true, id: data.id, requestId, ms: Date.now() - started }, 200);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unknown error", requestId }, 500);
  }
});
