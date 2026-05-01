// supabase/functions/classify-message/index.ts
// Receives a patient message (from web "Test", from n8n, or directly from
// the WhatsApp/Twilio webhooks). Classifies it with Claude in AR/FR/EN,
// updates the database, schedules the Google Calendar sync, and returns
// the structured payload to the caller.
//
// Deploy:   supabase functions deploy classify-message --no-verify-jwt
// Secrets:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You are an intent classifier for a multilingual virtual receptionist serving clinics, laboratoires, and other appointment-driven businesses.

Your ONLY job: read the patient's message and reply with valid JSON of EXACTLY this shape, no prose:

{
  "intent": "book" | "cancel" | "reschedule" | "faq",
  "language": "ar" | "fr" | "en",
  "service": string | null,                    // e.g. "Cardiology Checkup", "Blood test", "General Consultation"
  "date": string | null,                       // ISO YYYY-MM-DD; resolve "today", "tomorrow", "next Tuesday" etc.
  "time_preference": string | null,            // "morning" | "afternoon" | "evening" | "HH:MM"
  "urgent": boolean                            // true for emergencies, severe pain, asap, "urgence", "طارئ"
}

Detect language from the script and vocabulary:
- Arabic letters (أ-ي / ا-ي / ؀-ۿ) → "ar"
- French function words (bonjour, rendez-vous, annuler, reporter, je voudrais) → "fr"
- otherwise → "en"

