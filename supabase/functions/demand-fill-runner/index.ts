// supabase/functions/demand-fill-runner/index.ts
// DEMAND-FILL AUTO-PINGING — turns dead time into revenue.
//
// Three modes:
//   1) { mode: 'scan_all' }                    — cron-driven: scan every business
//   2) { mode: 'scan', business_id }           — owner-triggered scan for one business
//   3) { mode: 'send', campaign_id, target_ids? } — owner approved a campaign
//
// Returns:
//   - scan: { opportunities: [{date, doctor, slot_times, candidate_count, candidates[]}] }
//     Inserts a demand_fill_campaign row + queued targets per opportunity.
//   - send: { sent: N, errors: M }
//
// Deploy: supabase functions deploy demand-fill-runner --no-verify-jwt

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

// ============================================================================
// WhatsApp interactive button sender (max 3 buttons; we use 2: Yes / Skip)
// ============================================================================
async function sendOfferButtons(phone: string, body: string, campaignId: string, lang: string) {
  if (!WA_PHONE_ID || !WA_TOKEN || !phone) return false;
  const to = phone.replace(/^\+/, "");
  const labels = lang === "fr"
    ? { y: "Oui, intéressé", n: "Non, merci" }
    : lang === "ar"
    ? { y: "نعم", n: "لا، شكرا" }
    : { y: "Yes, book me", n: "Skip" };
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: body.slice(0, 1024) },
          action: {
            buttons: [
              { type: "reply", reply: { id: `df_yes:${campaignId}`,  title: labels.y } },
              { type: "reply", reply: { id: `df_no:${campaignId}`,   title: labels.n } },
            ],
          },
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function offerText(lang: string, name: string, doctorName: string, date: string, slots: string[], serviceName?: string): string {
  const slotList = slots.slice(0, 4).join(", ");
  const greeting = name ? (lang === "fr" ? `Bonjour ${name},` : lang === "ar" ? `مرحبا ${name},` : `Hi ${name},`) : "";
  const svc = serviceName ? ` (${serviceName})` : "";
  if (lang === "fr") return `${greeting} ${doctorName} a des créneaux libres le ${date} : ${slotList}${svc}. Voulez-vous en réserver un ?`;
  if (lang === "ar") return `${greeting} ${doctorName} لديه مواعيد متاحة يوم ${date}: ${slotList}${svc}. هل تريد حجز موعد؟`;
  return `${greeting} ${doctorName} has open slots on ${date}: ${slotList}${svc}. Want to grab one?`;
}

