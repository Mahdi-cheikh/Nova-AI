// supabase/functions/verify-whatsapp-otp/index.ts
// Verifies the 6-digit code, marks the business as whatsapp_verified.
//
// Deploy: supabase functions deploy verify-whatsapp-otp

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
 "Access-Control-Allow-Origin": "*",
 "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
 "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
 if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
 try {
 const { code, business_id } = await req.json();
 if (!code || !business_id) return err("Missing code or business_id", 400);

 const sb = createClient(SUPABASE_URL, SERVICE_KEY);
 const { data: otp } = await sb.from("whatsapp_otps").select("*").eq("business_id", business_id).maybeSingle();
 if (!otp) return err("No code found — please request a new one", 400);
 if (new Date(otp.expires_at) < new Date()) return err("Code expired — please request a new one", 400);

 const codeHash = await sha256(code);
 if (codeHash !== otp.code_hash) return err("Wrong code", 400);

 await sb.from("businesses").update({ whatsapp_verified: true, whatsapp_verified_at: new Date().toISOString() }).eq("id", business_id);
 await sb.from("whatsapp_otps").delete().eq("business_id", business_id);

 return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, "Content-Type": "application/json" } });
 } catch (e) { return err((e as Error).message, 500); }
});

function err(msg: string, status: number) {
 return new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
async function sha256(s: string) {
 const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
 return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
