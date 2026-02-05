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

type Body = { fill: Record<string, unknown>; dedupe_key?: string };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const requestId = crypto.randomUUID();
  const started = Date.now();

  try {
    const body = (await req.json()) as Partial<Body>;
    if (!body.fill || typeof body.fill !== "object") return json({ error: "fill is required" }, 400);

    const fill = body.fill as Record<string, unknown>;
    if (!fill.id || typeof fill.id !== "string") return json({ error: "fill.id is required" }, 400);
    if (!fill.user_id || typeof fill.user_id !== "string") return json({ error: "fill.user_id is required" }, 400);

    const admin = getAdmin();
    const { error } = await admin.from("fills").upsert(fill, { onConflict: "id" });
    if (error) return json({ error: error.message, requestId }, 500);

    console.log("[ingest-fill]", { requestId, id: fill.id, dedupe_key: body.dedupe_key, ms: Date.now() - started });

    return json({ ok: true, id: fill.id, requestId }, 200);
  } catch (e) {
    console.error("[ingest-fill]", { requestId, error: e instanceof Error ? e.message : e, ms: Date.now() - started });
    return json({ error: e instanceof Error ? e.message : "Unknown error", requestId }, 500);
  }
});
