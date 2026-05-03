// supabase/functions/send-reminders/index.ts
// Runs on a schedule (every 15 min via pg_cron). Finds appointments in the
// next 24h that haven't been reminded yet, and sends a WhatsApp reminder
// in the patient's preferred language.
//
// Deploy:   supabase functions deploy send-reminders --no-verify-jwt
// Schedule: see SQL migration at the bottom of the project's schema.sql

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function sendWhatsApp(phone: string, body: string, _business: any): Promise<boolean> {
  const phoneId = Deno.env.get("WA_PHONE_ID");
  const token   = Deno.env.get("WA_ACCESS_TOKEN");
  if (!phoneId || !token || !phone) return false;
  const to = phone.replace(/^\+/, "");
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", recipient_type: "individual", to,
        type: "text", text: { body },
      }),
    });
    return res.ok;
  } catch { return false; }
}

// One-tap interactive buttons for the 24h reminder. Patient hits CONFIRM or
// CANCEL right inside WhatsApp; the webhook routes the button_reply id back
// to update the appointment without a free-text round trip.
async function sendReminderButtons(phone: string, body: string, aptId: string, lang: string): Promise<boolean> {
  const phoneId = Deno.env.get("WA_PHONE_ID");
  const token   = Deno.env.get("WA_ACCESS_TOKEN");
  if (!phoneId || !token || !phone) return false;
  const to = phone.replace(/^\+/, "");
  const lbl = lang === "fr" ? { y:"Confirmer", n:"Annuler" }
            : lang === "ar" ? { y:"تأكيد",     n:"إلغاء"   }
            :                 { y:"Confirm",   n:"Cancel"  };
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", recipient_type: "individual", to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body.slice(0, 1024) },
          action: { buttons: [
            { type: "reply", reply: { id: `confirm:${aptId}`, title: lbl.y } },
            { type: "reply", reply: { id: `cancel:${aptId}`,  title: lbl.n } },
          ] },
        },
      }),
    });
    return res.ok;
  } catch { return false; }
}

function reminderText(lang: string, type: "24h"|"1h", a: any): string {
  const name = a.clients?.name || "";
  const svc  = a.services?.name || "";
  const when = `${a.date} ${a.time.slice(0,5)}`;
  const greeting = name ? (lang==="fr" ? `Bonjour ${name},` : lang==="ar" ? `مرحبا ${name}،` : `Hi ${name},`) : (lang==="fr" ? "Bonjour," : lang==="ar" ? "مرحبا،" : "Hi,");
  const businessName = a.businesses?.name || "";

  if (type === "24h") {
    if (lang === "fr") return `${greeting} petit rappel : votre rendez-vous${svc?` pour ${svc}`:''}${businessName?` chez ${businessName}`:''} est demain à ${a.time.slice(0,5)} (${a.date}). Répondez ANNULER si vous ne pouvez plus venir. À demain !`;
    if (lang === "ar") return `${greeting} تذكير: موعدك${svc?` لـ ${svc}`:''}${businessName?` في ${businessName}`:''} غدا على الساعة ${a.time.slice(0,5)} (${a.date}). أرسل إلغاء إذا لن تتمكن من الحضور. إلى الغد!`;
    return `${greeting} just a reminder — your appointment${svc?` for ${svc}`:''}${businessName?` at ${businessName}`:''} is tomorrow at ${a.time.slice(0,5)} (${a.date}). Reply CANCEL if you can't make it. See you then!`;
  } else { // 1h
    if (lang === "fr") return `${greeting} votre rendez-vous est dans 1 heure (${a.time.slice(0,5)})${svc?` — ${svc}`:''}. À tout de suite !`;
    if (lang === "ar") return `${greeting} موعدك بعد ساعة (${a.time.slice(0,5)})${svc?` — ${svc}`:''}. نراكم قريبا!`;
    return `${greeting} your appointment is in 1 hour (${a.time.slice(0,5)})${svc?` — ${svc}`:''}. See you soon!`;
  }
}

async function detectClientLanguage(sb: any, business_id: string, client_id: string): Promise<string> {
  // Pull the most recent message we have from this client; use its detected language.
  const { data } = await sb.from("messages")
    .select("detected_language")
    .eq("business_id", business_id).eq("client_id", client_id)
    .eq("direction","in")
    .not("detected_language","is",null)
    .order("created_at",{ascending:false})
    .limit(1)
    .maybeSingle();
  return data?.detected_language || "en";
}

serve(async (_req) => {
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const now = new Date();
  const in23h = new Date(now.getTime() + 23*3600*1000).toISOString();
  const in25h = new Date(now.getTime() + 25*3600*1000).toISOString();
  const in30m = new Date(now.getTime() + 30*60*1000).toISOString();
  const in90m = new Date(now.getTime() + 90*60*1000).toISOString();

  let sent24 = 0, sent1 = 0;

  // === 24h reminders ===
  // Approximate: look for confirmed appointments in the next ~25h that haven't had a 24h reminder.
  // We compare a synthesized date+time field against the window.
  const { data: cands24 } = await sb.from("appointments")
    .select("*, clients(id,name,phone), services(name), businesses(name)")
    .eq("status","confirmed")
    .is("reminder_24h_sent_at", null);

  for (const a of (cands24 as any[] || [])) {
    if (!a.clients?.phone) continue;
    const at = new Date(`${a.date}T${a.time}`);
    if (at.toISOString() < in23h || at.toISOString() > in25h) continue;
    const lang = await detectClientLanguage(sb, a.business_id, a.clients.id);
    const body = reminderText(lang, "24h", a);
    // Try interactive buttons first, fall back to plain text if WA rejects
    let ok = await sendReminderButtons(a.clients.phone, body, a.id, lang);
    if (!ok) ok = await sendWhatsApp(a.clients.phone, body, a);
    if (ok) {
      await sb.from("appointments").update({ reminder_24h_sent_at: new Date().toISOString() }).eq("id", a.id);
      await sb.from("messages").insert({
        business_id: a.business_id, client_id: a.clients.id,
        direction: "out", channel: "whatsapp", text: body, intent: "reminder_24h",
      });
      sent24++;
    }
  }

  // === 1h reminders ===
  const { data: cands1 } = await sb.from("appointments")
    .select("*, clients(id,name,phone), services(name), businesses(name)")
    .eq("status","confirmed")
    .is("reminder_1h_sent_at", null);

  for (const a of (cands1 as any[] || [])) {
    if (!a.clients?.phone) continue;
    const at = new Date(`${a.date}T${a.time}`);
    if (at.toISOString() < in30m || at.toISOString() > in90m) continue;
    const lang = await detectClientLanguage(sb, a.business_id, a.clients.id);
    const body = reminderText(lang, "1h", a);
    const ok = await sendWhatsApp(a.clients.phone, body, a);
    if (ok) {
      await sb.from("appointments").update({ reminder_1h_sent_at: new Date().toISOString() }).eq("id", a.id);
      await sb.from("messages").insert({
        business_id: a.business_id, client_id: a.clients.id,
        direction: "out", channel: "whatsapp", text: body, intent: "reminder_1h",
      });
      sent1++;
    }
  }

  return new Response(JSON.stringify({ ok: true, sent24, sent1 }), {
    headers: { "Content-Type": "application/json" },
  });
});
