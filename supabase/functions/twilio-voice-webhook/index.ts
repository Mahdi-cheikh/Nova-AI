// supabase/functions/twilio-voice-webhook/index.ts
// Twilio calls this when a patient phones the WhatsApp/voice number.
// Two-stage flow:
//   1. Capture 5s of speech, send to OpenAI Whisper for language detection
//   2. Re-prompt with detected-language STT, transcribe, hand to classify-message
//   3. Speak the AI reply back to the caller.
//
// Deploy:   supabase functions deploy twilio-voice-webhook --no-verify-jwt
// Secrets:  supabase secrets set OPENAI_API_KEY=sk-...

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;

serve(async (req) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const form = await req.formData();
  const url = new URL(req.url);
  const stage = url.searchParams.get("stage") ?? "greet";
  const callerNumber = (form.get("From") as string) ?? "";
  const calledNumber = (form.get("To") as string) ?? "";

  // Resolve which business owns this Twilio number
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: biz } = await sb.from("businesses").select("id").eq("phone", calledNumber).maybeSingle();

  // Stage 1: greet + capture in language=auto (Twilio doesn't truly auto-detect; we use Whisper after)
  if (stage === "greet") {
    return twiml(`<Response>
      <Say voice="Polly.Joanna">Hello, you've reached Nova AI. Please tell me how I can help, in Arabic, French, or English.</Say>
      <Record action="${url.origin}${url.pathname}?stage=transcribe" maxLength="20" playBeep="true" trim="trim-silence" recordingStatusCallback=""/>
    </Response>`);
  }

  // Stage 2: Twilio uploaded a recording. Pull it, send to Whisper for transcribe + language detection.
  if (stage === "transcribe") {
    const recordingUrl = form.get("RecordingUrl") as string;
    if (!recordingUrl || !biz) return twiml(`<Response><Say>Sorry, no audio. Goodbye.</Say><Hangup/></Response>`);

    // Twilio recording is binary; download and forward to Whisper
    const audioRes = await fetch(`${recordingUrl}.wav`, { headers: { Accept: "audio/wav" } });
    const audioBuf = new Uint8Array(await audioRes.arrayBuffer());

    const whisperForm = new FormData();
    whisperForm.append("file", new Blob([audioBuf], { type: "audio/wav" }), "speech.wav");
    whisperForm.append("model", "whisper-1");
    whisperForm.append("response_format", "verbose_json");

    const whRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: whisperForm,
    });
    const whJson = await whRes.json();
    const transcript: string = whJson.text ?? "";
    const detected: string = (whJson.language ?? "en").slice(0, 2);

    if (!transcript.trim()) return twiml(`<Response><Say>I didn't catch that. Goodbye.</Say><Hangup/></Response>`);

    // Hand off to classify-message
    const cmRes = await fetch(`${SUPABASE_URL}/functions/v1/classify-message`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        phone: callerNumber, text: transcript, business_id: biz.id,
        channel: "whatsapp_voice", detected_language: detected,
      }),
    });
    const cm = await cmRes.json();
    const reply = cm?.reply ?? "Thanks for calling.";

    // Pick a Twilio voice for the language
    const voice = detected === "fr" ? "Polly.Lea" : detected === "ar" ? "Polly.Zeina" : "Polly.Joanna";
    const lang = detected === "fr" ? "fr-FR" : detected === "ar" ? "arb" : "en-US";
    return twiml(`<Response>
      <Say voice="${voice}" language="${lang}">${escapeXml(reply)}</Say>
      <Hangup/>
    </Response>`);
  }

  return twiml(`<Response><Say>Goodbye.</Say><Hangup/></Response>`);
});

function twiml(body: string) {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/xml" } });
}
function escapeXml(s: string) {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" }[c]!));
}