Respond in the same language when generating any natural-language reply, but the JSON keys/values are always English-ASCII as above.`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { phone, text, business_id, channel = "whatsapp", detected_language } = await req.json();
    if (!text || !business_id) {
      return new Response(JSON.stringify({ error: "Missing text or business_id" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1. Upsert client
    let clientId: string | null = null;
    if (phone) {
      const { data: existing } = await sb.from("clients").select("id").eq("business_id", business_id).eq("phone", phone).maybeSingle();
      if (existing) clientId = existing.id;
      else {
        const { data: created } = await sb.from("clients").insert({ business_id, phone, name: phone }).select("id").single();
        clientId = created?.id ?? null;
      }
    }

    // 2. Call Claude
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: text }],
      }),
    });
    const aiJson = await aiRes.json();
    const rawText = aiJson?.content?.[0]?.text ?? "{}";

    let payload: Record<string, unknown>;
    try { payload = JSON.parse(rawText); }
    catch { payload = { intent: "faq", language: detected_language || "en", urgent: false }; }
    if (detected_language) payload.language = detected_language;

    // 3. Persist the message
    await sb.from("messages").insert({
      business_id, client_id: clientId, direction: "in",
      channel, text, intent: payload.intent as string,
      detected_language: payload.language as string,
      ai_payload: payload,
    });

    // 4. Take action based on intent
    let action: Record<string, unknown> = { kind: "none" };

    if (payload.urgent) {
      action = { kind: "escalate" };
      await sb.from("notifications").insert({
        business_id, type: "urgent", urgent: true,
        title: "URGENT message received",
        message: `${phone}: ${text}`,
      });
    } else if (payload.intent === "book") {
      // Find the right service / doctor
      const { data: services = [] } = await sb.from("services").select("*, users:doctor_id(*)").eq("business_id", business_id);
      const svc = (services as any[]).find(s => payload.service && s.name?.toLowerCase().includes(String(payload.service).split(" ")[0].toLowerCase())) || services[0];
      const doctor = svc?.users;
      const time = (typeof payload.time_preference === "string" && /^\d{2}:\d{2}$/.test(payload.time_preference)) ? payload.time_preference :
        payload.time_preference === "morning" ? "09:30" :
        payload.time_preference === "afternoon" ? "14:30" :
        payload.time_preference === "evening" ? "17:30" : "10:00";
      const date = (payload.date as string) || new Date(Date.now() + 86400000).toISOString().slice(0, 10);

      const { data: apt } = await sb.from("appointments").insert({
        business_id, client_id: clientId, doctor_id: doctor?.id ?? null, service_id: svc?.id ?? null,
        date, time, status: "confirmed",
        source: channel === "whatsapp_voice" ? "whatsapp_voice" : "whatsapp_ai",
      }).select().single();

      await sb.from("notifications").insert({
        business_id, doctor_id: doctor?.id ?? null, type: "booking",
        title: "New appointment booked",
        message: `${phone} booked ${svc?.name ?? "an appointment"} with ${doctor?.name ?? "a doctor"} on ${date} at ${time}`,
      });

      // Fire & forget Google Calendar sync via separate function
      fetch(`${SUPABASE_URL}/functions/v1/google-calendar-create`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ appointment_id: apt?.id }),
      }).catch(() => {});

      action = { kind: "booked", appointment_id: apt?.id, doctor_id: doctor?.id, date, time };
    } else if (payload.intent === "cancel" && clientId) {
      const { data: apt } = await sb.from("appointments").update({ status: "cancelled" })
        .eq("client_id", clientId).eq("status", "confirmed").select().maybeSingle();
      if (apt) {
        await sb.from("notifications").insert({
          business_id, type: "cancel", title: "Appointment cancelled",
          message: `${phone} cancelled their appointment on ${apt.date}`,
        });
        fetch(`${SUPABASE_URL}/functions/v1/google-calendar-delete`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ appointment_id: apt.id }),
        }).catch(() => {});
        action = { kind: "cancelled", appointment_id: apt.id };
      }
    } else if (payload.intent === "reschedule" && clientId) {
      const newDate = (payload.date as string) || new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const newTime = (typeof payload.time_preference === "string" && /^\d{2}:\d{2}$/.test(payload.time_preference)) ? payload.time_preference : "15:00";
      const { data: apt } = await sb.from("appointments").update({ date: newDate, time: newTime })
        .eq("client_id", clientId).neq("status", "cancelled").select().maybeSingle();
      if (apt) {
        await sb.from("notifications").insert({
          business_id, type: "reschedule", title: "Appointment rescheduled",
          message: `${phone} moved their appointment to ${newDate} ${newTime}`,
        });
        action = { kind: "rescheduled", appointment_id: apt.id, date: newDate, time: newTime };
      }
    }

    // 5. Build patient-facing reply (in their language)
    const reply = buildReply(payload, action);

    // 6. Persist outgoing message
    await sb.from("messages").insert({
      business_id, client_id: clientId, direction: "out",
      channel, text: reply, intent: payload.intent as string,
    });

    return new Response(JSON.stringify({ classification: payload, action, reply }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});

function buildReply(p: any, action: any): string {
  const lang = p.language || "en";
  const T: Record<string, Record<string, string>> = {
    booked_en: { default: `Your appointment is confirmed for ${action.date} at ${action.time}. See you then!` },
    booked_fr: { default: `Votre rendez-vous est confirmé pour le ${action.date} à ${action.time}. À bientôt !` },
    booked_ar: { default: `تم تأكيد موعدك بتاريخ ${action.date} على الساعة ${action.time}. نراكم قريبا.` },
    cancelled_en: { default: "Your appointment has been cancelled. Hope to see you another time." },
    cancelled_fr: { default: "Votre rendez-vous a été annulé. À bientôt." },
    cancelled_ar: { default: "تم إلغاء موعدك. نتمنى لقاءكم في وقت آخر." },
    rescheduled_en: { default: `Done — your appointment is moved to ${action.date} at ${action.time}.` },
    rescheduled_fr: { default: `C'est fait — votre rendez-vous est reporté au ${action.date} à ${action.time}.` },
    rescheduled_ar: { default: `تم — تم تحويل موعدك إلى ${action.date} على الساعة ${action.time}.` },
    escalate_en: { default: "I've flagged your message as urgent. A staff member will call you back very soon." },
    escalate_fr: { default: "J'ai signalé votre message comme urgent. Un membre de l'équipe vous rappellera très vite." },
    escalate_ar: { default: "تم تصنيف رسالتك كعاجلة. سيتواصل معكم أحد أفراد الفريق قريبا." },
    faq_en: { default: "Hi! I'm Nova. I can help you book, cancel or reschedule an appointment. What would you like to do?" },
    faq_fr: { default: "Bonjour ! Je suis Nova. Je peux vous aider à prendre, annuler ou reporter un rendez-vous. Que souhaitez-vous ?" },
    faq_ar: { default: "مرحبا! أنا نوفا. يمكنني مساعدتك في حجز موعد أو إلغائه أو تغييره. كيف يمكنني مساعدتك؟" },
  };
  const k = action.kind === "none" ? "faq" : action.kind;
  return T[`${k}_${lang}`]?.default ?? T[`${k}_en`]?.default ?? "Thanks, we got your message.";
}
