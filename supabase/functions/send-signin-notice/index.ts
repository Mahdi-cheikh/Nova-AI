// supabase/functions/send-signin-notice/index.ts
// Called from the frontend right after a Google OAuth sign-in completes.
// Sends a "Welcome back" email with a "Continue to dashboard" button via Resend.
//
// Required secrets (set with `supabase secrets set ...`):
//   RESEND_API_KEY    — get from resend.com → API Keys
//   FROM_EMAIL        — e.g. "Nova AI <noreply@yourdomain.com>" (or "Nova AI <onboarding@resend.dev>" for testing)
//   APP_URL           — e.g. "https://nova-ai-s8i6.vercel.app"
//
// Deploy:   supabase functions deploy send-signin-notice --no-verify-jwt

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM_EMAIL     = Deno.env.get("FROM_EMAIL") || "Nova AI <onboarding@resend.dev>";
const APP_URL        = Deno.env.get("APP_URL") || "https://nova-ai-s8i6.vercel.app";

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function buildHtml(opts: { name: string; businessName: string; dashboardUrl: string; provider: string; when: string }) {
  const { name, businessName, dashboardUrl, provider, when } = opts;
  const greet = name ? `Welcome back, ${name}` : "Welcome back";
  const bizLine = businessName ? `<div style="margin-top:6px;font-size:14px;color:#9ca3af">Signed in as <b style="color:#cbd5e1">${businessName}</b></div>` : "";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0b10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e5e7eb">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#0a0b10;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:#13151c;border-radius:18px;overflow:hidden;border:1px solid rgba(99,102,241,0.15)">

<tr><td style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 50%,#22d3ee 100%);padding:36px 32px 30px;text-align:center">
<div style="display:inline-block;background:rgba(255,255,255,0.18);width:64px;height:64px;border-radius:16px;line-height:64px;color:#ffffff;font-size:30px;font-weight:800;border:1px solid rgba(255,255,255,0.25)">N</div>
<div style="margin-top:14px;font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.5px">Nova AI</div>
<div style="margin-top:6px;font-size:13px;color:rgba(255,255,255,0.85);text-transform:uppercase;font-weight:500;letter-spacing:0.3px">Sign-in confirmed</div>
</td></tr>

<tr><td style="padding:32px 32px 8px">
<h1 style="margin:0 0 14px;font-size:22px;font-weight:700;color:#f9fafb;letter-spacing:-0.4px">${greet} 👋</h1>
<p style="margin:0 0 6px;font-size:15px;line-height:1.65;color:#d1d5db">You just signed in to your Nova AI dashboard with <b style="color:#e5e7eb">${provider === 'google' ? 'Google' : provider}</b>.</p>
<p style="margin:0 0 16px;font-size:13px;color:#9ca3af">${when}${bizLine ? '' : ''}</p>
${bizLine}
</td></tr>

<tr><td align="center" style="padding:18px 32px 24px">
<table role="presentation" cellspacing="0" cellpadding="0" border="0">
<tr><td style="border-radius:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);box-shadow:0 4px 16px rgba(99,102,241,0.35)">
<a href="${dashboardUrl}" style="display:inline-block;padding:14px 36px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;letter-spacing:0.3px">Continue to dashboard →</a>
</td></tr>
</table>
</td></tr>

<tr><td style="padding:0 32px 28px">
<div style="background:rgba(239,68,68,0.08);border-left:3px solid #ef4444;padding:14px 16px;border-radius:8px;font-size:12.5px;line-height:1.6;color:#cbd5e1">
<b style="color:#fecaca">🛡 Wasn't you?</b><br>
If you didn't sign in just now, your account may be at risk. Sign out from all devices in <b>Settings → Security</b> and contact us immediately.
</div>
</td></tr>
</table>

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;margin-top:16px">
<tr><td align="center" style="padding:8px 16px;font-size:12px;color:#6b7280;line-height:1.65">
<div style="font-size:12.5px;color:#9ca3af;font-weight:500">Nova AI</div>
<div style="margin-top:3px">24/7 multilingual receptionist for appointment-driven businesses</div>
<div style="margin-top:14px;padding-top:14px;border-top:1px solid #1f2230;font-size:11.5px">
Designed and built by <b style="color:#a5b4fc">Mehdi Cheikh</b><br>
<span style="color:#4b5563">© ${new Date().getFullYear()} · All rights reserved</span>
</div>
</td></tr>
</table>

</td></tr>
</table>
</body></html>`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { email, name, provider, business_name } = await req.json();
    if (!email) {
      return new Response(JSON.stringify({ error: "email required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (!RESEND_API_KEY) {
      return new Response(JSON.stringify({ skipped: "RESEND_API_KEY not configured" }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const when = new Date().toUTCString();
    const html = buildHtml({
      name: name || "",
      businessName: business_name || "",
      dashboardUrl: APP_URL + "/#/dashboard",
      provider: provider || "Google",
      when,
    });

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        from:    FROM_EMAIL,
        to:      email,
        subject: "👋 Welcome back to Nova AI",
        html,
      }),
    });
    const out = await res.json();
    if (!res.ok) {
      console.error("Resend error:", out);
      return new Response(JSON.stringify({ error: out }), {
        status: res.status, headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true, id: out.id }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
