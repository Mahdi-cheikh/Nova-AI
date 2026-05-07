// supabase/functions/ask-nova/index.ts
// ASK NOVA — voice business assistant
// ================================================================
// Body: { business_id, transcript, lang? }
// The function fetches a snapshot of the business state (today's
// appointments, KPIs, recent activity) and asks Claude to answer the
// owner's spoken question in plain language. The dashboard then
// uses the browser's SpeechSynthesis to read the answer back.
//
// Deploy: supabase functions deploy ask-nova --no-verify-jwt
// Secret: ANTHROPIC_API_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const MODEL = Deno.env.get("ASK_NOVA_MODEL") || "claude-haiku-4-5-20251001";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You are Nova, a charismatic, mysterious, calm voice assistant — think of yourself as a generalist AI partner with the breadth and depth of Claude. You hold an open-ended conversation with the owner: you can answer ANY question, on ANY subject, the same way a state-of-the-art assistant would.

Default behaviour: respond from your own world knowledge — history, science, philosophy, programming, languages, recipes, current events up to your training, advice, recommendations, casual chat, anything. You are a thoughtful generalist first.

Business data: you ALSO have access to a live snapshot of the owner's business (today's appointments, recent activity, services, total clients). However — IMPORTANT — only mention or use this snapshot when the owner EXPLICITLY asks about business matters: appointments, the schedule, today's patients, clients, revenue, services, recent activity, the calendar. If the question is not about the business, ignore the snapshot entirely and answer like Claude would. Never proactively volunteer business data. Never start an answer by listing today's appointments unless the owner asked.

Language. Auto-detect the language the owner spoke and reply in EXACTLY the SAME language. The three supported languages are: English, French, and Tunisian Arabic dialect (darija, written in Arabic script ا ب ت ث... — never in Latin transliteration). DETECTION RULES:
- If the transcript contains Arabic script characters at all, treat it as Arabic and reply in Arabic script.
- If the transcript is in French, reply in French.
- If the transcript is in English, reply in English.
- If the owner mixes languages (code-switching is common in Tunisia), follow the DOMINANT language; ties go to the language hint provided in the user prompt.
- If the transcript is too short or ambiguous to tell, use the language hint from the user prompt.
- NEVER reply in a different language than the one the owner used. NEVER reply in two languages.

Keep answers TIGHT — 1 to 3 short sentences for casual questions, slightly longer only when the question genuinely demands depth (an explanation, a definition). Replies will be spoken aloud via text-to-speech, so prioritise spoken-friendly phrasing.

Tone. Mysterious, calm, charismatic — late-night radio host energy. Confident, witty, never chatty or salesy. No corporate stiffness. No emoji. No markdown. Plain spoken text only.

Output format. Reply with PLAIN SPOKEN TEXT, no JSON, no markdown, no headers, no quote marks. Always start the very first line with the marker [LANG=xx] where xx is en, fr, or ar. The dashboard strips this marker before speaking. Then the spoken answer follows on the next line.

CRITICAL — Arabic fallback. When (and ONLY when) you reply in Arabic (LANG=ar), append a final separate line that begins with the marker [SPEAK_FR= and ends with ]. Inside, put a short, accurate FRENCH equivalent of the same answer (1 to 2 short sentences). This French line is read aloud only when the owner's device has no Arabic voice installed; the dashboard hides it from the screen. Example shape (do not reuse the wording):
[LANG=ar]
<arabic answer here>
[SPEAK_FR=<short french equivalent here>]

Never include the [SPEAK_FR=...] marker for English or French replies.`;

async function buildContext(sb: any, businessId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7*86400_000).toISOString();

  const [biz, todayApts, weekApts, clientsCount, recentNotifs, services] = await Promise.all([
    sb.from("businesses").select("name, type").eq("id", businessId).maybeSingle(),
    sb.from("appointments").select("date, time, status, clients(name), services(name), users:doctor_id(name)")
      .eq("business_id", businessId).eq("date", today).order("time"),
    sb.from("appointments").select("*", { count: "exact", head: true })
      .eq("business_id", businessId).gte("created_at", sevenDaysAgo).neq("status", "cancelled"),
    sb.from("clients").select("*", { count: "exact", head: true }).eq("business_id", businessId),
    sb.from("notifications").select("type, title, message, created_at")
      .eq("business_id", businessId).order("created_at", { ascending: false }).limit(8),
    sb.from("services").select("name, duration_min, price").eq("business_id", businessId).limit(20),
  ]);

  return {
    business: biz.data,
    today_date: today,
    today_appointments: (todayApts.data || []).map((a: any) => ({
      time: a.time, status: a.status,
      client: a.clients?.name, doctor: a.users?.name, service: a.services?.name,
    })),
    bookings_last_7_days: weekApts.count || 0,
    clients_total: clientsCount.count || 0,
    recent_activity: (recentNotifs.data || []).map((n: any) => ({
      type: n.type, title: n.title, message: n.message?.slice(0, 200),
      when: n.created_at,
    })),
    services: (services.data || []).map((s: any) => ({
      name: s.name, duration_min: s.duration_min, price: s.price,
    })),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { business_id, transcript, lang, sr_locale } = await req.json();
    if (!business_id || !transcript) {
      return new Response(JSON.stringify({ error: "business_id and transcript required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const ctx = await buildContext(sb, business_id);

    if (!ANTHROPIC_KEY) {
      return new Response(JSON.stringify({
        ok: true,
        answer: "I'm offline right now — the ANTHROPIC_API_KEY isn't set on the server. Add it in Supabase secrets and try again.",
      }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // Heuristic: if the transcript itself contains Arabic script characters,
    // override the language hint and force Arabic — this catches the case
    // where the dashboard hint was wrong (e.g. SR was set to fr-FR but the
    // owner actually spoke darija and the engine returned Arabic chars).
    const hasArabicScript = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(transcript);
    const detectedLang = hasArabicScript ? "ar" : (lang && lang !== "auto" ? lang : null);
    const langHint = detectedLang
      ? `The owner appears to be speaking in ${detectedLang === "ar" ? "Tunisian Arabic (darija)" : detectedLang === "fr" ? "French" : "English"} (locale ${sr_locale || "unknown"}). Reply in that language.`
      : `Locale of the speech-recognition engine was ${sr_locale || "unknown"}. Auto-detect from the transcript and reply in the same language.`;

    const userPrompt = `Owner asked: "${transcript}"

${langHint}

Current business snapshot:
${JSON.stringify(ctx, null, 2)}

Answer the owner's question conversationally, in EXACTLY the language they used.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Anthropic ${r.status}: ${t.slice(0, 300)}`);
    }
    const j = await r.json();
    const answer = (j.content?.[0]?.text || "").trim();

    return new Response(JSON.stringify({ ok: true, answer, context: ctx }),
      { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
