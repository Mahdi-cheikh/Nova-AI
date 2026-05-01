// supabase/functions/send-whatsapp-otp/index.ts
// Sends a 6-digit OTP via WhatsApp Cloud API for phone-number verification
// during onboarding. Code stored hashed in DB with 10-min expiry.
//
// Deploy:   supabase functions deploy send-whatsapp-otp
// Secrets:  supabase secrets set WA_PHONE_ID=... WA_ACCESS_TOKEN=...

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WA_PHONE_ID     = Deno.env.get("WA_PHONE_ID")!;
const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { phone, business_id } = await req.json();
    if (!phone || !business_id) return jsonErr("Missing phone or business_id", 400);

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // Hash and store
    const codeHash = await sha256(code);
    await sb.from("whatsapp_otps").upsert({
      business_id, phone, code_hash: codeHash,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    // Send via WhatsApp Cloud API
    const wa = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone.replace(/^\+/, ""),
        type: "text",
        text: { body: `Your Nova AI verification code is: ${code}\n\nExpires in 10 minutes.` },
      }),
    });
    if (!wa.ok) {
      const detail = await wa.text();
      return jsonErr("WhatsApp API rejected: " + detail, 502);
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return jsonErr((err as Error).message, 500);
  }
});

function jsonErr(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
