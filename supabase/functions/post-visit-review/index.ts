// supabase/functions/post-visit-review/index.ts
// Cron-triggered every 30 min. Finds appointments that ended ~2 hours ago,
// marks status='completed' if still 'confirmed', and sends a WhatsApp
// star-rating prompt with three quick-reply buttons (5★ / 3★ / 1★).
// Patient taps → review row populated → owner-side notification.
//
// Schedule:  pg_cron job in enhancement_pack.sql
// Deploy:    supabase functions deploy post-visit-review --no-verify-jwt

import { serve }        from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WA_PHONE_ID     = Deno.env.get("WA_PHONE_ID") || "";
const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN") || "";

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function sendWhatsAppButtons(phone: string, body: string, buttons: {id: string; title: string}[]) {
  if (!WA_PHONE_ID || !WA_ACCESS_TOKEN || !phone) return false;
  const to = phone.replace(/^\+/, "");
  const res = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", recipient_type: "individual", to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body.slice(0, 1024) },
        action: { buttons: buttons.slice(0, 3).map(b => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
      },
    }),
  }).catch(() => null);
  return !!res?.ok;
}

function reviewBody(lang: string, businessName: string): string {
  if (lang === "fr") return `Merci d'avoir choisi ${businessName} ! Comment s'est passé votre rendez-vous ?`;
  if (lang === "ar") return `شكرا لاختيارك ${businessName}! كيف كان موعدك؟`;
  return `Thanks for choosing ${businessName}! How was your visit?`;
}

function btns(lang: string) {
  if (lang === "fr") return [{id:"rev:5", title:"Excellent"}, {id:"rev:3", title:"Correct"},  {id:"rev:1", title:"Pas top"}];
  if (lang === "ar") return [{id:"rev:5", title:"ممتاز"},     {id:"rev:3", title:"عادي"},     {id:"rev:1", title:"غير جيد"}];
  return                  [{id:"rev:5", title:"Excellent"}, {id:"rev:3", title:"OK"},        {id:"rev:1", title:"Bad"}];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const now = new Date();

    // Pull confirmed appointments whose date+time was 2-3h ago and we haven't asked yet.
    const cutoffHi = new Date(now.getTime() -  2 * 3600 * 1000);
    const cutoffLo = new Date(now.getTime() -  3 * 3600 * 1000);

    const { data: aps = [] } = await sb.from("appointments")
      .select(`
        id, business_id, client_id, doctor_id, date, time, status, review_prompt_sent_at,
        clients(name, phone, profile),
        businesses(name)
      `)
      .in("status", ["confirmed","completed"])
      .is("review_prompt_sent_at", null)
      .gte("date", cutoffLo.toISOString().slice(0,10))
      .lte("date", cutoffHi.toISOString().slice(0,10));

    let pinged = 0;
    for (const a of aps as any[]) {
      // Compose the appointment end timestamp (UTC date + time, 30-min default)
      const ts = new Date(`${a.date}T${(a.time as string).slice(0,5)}:00Z`);
      if (ts > cutoffHi || ts < cutoffLo) continue;

      const lang  = a.clients?.profile?.language || "en";
      const phone = a.clients?.phone;
      if (!phone) continue;

      const ok = await sendWhatsAppButtons(
        phone,
        reviewBody(lang, a.businesses?.name || "us"),
        btns(lang).map(b => ({ id: `${b.id}:${a.id}`, title: b.title })),
      );
      if (!ok) continue;

      await sb.from("appointment_reviews").insert({
        business_id:   a.business_id,
        appointment_id:a.id,
        client_id:     a.client_id,
        doctor_id:     a.doctor_id,
        prompted_at:   new Date().toISOString(),
      });
      await sb.from("appointments").update({
        review_prompt_sent_at: new Date().toISOString(),
        status: "completed",
      }).eq("id", a.id);
      // Bump client last_visit_at so future memory injection + reactivation works
      await sb.from("clients").update({
        last_visit_at: new Date().toISOString(),
      }).eq("id", a.client_id);
      pinged++;
    }

    return new Response(JSON.stringify({ ok: true, pinged }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