// ============================================================================
// SCAN — find empty-slot opportunities and build a candidate list per business
// ============================================================================
async function scanOne(sb: any, businessId: string) {
  // Find raw opportunities (date + doctor + free-slot times + candidate count)
  const { data: opps, error: oppsErr } = await sb.rpc("find_demand_fill_opportunities", {
    p_business_id: businessId,
    p_days_ahead: 7,
  });
  if (oppsErr) throw oppsErr;

  const out: any[] = [];

  for (const o of (opps || [])) {
    if (!o.candidate_count || o.candidate_count === 0) continue;

    // Skip if a campaign for the same date+doctor already exists in pending/approved/sent state
    const { data: existing } = await sb
      .from("demand_fill_campaigns")
      .select("id, status")
      .eq("business_id", businessId)
      .eq("date", o.date)
      .eq("doctor_id", o.doctor_id)
      .in("status", ["pending_approval", "approved", "sent"])
      .maybeSingle();
    if (existing) {
      out.push({ ...o, campaign_id: existing.id, status: existing.status });
      continue;
    }

    // Pick a default service for this doctor (their most-frequent past service)
    const { data: svcRow } = await sb
      .from("appointments")
      .select("service_id, services(name)")
      .eq("business_id", businessId)
      .eq("doctor_id", o.doctor_id)
      .not("service_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const serviceId = svcRow?.service_id || null;

    // Insert campaign + queued targets
    const { data: campaign, error: cErr } = await sb
      .from("demand_fill_campaigns")
      .insert({
        business_id: businessId,
        doctor_id: o.doctor_id,
        service_id: serviceId,
        date: o.date,
        slot_times: o.slot_times,
        status: "pending_approval",
        candidate_count: o.candidate_count,
      })
      .select()
      .single();
    if (cErr) {
      console.error("campaign insert failed:", cErr);
      continue;
    }

    // Pull ranked candidates (top 12 per opportunity to keep WhatsApp cost down)
    const { data: candidates } = await sb.rpc("demand_fill_candidates", {
      p_business_id: businessId,
      p_date: o.date,
      p_service_id: serviceId,
      p_limit: 12,
    });

    if (candidates && candidates.length) {
      const rows = candidates.map((c: any, idx: number) => ({
        campaign_id: campaign.id,
        client_id: c.client_id,
        rank: idx + 1,
        status: "queued",
        reason: c.reason,
      }));
      await sb.from("demand_fill_targets").insert(rows);
    }

    out.push({ ...o, campaign_id: campaign.id, status: "pending_approval", candidates });
  }

  return out;
}

// ============================================================================
// SEND — owner approved; send the WhatsApp blast
// ============================================================================
async function sendCampaign(sb: any, campaignId: string, onlyTargetIds?: string[]) {
  const { data: campaign, error: cErr } = await sb
    .from("demand_fill_campaigns")
    .select("*, businesses(name), users:doctor_id(name), services(name)")
    .eq("id", campaignId)
    .maybeSingle();
  if (cErr || !campaign) throw cErr || new Error("Campaign not found");
  if (campaign.status === "sent") return { sent: 0, errors: 0, note: "already sent" };

  let q = sb.from("demand_fill_targets").select("*, clients(name, phone, profile)").eq("campaign_id", campaignId).eq("status", "queued");
  if (onlyTargetIds && onlyTargetIds.length) q = q.in("id", onlyTargetIds);
  const { data: targets = [] } = await q;

  let sent = 0, errors = 0;
  for (const t of targets) {
    const lang = t.clients?.profile?.language || "en";
    const phone = t.clients?.phone;
    const name = (t.clients?.name || "").split(" ")[0];
    const body = offerText(
      lang, name,
      campaign.users?.name || "your provider",
      campaign.date,
      campaign.slot_times,
      campaign.services?.name,
    );
    const ok = await sendOfferButtons(phone, body, campaignId, lang);
    if (ok) {
      sent++;
      await sb.from("demand_fill_targets").update({ status: "sent", pinged_at: new Date().toISOString() }).eq("id", t.id);
      await sb.from("clients").update({ last_demand_ping_at: new Date().toISOString() }).eq("id", t.client_id);
    } else {
      errors++;
    }
  }

  await sb.from("demand_fill_campaigns").update({
    status: "sent",
    sent_at: new Date().toISOString(),
    approved_at: campaign.approved_at || new Date().toISOString(),
  }).eq("id", campaignId);

  await sb.from("notifications").insert({
    business_id: campaign.business_id,
    type: "info",
    title: "Demand-fill campaign sent",
    message: `Pinged ${sent} patient${sent === 1 ? "" : "s"} about open slots on ${campaign.date}.`,
  });

  return { sent, errors };
}

// ============================================================================
// HTTP HANDLER
// ============================================================================
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    if (body.mode === "scan_all") {
      const { data: bizs = [] } = await sb.from("businesses").select("id");
      const allOpps: any[] = [];
      for (const b of bizs) {
        try { allOpps.push({ business_id: b.id, opportunities: await scanOne(sb, b.id) }); }
        catch (e) { console.error("scan_all err for biz", b.id, e); }
      }
      return new Response(JSON.stringify({ ok: true, scanned: bizs.length, results: allOpps }),
        { headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (body.mode === "scan") {
      if (!body.business_id) return new Response(JSON.stringify({ error: "business_id required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      const opps = await scanOne(sb, body.business_id);
      return new Response(JSON.stringify({ ok: true, opportunities: opps }),
        { headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (body.mode === "send") {
      if (!body.campaign_id) return new Response(JSON.stringify({ error: "campaign_id required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      const r = await sendCampaign(sb, body.campaign_id, body.target_ids);
      return new Response(JSON.stringify({ ok: true, ...r }),
        { headers: { ...cors, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "unknown mode" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
