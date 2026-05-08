// supabase/functions/ask-nova/index.ts
// ASK NOVA - real-time voice business assistant with TOOL USE
// ============================================================================
// Body: { business_id, transcript, lang?, sr_locale? }
//
// Claude gets a small initial snapshot PLUS a set of tools she can call
// when she needs more detail. Tools: query_appointments, query_clients,
// query_messages, query_revenue, query_services, query_lab_results,
// get_appointment_details. Agent loop runs up to 5 turns.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const MODEL = Deno.env.get("ASK_NOVA_MODEL") || "claude-haiku-4-5-20251001";
const MAX_AGENT_TURNS = 5;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You are Nova, a charismatic, mysterious, calm voice assistant - think of yourself as a generalist AI partner with the breadth and depth of Claude. You hold an open-ended conversation with the owner: you can answer ANY question, on ANY subject, the same way a state-of-the-art assistant would.

Default behaviour: respond from your own world knowledge - history, science, philosophy, programming, languages, recipes, current events up to your training, advice, recommendations, casual chat, anything. You are a thoughtful generalist first.

Business data: you have a live connection to the owner's business database via TOOLS. You also receive a small initial snapshot at the start of every question. Use the snapshot when it already answers the question. CALL THE TOOLS when the owner asks something the snapshot does not cover: a specific date in the past or future, a particular client by name, revenue figures, recent WhatsApp messages, lab results, appointment details, etc. Always call tools instead of guessing or saying you do not know.

Tool usage rules:
- Only call tools when the owner is genuinely asking about business data. Never call tools for casual chat, world-knowledge questions, or generic advice.
- Be efficient: pick the most specific tool, give it the tightest filters, and only call it once unless the answer truly needs combined data.
- Never expose tool names, IDs, or raw JSON to the owner. Speak naturally about what you found.

Language. Auto-detect the language the owner spoke and reply in EXACTLY the SAME language. The three supported languages are: English, French, and Tunisian Arabic dialect (darija, written in Arabic script - never in Latin transliteration). DETECTION RULES:
- If the transcript contains Arabic script characters at all, treat it as Arabic and reply in Arabic script.
- If the transcript is in French, reply in French.
- If the transcript is in English, reply in English.
- If the owner mixes languages, follow the DOMINANT language; ties go to the language hint provided.
- If the transcript is too short or ambiguous to tell, use the language hint.
- NEVER reply in a different language than the one the owner used. NEVER reply in two languages.

Keep answers TIGHT - 1 to 3 short sentences for casual questions, slightly longer only when the question genuinely demands depth. Replies will be spoken aloud via text-to-speech, so prioritise spoken-friendly phrasing - say "ten thirty" not "10:30".

Tone. Mysterious, calm, charismatic - late-night radio host energy. Confident, witty, never chatty or salesy. No corporate stiffness. No emoji. No markdown. Plain spoken text only.

Output format. Reply with PLAIN SPOKEN TEXT, no JSON, no markdown, no headers, no quote marks. Always start the very first line with the marker [LANG=xx] where xx is en, fr, or ar. The dashboard strips this marker before speaking. Then the spoken answer follows on the next line.

