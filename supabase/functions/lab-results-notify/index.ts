// supabase/functions/lab-results-notify/index.ts
// Run on demand or via pg_cron (every 5 min). Finds lab_orders that are
// status='ready' but where the appointment hasn't had results_sent_at set,
// generates a signed URL to the result PDF in Supabase Storage, and sends
// the patient a WhatsApp with the result summary + download link.
//
// Deploy: supabase functions deploy lab-results-notify --no-verify-jwt

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

async function sendWhatsAppDocument(phone: string, body: string, pdfUrl: string, filename: string) {
  if (!WA_PHONE_ID || !WA_ACCESS_TOKEN || !phone) return false;
  const to = phone.replace(/^\+/, "");
  // Send the message body and the document as a follow-up — WhatsApp's `document`
  // type lets us deliver the PDF directly inside the chat.
  const r1 = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", recipient_type: "individual", to,
      type: "text", text: { body, preview_url: true },
    }),
  }).catch(() => null);
  const r2 = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", recipient_type: "individual", to,
      type: "document",
      document: { link: pdfUrl, filename },
    }),
  }).catch(() => null);
  return !!(r1?.ok && r2?.ok);
}

function compose(lang: string, name: string, businessName: string, tests: string[], critical: boolean): string {
  const list = tests.map(t => `• ${t}`).join("\n");
  if (lang === "fr") return `Bonjour ${name}, vos résultats chez ${businessName} sont prêts :\n${list}${critical ? "\n\n⚠ Certaines valeurs sont en dehors des plages de référence — contactez votre médecin." : ""}\n\nLe document est ci-dessous.`;
  if (lang === "ar") return `مرحبا ${name}، نتائج تحاليلك من ${businessName} جاهزة:\n${list}${critical ? "\n\n⚠ بعض القيم خارج المعدلات الطبيعية — يرجى التواصل مع الطبيب." : ""}\n\nالمستند مرفق.`;
  return `Hi ${name}, your results from ${businessName} are ready:\n${list}${critical ? "\n\n⚠ Some values are outside the normal range — please contact your doctor." : ""}\n\nThe document is attached below.`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    let scopedAptId: string | null = null;
    try {
      if (req.method === "POST") {
        const body = await req.json().catch(()=>null);
        if (body?.appointment_id) scopedAptId = body.appointment_id;
      }
    } catch (_e) { /* no body */ }

    // Group ready-but-unsent results by appointment so we send one message per visit.
    let q = sb.from("lab_orders")
      .select(`
        id, business_id, appointment_id, status, ready_at,
        lab_tests(name),
        lab_results(numeric_value, text_value, unit, is_critical, pdf_path),
        appointments(client_id, results_sent_at, clients(name, phone, profile), businesses(name))
      `)
      .eq("status", "ready");
    if (scopedAptId) q = q.eq("appointment_id", scopedAptId);
    const { data: orders = [] } = await q;

    // Two buckets: ones with actual results uploaded (send PDF/values), and ones
    // marked ready but no content yet (send a generic "tests are ready, come pick
    // them up" message). Both count as a successful notification.
    const byApt: Record<string, any[]> = {};
    const byAptNoContent: Record<string, any[]> = {};
    for (const o of (orders as any[])) {
      if (o.appointments?.results_sent_at) continue;
      const hasContent = (o.lab_results || []).some((r: any) =>
        r.pdf_path || r.numeric_value !== null || (r.text_value && r.text_value.length > 0)
      );
      const k = o.appointment_id;
      if (hasContent) (byApt[k] = byApt[k] || []).push(o);
      else            (byAptNoContent[k] = byAptNoContent[k] || []).push(o);
    }

    let sent = 0;
    for (const aptId of Object.keys(byApt)) {
      const group = byApt[aptId];
      const first = group[0];
      const phone = first.appointments?.clients?.phone;
      const cName = (first.appointments?.clients?.name || "").split(" ")[0] || "there";
      const bName = first.appointments?.businesses?.name || "the lab";
      const lang  = first.appointments?.clients?.profile?.language || "en";
      const tests = group.map((g: any) => g.lab_tests?.name).filter(Boolean);
      const critical = group.some((g: any) => (g.lab_results || []).some((r: any) => r.is_critical));
      const pdfPath  = group.map((g: any) => (g.lab_results || []).find((r: any) => r.pdf_path)?.pdf_path).find(Boolean);

      let pdfUrl = "";
      if (pdfPath) {
        const { data: signed } = await sb.storage.from("lab-results").createSignedUrl(pdfPath, 60 * 60 * 24 * 7);
        pdfUrl = signed?.signedUrl || "";
      }

      const body = compose(lang, cName, bName, tests, critical);

      let ok = false;
      if (pdfUrl) ok = await sendWhatsAppDocument(phone, body, pdfUrl, `results_${aptId.slice(0,8)}.pdf`);
      else {
        // Fall back to plain text if no PDF was uploaded yet
        ok = !!(await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: phone.replace(/^\+/, ""), type: "text", text: { body } }),
        }).catch(() => null))?.ok;
      }

      if (ok) {
        await sb.from("appointments").update({
          results_sent_at: new Date().toISOString(),
          results_ready_at: first.ready_at || new Date().toISOString(),
          status: "completed",
        }).eq("id", aptId);
        await sb.from("lab_orders").update({ status: "delivered", delivered_at: new Date().toISOString() })
          .in("id", group.map((g: any) => g.id));
        await sb.from("notifications").insert({
          business_id: first.business_id, type: "info",
          title: "Lab results sent",
          message: `Sent ${tests.length} result(s) to ${cName} (${phone}).`,
          urgent: critical,
        });
        sent++;
      }
    }

    // Second pass: appointments marked ready but no result content yet — send a
    // simple "your tests are ready, come pick them up" message in patient's language.
    for (const aptId of Object.keys(byAptNoContent)) {
      const group = byAptNoContent[aptId];
      const first = group[0];
      const phone = first.appointments?.clients?.phone;
      const cName = (first.appointments?.clients?.name || "").split(" ")[0] || "there";
      const bName = first.appointments?.businesses?.name || "the lab";
      const lang  = first.appointments?.clients?.profile?.language || "en";
      const tests = group.map((g: any) => g.lab_tests?.name).filter(Boolean);
      const list  = tests.map((t: string) => `• ${t}`).join("\n");
      const body  = lang === "fr"
        ? `Bonjour ${cName}, vos analyses chez ${bName} sont prêtes :\n${list}\n\nVous pouvez passer récupérer le rapport.`
        : lang === "ar"
        ? `مرحبا ${cName}، تحاليلك من ${bName} جاهزة:\n${list}\n\nيمكنك المرور لاستلام التقرير.`
        : `Hi ${cName}, your tests at ${bName} are ready:\n${list}\n\nYou can come pick up the report.`;
      const ok = !!(await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: phone.replace(/^\+/, ""), type: "text", text: { body } }),
      }).catch(() => null))?.ok;
      if (ok) {
        await sb.from("appointments").update({
          results_sent_at: new Date().toISOString(),
          results_ready_at: first.ready_at || new Date().toISOString(),
        }).eq("id", aptId);
        await sb.from("notifications").insert({
          business_id: first.business_id, type: "info",
          title: "Patient pinged — pickup notice",
          message: `${cName} (${phone}) was told ${tests.length} test(s) are ready (no PDF uploaded).`,
        });
        sent++;
      }
    }

    return new Response(JSON.stringify({ ok: true, sent }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
