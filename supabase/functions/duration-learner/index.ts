// supabase/functions/duration-learner/index.ts
// SELF-LEARNING APPOINTMENT DURATIONS
// ================================================================
// Scans actual visit durations vs scheduled and either:
//   • auto-applies the change (when the service has auto_adjust_duration=true)
//   • or leaves it as a suggestion + posts an owner notification
//
// Modes:
//   { mode: 'review_all' }                     — cron: every business
//   { mode: 'review', business_id }            — owner-triggered
//   { mode: 'apply', service_id, new_duration } — single Apply tap
//
// Deploy: supabase functions deploy duration-learner --no-verify-jwt

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function reviewBusiness(sb: any, businessId: string) {
  const { data: suggestions = [], error } = await sb.rpc("duration_suggestions", { p_business_id: businessId });
  if (error) throw error;

  let applied = 0;
  let suggested = 0;

  for (const s of suggestions) {
    // Only auto-apply when the service has opted in.
    const { data: svc } = await sb.from("services")
      .select("auto_adjust_duration")
      .eq("id", s.service_id)
      .maybeSingle();

    if (svc?.auto_adjust_duration === true) {
      await sb.rpc("apply_duration_suggestion", {
        p_service_id: s.service_id,
        p_new_duration: s.suggested_duration,
      });
      await sb.from("notifications").insert({
        business_id: businessId,
        type: "info",
        title: "Schedule auto-adjusted",
        message: `${s.service_name}${s.doctor_name ? " (" + s.doctor_name + ")" : ""} now ${s.suggested_duration} min — was ${s.current_duration} min. Average actual: ${s.observed_avg} min over ${s.sample_size} visits.`,
      });
      applied++;
    } else {
      suggested++;
    }
  }

  if (suggested > 0) {
    await sb.from("notifications").insert({
      business_id: businessId,
      type: "info",
      title: "Schedule learning suggestions",
      message: `${suggested} service${suggested === 1 ? "" : "s"} are running off-schedule. Open Schedule Insights to review.`,
    });
  }

  return { applied, suggested, total: suggestions.length, suggestions };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    if (body.mode === "review_all") {
      const { data: bizs = [] } = await sb.from("businesses").select("id");
      const out: any[] = [];
      for (const b of bizs) {
        try { out.push({ business_id: b.id, ...(await reviewBusiness(sb, b.id)) }); }
        catch (e) { console.error("review_all", b.id, e); }
      }
      return new Response(JSON.stringify({ ok: true, scanned: bizs.length, results: out }),
        { headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (body.mode === "review") {
      if (!body.business_id) return new Response(JSON.stringify({ error: "business_id required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      const r = await reviewBusiness(sb, body.business_id);
      return new Response(JSON.stringify({ ok: true, ...r }),
        { headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (body.mode === "apply") {
      if (!body.service_id || !body.new_duration) {
        return new Response(JSON.stringify({ error: "service_id and new_duration required" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      }
      await sb.rpc("apply_duration_suggestion", {
        p_service_id: body.service_id,
        p_new_duration: body.new_duration,
      });
      return new Response(JSON.stringify({ ok: true }),
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
