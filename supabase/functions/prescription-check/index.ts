// supabase/functions/prescription-check/index.ts
// DRUG-INTERACTION + ALLERGY CHECKER
// ================================================================
// Doctor types a prescription. We snapshot the patient's current
// medications, allergies, and conditions, send them to Claude with
// a strict structured-JSON prompt, and persist the verdict.
//
// Body: { client_id, prescription, appointment_id?, doctor_id? }
// Returns: { check_id, verdict: { interactions[], allergy_hits[], cautions[],
//   highest_severity, summary }, patient_context }
//
// Deploy: supabase functions deploy prescription-check --no-verify-jwt
// Secrets: ANTHROPIC_API_KEY (re-uses the same key as classify-message)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY   = Deno.env.get("ANTHROPIC_API_KEY") || "";
const MODEL           = Deno.env.get("ANTHROPIC_MODEL") || "claude-haiku-4-5-20251001";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ============================================================================
// Claude prompt — asks for strict JSON only. The system prompt makes the
// model pessimistic (flag uncertain interactions rather than miss them) and
// pins the output schema so the dashboard never has to parse free text.
// ============================================================================
const SYSTEM_PROMPT = `You are a clinical-pharmacology assistant assisting a Tunisian doctor.
You receive: (1) a proposed prescription, (2) the patient's current medications, (3) recorded allergies, (4) optional conditions.

Your job: identify risks BEFORE the prescription is filled. Be cautious — if you're not sure, flag it as a caution rather than letting it through silent. Do NOT diagnose or recommend dosages; only flag risks.

Output ONLY a single JSON object, no markdown, no preamble. Schema:
{
  "interactions":   [{ "drug_a": string, "drug_b": string, "severity": "low"|"medium"|"high"|"critical", "explanation": string, "advice": string }],
  "allergy_hits":   [{ "drug": string, "allergy": string, "severity": "low"|"medium"|"high"|"critical", "explanation": string }],
  "cautions":       [{ "drug": string, "reason": string, "severity": "low"|"medium" }],
  "highest_severity": "none"|"low"|"medium"|"high"|"critical",
  "summary": string
}

severity rules:
- "critical" = potential serious harm or death (e.g. anaphylaxis, serotonin syndrome, QT-fatal combos)
- "high"     = clinically significant adverse interaction (e.g. contraceptive efficacy lost, bleeding risk)
- "medium"   = monitor closely, dose adjustment may be needed
- "low"      = mild, document but generally proceed
- cautions are advisory (renal/hepatic concerns, pregnancy class, age-specific)

If the prescription is clearly safe with the given context, return empty arrays and "highest_severity": "none" with a one-sentence positive summary.

Write all explanations in clear, jargon-light English so a busy clinician can scan them in 5 seconds. Mention the SPECIFIC drugs by name when explaining.`;

async function callClaude(userPrompt: string): Promise<any> {
  if (!ANTHROPIC_KEY) {
    return {
      interactions: [],
      allergy_hits: [],
      cautions: [{ drug: "Nova", reason: "ANTHROPIC_API_KEY not set on the edge function", severity: "low" }],
      highest_severity: "none",
      summary: "AI offline — ANTHROPIC_API_KEY not configured. Add it in Supabase secrets to enable real-time interaction checking.",
    };
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 300)}`);
  }
  const j = await res.json();
  const text = j.content?.[0]?.text || "";
  // Strip optional ```json fences just in case
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      interactions: [],
      allergy_hits: [],
      cautions: [{ drug: "AI", reason: "Could not parse AI response — review manually.", severity: "low" }],
      highest_severity: "low",
      summary: cleaned.slice(0, 400),
    };
  }
}

const sevRank = (s: string) => ({ none: 0, low: 1, medium: 2, high: 3, critical: 4 }[s] ?? 0);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { client_id, prescription, appointment_id, doctor_id, decision, doctor_note, check_id } = await req.json();

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // === Mode B: doctor is recording their decision after seeing the verdict ===
    if (check_id && decision) {
      const valid = ["safe", "warned_proceeded", "warned_amended", "warned_cancelled"];
      if (!valid.includes(decision)) {
        return new Response(JSON.stringify({ error: "Invalid decision" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      }
      await sb.from("prescription_checks").update({ decision, doctor_note: doctor_note || null }).eq("id", check_id);
      return new Response(JSON.stringify({ ok: true }),
        { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // === Mode A: run the check ===
    if (!client_id || !prescription) {
      return new Response(JSON.stringify({ error: "client_id and prescription required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const { data: client } = await sb.from("clients")
      .select("id, name, age, business_id, medications, allergies, conditions, profile")
      .eq("id", client_id).maybeSingle();
    if (!client) {
      return new Response(JSON.stringify({ error: "Client not found" }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const ctx = {
      patient: {
        name: client.name,
        age: client.age || null,
        sex: client.profile?.sex || null,
        pregnancy: client.profile?.pregnant || null,
      },
      medications: Array.isArray(client.medications) ? client.medications : [],
      allergies:   Array.isArray(client.allergies)   ? client.allergies   : [],
      conditions:  Array.isArray(client.conditions)  ? client.conditions  : [],
    };

    const userPrompt = `Proposed prescription:
${prescription}

Patient context:
${JSON.stringify(ctx, null, 2)}

Run the safety check and respond with the JSON object only.`;

    const verdict = await callClaude(userPrompt);
    const highest = verdict.highest_severity || "none";

    // Persist the audit row
    const { data: row, error: insErr } = await sb.from("prescription_checks").insert({
      business_id:     client.business_id,
      client_id,
      appointment_id:  appointment_id || null,
      doctor_id:       doctor_id || null,
      prescription,
      patient_context: ctx,
      ai_verdict:      verdict,
      highest_severity: highest,
      decision:        highest === "none" ? "safe" : null,
    }).select().single();

    if (insErr) {
      console.error("audit insert failed:", insErr);
    }

    // If a critical risk surfaced, also notify the owner so it shows in the bell
    if (sevRank(highest) >= 3 && row?.id) {
      await sb.from("notifications").insert({
        business_id: client.business_id,
        type: "info",
        title: highest === "critical" ? "CRITICAL: drug-safety flag" : "High-risk drug flag",
        message: `Prescription for ${client.name}: ${verdict.summary || "review needed."}`,
        urgent: highest === "critical",
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      check_id: row?.id,
      verdict,
      patient_context: ctx,
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
