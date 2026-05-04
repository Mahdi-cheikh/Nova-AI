// supabase/functions/pwa-verify-otp/index.ts
// Verifies the 6-digit code the patient typed. On success: sets the patient's
// phone + phone_verified=true, which fires the auto-link trigger that maps
// every existing clients row with the same phone to this patient_user.
//
// Body: { patient_user_id, phone, code }
// Returns: { ok: true } | { error: '...' }

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function sha256(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,'0')).join('');
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { patient_user_id, phone, code } = await req.json();
    if (!patient_user_id || !phone || !code) {
      return new Response(JSON.stringify({ error: "patient_user_id, phone, and code required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: otp } = await sb.from("patient_phone_otps")
      .select("*").eq("patient_user_id", patient_user_id).maybeSingle();

    if (!otp) {
      return new Response(JSON.stringify({ error: "No pending verification — request a new code" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (new Date(otp.expires_at) < new Date()) {
      await sb.from("patient_phone_otps").delete().eq("patient_user_id", patient_user_id);
      return new Response(JSON.stringify({ error: "Code expired — request a new one" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (otp.attempts >= 5) {
      await sb.from("patient_phone_otps").delete().eq("patient_user_id", patient_user_id);
      return new Response(JSON.stringify({ error: "Too many attempts — request a new code" }), {
        status: 429, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (otp.phone !== phone) {
      return new Response(JSON.stringify({ error: "Phone mismatch — start verification again" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const expectedHash = await sha256(String(code) + phone);
    if (expectedHash !== otp.code_hash) {
      await sb.from("patient_phone_otps").update({ attempts: (otp.attempts || 0) + 1 })
        .eq("patient_user_id", patient_user_id);
      return new Response(JSON.stringify({ error: "Wrong code" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Success — claim the phone (this fires the link-clients trigger).
    const { error: rpcErr } = await sb.rpc("pwa_claim_phone", { p_patient_user_id: patient_user_id, p_phone: phone });
    if (rpcErr) {
      return new Response(JSON.stringify({ error: rpcErr.message }), {
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
