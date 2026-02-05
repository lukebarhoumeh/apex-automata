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

type Action = "create" | "update" | "delete";

type Body = {
  action: Action;
  id?: string;
  user_id: string;
  title?: string;
  note?: string | null;
  position_id?: string;
  order_id?: string;
  signal_id?: string;
  attachments?: string[];
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const requestId = crypto.randomUUID();
  const started = Date.now();

  try {
    const body = (await req.json()) as Partial<Body>;
    if (!body.action || (body.action !== "create" && body.action !== "update" && body.action !== "delete")) {
      return json({ error: "action must be create|update|delete" }, 400);
    }
    if (!body.user_id || typeof body.user_id !== "string") return json({ error: "user_id is required" }, 400);

    const admin = getAdmin();

    if (body.action === "create") {
      if (!body.title || typeof body.title !== "string") return json({ error: "title is required" }, 400);

      const payload = {
        user_id: body.user_id,
        title: body.title,
        note: body.note ?? null,
        position_id: body.position_id ?? null,
        order_id: body.order_id ?? null,
        signal_id: body.signal_id ?? null,
        attachments: body.attachments ?? null,
      };

      const { data, error } = await admin.from("journal_entries").insert(payload).select("id").single();
      if (error) return json({ error: error.message, requestId }, 500);

      console.log("[journal-entry]", { requestId, action: "create", id: data.id, ms: Date.now() - started });

      return json({ ok: true, id: data.id, requestId }, 200);
    }

    if (!body.id || typeof body.id !== "string") return json({ error: "id is required" }, 400);

    if (body.action === "delete") {
      const { error } = await admin.from("journal_entries").delete().eq("id", body.id);
      if (error) return json({ error: error.message, requestId }, 500);

      console.log("[journal-entry]", { requestId, action: "delete", id: body.id, ms: Date.now() - started });

      return json({ ok: true, id: body.id, requestId }, 200);
    }

    const updatePayload: Record<string, unknown> = {};
    if (body.title !== undefined) updatePayload.title = body.title;
    if (body.note !== undefined) updatePayload.note = body.note;
    if (body.position_id !== undefined) updatePayload.position_id = body.position_id;
    if (body.order_id !== undefined) updatePayload.order_id = body.order_id;
    if (body.signal_id !== undefined) updatePayload.signal_id = body.signal_id;
    if (body.attachments !== undefined) updatePayload.attachments = body.attachments;

    const { error } = await admin.from("journal_entries").update(updatePayload).eq("id", body.id);
    if (error) return json({ error: error.message, requestId }, 500);

    console.log("[journal-entry]", { requestId, action: "update", id: body.id, ms: Date.now() - started });

    return json({ ok: true, id: body.id, requestId }, 200);
  } catch (e) {
    console.error("[journal-entry]", { requestId, error: e instanceof Error ? e.message : e, ms: Date.now() - started });
    return json({ error: e instanceof Error ? e.message : "Unknown error", requestId }, 500);
  }
});
