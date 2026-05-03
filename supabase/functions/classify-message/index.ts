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

function buildSystemPrompt(memory: string = ""): string {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);             // YYYY-MM-DD UTC
  const dow   = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);

  const memBlock = memory ? `\n\nWHAT WE ALREADY KNOW ABOUT THIS CUSTOMER (use to be more helpful, do NOT echo back literally):\n${memory}\n` : "";

  return `You are an intent classifier for a multilingual virtual receptionist used by ANY appointment-driven business: clinics, labs, salons, spas, lawyers, coaches, garages, accountants, photographers, etc. Do NOT assume the business is medical.${memBlock}

CRITICAL DATE CONTEXT — use these to resolve relative dates the user says:
- TODAY is ${dow}, ${today}
- TOMORROW is ${tomorrow}
- "next Tuesday" / "next Monday" etc means the upcoming weekday after today (within 7 days)
- ALWAYS return dates as ISO YYYY-MM-DD format using these reference points. Never return dates in the past.

Your ONLY job: read the customer's message and reply with valid JSON of EXACTLY this shape, no prose:

{
  "intent": "book" | "cancel" | "reschedule" | "availability" | "faq",
  "language": "ar" | "fr" | "en",
  "service": string | null,                    // whatever the customer asked for (haircut, tax filing, oil change, consultation, lab test, ...). Leave null if unclear.
  "date": string | null,                       // ISO YYYY-MM-DD resolved against today=${today}
  "time_preference": string | null,            // "morning" | "afternoon" | "evening" | "HH:MM"
  "urgent": boolean                            // true for emergencies / asap / urgent words in any language
}

Detect language from the script and vocabulary:
- Arabic letters (أ-ي / ا-ي / ؀-ۿ) → "ar"
- French function words (bonjour, rendez-vous, annuler, reporter, je voudrais) → "fr"
- otherwise → "en"

Respond in the same language when generating any natural-language reply, but the JSON keys/values are always English-ASCII as above.`;
}



async function sendWhatsApp(channel: string, phone: string|null, body: string): Promise<void> {
  const WA_PHONE_ID     = Deno.env.get("WA_PHONE_ID");
  const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN");
  if (!channel?.startsWith("whatsapp") || !phone || !WA_PHONE_ID || !WA_ACCESS_TOKEN) return;
  const to = phone.replace(/^\+/, "");
  await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", recipient_type: "individual", to,
      type: "text", text: { body },
    }),
  }).catch(()=>{});
}

// Send a tappable list (WhatsApp Interactive Message). Each row has an id that
// comes back to us when the user taps it — perfect for doctor selection because
// we receive the UUID directly without parsing.
async function sendWhatsAppList(
  channel: string,
  phone: string|null,
  body: string,
  buttonLabel: string,
  items: {id: string; title: string; description?: string}[],
): Promise<boolean> {
  const WA_PHONE_ID     = Deno.env.get("WA_PHONE_ID");
  const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN");
  if (!channel?.startsWith("whatsapp") || !phone || !WA_PHONE_ID || !WA_ACCESS_TOKEN) return false;
  const to = phone.replace(/^\+/, "");
  // WhatsApp limits: row.title 24 chars, row.description 72 chars, button 20 chars.
  const rows = items.slice(0, 10).map(it => ({
    id: it.id.slice(0, 200),
    title: (it.title || "").slice(0, 24),
    ...(it.description ? { description: it.description.slice(0, 72) } : {}),
  }));
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", recipient_type: "individual", to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: body.slice(0, 1024) },
          action: {
            button: buttonLabel.slice(0, 20),
            sections: [{ title: "Options", rows }],
          },
        },
      }),
    });
    return res.ok;
  } catch { return false; }
}

// ===== Multi-turn booking-draft helpers =====
type DraftState = "name"|"age"|"service"|"doctor"|"date"|"time"|"confirming"|"done";

function nextQuestion(state: DraftState, lang: string, ctx: any): string {
  const t = (en: string, fr: string, ar: string) => lang==="fr" ? fr : lang==="ar" ? ar : en;
  // Personalised greeting prefix when this is the FIRST question of a returning
  // patient's flow (name already known, ctx.greeted not yet set by caller).
  const hi = (ctx.name && !ctx._greeted)
    ? (lang==="fr" ? `Bon retour ${ctx.name} ! ` : lang==="ar" ? `أهلا بعودتك ${ctx.name}! ` : `Welcome back ${ctx.name}! `)
    : "";
  if (ctx.name && !ctx._greeted) ctx._greeted = true;
  switch (state) {
    case "name":     return t("Sure! What is your name?", "Bien sûr ! Quel est votre nom ?", "بالتأكيد! ما اسمك؟");
    case "age":      return t(`Thanks ${ctx.name}! How old are you?`, `Merci ${ctx.name} ! Quel est votre âge ?`, `شكرا ${ctx.name}! كم عمرك؟`);
    case "service": {
      // Lab-flavoured prompt when ctx.biz_type='laboratoire'. Lists categories and accepts free-text.
      if (ctx.biz_type === "laboratoire") {
        const sample = (ctx.lab_tests_sample || []) as any[];
        const list = sample.slice(0, 6).map((x:any) => `• ${x.name}`).join("\n");
        return hi + t(
          `Which test(s) would you like to book? You can list multiple.\nCommon tests:\n${list}\n\nIf you have a prescription, send a photo and I'll read it.`,
          `Quels analyses voulez-vous réserver ? Vous pouvez en lister plusieurs.\nExemples :\n${list}\n\nSi vous avez une ordonnance, envoyez une photo et je la lirai.`,
          `ما هي التحاليل المطلوبة؟ يمكنك ذكر عدة تحاليل.\nأمثلة:\n${list}\n\nإذا لديك وصفة طبية، أرسل صورة وسأقرأها.`);
      }
      return hi + t("What service or appointment type do you want?", "Quel service ou type de rendez-vous souhaitez-vous ?", "ما نوع الخدمة أو الموعد الذي تريده؟");
    }
    case "doctor":   {
      const items = (ctx.doctor_choices||[]) as any[];
      const numbered = items.map((d:any, i:number)=>`${i+1}. ${d.name}${d.specialty?` (${d.specialty})`:''}`).join("\n");
      return t(
        `Which doctor would you like to see?\n${numbered}\n\nReply with the number (1-${items.length}).`,
        `Quel médecin préférez-vous ?\n${numbered}\n\nRépondez avec le numéro (1-${items.length}).`,
        `أي طبيب تفضل؟\n${numbered}\n\nأرسل الرقم (1-${items.length}).`);
    }
    case "date":     return t("What date works for you? (e.g. tomorrow, next Monday)", "Quelle date vous convient ? (demain, lundi prochain)", "أي يوم يناسبك؟ (غدا، الإثنين القادم)");
    case "time":     return t("What time? (e.g. 10am, morning, 14:00)", "À quelle heure ? (10h, matin, 14:00)", "أي ساعة؟ (10 صباحا، الصباح، 14:00)");
    case "confirming": {
      // Lab-flavoured confirmation: list each matched test with prices + fasting note
      if (ctx.biz_type === "laboratoire" && Array.isArray(ctx.lab_matched_tests) && ctx.lab_matched_tests.length) {
        const tests   = ctx.lab_matched_tests as any[];
        const lines   = tests.map((x: any) => `• ${x.name} — ${x.price} TND${x.fasting_required ? " (à jeun)" : ""}`).join("\n");
        const total   = tests.reduce((a: number, b: any) => a + Number(b.price || 0), 0);
        const needsFast = tests.some((x: any) => x.fasting_required);
        const fastHrs   = Math.max(...tests.map((x: any) => x.fasting_hours || 0), 0);
        return t(
          `Confirm your booking for ${ctx.name} on ${ctx.date} at ${ctx.time}:\n${lines}\n\nTotal: ${total} TND${needsFast ? `\n⚠ Fasting required (${fastHrs}h before sample collection)` : ""}\n\nReply YES to book, NO to cancel.`,
          `Confirmation pour ${ctx.name} le ${ctx.date} à ${ctx.time} :\n${lines}\n\nTotal : ${total} TND${needsFast ? `\n⚠ À jeun obligatoire (${fastHrs}h avant le prélèvement)` : ""}\n\nRépondez OUI pour confirmer, NON pour annuler.`,
          `تأكيد الحجز لـ${ctx.name} يوم ${ctx.date} على الساعة ${ctx.time}:\n${lines}\n\nالإجمالي: ${total} د.ت${needsFast ? `\n⚠ يجب الصيام (${fastHrs} ساعة قبل أخذ العينة)` : ""}\n\nأرسل نعم للتأكيد، لا للإلغاء.`);
      }
      return t(
        `Confirm: ${ctx.service} on ${ctx.date} at ${ctx.time} for ${ctx.name}. Reply YES to book, NO to cancel.`,
        `Confirmation : ${ctx.service} le ${ctx.date} à ${ctx.time} pour ${ctx.name}. Répondez OUI pour confirmer, NON pour annuler.`,
        `تأكيد: ${ctx.service} يوم ${ctx.date} على الساعة ${ctx.time} لـ${ctx.name}. أرسل نعم للتأكيد، لا للإلغاء.`);
    }
    default: return "";
  }
}