CRITICAL - Arabic fallback. When (and ONLY when) you reply in Arabic (LANG=ar), append a final separate line that begins with the marker [SPEAK_FR= and ends with ]. Inside, put a short, accurate FRENCH equivalent of the same answer. Never include the [SPEAK_FR=...] marker for English or French replies.`;

const TOOLS = [
  {
    name: "query_appointments",
    description: "Search appointments by date range, status, client name, doctor name, or service. Defaults to today if no date filter is given.",
    input_schema: {
      type: "object",
      properties: {
        date_from: { type: "string", description: "ISO date YYYY-MM-DD (inclusive). Optional. Defaults to today." },
        date_to:   { type: "string", description: "ISO date YYYY-MM-DD (inclusive). Optional. Defaults to date_from." },
        status:    { type: "string", description: "Optional: scheduled | confirmed | cancelled | completed | arrived." },
        client_name:  { type: "string", description: "Optional partial match on client name." },
        doctor_name:  { type: "string", description: "Optional partial match on doctor name." },
        service_name: { type: "string", description: "Optional partial match on service name." },
        limit: { type: "integer", description: "Default 20, max 50." },
      },
    },
  },
  {
    name: "query_clients",
    description: "Search clients/patients by name or phone.",
    input_schema: {
      type: "object",
      properties: {
        name:  { type: "string", description: "Partial match on client name." },
        phone: { type: "string", description: "Partial match on client phone." },
        limit: { type: "integer", description: "Default 10, max 25." },
      },
    },
  },
  {
    name: "get_appointment_details",
    description: "Fetch full details for a single appointment, including notes and conditions.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "UUID if known." },
        client_name:    { type: "string", description: "Or pass a client name to find their most recent appointment." },
        when:           { type: "string", description: "next | last | YYYY-MM-DD. Default next." },
      },
    },
  },
  {
    name: "query_messages",
    description: "Pull recent WhatsApp messages, optionally filtered to a single client.",
    input_schema: {
      type: "object",
      properties: {
        client_name: { type: "string", description: "Optional filter by client name." },
        hours_back:  { type: "integer", description: "How far back (default 24)." },
        limit:       { type: "integer", description: "Default 15, max 40." },
      },
    },
  },
  {
    name: "query_revenue",
    description: "Aggregate revenue and appointment counts over a period.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", description: "today | yesterday | this_week | last_week | this_month | last_month | last_30_days. Default this_week." },
        group_by: { type: "string", description: "Optional: doctor | service | day. Default: total." },
      },
    },
  },
  {
    name: "query_services",
    description: "Look up services with prices and durations.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "Partial match." } },
    },
  },
  {
    name: "query_lab_results",
    description: "(Laboratoire businesses) Pull pending or recent lab samples.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional filter." },
        client_name: { type: "string", description: "Optional client filter." },
        limit: { type: "integer", description: "Default 15." },
      },
    },
  },
];

async function executeTool(name: string, input: any, businessId: string, sb: any): Promise<string> {
  try {
    switch (name) {
      case "query_appointments": {
        const today = new Date().toISOString().slice(0, 10);
        const dateFrom = input.date_from || today;
        const dateTo = input.date_to || dateFrom;
        const limit = Math.min(50, input.limit || 20);
        let q = sb.from("appointments")
          .select("id, date, time, status, source, clients(id, name, phone), users:doctor_id(name), services(name, duration_min, price)")
          .eq("business_id", businessId)
          .gte("date", dateFrom)
          .lte("date", dateTo);
        if (input.status) q = q.eq("status", input.status);
        const { data, error } = await q.order("date").order("time").limit(200);
        if (error) return JSON.stringify({ error: error.message });
        let results = (data || []) as any[];
        if (input.client_name)  results = results.filter((a: any) => a.clients?.name?.toLowerCase().includes(input.client_name.toLowerCase()));
        if (input.doctor_name)  results = results.filter((a: any) => a.users?.name?.toLowerCase().includes(input.doctor_name.toLowerCase()));
        if (input.service_name) results = results.filter((a: any) => a.services?.name?.toLowerCase().includes(input.service_name.toLowerCase()));
        return JSON.stringify({
          count: results.length,
          returned: Math.min(results.length, limit),
          appointments: results.slice(0, limit).map((a: any) => ({
            id: a.id, date: a.date, time: a.time, status: a.status, source: a.source,
            client: a.clients?.name, client_phone: a.clients?.phone,
            doctor: a.users?.name,
            service: a.services?.name, duration_min: a.services?.duration_min, price: a.services?.price,
          })),
        });
      }
      case "query_clients": {
        const limit = Math.min(25, input.limit || 10);
        let q = sb.from("clients").select("id, name, phone, email, age, birthday, created_at").eq("business_id", businessId);
        if (input.name)  q = q.ilike("name", "%" + input.name + "%");
        if (input.phone) q = q.ilike("phone", "%" + input.phone + "%");
        const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
        if (error) return JSON.stringify({ error: error.message });
        return JSON.stringify({ count: data?.length || 0, clients: data || [] });
      }
      case "get_appointment_details": {
        let aptId = input.appointment_id;
        if (!aptId && input.client_name) {
          const { data: clients } = await sb.from("clients").select("id, name").eq("business_id", businessId).ilike("name", "%" + input.client_name + "%").limit(5);
          if (!clients || clients.length === 0) return JSON.stringify({ error: "No client matched that name." });
          const clientIds = clients.map((c: any) => c.id);
          const today = new Date().toISOString().slice(0, 10);
          const when = input.when || "next";
          let q = sb.from("appointments").select("id").eq("business_id", businessId).in("client_id", clientIds);
          if (when === "next") q = q.gte("date", today).order("date").order("time");
          else if (when === "last") q = q.lt("date", today).order("date", { ascending: false }).order("time", { ascending: false });
          else if (/^\d{4}-\d{2}-\d{2}$/.test(when)) q = q.eq("date", when).order("time");
          const { data: apts } = await q.limit(1);
          if (!apts || apts.length === 0) return JSON.stringify({ error: "No appointment found." });
          aptId = apts[0].id;
        }
        if (!aptId) return JSON.stringify({ error: "Provide appointment_id or client_name." });
        const { data, error } = await sb.from("appointments")
          .select("*, clients(name, phone, email, age, birthday, allergies, chronic_conditions, medications), users:doctor_id(name, specialty), services(name, duration_min, price)")
          .eq("id", aptId).eq("business_id", businessId).maybeSingle();
        if (error) return JSON.stringify({ error: error.message });
        if (!data) return JSON.stringify({ error: "Appointment not found." });
        return JSON.stringify(data).slice(0, 4000);
      }
      case "query_messages": {
        const limit = Math.min(40, input.limit || 15);
        const hoursBack = input.hours_back || 24;
        const since = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
        let q = sb.from("messages").select("id, direction, body, created_at, clients(name, phone)").eq("business_id", businessId).gte("created_at", since);
        const { data, error } = await q.order("created_at", { ascending: false }).limit(200);
        if (error) return JSON.stringify({ error: error.message });
        let results = (data || []) as any[];
        if (input.client_name) results = results.filter((m: any) => m.clients?.name?.toLowerCase().includes(input.client_name.toLowerCase()));
        return JSON.stringify({
          count: results.length, returned: Math.min(results.length, limit),
          messages: results.slice(0, limit).map((m: any) => ({
            from: m.direction === "in" ? (m.clients?.name || m.clients?.phone) : "you",
            direction: m.direction, body: (m.body || "").slice(0, 400), when: m.created_at,
          })),
        });
      }
      case "query_revenue": {
        const period = input.period || "this_week";
        const now = new Date();
        let from: string, to: string;
        const d = (x: Date) => x.toISOString().slice(0, 10);
        const startOfWeek = (x: Date) => { const r = new Date(x); r.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return r; };
        const startOfMonth = (x: Date) => new Date(x.getFullYear(), x.getMonth(), 1);
        switch (period) {
          case "today":      from = d(now); to = d(now); break;
          case "yesterday": { const y = new Date(now); y.setDate(now.getDate() - 1); from = d(y); to = d(y); break; }
          case "this_week":  from = d(startOfWeek(now)); to = d(now); break;
          case "last_week": { const e = new Date(startOfWeek(now)); e.setDate(e.getDate() - 1); const s = new Date(e); s.setDate(e.getDate() - 6); from = d(s); to = d(e); break; }
          case "this_month": from = d(startOfMonth(now)); to = d(now); break;
          case "last_month": { const m = startOfMonth(now); m.setDate(0); const s = new Date(m); s.setDate(1); from = d(s); to = d(m); break; }
          case "last_30_days":  { const s = new Date(now); s.setDate(now.getDate() - 30); from = d(s); to = d(now); break; }
          default: from = d(startOfWeek(now)); to = d(now);
        }
        const { data, error } = await sb.from("appointments")
          .select("date, status, services(name, price), users:doctor_id(name)")
          .eq("business_id", businessId)
          .gte("date", from).lte("date", to);
        if (error) return JSON.stringify({ error: error.message });
        const apts = (data || []) as any[];
        const completed = apts.filter((a: any) => a.status === "completed" || a.status === "confirmed" || a.status === "arrived");
        const totalRevenue = completed.reduce((acc: number, a: any) => acc + (a.services?.price || 0), 0);
        const result: any = { period, from, to, total_appointments: apts.length, completed_appointments: completed.length, total_revenue: totalRevenue, currency: "TND" };
        if (input.group_by === "doctor") {
          const byDoc: Record<string, { count: number; revenue: number }> = {};
          completed.forEach((a: any) => { const k = a.users?.name || "unknown"; byDoc[k] = byDoc[k] || { count: 0, revenue: 0 }; byDoc[k].count++; byDoc[k].revenue += a.services?.price || 0; });
          result.by_doctor = byDoc;
        } else if (input.group_by === "service") {
          const bySvc: Record<string, { count: number; revenue: number }> = {};
          completed.forEach((a: any) => { const k = a.services?.name || "unknown"; bySvc[k] = bySvc[k] || { count: 0, revenue: 0 }; bySvc[k].count++; bySvc[k].revenue += a.services?.price || 0; });
          result.by_service = bySvc;
        } else if (input.group_by === "day") {
          const byDay: Record<string, { count: number; revenue: number }> = {};
          completed.forEach((a: any) => { const k = a.date; byDay[k] = byDay[k] || { count: 0, revenue: 0 }; byDay[k].count++; byDay[k].revenue += a.services?.price || 0; });
          result.by_day = byDay;
        }
        return JSON.stringify(result);
      }
      case "query_services": {
        let q = sb.from("services").select("id, name, duration_min, price").eq("business_id", businessId);
        if (input.name) q = q.ilike("name", "%" + input.name + "%");
        const { data, error } = await q.order("name").limit(50);
        if (error) return JSON.stringify({ error: error.message });
        return JSON.stringify({ count: data?.length || 0, services: data || [] });
      }
      case "query_lab_results": {
        const limit = Math.min(40, input.limit || 15);
        let q = sb.from("lab_samples")
          .select("id, status, collected_at, results_at, clients(name), tests(name)")
          .eq("business_id", businessId);
        if (input.status) q = q.eq("status", input.status);
        const { data, error } = await q.order("collected_at", { ascending: false }).limit(200);
        if (error) return JSON.stringify({ error: error.message });
        let results = (data || []) as any[];
        if (input.client_name) results = results.filter((r: any) => r.clients?.name?.toLowerCase().includes(input.client_name.toLowerCase()));
        return JSON.stringify({
          count: results.length, returned: Math.min(results.length, limit),
          samples: results.slice(0, limit).map((r: any) => ({ id: r.id, status: r.status, collected_at: r.collected_at, results_at: r.results_at, client: r.clients?.name, test: r.tests?.name })),
        });
      }
      default:
        return JSON.stringify({ error: "Unknown tool: " + name });
    }
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}

async function buildSnapshot(sb: any, businessId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [biz, todayApts, weekApts, clientsCount, recentNotifs, services] = await Promise.all([
    sb.from("businesses").select("name, type").eq("id", businessId).maybeSingle(),
    sb.from("appointments").select("date, time, status, clients(name), services(name), users:doctor_id(name)")
      .eq("business_id", businessId).eq("date", today).order("time"),
    sb.from("appointments").select("*", { count: "exact", head: true })
      .eq("business_id", businessId).gte("created_at", sevenDaysAgo).neq("status", "cancelled"),
    sb.from("clients").select("*", { count: "exact", head: true }).eq("business_id", businessId),
    sb.from("notifications").select("type, title, message, created_at")
      .eq("business_id", businessId).order("created_at", { ascending: false }).limit(6),
    sb.from("services").select("name, duration_min, price").eq("business_id", businessId).limit(15),
  ]);

  return {
    business: biz.data,
    today_date: today,
    today_appointments: (todayApts.data || []).map((a: any) => ({
      time: a.time, status: a.status, client: a.clients?.name, doctor: a.users?.name, service: a.services?.name,
    })),
    bookings_last_7_days: weekApts.count || 0,
    clients_total: clientsCount.count || 0,
    recent_activity: (recentNotifs.data || []).map((n: any) => ({
      type: n.type, title: n.title, message: n.message?.slice(0, 160), when: n.created_at,
    })),
    services: (services.data || []).map((s: any) => ({ name: s.name, duration_min: s.duration_min, price: s.price })),
  };
}

async function callClaude(messages: any[]) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("Anthropic " + r.status + ": " + t.slice(0, 300));
  }
  return await r.json();
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
    const snapshot = await buildSnapshot(sb, business_id);

    if (!ANTHROPIC_KEY) {
      return new Response(JSON.stringify({
        ok: true,
        answer: "I'm offline right now - the ANTHROPIC_API_KEY isn't set on the server.",
      }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    const hasArabicScript = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/.test(transcript);
    const detectedLang = hasArabicScript ? "ar" : (lang && lang !== "auto" ? lang : null);
    const langHint = detectedLang
      ? "The owner appears to be speaking in " + (detectedLang === "ar" ? "Tunisian Arabic (darija)" : detectedLang === "fr" ? "French" : "English") + " (locale " + (sr_locale || "unknown") + "). Reply in that language."
      : "Locale of the speech-recognition engine was " + (sr_locale || "unknown") + ". Auto-detect from the transcript and reply in the same language.";

    const userPrompt = "Owner asked: \"" + transcript + "\"\n\n" + langHint + "\n\nInitial business snapshot (call tools when you need more):\n" + JSON.stringify(snapshot, null, 2) + "\n\nAnswer the owner conversationally, in EXACTLY the language they used.";

    const messages: any[] = [{ role: "user", content: userPrompt }];
    const toolTrace: any[] = [];
    let answer = "";

    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      const j = await callClaude(messages);
      messages.push({ role: "assistant", content: j.content });

      if (j.stop_reason === "tool_use") {
        const toolResults: any[] = [];
        for (const block of j.content) {
          if (block.type === "tool_use") {
            const out = await executeTool(block.name, block.input, business_id, sb);
            toolTrace.push({ tool: block.name, input: block.input, output_size: out.length });
            const capped = out.length > 3500 ? out.slice(0, 3500) + "...(truncated)" : out;
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: capped });
          }
        }
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      answer = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
      break;
    }

    if (!answer) {
      answer = "[LANG=en]\nI couldn't pull that one together - try asking in a slightly different way.";
    }

    return new Response(JSON.stringify({ ok: true, answer, snapshot, tool_trace: toolTrace }),
      { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
