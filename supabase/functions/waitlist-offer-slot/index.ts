// waitlist-offer-slot/index.ts
// Triggered when an appointment slot opens (cancellation / no-show / manual).
// Calls waitlist_match_for_slot to find the top-N best candidates, sends each
// of them a parallel WhatsApp interactive button offer ("Oui / Non"), and
// records pending offer rows. The first one to tap "Oui" wins the race —
// the webhook handler resolves the contention atomically.
//
// Body:
//   {
//     business_id: uuid (required),
//     slot_date:   "YYYY-MM-DD" (required),
//     slot_time:   "HH:MM" or "HH:MM:SS" (required),
//     doctor_id?:  uuid,
//     service_id?: uuid,
//     top_n?:      int (default 3, max 5)
//   }
//
// Response:
//   { ok: true, offers_sent: <int>, candidates: [{name, phone, score}, ...] }
//
// Auth: requires the caller to use either the service-role key (server side
// from dashboard) or the anon key with a valid user JWT — verify_jwt=true.
//
// Deploy: supabase functions deploy waitlist-offer-slot

import { serve }        from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WA_PHONE_ID     = Deno.env.get("WA_PHONE_ID")     || "";
const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN") || "";

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// ---------- Localized message bodies ----------
function offerBody(lang: string, bizName: string, slotDate: string, slotTime: string, doctorName: string | null) {
  const date = formatDate(slotDate, lang);
  const time = slotTime.slice(0, 5);
  if (lang === "fr") {
    return doctorName
      ? `Bonne nouvelle ! Un créneau s'est libéré chez ${bizName} avec ${doctorName} le ${date} à ${time}. Voulez-vous le prendre ?`
      : `Bonne nouvelle ! Un créneau s'est libéré chez ${bizName} le ${date} à ${time}. Voulez-vous le prendre ?`;
  }
  if (lang === "ar") {
    return doctorName
      ? `بشرى سارة! تم تحرير موعد لدى ${bizName} مع ${doctorName} يوم ${date} الساعة ${time}. هل تريد حجزه؟`
      : `بشرى سارة! تم تحرير موعد لدى ${bizName} يوم ${date} الساعة ${time}. هل تريد حجزه؟`;
  }
  return doctorName
    ? `Good news! A slot opened up at ${bizName} with ${doctorName} on ${date} at ${time}. Want to claim it?`
    : `Good news! A slot opened up at ${bizName} on ${date} at ${time}. Want to claim it?`;
}

function offerButtons(lang: string, offerId: string) {
  const labels =
    lang === "ar" ? ["نعم، احجزه", "لا، شكرا"] :
    lang === "en" ? ["Yes, claim it", "No, thanks"] :
                    ["Oui, je le prends", "Non, merci"];
  return [
    { type: "reply", reply: { id: `wait:Y:${offerId}`, title: labels[0].slice(0, 20) } },
    { type: "reply", reply: { id: `wait:N:${offerId}`, title: labels[1].slice(0, 20) } },
  ];
}

function formatDate(iso: string, lang: string) {
  // iso = "YYYY-MM-DD" — show as "lundi 19 mai" / "Mon May 19" / "الإثنين 19 ماي"
  const d = new Date(iso + "T12:00:00Z");
  const locale = lang === "ar" ? "ar-TN" : lang === "en" ? "en-GB" : "fr-FR";
  try { return new Intl.DateTimeFormat(locale, { weekday: "long", day: "2-digit", month: "long" }).format(d); }
  catch { return iso; }
}

// ---------- WhatsApp send helper ----------
async function sendInteractive(phone: string, body: string, buttons: any[]) {
  if (!WA_PHONE_ID || !WA_ACCESS_TOKEN || !phone) {
    return { ok: false, reason: "missing-secret-or-phone" as const };
  }
  const to = phone.replace(/^\+/, "").replace(/[\s\-().]/g, "");
  const r = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", recipient_type: "individual", to,
      type: "interactive",
      interactive: {
        type: "button",
        body:   { text: body.slice(0, 1024) },
        action: { buttons: buttons.slice(0, 3) },
      },
    }),
  });
  const j: any = await r.json().catch(() => ({ http: r.status }));
  if (!r.ok || j.error) {
    console.error("[WAITLIST-OFFER] WA send FAILED status=", r.status, "body=", JSON.stringify(j));
    return { ok: false, status: r.status, body: j };
  }
  return { ok: true, msg_id: j.messages?.[0]?.id as string | undefined };
}

