// supabase/functions/reactivation-campaign/index.ts
// Cron-triggered weekly. Finds clients whose last_visit_at is > 6 months ago,
// have NO upcoming appointment, and weren't pinged in the last 30 days.
// Sends each one a personalised WhatsApp re-engagement message in their
// language, with a quick-book button that opens a fresh booking flow.
//
// Schedule: pg_cron job in enhancement_pack.sql (Mondays 09:00)
// Deploy: supabase functions deploy reactivation-campaign --no-verify-jwt

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WA_PHONE_ID = Deno.env.get("WA_PHONE_ID") || "";
const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN") || "";

const cors = {
 "Access-Control-Allow-Origin": "*",
 "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
 "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function sendWhatsAppButton(phone: string, body: string, buttonId: string, buttonTitle: string) {
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
 action: { buttons: [{ type: "reply", reply: { id: buttonId, title: buttonTitle.slice(0, 20) } }] },
 },
 }),
 }).catch(() => null);
 return !!res?.ok;
}

function compose(lang: string, name: string, businessName: string, monthsSince: number) {
 if (lang === "fr") return `Bonjour ${name} ! Cela fait ${monthsSince} mois depuis votre dernière visite chez ${businessName}. C'est peut-être le bon moment pour reprendre rendez-vous ?`;
 if (lang === "ar") return `مرحبا ${name}! مرت ${monthsSince} أشهر منذ آخر زيارة لك إلى ${businessName}. ربما حان الوقت لحجز موعد جديد؟`;
 return `Hi ${name} — it's been ${monthsSince} months since your last visit to ${businessName}. Maybe time to book again?`;
}

function btnLabel(lang: string) {
 if (lang === "fr") return "Réserver";
 if (lang === "ar") return "احجز الآن";
 return "Book now";
}

serve(async (req) => {
 if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
 try {
 const sb = createClient(SUPABASE_URL, SERVICE_KEY);
 const sixMonthsAgo = new Date(Date.now() - 180 * 86400 * 1000).toISOString();
 const thirtyAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
 const today = new Date().toISOString().slice(0, 10);

 // Pull candidates. We do server-side filtering for "no upcoming appointment"
 // because Postgres can't easily express "anti-join" through PostgREST.
 const { data: clients = [] } = await sb.from("clients")
 .select("id, name, phone, profile, business_id, last_visit_at, last_reactivation_at, businesses(name)")
 .lt("last_visit_at", sixMonthsAgo)
 .or(`last_reactivation_at.is.null,last_reactivation_at.lt.${thirtyAgo}`);

 let sent = 0;
 for (const c of (clients as any[])) {
 // Skip if patient has any upcoming appointment
 const { count } = await sb.from("appointments")
 .select("*", { count: "exact", head: true })
 .eq("client_id", c.id)
 .gte("date", today)
 .neq("status", "cancelled");
 if ((count || 0) > 0) continue;

 const lang = c.profile?.language || "en";
 const name = (c.name || "").split(" ")[0] || (lang === "fr" ? "Bonjour" : lang === "ar" ? "مرحبا" : "there");
 const biz = c.businesses?.name || "us";
 const months = Math.max(6, Math.floor((Date.now() - new Date(c.last_visit_at).getTime()) / (30 * 86400 * 1000)));

 const ok = await sendWhatsAppButton(
 c.phone,
 compose(lang, name, biz, months),
 `reactivate:${c.id}`,
 btnLabel(lang),
 );
 if (!ok) continue;

 await sb.from("clients")
 .update({ last_reactivation_at: new Date().toISOString() })
 .eq("id", c.id);
 sent++;
 }

 return new Response(JSON.stringify({ ok: true, sent }), { headers: { ...cors, "Content-Type": "application/json" } });
 } catch (err) {
 return new Response(JSON.stringify({ error: (err as Error).message }), {
 status: 500, headers: { ...cors, "Content-Type": "application/json" },
 });
 }
});
