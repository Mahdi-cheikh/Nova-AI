// supabase/functions/whatsapp-webhook/index.ts
// Public endpoint that Meta WhatsApp posts incoming messages to.
// Routes them to classify-message for the right business (looked up
// by the destination phone number).
//
// Deploy:   supabase functions deploy whatsapp-webhook --no-verify-jwt
// Secrets:  supabase secrets set WA_VERIFY_TOKEN=your-shared-secret

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY_TOKEN    = Deno.env.get("WA_VERIFY_TOKEN")!;

serve(async (req) => {
  const url = new URL(req.url);

  // Meta verification handshake (GET)
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === VERIFY_TOKEN) return new Response(challenge ?? "", { status: 200 });
    return new Response("forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("method", { status: 405 });

  try {
    const body = await req.json();
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // Walk Meta's payload shape
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        const recipientPhone = value?.metadata?.display_phone_number;
        if (!recipientPhone) continue;

        // Find the business that owns this phone number
        const { data: biz } = await sb.from("businesses").select("id").eq("phone", "+" + recipientPhone).maybeSingle();
        if (!biz) continue;

        for (const msg of value.messages ?? []) {
          const text = msg.text?.body ?? "";
          const from = "+" + msg.from;
          if (!text) continue;

          // Hand off to classify-message
          await fetch(`${SUPABASE_URL}/functions/v1/classify-message`, {
            method: "POST",
            headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ phone: from, text, business_id: biz.id, channel: "whatsapp" }),
          });
        }
      }
    }
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response("ok", { status: 200 }); // always 200 to Meta to avoid retries
  }
});
