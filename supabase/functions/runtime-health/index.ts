import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";

type HealthResponse = {
  ok: boolean;
  ts: string;
  dbOk: boolean;
  projectRef?: string;
  error?: string;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function getSupabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

Deno.serve(async (_req: Request) => {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  const ts = new Date().toISOString();

  try {
    const admin = getSupabaseAdmin();
    const { error } = await admin.from("account_metrics").select("id").limit(1);

    const body: HealthResponse = {
      ok: true,
      ts,
      dbOk: !error,
      projectRef: Deno.env.get("SUPABASE_PROJECT_ID") ?? undefined,
      error: error?.message,
    };

    console.log("[runtime-health]", {
      requestId,
      dbOk: body.dbOk,
      ms: Date.now() - started,
    });

    return json(body, body.dbOk ? 200 : 503);
  } catch (e) {
    console.error("[runtime-health]", {
      requestId,
      error: e instanceof Error ? e.message : "Unknown error",
      ms: Date.now() - started,
    });

    return json(
      {
        ok: false,
        ts,
        dbOk: false,
        error: e instanceof Error ? e.message : "Unknown error",
      } satisfies HealthResponse,
      500,
    );
  }
});