function pickNextState(collected: any): DraftState {
  if (!collected.name)    return "name";
  if (!collected.age)     return "age";
  if (!collected.service) return "service";
  if (collected.needs_doctor && !collected.doctor_id) return "doctor";
  if (!collected.date)    return "date";
  if (!collected.time)    return "time";
  return "confirming";
}

function parseAnswer(state: DraftState, text: string, services: any[]): any {
  const t = text.trim();
  if (state === "name") return t;
  if (state === "age")  { const m = t.match(/\d{1,3}/); return m ? parseInt(m[0],10) : null; }
  if (state === "service"){
    const lower = t.toLowerCase();
    const svc = services.find(s => lower.includes(s.name.toLowerCase().split(" ")[0]));
    return svc ? svc.name : t;
  }
  if (state === "date"){
    const today = new Date();
    const lc = t.toLowerCase();
    if (/today|aujourd|اليوم/i.test(t)) return today.toISOString().slice(0,10);
    if (/tomorrow|demain|غدا/i.test(t)) { const d = new Date(today.getTime()+86400000); return d.toISOString().slice(0,10); }
    const m = t.match(/\d{4}-\d{2}-\d{2}/);
    if (m) return m[0];
    // weekday match (en + fr)
    const map: Record<string, number> = {monday:1,tuesday:2,wednesday:3,thursday:4,friday:5,saturday:6,sunday:0,
                      lundi:1,mardi:2,mercredi:3,jeudi:4,vendredi:5,samedi:6,dimanche:0};
    for (const k of Object.keys(map)){
      if (lc.includes(k)){
        const target = map[k]; let diff = (target - today.getDay() + 7) % 7; if (diff===0) diff = 7;
        const d = new Date(today.getTime() + diff*86400000); return d.toISOString().slice(0,10);
      }
    }
    return null;
  }
  if (state === "time"){
    const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm|h)?/i);
    if (m){
      let h = parseInt(m[1],10); const mn = m[2]||"00"; const ap = (m[3]||"").toLowerCase();
      if (ap==="pm" && h<12) h += 12;
      if (ap==="am" && h===12) h = 0;
      return `${String(h).padStart(2,"0")}:${mn}`;
    }
    if (/morning|matin|صباح/i.test(t)) return "09:30";
    if (/afternoon|apr[eè]s.midi|بعد الظهر/i.test(t)) return "14:30";
    if (/evening|soir|مساء/i.test(t)) return "17:30";
    return null;
  }
  if (state === "confirming"){
    if (/^(yes|y|oui|o|نعم|ok|نعم|اجل|ايه|ايوه)/i.test(t)) return "yes";
    if (/^(no|n|non|لا|كلا)/i.test(t)) return "no";
    return null;
  }
  return null;
}

const lower = (s: string) => (s||"").toLowerCase();


