// supabase/functions/voice-avatar/index.ts
// VOICE AVATARS via ElevenLabs
// ================================================================
// Modes:
//   { mode: 'clone',  business_id, sample_b64, sample_mime, name? }
//     → creates a cloned voice on ElevenLabs from a 30-second sample
//   { mode: 'tts',    business_id, text, message_id? }
//     → generates speech with the cloned voice, uploads to Supabase
//       storage, returns a public URL (and optionally writes it onto
//       the messages row if message_id is given)
//   { mode: 'delete', business_id }
//     → removes the cloned voice from ElevenLabs and clears the row
//   { mode: 'preview', business_id, text }
//     → like 'tts' but doesn't write to messages — for the dashboard
//       'Test voice' button
//
// Secrets needed: ELEVENLABS_API_KEY
// Storage bucket: 'voice-replies' (auto-created if missing)
//
// Deploy: supabase functions deploy voice-avatar --no-verify-jwt

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const EL_KEY       = Deno.env.get("ELEVENLABS_API_KEY") || "";
const EL_MODEL     = Deno.env.get("ELEVENLABS_MODEL") || "eleven_multilingual_v2";
const BUCKET       = "voice-replies";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^;]+;base64,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function ensureBucket(sb: any) {
  // Idempotent: try to create, ignore "already exists"
  try { await sb.storage.createBucket(BUCKET, { public: true, fileSizeLimit: "10MB" }); }
  catch (_e) { /* exists */ }
}

// ============================================================================
// CLONE — upload the sample to ElevenLabs and store the voice_id
// ============================================================================
async function clone(sb: any, body: any) {
  if (!EL_KEY) throw new Error("ELEVENLABS_API_KEY not set on the edge function");
  if (!body.business_id || !body.sample_b64) throw new Error("business_id and sample_b64 required");

  await ensureBucket(sb);
  const bytes = b64ToBytes(body.sample_b64);
  const mime = body.sample_mime || "audio/webm";
  const ext = mime.includes("mp3") ? "mp3" : mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : "webm";

  // Mark as training immediately so the dashboard reflects state
  await sb.from("businesses").update({ voice_clone_status: "training" }).eq("id", body.business_id);

  // Archive the raw sample in our own storage so we can re-clone later if needed
  const samplePath = `${body.business_id}/sample-${Date.now()}.${ext}`;
  await sb.storage.from(BUCKET).upload(samplePath, bytes, { contentType: mime, upsert: true });

  // POST multipart/form-data to ElevenLabs voice/add
  const form = new FormData();
  form.append("name", body.name || `Nova clone — ${body.business_id.slice(0, 8)}`);
  form.append("description", "Nova AI cloned receptionist voice");
  form.append("files", new Blob([bytes], { type: mime }), `sample.${ext}`);

  const elRes = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": EL_KEY },
    body: form,
  });
  const elJson = await elRes.json();
  if (!elRes.ok || !elJson.voice_id) {
    await sb.from("businesses").update({ voice_clone_status: "failed" }).eq("id", body.business_id);
    // Friendlier messages for the common gotchas
    const detail = elJson?.detail?.message || elJson?.detail || JSON.stringify(elJson).slice(0,300);
    if (elRes.status === 401) {
      throw new Error(`ElevenLabs API key is invalid or missing. In Supabase, run: supabase secrets set ELEVENLABS_API_KEY=sk_... — then redeploy the function. (Voice cloning requires the paid Creator plan or higher.)`);
    }
    if (elRes.status === 403 || /can_use_instant_voice_cloning/i.test(detail)) {
      throw new Error(`ElevenLabs free plan doesn't include voice cloning. Upgrade to the Creator plan ($22/mo) at elevenlabs.io/subscription, then try again.`);
    }
    if (elRes.status === 422) {
      throw new Error(`ElevenLabs rejected the audio: ${detail}. Try a longer / cleaner recording (at least 30 seconds, no music or other voices).`);
    }
    throw new Error(`ElevenLabs ${elRes.status}: ${detail}`);
  }

  await sb.from("businesses").update({
    voice_clone_id:         elJson.voice_id,
    voice_clone_name:       body.name || elJson.requires_verification === false ? null : null,
    voice_clone_status:     "ready",
    voice_sample_path:      samplePath,
    voice_clone_created_at: new Date().toISOString(),
  }).eq("id", body.business_id);

  return { voice_id: elJson.voice_id, status: "ready", sample_path: samplePath };
}

