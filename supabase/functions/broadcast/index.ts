// supabase/functions/broadcast/index.ts
// BROADCAST — owner sends one WhatsApp message to every client of their business.
// ============================================================================
// Body:
//   { business_id, message }                              -> dry-run, returns recipient count
//   { business_id, message, confirm: true }               -> actually send
//
// The owner is identified via the JWT Supabase passes through (verify_jwt = true).
// RLS doesn't matter here because we use the service role; we re-check ownership
// manually by joining auth.users -> users.auth_uid -> businesses.owner_user_id.
//
// Returns:
//   { recipient_count: number, sent?: number, failed?: number }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WA_PHONE_ID  = Deno.env.get("WA_PHONE_ID") || "";
const WA_TOKEN     = Deno.env.get("WA_ACCESS_TOKEN") || "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

async function sendOne(phone: string, body: string): Promise<boolean> {
  if (!WA_PHONE_ID || !WA_TOKEN) {
    // Demo / dev mode — pretend success so the UI flow can be exercised without WhatsApp creds.
    console.log("[broadcast:demo] would send to", phone, "->", body.slice(0, 60));
    return true;
  }
  const to = phone.replace(/^\+/, "");
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: body.slice(0, 4096) },
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const businessId = String(body.business_id || "");
  const message = String(body.message || "").trim();
  const confirm = !!body.confirm;
  if (!businessId) return json({ error: "business_id required" }, 400);
  if (!message) return json({ error: "message required" }, 400);
  if (message.length > 4000) return json({ error: "Message too long (max 4000 chars)" }, 400);

  // Verify caller owns this business (via JWT).
  const authHeader = req.headers.get("authorization") || "";
  const sbUser = createClient(SUPABASE_URL, SERVICE_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: uErr } = await sbUser.auth.getUser();
  if (uErr || !user) return json({ error: "Not signed in" }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: biz, error: bErr } = await sb
    .from("businesses")
    .select("id, name, owner_user_id, phone")
    .eq("id", businessId)
    .single();
  if (bErr || !biz) return json({ error: "Business not found" }, 404);
  if (biz.owner_user_id !== user.id) return json({ error: "You don't own this business" }, 403);

  // Gather unique client phones for this business.
  const { data: clients, error: cErr } = await sb
    .from("clients")
    .select("id, name, phone")
    .eq("business_id", businessId)
    .not("phone", "is", null);
  if (cErr) return json({ error: cErr.message }, 500);

  // Dedupe by phone
  const seen = new Set<string>();
  const recipients = (clients || []).filter(c => {
    if (!c.phone || seen.has(c.phone)) return false;
    seen.add(c.phone);
    return true;
  });

  if (!confirm) {
    return json({ recipient_count: recipients.length });
  }

  // Send. Personalise with {name} if the template uses it.
  let sent = 0, failed = 0;
  const errors: string[] = [];
  for (const c of recipients) {
    const personalised = message.replaceAll("{name}", c.name || "");
    const ok = await sendOne(c.phone, personalised);
    if (ok) sent++; else { failed++; if (errors.length < 5) errors.push(c.phone); }
    // Log to messages table for the dashboard activity feed.
    try {
      await sb.from("messages").insert({
        business_id: businessId,
        client_id: c.id,
        direction: "out",
        channel: "whatsapp",
        body: personalised,
        status: ok ? "sent" : "failed",
      });
    } catch { /* non-fatal */ }
    // Tiny stagger to avoid hammering the WA Graph API
    await new Promise(r => setTimeout(r, 60));
  }

  return json({ recipient_count: recipients.length, sent, failed, errors });
});
