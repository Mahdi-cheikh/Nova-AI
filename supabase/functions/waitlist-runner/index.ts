// supabase/functions/waitlist-runner/index.ts
// Runs whenever a confirmed appointment is cancelled. Looks for active
// waitlist entries that match the freed slot (date / doctor) and pings
// the patient on WhatsApp with a one-tap "claim it" prompt.
//
// Invoke with: { business_id, date, doctor_id, time, service_id }
//
// Deploy:   supabase functions deploy waitlist-runner --no-verify-jwt

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
  if (!WA_PHONE_ID || !WA_ACCESS_TOKEN || !phone) return;
  const to = phone.replace(/^\+/, "");
  await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", recipient_type: "individual", to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body.slice(0, 1024) },
        action: {
          buttons: buttons.slice(0, 3).map(b => ({
            type: "reply",
            reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) },
          })),
        },
      },
    }),
  }).catch(() => {});
}

function bodyForLang(lang: string, date: string, time: string, doctor?: string): string {
  if (lang === "fr") return `Bonne nouvelle ! Un créneau s'est libéré le ${date} à ${time}${doctor ? ` avec ${doctor}` : ""}. Voulez-vous le réserver ?`;
  if (lang === "ar") return `خبر جيد! تم تحرير موعد يوم ${date} على الساعة ${time}${doctor ? ` مع ${doctor}` : ""}. هل تريد حجزه؟`;
  return `Good news — a slot opened on ${date} at ${time}${doctor ? ` with ${doctor}` : ""}. Want to grab it?`;
}

function btnLabels(lang: string): {yes: string; no: string} {
  if (lang === "fr") return { yes: "Oui, réserver", no: "Non, passer" };
  if (lang === "ar") return { yes: "نعم، احجز",   no: "لا، تخطي"  };
  return                     { yes: "Yes, book it", no: "Skip"      };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { business_id, date, doctor_id, time, service_id } = await req.json();
    if (!business_id || !date) {
      return new Response(JSON.stringify({ error: "business_id and date required" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // Find the freshest matching active waitlist entry. Match priority:
    //   1. exact doctor + same date
    //   2. exact doctor + any date in next 7 days
    //   3. any doctor + same date
    let q = sb.from("waitlist")
      .select("*, clients(name, phone, profile)")
      .eq("business_id", business_id)
      .eq("status", "active");

    let { data: candidates = [] } = await q;
    candidates = (candidates as any[]).filter((w: any) => {
      const dateOk = !w.preferred_date || w.preferred_date === date;
      const docOk  = !w.doctor_id      || w.doctor_id     === doctor_id;
      return dateOk && docOk;
    }).sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    if (!candidates.length) {
      return new Response(JSON.stringify({ ok: true, matched: 0 }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    const winner = candidates[0];
    const lang   = winner.language || winner.clients?.profile?.language || "en";
    const phone  = winner.clients?.phone;

    let doctorName = "";
    if (doctor_id) {
      const { data: doc } = await sb.from("users").select("name").eq("id", doctor_id).maybeSingle();
      doctorName = doc?.name || "";
    }

    const body = bodyForLang(lang, date, time || "", doctorName);
    const lbl  = btnLabels(lang);

    await sendWhatsAppButtons(phone, body, [
      { id: `wl_yes:${winner.id}:${date}:${time || ""}:${doctor_id || ""}:${service_id || ""}`, title: lbl.yes },
      { id: `wl_no:${winner.id}`,                                                                title: lbl.no  },
    ]);

    await sb.from("waitlist").update({
      status: "notified",
      notified_at: new Date().toISOString(),
    }).eq("id", winner.id);

    await sb.from("notifications").insert({
      business_id,
      type: "info",
      title: "Waitlist patient pinged",
      message: `${winner.clients?.name || phone} was offered the freed ${date} ${time || ""} slot.`,
    });

    return new Response(JSON.stringify({ ok: true, matched: 1, waitlist_id: winner.id }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
