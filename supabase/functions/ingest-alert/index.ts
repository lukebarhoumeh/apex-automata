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

type IngestAlertBody = {
  user_id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message?: string | null;
  data?: unknown;
  created_at?: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const requestId = crypto.randomUUID();
  const started = Date.now();

  try {
    const body = (await req.json()) as Partial<IngestAlertBody>;

    if (!body.user_id || typeof body.user_id !== "string") return json({ error: "user_id is required" }, 400);
    if (!body.title || typeof body.title !== "string") return json({ error: "title is required" }, 400);
    if (!body.severity || (body.severity !== "info" && body.severity !== "warning" && body.severity !== "critical")) {
      return json({ error: "severity must be info|warning|critical" }, 400);
    }

    const admin = getAdmin();

    const insertPayload = {
      user_id: body.user_id,
      severity: body.severity,
      title: body.title,
      message: body.message ?? null,
      data: body.data ?? null,
      created_at: body.created_at ?? undefined,
    };

    const { data, error } = await admin.from("alerts").insert(insertPayload).select("id").single();
    if (error) {
      console.error("[ingest-alert]", { requestId, error: error.message });
      return json({ error: error.message, requestId }, 500);
    }

    return json({ ok: true, id: data.id, requestId, ms: Date.now() - started }, 200);
  } catch (e) {
    console.error("[ingest-alert]", { requestId, error: e instanceof Error ? e.message : e });
    return json({ error: e instanceof Error ? e.message : "Unknown error", requestId }, 500);
  }
});