// ============================================================================
// TTS — generate audio for a given text using the cloned voice
// ============================================================================
async function tts(sb: any, body: any, opts: { writeToMessage?: boolean } = {}) {
  if (!EL_KEY) throw new Error("ELEVENLABS_API_KEY not set");
  if (!body.business_id || !body.text) throw new Error("business_id and text required");

  const { data: biz } = await sb.from("businesses")
    .select("voice_clone_id, voice_clone_status, voice_enabled, voice_settings")
    .eq("id", body.business_id).maybeSingle();
  if (!biz?.voice_clone_id || biz.voice_clone_status !== "ready") {
    throw new Error("No ready voice clone for this business");
  }

  await ensureBucket(sb);

  const settings = biz.voice_settings || { stability: 0.45, similarity_boost: 0.85, style: 0.2, speaker_boost: true };

  const elRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${biz.voice_clone_id}`, {
    method: "POST",
    headers: {
      "xi-api-key": EL_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg",
    },
    body: JSON.stringify({
      text: body.text.slice(0, 2000),
      model_id: EL_MODEL,
      voice_settings: {
        stability:        settings.stability,
        similarity_boost: settings.similarity_boost,
        style:            settings.style,
        use_speaker_boost: settings.speaker_boost ?? true,
      },
    }),
  });
  if (!elRes.ok) {
    const t = await elRes.text();
    throw new Error(`ElevenLabs TTS ${elRes.status}: ${t.slice(0, 300)}`);
  }
  const audio = new Uint8Array(await elRes.arrayBuffer());

  const path = `${body.business_id}/replies/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.mp3`;
  await sb.storage.from(BUCKET).upload(path, audio, { contentType: "audio/mpeg", upsert: false });
  const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
  const url = pub?.publicUrl || "";

  if (opts.writeToMessage && body.message_id) {
    await sb.from("messages").update({
      tts_audio_path: path,
      tts_voice_id:   biz.voice_clone_id,
    }).eq("id", body.message_id);
  }

  return { url, path, voice_id: biz.voice_clone_id, bytes: audio.length };
}

// ============================================================================
// DELETE
// ============================================================================
async function deleteClone(sb: any, businessId: string) {
  const { data: biz } = await sb.from("businesses").select("voice_clone_id").eq("id", businessId).maybeSingle();
  if (biz?.voice_clone_id && EL_KEY) {
    try {
      await fetch(`https://api.elevenlabs.io/v1/voices/${biz.voice_clone_id}`, {
        method: "DELETE",
        headers: { "xi-api-key": EL_KEY },
      });
    } catch (_e) { /* best-effort */ }
  }
  await sb.from("businesses").update({
    voice_clone_id: null,
    voice_clone_status: "none",
    voice_clone_name: null,
    voice_enabled: false,
    voice_sample_path: null,
    voice_clone_created_at: null,
  }).eq("id", businessId);
  return { ok: true };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    if (body.mode === "clone") {
      const r = await clone(sb, body);
      return new Response(JSON.stringify({ ok: true, ...r }),
        { headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (body.mode === "tts") {
      const r = await tts(sb, body, { writeToMessage: true });
      return new Response(JSON.stringify({ ok: true, ...r }),
        { headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (body.mode === "preview") {
      const r = await tts(sb, body, { writeToMessage: false });
      return new Response(JSON.stringify({ ok: true, ...r }),
        { headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (body.mode === "delete") {
      const r = await deleteClone(sb, body.business_id);
      return new Response(JSON.stringify(r),
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
