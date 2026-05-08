// supabase/functions/nova-tts/index.ts
// NOVA TTS — single consistent male voice across English, French, and Arabic.
// ============================================================================
// Body: { text: string, lang?: 'en'|'fr'|'ar' }
// Returns: audio/mpeg (raw mp3 bytes) on success, or JSON {error, code} otherwise.
//
// Uses OpenAI's tts-1 with the 'onyx' voice — a deep male voice that handles
// all three languages with the same character. The dashboard plays the mp3
// via an <audio> element instead of the browser's SpeechSynthesis API, so
// the voice is identical regardless of language.
//
// Falls back: if OPENAI_API_KEY is not set, returns 503. The dashboard then
// uses browser TTS as a fallback so Nova stays usable on day one.
//
// Deploy: supabase functions deploy nova-tts --no-verify-jwt
// Secret: OPENAI_API_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const MODEL = Deno.env.get("NOVA_TTS_MODEL") || "tts-1";   // or "tts-1-hd" for higher quality (slower, 2x cost)
const VOICE = Deno.env.get("NOVA_TTS_VOICE") || "onyx";    // onyx = deep male; alloy/echo/fable also male; nova/shimmer female

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { text, lang } = await req.json();
    if (!text || typeof text !== "string") {
      return new Response(JSON.stringify({ error: "text required", code: "BAD_REQUEST" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (!OPENAI_KEY) {
      // Tell the dashboard cleanly so it can fall back to browser TTS without
      // surfacing an alarming error to the user.
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY not configured", code: "NO_KEY" }),
        { status: 503, headers: { ...cors, "Content-Type": "application/json" } });
    }

    // Light text guard: clamp to 2000 chars (way more than we'd ever speak).
    const safeText = text.slice(0, 2000);

    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        voice: VOICE,
        input: safeText,
        response_format: "mp3",
        speed: lang === "ar" ? 0.95 : 1.0,  // Arabic reads slightly slower for clarity
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error("[nova-tts] OpenAI error", r.status, errText.slice(0, 300));
      return new Response(JSON.stringify({ error: `OpenAI ${r.status}`, code: "UPSTREAM" }),
        { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const audio = await r.arrayBuffer();
    return new Response(audio, {
      status: 200,
      headers: {
        ...cors,
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "X-Nova-Voice": VOICE,
        "X-Nova-Model": MODEL,
      },
    });
  } catch (err) {
    console.error("[nova-tts] failure", err);
    return new Response(JSON.stringify({ error: (err as Error).message, code: "INTERNAL" }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
