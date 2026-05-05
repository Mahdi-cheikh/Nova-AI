// supabase/functions/pwa-send-otp/index.ts
// Called by the PWA during patient onboarding. Generates a 6-digit code,
// stores its bcrypt-style SHA-256 hash with a 10-minute expiry, and sends
// it to the patient's phone via Meta WhatsApp Cloud API.
//
// Body: { patient_user_id, phone }
// Returns: { ok: true } or { error: '...' }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WA_PHONE_ID = Deno.env.get("WA_PHONE_ID") || "";
const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN") || "";

const cors = {
 "Access-Control-Allow-Origin": "*",
 "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
 "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function sha256(s: string): Promise<string> {
 const buf = new TextEncoder().encode(s);
 const digest = await crypto.subtle.digest("SHA-256", buf);
 return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
 if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
 try {
 const { patient_user_id, phone } = await req.json();
 if (!patient_user_id || !phone) {
 return new Response(JSON.stringify({ error: "patient_user_id and phone required" }), {
 status: 400, headers: { ...cors, "Content-Type": "application/json" },
 });
 }
 if (!/^\+\d{8,15}$/.test(phone)) {
 return new Response(JSON.stringify({ error: "phone must be E.164 format (e.g. +21629774784)" }), {
 status: 400, headers: { ...cors, "Content-Type": "application/json" },
 });
 }
 if (!WA_PHONE_ID || !WA_ACCESS_TOKEN) {
 return new Response(JSON.stringify({ error: "WhatsApp not configured" }), {
 status: 500, headers: { ...cors, "Content-Type": "application/json" },
 });
 }

 // Generate 6-digit code
 const code = String(Math.floor(100000 + Math.random() * 900000));
 const code_hash = await sha256(code + phone);
 const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();

 const sb = createClient(SUPABASE_URL, SERVICE_KEY);
 await sb.from("patient_phone_otps").upsert({
 patient_user_id, phone, code_hash, expires_at, attempts: 0,
 }, { onConflict: "patient_user_id" });

 // Send via Meta WhatsApp
 const to = phone.replace(/^\+/, "");
 const waRes = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
 method: "POST",
 headers: { "Authorization": `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
 body: JSON.stringify({
 messaging_product: "whatsapp", recipient_type: "individual", to,
 type: "text",
 text: { body: ` Your Nova verification code is: ${code}\n\nIt expires in 10 minutes. Don't share it with anyone.` },
 }),
 });
 const waBody = await waRes.json().catch(() => ({}));
 if (!waRes.ok) {
 console.error("WhatsApp send failed:", waBody);
 return new Response(JSON.stringify({ error: "Could not send WhatsApp message", detail: waBody }), {
 status: 500, headers: { ...cors, "Content-Type": "application/json" },
 });
 }

 return new Response(JSON.stringify({ ok: true }), {
 headers: { ...cors, "Content-Type": "application/json" },
 });
 } catch (err) {
 return new Response(JSON.stringify({ error: (err as Error).message }), {
 status: 500, headers: { ...cors, "Content-Type": "application/json" },
 });
 }
});
