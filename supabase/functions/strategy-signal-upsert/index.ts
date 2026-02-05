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
  name: string;
  enabled?: boolean;
  params?: Record<string, unknown>;
  win_rate?: number | null;
  avg_r?: number | null;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const requestId = crypto.randomUUID();
  const started = Date.now();

  try {
    const body = (await req.json()) as Partial<Body>;
    if (!body.user_id || typeof body.user_id !== "string") return json({ error: "user_id is required" }, 400);
    if (!body.name || typeof body.name !== "string") return json({ error: "name is required" }, 400);

    const admin = getAdmin();

    const { data: existing, error: selectError } = await admin
      .from("strategy_signals")
      .select("id, params")
      .eq("user_id", body.user_id)
      .eq("name", body.name)
      .maybeSingle();

    if (selectError) return json({ error: selectError.message, requestId }, 500);

    const mergedParams = {
      ...(existing?.params as Record<string, unknown> | null | undefined),
      ...(body.params ?? {}),
    };

    if (existing) {
      const updatePayload: Record<string, unknown> = {
        params: mergedParams,
      };
      if (body.enabled !== undefined) updatePayload.enabled = body.enabled;
      if (body.win_rate !== undefined) updatePayload.win_rate = body.win_rate;
      if (body.avg_r !== undefined) updatePayload.avg_r = body.avg_r;

      const { error } = await admin.from("strategy_signals").update(updatePayload).eq("id", existing.id);

      if (error) return json({ error: error.message, requestId }, 500);

      console.log("[strategy-signal-upsert]", { requestId, id: existing.id, ms: Date.now() - started });

      return json({ ok: true, id: existing.id, requestId }, 200);
    }

    const insertPayload: Record<string, unknown> = {
      user_id: body.user_id,
      name: body.name,
      params: mergedParams,
      enabled: body.enabled ?? true,
      win_rate: body.win_rate ?? null,
      avg_r: body.avg_r ?? null,
    };

    const { data, error } = await admin.from("strategy_signals").insert(insertPayload).select("id").single();

    if (error) return json({ error: error.message, requestId }, 500);

    console.log("[strategy-signal-upsert]", { requestId, id: data.id, ms: Date.now() - started });

    return json({ ok: true, id: data.id, requestId }, 200);
  } catch (e) {
    console.error("[strategy-signal-upsert]", { requestId, error: e instanceof Error ? e.message : e, ms: Date.now() - started });
    return json({ error: e instanceof Error ? e.message : "Unknown error", requestId }, 500);
  }
});