// LLM-powered field parser. Handles darija, Arabizi, typos, slang, multilingual. Returns
// { value, clear, clarify }. If clear=false, the caller should send `clarify` to the user
// and stay in the current state.
async function claudeParseField(state: DraftState, text: string, collected: any, services: any[], lang: string): Promise<{ value: any; clear: boolean; clarify: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const dow = new Date().toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const guide: Record<string, string> = {
    name: "Extract the customer's full name. Strip 'my name is', 'I am', 'ismi', 'ana', 'je m'appelle', 'ana ismi'.",
    age: "Extract the customer's age as a positive integer (years). Convert worded numbers ('thirty', 'trente', 'tlathine').",
    service: "Identify the requested service / appointment type. ACCEPT WHATEVER THE USER SAYS — return the user's description as-is (haircut, cardiology, tax filing, oil change, swim lesson, consultation, ...). The available services in the database are only suggestions to help match canonical names; if the user asks for something NOT in the list, that's fine — return their description and the system will auto-create the service. Only return null/unclear if the answer is empty or completely unrelated (e.g. 'how are you?').",
    doctor: `Identify which doctor the user wants. Match the user's reply against this list of doctors and return the doctor's UUID (id field): ${JSON.stringify((collected.doctor_choices||[]).map((d:any)=>({id:d.id, name:d.name, specialty:d.specialty})))}. The user may say a name fragment ("Karim", "the cardio one"), specialty ("the cardiologist"), or a number (1, 2). Return the matching doctor's id.`,
    date: `Extract a calendar date as ISO YYYY-MM-DD. Today=${dow} ${today}. Tomorrow=${tomorrow}. Resolve 'tomorrow', 'next Monday', 'in 3 days', 'after this weekend' etc. Never return a date in the past.`,
    time: "Extract a time as HH:MM (24h). Vague words: 'morning'=09:30, 'afternoon'=14:30, 'evening'=17:30, 'noon'=12:00. Recognize Arabic numerals and 'fi le 3sha' style.",
    confirming: "Decide if the user is confirming (output 'yes') or declining (output 'no'). Recognize ANY positive/negative phrasing in any language and dialect (yes, oui, نعم, sah, eh, ah, hatte, ok, please, go ahead, daccor / no, non, لا, la, lala, mada, never).",
    done: "",
  };

  const sys = `You parse a SINGLE field of an appointment-booking dialog.

Field to extract: ${state}
Rule: ${guide[state]}
${services.length ? `Available services in this business: ${services.map((s:any)=>s.name).join(", ")}` : ""}
Already collected so far: ${JSON.stringify(collected)}

The customer can write in:
- English (formal, slang, txt-speak, typos)
- French (with or without accents, Quebec / Maghreb variants)
- Arabic (MSA, plus dialects: Tunisian / Moroccan / Algerian darija, Egyptian, Gulf, Levantine)
- Arabizi (Arabic written in Latin letters with numbers, e.g. "ne7eb n7ejez", "9adwa", "3sha")
- Mixed code-switching is common.

Be tolerant of typos and informal phrasing. If the answer is genuinely ambiguous, missing, or doesn't address the field, set clear=false and write a SHORT polite clarifying question in the SAME language the user wrote in (preserve dialect when possible).

Reply with valid JSON ONLY — no prose, no markdown fences:
{
  "value": <extracted value or null>,
  "clear": true | false,
  "clarify": "<short follow-up question in user's language if not clear, otherwise empty string>"
}`;

  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 250,
        system: sys,
        messages: [{ role: "user", content: text }],
      }),
    });
    const aiJson = await aiRes.json();
    const raw = aiJson?.content?.[0]?.text ?? "{}";
    console.log("Field parse (" + state + ") raw:", raw);
    const cleaned = raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    const parsed = JSON.parse(cleaned);
    return {
      value: parsed.value ?? null,
      clear: parsed.clear === true,
      clarify: String(parsed.clarify || ""),
    };
  } catch (e) {
    console.log("claudeParseField error:", (e as Error).message);
    return { value: null, clear: false, clarify: "" };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { phone, text, business_id, channel = "whatsapp", detected_language } = await req.json();
    if (!text || !business_id) {
      return new Response(JSON.stringify({ error: "Missing text or business_id" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // 0. Per-business daily classification quota. Stops a runaway loop or abusive
    // client from burning the whole Anthropic budget. Default 500/day.
    try {
      const { data: ok } = await sb.rpc("bump_classification_quota", { p_biz: business_id, p_limit: 500 });
      if (ok === false) {
        console.log("[QUOTA] exceeded for business", business_id);
        return new Response(JSON.stringify({ error: "quota_exceeded" }), {
          status: 429, headers: { ...cors, "Content-Type": "application/json" },
        });
      }
    } catch (_e) { /* if rpc not deployed yet, fail open */ }

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

    // 1.5. If a booking-draft is in progress for this client, handle it directly.
    if (clientId) {
      // Order by updated_at desc + limit 1 so we always pick the freshest row even
      // if duplicates somehow exist. Then clean up any older duplicates so we converge
      // back to a single-row-per-client invariant.
      const { data: drafts } = await sb.from("booking_drafts")
        .select("*")
        .eq("business_id", business_id)
        .eq("client_id", clientId)
        .order("updated_at", { ascending: false })
        .limit(5);
      const draft = (drafts && drafts.length) ? drafts[0] : null;
      if (drafts && drafts.length > 1) {
        const staleIds = drafts.slice(1).map((d:any)=>d.id);
        console.log("[CLEANUP] removing", staleIds.length, "stale booking_drafts:", staleIds);
        await sb.from("booking_drafts").delete().in("id", staleIds);
      }
      if (draft) {
        const collected = (draft.collected as any) || {};
        // Memory backfill — if this draft is stuck on a question we already
        // know the answer to (from a previous booking), auto-fill and skip.
        if ((draft.state === "name" || draft.state === "age" || !collected.name || !collected.age)) {
          const { data: cRow } = await sb.from("clients").select("name, age, profile").eq("id", clientId).maybeSingle();
          if (cRow?.name && cRow.name !== phone && !collected.name) collected.name = cRow.name;
          if (cRow?.age && !collected.age) collected.age = cRow.age;
          // If after backfill the current state is satisfied, advance
          if ((draft.state === "name" && collected.name) || (draft.state === "age" && collected.age)) {
            const ns = pickNextState(collected);
            if (ns !== draft.state) {
              await sb.from("booking_drafts").update({ state: ns, collected, updated_at: new Date().toISOString() }).eq("id", draft.id);
              draft.state = ns;
              console.log("[MEMORY-SKIP] auto-advanced past", draft.state === ns ? "" : draft.state, "to", ns);
            }
          }
        }
        console.log("[MULTITURN-ENTRY] draft.id=", draft.id, "state=", draft.state, "user text=", text, "doctor_choices.len=", (collected.doctor_choices||[]).length, "doctor_id=", !!collected.doctor_id, "service=", JSON.stringify(collected.service), "name=", !!collected.name, "age=", !!collected.age);
        const { data: services = [] } = await sb.from("services").select("*, users:doctor_id(*)").eq("business_id", business_id);
        const lang = collected.language || "en";

        // Persist incoming message
        await sb.from("messages").insert({ business_id, client_id: clientId, direction: "in", channel, text, intent: "booking_flow" });

        // SHORTCUT: doctor state with explicit choices -> skip Claude entirely.
        // Match by NUMBER ("1", "2", ...) — primary path now — then fuzzy name fallback.
        if (draft.state === "doctor" && Array.isArray(collected.doctor_choices) && collected.doctor_choices.length) {
          const choices = collected.doctor_choices as any[];
          const tt = String(text || "").trim();
          const lc = tt.toLowerCase();
          let matchedId: string | null = null;
          // 1. NUMBER match — patient typed "1", "2", "#1", "n2", "rakam 1", etc.
          const numMatch = tt.match(/\b(\d{1,2})\b/);
          if (numMatch) {
            const idx = parseInt(numMatch[1], 10) - 1;
            if (idx >= 0 && idx < choices.length) matchedId = choices[idx].id;
          }
          // 2. Exact UUID match (legacy interactive-list tap, kept for safety)
          if (!matchedId) {
            const exact = choices.find((d: any) => d.id === tt);
            if (exact) matchedId = exact.id;
          }
          // 3. Fuzzy name fallback
          if (!matchedId) {
            const m = choices.find((d: any) => {
              const name = String(d.name || "").toLowerCase().trim();
              if (!name) return false;
              if (lc.includes(name)) return true;
              const parts = name.split(/\s+/).filter(Boolean);
              return parts.some(p => p.length >= 3 && lc.includes(p));
            });
            if (m) matchedId = m.id;
          }
          if (matchedId) {
            collected.doctor_id = matchedId;
            const ns = pickNextState(collected);
            console.log("[DOCTOR-SAVE] matched=", matchedId, "next state=", ns, "collected keys=", Object.keys(collected).join(","));
            const upd = await sb.from("booking_drafts").update({ state: ns, collected, updated_at: new Date().toISOString() }).eq("id", draft.id).select();
            console.log("[DOCTOR-SAVE] update result error=", upd.error, "rows=", upd.data?.length);
            const reply = nextQuestion(ns, lang, collected);
            await sb.from("messages").insert({ business_id, client_id: clientId, direction: "out", channel, text: reply });
            await sendWhatsApp(channel, phone, reply);
            return new Response(JSON.stringify({ ok: true, step: "doctor_matched_local" }), { headers: { ...cors, "Content-Type": "application/json" } });
          }
          // No match — re-send the numbered list with a brief clarification
          const clarify = lang==="fr"
            ? `Désolé, je n'ai pas compris. ${nextQuestion("doctor" as DraftState, lang, collected)}`
            : lang==="ar"
            ? `آسف، لم أفهم. ${nextQuestion("doctor" as DraftState, lang, collected)}`
            : `Sorry, I didn't catch that. ${nextQuestion("doctor" as DraftState, lang, collected)}`;
          await sb.from("messages").insert({ business_id, client_id: clientId, direction: "out", channel, text: clarify });
          await sendWhatsApp(channel, phone, clarify);
          return new Response(JSON.stringify({ ok: true, step: "doctor_repick_local" }), { headers: { ...cors, "Content-Type": "application/json" } });
        }

        // LLM-parse the answer for the current field
        const parsed = await claudeParseField(draft.state as DraftState, text, collected, services as any[], lang);
        const answer = parsed.value;

        // Unclear answer? Send Claude's clarifying question and stay in the same state.
        if (!parsed.clear || answer === null || answer === "" || answer === undefined) {
          const clarify = parsed.clarify && parsed.clarify.length > 2 ? parsed.clarify : nextQuestion(draft.state as DraftState, lang, collected);
          await sb.from("messages").insert({ business_id, client_id: clientId, direction: "out", channel, text: clarify });
          await sendWhatsApp(channel, phone, clarify);
          return new Response(JSON.stringify({ ok: true, step: "clarify_" + draft.state }), { headers: { ...cors, "Content-Type": "application/json" } });
        }

        if (draft.state === "confirming") {
          if (answer === "yes") {
            // Resolve service: try matching, else AUTO-CREATE so the type is always recorded
            let svc: any = (services as any[]).find(s => collected.service && lower(s.name).includes(lower(String(collected.service).split(" ")[0])));
            if (!svc && collected.service) {
              const { data: created } = await sb.from("services").insert({
                business_id, name: String(collected.service), duration_min: 30
              }).select().single();
              svc = created;
            }
            // Doctor preference: explicit collected.doctor_id wins, else service.users, else null
            let doctor: any = null;
            if (collected.doctor_id) {
              const { data: d } = await sb.from("users").select("id, name, specialty").eq("id", collected.doctor_id).maybeSingle();
              doctor = d;
            } else {
              doctor = svc?.users;
            }

            // 30-MIN BUFFER CHECK — block any appointment within ±30 min of requested time
            const timeToMin = (t: string) => { const [h,m] = String(t).slice(0,5).split(":").map(Number); return (h||0)*60 + (m||0); };
            const minToTime = (m: number) => `${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;
            const reqMin = timeToMin(collected.time);

            const { data: dayApts } = await sb.from("appointments")
              .select("time")
              .eq("business_id", business_id)
              .eq("date", collected.date)
              .neq("status", "cancelled");
            const taken = (dayApts as any[] || []).map(a => timeToMin(a.time));
            const tooClose = taken.some(t => Math.abs(t - reqMin) < 30);

            if (tooClose) {
              // Suggest next free slot at least 30 min after any existing appointment
              let candidate = reqMin;
              for (let i=0; i<48; i++){
                if (!taken.some(t => Math.abs(t - candidate) < 30)) break;
                candidate += 30;
              }
              const suggestion = candidate <= 19*60 ? minToTime(candidate) : null;
              await sb.from("booking_drafts").update({
                state: "time",
                collected: { ...collected, time: null },
                updated_at: new Date().toISOString()
              }).eq("id", draft.id);
              const reply = lang==="fr"
                ? `Désolé, ${collected.time} le ${collected.date} n'est pas libre (un écart de 30 min entre rendez-vous est requis).${suggestion?` Le prochain créneau libre est ${suggestion}.`:""} Quelle autre heure ?`
                : lang==="ar"
                ? `للأسف، ${collected.time} يوم ${collected.date} غير متاح (يجب 30 دقيقة فاصل بين المواعيد).${suggestion?` أقرب وقت متاح ${suggestion}.`:""} أي وقت آخر تفضل؟`
                : `Sorry, ${collected.time} on ${collected.date} isn't free (we need a 30-min gap between appointments).${suggestion?` Next available is ${suggestion}.`:""} What time works?`;
              await sb.from("messages").insert({ business_id, client_id: clientId, direction: "out", channel, text: reply });
              await sendWhatsApp(channel, phone, reply);
              return new Response(JSON.stringify({ ok: true, step: "buffer_conflict" }), { headers: { ...cors, "Content-Type": "application/json" } });
            }

            // Lab-specific extras at booking time
            const labMatched = (collected.lab_matched_tests || []) as any[];
            const labTotal   = labMatched.reduce((a: number, b: any) => a + Number(b.price || 0), 0);
            const labFasting = labMatched.some((t: any) => t.fasting_required);

            const { data: apt } = await sb.from("appointments").insert({
              business_id, client_id: clientId,
              doctor_id: doctor?.id ?? null, service_id: svc?.id ?? null,
              date: collected.date, time: collected.time, status: "confirmed",
              source: channel === "whatsapp_voice" ? "whatsapp_voice" : "whatsapp_ai",
              fasting_required: labFasting,
              total_amount: labTotal || null,
            }).select().single();

            // Create lab_orders rows for every matched test
            if (apt?.id && labMatched.length && collected.biz_type === "laboratoire") {
              const orderRows = labMatched.map((t: any) => ({
                business_id,
                appointment_id: apt.id,
                test_id: t.id,
                status: "requested",
                price_charged: t.price,
              }));
              await sb.from("lab_orders").insert(orderRows);
            }

            await sb.from("notifications").insert({
              business_id, doctor_id: doctor?.id ?? null, type: "booking",
              title: collected.biz_type === "laboratoire" ? "New lab order" : "New appointment booked",
              message: collected.biz_type === "laboratoire"
                ? `${collected.name} booked ${labMatched.length} test(s) for ${collected.date} ${collected.time} — ${labTotal} TND${labFasting ? " (fasting)" : ""}`
                : `${collected.name} (age ${collected.age}) booked ${svc?.name ?? "an appointment"} on ${collected.date} at ${collected.time}`,
            });
            // Update client with collected data
            await sb.from("clients").update({ name: collected.name, age: collected.age }).eq("id", clientId);
            await sb.from("booking_drafts").delete().eq("id", draft.id);
            const reply = lang==="fr" ? `C'est confirmé, ${collected.name} ! Votre rendez-vous est le ${collected.date} à ${collected.time}.`
                       : lang==="ar" ? `تم التأكيد ${collected.name}! موعدك يوم ${collected.date} على الساعة ${collected.time}.`
                       : `Confirmed, ${collected.name}! Your appointment is on ${collected.date} at ${collected.time}.`;
            await sb.from("messages").insert({ business_id, client_id: clientId, direction: "out", channel, text: reply });
            await sendWhatsApp(channel, phone, reply);
            return new Response(JSON.stringify({ ok: true, step: "booked" }), { headers: { ...cors, "Content-Type": "application/json" } });
          } else if (answer === "no") {
            await sb.from("booking_drafts").delete().eq("id", draft.id);
            const reply = lang==="fr" ? "Pas de souci, j'ai annulé. Dites-moi quand vous voulez essayer à nouveau."
                        : lang==="ar" ? "لا مشكلة، تم الإلغاء. أخبرني متى تريد المحاولة مرة أخرى."
                        : "No worries, I cancelled the request. Tell me when you'd like to try again.";
            await sb.from("messages").insert({ business_id, client_id: clientId, direction: "out", channel, text: reply });
            await sendWhatsApp(channel, phone, reply);
            return new Response(JSON.stringify({ ok: true, step: "cancelled" }), { headers: { ...cors, "Content-Type": "application/json" } });
          } else {
            const reply = lang==="fr" ? "Répondez par OUI ou NON, s'il vous plaît." : lang==="ar" ? "يرجى الرد بنعم أو لا." : "Please reply YES or NO.";
            await sb.from("messages").insert({ business_id, client_id: clientId, direction: "out", channel, text: reply });
            await sendWhatsApp(channel, phone, reply);
            return new Response(JSON.stringify({ ok: true, step: "reprompt_yes_no" }), { headers: { ...cors, "Content-Type": "application/json" } });
          }
        } else {
          // If user typed a doctor's name as the service answer, that's ambiguous — clarify.
          if (draft.state === "service" && Array.isArray(collected.doctor_choices)) {
            const lc = String(answer || "").toLowerCase();
            const looksLikeDoctor = (collected.doctor_choices as any[]).some((d:any)=>{
              const n = String(d.name||"").toLowerCase();
              return n && (lc === n || lc.includes(n) || (n.split(" ").length>1 && lc.includes(n.split(" ").slice(-1)[0])));
            });
            if (looksLikeDoctor) {
              const reply = lang==="fr" ? "C'est un médecin, pas un service. Quel SERVICE souhaitez-vous ? (ex. consultation, cardiologie, analyse...)" :
                           lang==="ar" ? "هذا اسم طبيب وليس خدمة. ما هي الخدمة المطلوبة؟ (مثل: استشارة، قلب، تحليل...)" :
                           "That's a doctor, not a service. What SERVICE do you want? (e.g. consultation, cardiology, lab test)";
              await sb.from("messages").insert({ business_id, client_id: clientId, direction: "out", channel, text: reply });
              await sendWhatsApp(channel, phone, reply);
              return new Response(JSON.stringify({ ok: true, step: "service_disambig" }), { headers: { ...cors, "Content-Type": "application/json" } });
            }
          }
          // Lab: when patient just answered the SERVICE question, fuzzy-match
          // their list of tests against the catalog so we can show prices and
          // fasting info on the confirmation step.
          if (draft.state === "service" && collected.biz_type === "laboratoire" && Array.isArray(collected.lab_tests_catalog)) {
            const txt = String(answer || "").toLowerCase();
            const catalog = collected.lab_tests_catalog as any[];
            const matched = catalog.filter((t: any) => {
              const n = String(t.name || "").toLowerCase();
              const c = String(t.code || "").toLowerCase();
              if (!n) return false;
              if (c && txt.includes(c)) return true;
              // Match on any meaningful word in the test name (≥3 chars), not just first word
              const words = n.split(/[\s()/-]+/).filter((w:string) => w.length >= 3);
              return words.some((w:string) => txt.includes(w));
            });
            // If nothing matched, ask again with a clearer prompt instead of advancing
            if (!matched.length) {
              const reply = lang === "fr"
                ? `Je n'ai pas trouvé ces analyses dans notre catalogue. Pouvez-vous reformuler ? Exemples : "bilan lipidique", "TSH", "vitamine D", "NFS".`
                : lang === "ar"
                ? `لم أجد هذه التحاليل في الكتالوج. هل يمكنك إعادة الصياغة؟ أمثلة: "صورة الدهون"، "TSH"، "فيتامين د"، "تعداد الدم".`
                : `I couldn't find those tests in our catalog. Could you rephrase? Examples: "lipid panel", "TSH", "vitamin D", "CBC".`;
              await sb.from("messages").insert({ business_id, client_id: clientId, direction: "out", channel, text: reply });
              await sendWhatsApp(channel, phone, reply);
              return new Response(JSON.stringify({ ok: true, step: "lab_no_match" }), { headers: { ...cors, "Content-Type": "application/json" } });
            }
            collected.lab_matched_tests = matched;
            collected.service = matched.map((t: any) => t.name).join(", ");
          }

          if (draft.state === "doctor") {
            // Validate by number first, then UUID, then name fragment
            const choices = (collected.doctor_choices || []) as any[];
            let matchedId: string | null = null;
            const ans = String(answer || "").trim();
            const numMatch = ans.match(/\b(\d{1,2})\b/);
            if (numMatch) {
              const idx = parseInt(numMatch[1], 10) - 1;
              if (idx >= 0 && idx < choices.length) matchedId = choices[idx].id;
            }
            if (!matchedId && choices.find((d:any)=>d.id === ans)) matchedId = ans;
            if (!matchedId) {
              const lc = ans.toLowerCase();
              const m = choices.find((d:any)=>lc.includes(String(d.name||"").toLowerCase().split(" ")[0]) || lc.includes(String(d.name||"").toLowerCase().split(" ").slice(-1)[0]));
              if (m) matchedId = m.id;
            }
            if (!matchedId){
              const reply = nextQuestion("doctor" as DraftState, lang, collected);
              await sb.from("messages").insert({ business_id, client_id: clientId, direction: "out", channel, text: reply });
              await sendWhatsApp(channel, phone, reply);
              return new Response(JSON.stringify({ ok: true, step: "doctor_repick" }), { headers: { ...cors, "Content-Type": "application/json" } });
            }
            collected.doctor_id = matchedId;
          } else {
            collected[draft.state] = answer;
          }
          // pick the next state based on what's still missing
          const ns = pickNextState(collected);
          console.log("[ADVANCE] from=", draft.state, "to=", ns, "draft.id=", draft.id, "collected.service=", JSON.stringify(collected.service), "collected.doctor_id=", collected.doctor_id);
          const upd = await sb.from("booking_drafts").update({ state: ns, collected, updated_at: new Date().toISOString() }).eq("id", draft.id).select();
          console.log("[ADVANCE] update error=", JSON.stringify(upd.error), "rows updated=", upd.data?.length);
          // Verify by re-reading the row
          const { data: verify } = await sb.from("booking_drafts").select("state, collected").eq("id", draft.id).maybeSingle();
          console.log("[ADVANCE-VERIFY] state in DB=", verify?.state, "service in DB=", JSON.stringify((verify?.collected as any)?.service), "doctor_id in DB=", (verify?.collected as any)?.doctor_id);
          const reply = nextQuestion(ns, lang, collected);
          await sb.from("messages").insert({ business_id, client_id: clientId, direction: "out", channel, text: reply });
          await sendWhatsApp(channel, phone, reply);
          return new Response(JSON.stringify({ ok: true, step: ns }), { headers: { ...cors, "Content-Type": "application/json" } });
        }
      }
    }

    // 2. Build customer-memory block from clients.profile + last visit
    let memoryBlock = "";
    if (clientId) {
      const { data: clientRow } = await sb.from("clients")
        .select("name, age, profile, last_visit_at")
        .eq("id", clientId).maybeSingle();
      if (clientRow) {
        const bits: string[] = [];
        if (clientRow.name && clientRow.name !== phone) bits.push(`Name: ${clientRow.name}`);
        if (clientRow.age) bits.push(`Age: ${clientRow.age}`);
        if (clientRow.last_visit_at) bits.push(`Last visit: ${String(clientRow.last_visit_at).slice(0,10)}`);
        const p = (clientRow.profile as any) || {};
        if (p.preferred_doctor) bits.push(`Preferred doctor: ${p.preferred_doctor}`);
        if (p.preferred_service) bits.push(`Preferred service: ${p.preferred_service}`);
        if (p.allergies) bits.push(`Allergies: ${p.allergies}`);
        if (p.notes) bits.push(`Notes: ${p.notes}`);
        memoryBlock = bits.join("\n");
      }
    }

    // 2.1. Call Claude
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
        system: buildSystemPrompt(memoryBlock),
        messages: [{ role: "user", content: text }],
      }),
    });
    const aiJson = await aiRes.json();
    const rawText = aiJson?.content?.[0]?.text ?? "{}";
    console.log("Claude raw response:", rawText);  // log so we can see in dashboard

    // Robustly extract a JSON object from Claude's reply.
    // Handles: pure JSON, markdown ```json fences, prose-wrapped JSON.
    const cleaned = rawText.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(cleaned); }
    catch (e) {
      console.log("JSON parse failed, falling back to faq:", (e as Error).message);
      payload = { intent: "faq", language: detected_language || "en", urgent: false };
    }
    if (detected_language) payload.language = detected_language;
    console.log("Final classification:", JSON.stringify(payload));

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
      // Start a multi-turn booking draft. Pre-fill whatever Claude already extracted
      // PLUS what we already know about this returning patient from clients.profile.
      const { data: services = [] } = await sb.from("services").select("*, users:doctor_id(*)").eq("business_id", business_id);
      const { data: clientRow } = await sb.from("clients").select("name, age, profile").eq("id", clientId).maybeSingle();
      const collected: any = { language: payload.language || "en" };
      // Memory: skip name/age questions for returning patients
      if (clientRow?.name && clientRow.name !== phone) collected.name = clientRow.name;
      if (clientRow?.age) collected.age = clientRow.age;
      const profile = (clientRow?.profile as any) || {};
      if (profile.preferred_service && !payload.service) collected.service = profile.preferred_service;

      // For clinics/laboratoires with 2+ doctors: ask which doctor.
      const { data: bizRow } = await sb.from("businesses").select("type").eq("id", business_id).single();
      collected.biz_type = bizRow?.type;
      // Pre-load the lab test catalog for laboratoire businesses so the service
      // question can show categories and the confirmation can list prices.
      if (bizRow?.type === "laboratoire") {
        const { data: tests = [] } = await sb.from("lab_tests")
          .select("id, code, name, price, fasting_required, fasting_hours, sample_type, category")
          .eq("business_id", business_id).eq("active", true);
        collected.lab_tests_catalog = tests;
        collected.lab_tests_sample  = (tests as any[]).slice(0, 8);
      }
      if (bizRow?.type === "clinic" || bizRow?.type === "laboratoire") {
        const { data: doctors = [] } = await sb.from("users")
          .select("id, name, specialty")
          .eq("business_id", business_id)
          .eq("role", "doctor");
        if ((doctors as any[]).length > 1) {
          collected.needs_doctor = true;
          collected.doctor_choices = doctors;
        } else if ((doctors as any[]).length === 1) {
          // only one doctor → auto-assign, no need to ask
          collected.doctor_id = (doctors as any[])[0].id;
        }
      }
      if (payload.service && bizRow?.type !== "laboratoire"){
        const svcMatch = (services as any[]).find(s => lower(s.name).includes(lower(String(payload.service).split(" ")[0])));
        collected.service = svcMatch?.name || payload.service;
      }
      // For laboratoire: try to match the inbound text (not just Claude's service extraction)
      // against the test catalog. If we get ≥1 matches, pre-fill them so the service
      // question is skipped and we go straight to date. This makes prescription-image
      // bookings flow without re-asking. If nothing matches, fall through to the
      // catalog-list service question as before.
      if (bizRow?.type === "laboratoire" && Array.isArray(collected.lab_tests_catalog)) {
        const txt = String(text || "").toLowerCase();
        const catalog = collected.lab_tests_catalog as any[];
        const matched = catalog.filter((t: any) => {
          const n = String(t.name || "").toLowerCase();
          const c = String(t.code || "").toLowerCase();
          if (!n) return false;
          if (c && c.length >= 2 && new RegExp(`\\b${c}\\b`, "i").test(text || "")) return true;
          const words = n.split(/[\s()/-]+/).filter((w:string) => w.length >= 3);
          return words.some((w:string) => txt.includes(w));
        });
        // Only pre-fill if we matched something genuinely test-like (≥1 match AND
        // the matched tests cover most of the message). Otherwise stay open-ended.
        if (matched.length >= 1) {
          collected.lab_matched_tests = matched;
          collected.service = matched.map((t:any) => t.name).join(", ");
        }
      }
      if (payload.date) collected.date = payload.date;
      if (payload.time_preference){
        const tp = payload.time_preference;
        if (/^\d{2}:\d{2}$/.test(tp as string)) collected.time = tp;
        else if (tp === "morning") collected.time = "09:30";
        else if (tp === "afternoon") collected.time = "14:30";
        else if (tp === "evening") collected.time = "17:30";
      }
      const ns = pickNextState(collected);
      await sb.from("booking_drafts").upsert({
        business_id, client_id: clientId, state: ns, collected,
        updated_at: new Date().toISOString()
      }, { onConflict: "business_id,client_id" });
      const reply = nextQuestion(ns, collected.language, collected);
      await sb.from("messages").insert({ business_id, client_id: clientId, direction: "out", channel, text: reply });
      await sendWhatsApp(channel, phone, reply);
      action = { kind: "draft_started", state: ns };
      // Skip the rest of the booking branch - we already replied
      return new Response(JSON.stringify({ classification: payload, action, reply }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" },
      });
      // (the old in-place booking code below this point is no longer reachable)
      const svc = (services as any[]).find(s => payload.service && s.name?.toLowerCase().includes(String(payload.service).split(" ")[0].toLowerCase())) || services[0];
      const doctor = svc?.users;
      const requestedTime = (typeof payload.time_preference === "string" && /^\d{2}:\d{2}$/.test(payload.time_preference)) ? payload.time_preference :
        payload.time_preference === "morning" ? "09:30" :
        payload.time_preference === "afternoon" ? "14:30" :
        payload.time_preference === "evening" ? "17:30" : "10:00";
      const date = (payload.date as string) || new Date(Date.now() + 86400000).toISOString().slice(0, 10);

      // Check existing appointments for that day with this doctor (handle null doctor properly)
      let existingQ = sb.from("appointments")
        .select("time, status")
        .eq("business_id", business_id)
        .eq("date", date)
        .neq("status", "cancelled");
      if (doctor?.id) existingQ = existingQ.eq("doctor_id", doctor.id);
      const { data: existing } = await existingQ;
      const existingArr = (existing as any[]) || [];

      const slotDuration = svc?.duration_min ?? 30;
      const taken = new Set(existingArr.map((a:any) => a.time.slice(0,5)));

      const isFree = (t: string) => !taken.has(t);
      let finalTime = requestedTime;
      let alternativeUsed = false;

      if (!isFree(requestedTime)) {
        // Find next free slot starting from requested time, in 30-min increments, until 18:00
        const [reqH, reqM] = requestedTime.split(":").map(Number);
        const totalReqMin = reqH*60 + reqM;
        for (let m = totalReqMin; m < 18*60; m += slotDuration) {
          const h = Math.floor(m/60), mn = m%60;
          const candidate = `${String(h).padStart(2,"0")}:${String(mn).padStart(2,"0")}`;
          if (isFree(candidate)) { finalTime = candidate; alternativeUsed = true; break; }
        }
      }

      const { data: apt } = await sb.from("appointments").insert({
        business_id, client_id: clientId, doctor_id: doctor?.id ?? null, service_id: svc?.id ?? null,
        date, time: finalTime, status: "confirmed",
        source: channel === "whatsapp_voice" ? "whatsapp_voice" : "whatsapp_ai",
      }).select().single();

      await sb.from("notifications").insert({
        business_id, doctor_id: doctor?.id ?? null, type: "booking",
        title: "New appointment booked",
        message: `${phone} booked ${svc?.name ?? "an appointment"} with ${doctor?.name ?? "a doctor"} on ${date} at ${finalTime}`,
      });

      action = { kind: "booked", appointment_id: apt?.id, doctor_id: doctor?.id, date, time: finalTime, alternativeUsed, requestedTime };
    } else if (payload.intent === "availability") {
      // Patient asking about available slots — list next 3 available times
      const { data: services = [] } = await sb.from("services").select("*, users:doctor_id(*)").eq("business_id", business_id);
      const svc = (services as any[]).find(s => payload.service && s.name?.toLowerCase().includes(String(payload.service).split(" ")[0].toLowerCase())) || services[0];
      const doctor = svc?.users;
      const today = new Date().toISOString().slice(0,10);
      const horizon = new Date(Date.now() + 7*86400000).toISOString().slice(0,10);
      let bookedQ = sb.from("appointments")
        .select("date, time")
        .eq("business_id", business_id)
        .gte("date", today).lte("date", horizon)
        .neq("status", "cancelled");
      if (doctor?.id) bookedQ = bookedQ.eq("doctor_id", doctor.id);
      const { data: booked } = await bookedQ;
      const taken = new Set(((booked as any[]) || []).map((a:any) => `${a.date} ${a.time.slice(0,5)}`));
      const slots: string[] = [];
      for (let d = 0; d < 7 && slots.length < 3; d++) {
        const day = new Date(); day.setDate(day.getDate()+d);
        const ds = day.toISOString().slice(0,10);
        for (const t of ["09:00","10:00","11:00","14:00","15:00","16:00"]) {
          if (!taken.has(`${ds} ${t}`)) {
            slots.push(`${ds} ${t}`);
            if (slots.length >= 3) break;
          }
        }
      }
      action = { kind: "availability", slots, doctor_name: doctor?.name, service_name: svc?.name };
    } else if (payload.intent === "cancel" && clientId) {
      const { data: apt } = await sb.from("appointments").update({ status: "cancelled" })
        .eq("client_id", clientId).eq("status", "confirmed").select().maybeSingle();
      if (apt) {
        await sb.from("notifications").insert({
          business_id, type: "cancel", title: "Appointment cancelled",
          message: `${phone} cancelled their appointment on ${apt.date}`,
        });
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

    // 4.4. LAB-SPECIFIC INTENTS — pricing, fasting, results status. Run before
    // the generic FAQ KB so labs get instant accurate answers from structured data.
    let labAnswer: string | null = null;
    if (payload.intent === "faq" || payload.intent === "availability") {
      const { data: bizT } = await sb.from("businesses").select("type, name").eq("id", business_id).single();
      if (bizT?.type === "laboratoire") {
        const lc = String(text).toLowerCase();
        const lang = (payload.language as string) || "en";
        // Pricing query: "how much", "combien", "بكم", "prix", "price", "cost"
        if (/how much|combien|بكم|prix|price|cost|tarif|سعر|كم/.test(lc)) {
          const { data: tests = [] } = await sb.from("lab_tests")
            .select("name, price, fasting_required").eq("business_id", business_id).eq("active", true).order("price");
          const top = (tests as any[]).slice(0, 12).map((t:any) => `• ${t.name}: ${t.price} TND${t.fasting_required ? " (à jeun)" : ""}`).join("\n");
          labAnswer = lang === "fr"
            ? `Voici nos tarifs principaux :\n${top}\n\nVous pouvez me demander un test précis ou m'envoyer une ordonnance.`
            : lang === "ar"
            ? `إليك أسعار التحاليل الرئيسية:\n${top}\n\nيمكنك سؤالي عن تحليل محدد أو إرسال وصفة طبية.`
            : `Here are our main test prices:\n${top}\n\nAsk me about a specific test or send me a prescription photo.`;
        }
        // Fasting query
        else if (/fast|jeûne|jeun|صيام|صائم/.test(lc)) {
          labAnswer = lang === "fr"
            ? `Le jeûne est requis pour : glycémie, bilan lipidique (12h sans manger, eau OK).\nPour les autres tests (NFS, hormones, vitamines...) le jeûne n'est pas obligatoire.\nDites-moi quel test vous voulez et je vous confirme.`
            : lang === "ar"
            ? `الصيام مطلوب لـ: سكر الدم وصورة الدهون (12 ساعة بدون أكل، الماء مسموح).\nباقي التحاليل (تعداد الدم، الهرمونات، الفيتامينات) لا تتطلب الصيام.\nأخبرني بالتحليل المطلوب وسأؤكد لك.`
            : `Fasting is required for: fasting glucose, lipid panel (12h no food, water OK).\nMost other tests (CBC, hormones, vitamins) don't need fasting.\nTell me which test you want and I'll confirm.`;
        }
        // Results status query
        else if (/result|résultat|nateeja|نتيجة|نتائج|ready|prêt|جاهز/.test(lc) && clientId) {
          const { data: orders = [] } = await sb.from("lab_orders")
            .select("status, ready_at, lab_tests(name), appointments(date)")
            .eq("business_id", business_id)
            .order("created_at", { ascending: false }).limit(10);
          const mine = (orders as any[]).filter(() => true);
          if (mine.length === 0) {
            labAnswer = lang === "fr" ? "Je ne trouve aucune analyse récente à votre nom." : lang === "ar" ? "لم أجد أي تحاليل حديثة باسمك." : "I don't see any recent tests under your name.";
          } else {
            const ready = mine.filter((o: any) => o.status === "ready" || o.status === "delivered");
            const pending = mine.filter((o: any) => o.status !== "ready" && o.status !== "delivered" && o.status !== "cancelled");
            const readyList = ready.map((o:any)=>`✅ ${o.lab_tests?.name}`).join("\n") || (lang==="fr"?"Aucun encore prêt.":lang==="ar"?"لا شيء جاهز بعد.":"None ready yet.");
            const pendList  = pending.map((o:any)=>`⏳ ${o.lab_tests?.name} (${o.status})`).join("\n");
            labAnswer = lang === "fr"
              ? `Voici l'état de vos analyses :\nPrêtes :\n${readyList}\n${pendList ? `\nEn cours :\n${pendList}` : ""}`
              : lang === "ar"
              ? `حالة تحاليلك:\nجاهزة:\n${readyList}\n${pendList ? `\nقيد الإجراء:\n${pendList}` : ""}`
              : `Here is the status of your tests:\nReady:\n${readyList}\n${pendList ? `\nIn progress:\n${pendList}` : ""}`;
          }
        }
      }
    }

    // 4.5. FAQ Knowledge Base — if intent is faq AND business has uploaded FAQs,
    // ask Claude to pick the best matching answer instead of using the generic
    // greeting. Falls through to buildReply if no good match.
    let faqAnswer: string | null = null;
    if (payload.intent === "faq") {
      const { data: faqs = [] } = await sb.from("business_faqs")
        .select("question, answer, language")
        .eq("business_id", business_id)
        .eq("active", true);
      if ((faqs as any[]).length > 0) {
        try {
          const kbSys = `You answer customer questions for a business using the FAQ list below. If the customer's message matches one of the FAQs (paraphrasing OK), reply with that FAQ's answer translated into ${payload.language || "en"} naturally. If NONE of the FAQs apply, reply with the literal string NO_MATCH (no quotes, no prose).

FAQs:
${(faqs as any[]).map((f: any, i: number) => `${i+1}. Q: ${f.question}\n   A: ${f.answer}`).join("\n\n")}`;
          const kbRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001", max_tokens: 350,
              system: kbSys, messages: [{ role: "user", content: text }],
            }),
          });
          const kbJson = await kbRes.json();
          const kbText = (kbJson?.content?.[0]?.text || "").trim();
          if (kbText && kbText !== "NO_MATCH" && kbText.length > 5) faqAnswer = kbText;
        } catch (e) { console.log("FAQ KB lookup failed:", (e as Error).message); }
      }
    }

    // 4.6. Triage tagging for clinics — flag urgent vs routine vs non_medical.
    // Stored on the latest appointment for this client (if any) so the doctor
    // sees it on their dashboard.
    if (clientId && (payload.intent === "book" || payload.intent === "faq")) {
      try {
        const { data: bizT } = await sb.from("businesses").select("type").eq("id", business_id).single();
        if (bizT?.type === "clinic" || bizT?.type === "laboratoire") {
          const triagePrompt = `You are a clinical-triage classifier. Given a patient message, output ONE of: urgent | routine | non_medical. Output the single word, no JSON, no prose.\n\n- "urgent": chest pain, severe bleeding, broken bones, allergic reactions, suicidal language, anything needing same-day care\n- "routine": general check-ups, follow-ups, prescription refills, minor symptoms\n- "non_medical": pricing, hours, location, parking, insurance questions`;
          const tRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 10, system: triagePrompt, messages: [{ role: "user", content: text }] }),
          });
          const tJson = await tRes.json();
          const tag = ((tJson?.content?.[0]?.text || "").trim().toLowerCase().match(/(urgent|routine|non_medical)/) || [])[1];
          if (tag) {
            // Tag latest appointment for this client (most recent first)
            const { data: lastApt } = await sb.from("appointments").select("id").eq("client_id", clientId).order("created_at", { ascending: false }).limit(1).maybeSingle();
            if (lastApt?.id) await sb.from("appointments").update({ triage_level: tag }).eq("id", lastApt.id);
            if (tag === "urgent") {
              await sb.from("notifications").insert({
                business_id, type: "urgent", urgent: true,
                title: "Urgent triage flag",
                message: `${phone}: "${String(text).slice(0,160)}" — auto-tagged URGENT`,
              });
            }
          }
        }
      } catch (e) { console.log("Triage tagging failed:", (e as Error).message); }
    }

    // 5. Build patient-facing reply (in their language)
    const reply = labAnswer || faqAnswer || buildReply(payload, action);

    // 6. Send the reply back via WhatsApp Cloud API (text channel only)
    const WA_PHONE_ID     = Deno.env.get("WA_PHONE_ID");
    const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN");
    let waResult: unknown = { skipped: "not whatsapp" };
    if (channel?.startsWith("whatsapp") && phone && WA_PHONE_ID && WA_ACCESS_TOKEN) {
      const to = phone.replace(/^\+/, "");
      console.log("Sending WhatsApp reply to:", to, "via phone_id:", WA_PHONE_ID, "(channel:", channel, ")");
      const waRes = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { body: reply },
        }),
      });
      waResult = await waRes.json().catch(() => ({ http: waRes.status }));
      console.log("WhatsApp send result:", JSON.stringify(waResult));
    } else {
      console.log("WhatsApp send skipped — channel doesn\'t start with whatsapp, or missing phone/secret. channel:", channel, "phone:", phone, "phoneId set:", !!WA_PHONE_ID, "token set:", !!WA_ACCESS_TOKEN);
    }

    // 7. Persist outgoing message
    await sb.from("messages").insert({
      business_id, client_id: clientId, direction: "out",
      channel, text: reply, intent: payload.intent as string,
    });

    return new Response(JSON.stringify({ classification: payload, action, reply, wa: waResult }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});

function buildReply(p: any, action: any): string {
  const lang = p.language || "en";
  // Special case: alternative slot picked because requested was busy
  if (action.kind === "booked" && action.alternativeUsed) {
    if (lang === "fr") return `Le créneau ${action.requestedTime} était déjà pris. J'ai réservé pour vous le ${action.date} à ${action.time} à la place. À bientôt !`;
    if (lang === "ar") return `الوقت ${action.requestedTime} كان محجوزا. حجزت لك بدلا منه يوم ${action.date} على الساعة ${action.time}.`;
    return `${action.requestedTime} was already taken. I booked you for ${action.date} at ${action.time} instead. See you then!`;
  }
  // Availability response
  if (action.kind === "availability") {
    const list = (action.slots || []).join(", ") || "no slots in the next 7 days";
    if (lang === "fr") return `Voici les prochains créneaux disponibles : ${list}. Quel créneau préférez-vous ?`;
    if (lang === "ar") return `هذه أقرب المواعيد المتاحة: ${list}. أي وقت تفضلون؟`;
    return `Next available slots: ${list}. Which one works for you?`;
  }
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