// ---------- Main ----------
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return json(405, { ok: false, error: "POST only" });

  try {
    const body = await req.json().catch(() => ({}));
    const business_id = String(body.business_id || "").trim();
    const slot_date   = String(body.slot_date   || "").trim();
    const slot_time_in = String(body.slot_time  || "").trim();
    const doctor_id   = body.doctor_id  ? String(body.doctor_id)  : null;
    const service_id  = body.service_id ? String(body.service_id) : null;
    const top_n       = Math.max(1, Math.min(5, Number(body.top_n) || 3));

    if (!business_id || !/^\d{4}-\d{2}-\d{2}$/.test(slot_date) || !/^\d{2}:\d{2}/.test(slot_time_in)) {
      return json(400, { ok: false, error: "business_id, slot_date (YYYY-MM-DD), slot_time (HH:MM) required" });
    }
    const slot_time = slot_time_in.length === 5 ? slot_time_in + ":00" : slot_time_in.slice(0, 8);

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // Defensive: confirm the slot is actually free (no live appointment).
    const { data: clash } = await sb
      .from("appointments")
      .select("id, status")
      .eq("business_id", business_id)
      .eq("date", slot_date)
      .eq("time", slot_time.slice(0, 5))
      .not("status", "in", "(\"cancelled\",\"no_show\")")
      .limit(1);
    if (clash && clash.length) {
      return json(409, { ok: false, error: "slot_not_free", appointment_id: clash[0].id });
    }

    // Pull business name (and doctor name if specified) for the WA copy
    const { data: biz } = await sb.from("businesses")
      .select("name").eq("id", business_id).maybeSingle();
    let doctorName: string | null = null;
    if (doctor_id) {
      // doctors live in user_roles or a doctors view in this project — try a few
      const { data: doc } = await sb.from("user_roles")
        .select("display_name").eq("user_id", doctor_id).maybeSingle();
      doctorName = doc?.display_name || null;
    }

    // Match
    const { data: matches, error: matchErr } = await sb.rpc("waitlist_match_for_slot", {
      p_business_id: business_id,
      p_slot_date:   slot_date,
      p_slot_time:   slot_time,
      p_doctor_id:   doctor_id,
      p_service_id:  service_id,
      p_top_n:       top_n,
    });
    if (matchErr) throw matchErr;

    const candidates = (matches || []) as Array<{
      waitlist_id: string; client_name: string; client_phone: string;
      language: string; score: number;
    }>;

    if (!candidates.length) {
      return json(200, { ok: true, offers_sent: 0, candidates: [], reason: "no_match" });
    }

    // For each candidate: insert pending offer row, then send WhatsApp.
    // We insert FIRST so the offerId can be embedded in the button payload.
    const sent: Array<{ name: string; phone: string; score: number; offer_id: string; wa_ok: boolean }> = [];
    for (const c of candidates) {
      const { data: offer, error: offErr } = await sb
        .from("waitlist_offers")
        .insert({
          waitlist_id: c.waitlist_id,
          business_id, slot_date, slot_time,
          doctor_id, service_id,
        })
        .select("id")
        .single();
      if (offErr || !offer) {
        console.error("[WAITLIST-OFFER] insert failed for", c.waitlist_id, offErr);
        continue;
      }
      const lang = c.language || "fr";
      const text = offerBody(lang, biz?.name || "Nova", slot_date, slot_time, doctorName);
      const wa = await sendInteractive(c.client_phone, text, offerButtons(lang, offer.id));
      if (wa.ok) {
        await sb.from("waitlist_offers")
          .update({ wa_message_id: wa.msg_id || null })
          .eq("id", offer.id);
        await sb.from("waitlist")
          .update({ status: "offered", last_offered_at: new Date().toISOString() })
          .eq("id", c.waitlist_id);
      } else {
        // WA failed — mark this offer as expired immediately so retries can happen
        await sb.from("waitlist_offers")
          .update({ status: "expired" })
          .eq("id", offer.id);
      }
      sent.push({
        name: c.client_name, phone: c.client_phone, score: Number(c.score),
        offer_id: offer.id, wa_ok: wa.ok,
      });
    }

    return json(200, {
      ok: true,
      offers_sent: sent.filter(s => s.wa_ok).length,
      candidates: sent,
    });
  } catch (err) {
    const e = err as Error;
    console.error("[WAITLIST-OFFER FATAL]", e.message, "\n", e.stack);
    return json(500, { ok: false, error: e.message });
  }
});
