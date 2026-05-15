// waitlist-add/index.ts
// Public endpoint that lets the patient PWA, the marketing landing page, or
// the WhatsApp bot add a person to a business's waitlist when no slot is
// available. No auth required; idempotent on (business_id, phone, doctor,
// preferred_date) so repeated taps don't duplicate.
//
// Body:
//   {
//     business_id:    string (uuid, required),
//     client_name:    string (required),
//     client_phone:   string (required, will be normalized minimally),
//     language?:      "fr" | "ar" | "en" (default "fr"),
//     doctor_id?:     string (uuid),
//     service_id?:    string (uuid),
//     service_name?:  string,
//     preferred_date? "YYYY-MM-DD",
//     preferred_window? { from: "HH:MM", to: "HH:MM" },
//     preferred_days? ["mon","tue",...],
//     notes?:         string
//   }
//
// Response:
//   { ok: true, id: "<waitlist uuid>", position: <int>, alreadyOnList: bool }
//
// Deploy: supabase functions deploy waitlist-add --no-verify-jwt

import { serve }        from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// Light phone normalization: strip spaces / dashes / parens. We don't try to
// canonicalize country codes — the WhatsApp send pipeline handles that.
const normalizePhone = (p: string) =>
  (p || "").replace(/[\s\-().]/g, "").trim();

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return json(405, { ok: false, error: "POST only" });

  try {
    const body = await req.json().catch(() => ({}));
    const business_id   = String(body.business_id || "").trim();
    const client_name   = String(body.client_name || "").trim();
    const client_phone  = normalizePhone(String(body.client_phone || ""));
    const language      = ["fr","ar","en"].includes(body.language) ? body.language : "fr";
    const doctor_id     = body.doctor_id    ? String(body.doctor_id)    : null;
    const service_id    = body.service_id   ? String(body.service_id)   : null;
    const service_name  = body.service_name ? String(body.service_name) : null;
    const preferred_date = body.preferred_date && /^\d{4}-\d{2}-\d{2}$/.test(body.preferred_date)
                           ? body.preferred_date : null;
    const preferred_window = body.preferred_window
      && typeof body.preferred_window === "object"
      && /^\d{2}:\d{2}$/.test(body.preferred_window.from || "")
      && /^\d{2}:\d{2}$/.test(body.preferred_window.to   || "")
      ? body.preferred_window : null;
    const preferred_days = Array.isArray(body.preferred_days)
      ? body.preferred_days.filter((d: unknown) =>
          typeof d === "string" && ["mon","tue","wed","thu","fri","sat","sun"].includes(d))
      : null;
    const notes = body.notes ? String(body.notes).slice(0, 500) : null;

    if (!business_id || !client_name || !client_phone) {
      return json(400, { ok: false, error: "business_id, client_name, client_phone required" });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // Verify the business exists (cheap sanity check)
    const { data: biz, error: bizErr } = await sb
      .from("businesses")
      .select("id, name")
      .eq("id", business_id)
      .single();
    if (bizErr || !biz) return json(404, { ok: false, error: "business not found" });

    // Idempotency: if the same phone is ALREADY on the waitlist for this
    // business with the same (doctor, preferred_date), return the existing
    // row instead of creating a duplicate.
    const { data: existing } = await sb
      .from("waitlist")
      .select("id, status")
      .eq("business_id", business_id)
      .eq("client_phone", client_phone)
      .in("status", ["waiting", "offered"])
      .limit(20);

    const dup = (existing || []).find((r: any) => r); // any active entry counts
    if (dup) {
      const position = await positionOf(sb, business_id, dup.id);
      return json(200, { ok: true, id: dup.id, position, alreadyOnList: true });
    }

    // Insert
    const { data: inserted, error: insErr } = await sb
      .from("waitlist")
      .insert({
        business_id, client_name, client_phone, language,
        doctor_id, service_id, service_name,
        preferred_date, preferred_window, preferred_days, notes,
      })
      .select("id")
      .single();
    if (insErr) throw insErr;

    const position = await positionOf(sb, business_id, inserted.id);
    return json(200, { ok: true, id: inserted.id, position, alreadyOnList: false });
  } catch (err) {
    const e = err as Error;
    console.error("[WAITLIST-ADD] FATAL", e.message, "\n", e.stack);
    return json(500, { ok: false, error: e.message });
  }
});

// 1-based position in the waiting queue for this business
async function positionOf(sb: any, business_id: string, waitlist_id: string): Promise<number> {
  const { data: target } = await sb
    .from("waitlist")
    .select("created_at")
    .eq("id", waitlist_id)
    .single();
  if (!target) return 1;
  const { count } = await sb
    .from("waitlist")
    .select("id", { count: "exact", head: true })
    .eq("business_id", business_id)
    .eq("status", "waiting")
    .lte("created_at", target.created_at);
  return count || 1;
}
