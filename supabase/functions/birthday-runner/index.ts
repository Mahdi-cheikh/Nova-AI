// supabase/functions/birthday-runner/index.ts
// AI BIRTHDAY SURPRISE
// ================================================================
// Daily cron: scans every business with birthday_config.enabled=true,
// finds clients whose birthday matches today (any year), mints a unique
// voucher code, and sends a personalised WhatsApp.
//
// Modes:
//   { mode: 'run_all' }                                       — cron job
//   { mode: 'run', business_id }                              — owner test
//   { mode: 'send_test', business_id, client_id }             — preview to one
//
// Deploy: supabase functions deploy birthday-runner --no-verify-jwt

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WA_PHONE_ID  = Deno.env.get("WA_PHONE_ID") || "";
const WA_TOKEN     = Deno.env.get("WA_ACCESS_TOKEN") || "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Generate a friendly 6-char voucher code: easy to type, no ambiguous chars
function generateCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function sendWhatsApp(phone: string, body: string): Promise<boolean> {
  if (!WA_PHONE_ID || !WA_TOKEN || !phone) return false;
  const to = phone.replace(/^\+/, "");
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", recipient_type: "individual", to,
        type: "text", text: { body: body.slice(0, 4096) },
      }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Build the message — uses the owner's template if provided, otherwise a sensible default.
// Placeholders: {name}, {business}, {voucher_label}, {voucher_code}, {valid_until}.
function composeMessage(
  template: string | null | undefined,
  ctx: { name: string; business: string; voucher_label: string; voucher_code: string; valid_until: string; lang: string },
): string {
  if (template && template.trim()) {
    return template
      .replaceAll("{name}", ctx.name)
      .replaceAll("{business}", ctx.business)
      .replaceAll("{voucher_label}", ctx.voucher_label)
      .replaceAll("{voucher_code}", ctx.voucher_code)
      .replaceAll("{valid_until}", ctx.valid_until);
  }
  // Default per-language templates
  if (ctx.lang === "fr") {
    return `Joyeux anniversaire ${ctx.name} ! 🎂\n\nL'équipe de ${ctx.business} vous offre un cadeau : ${ctx.voucher_label}.\n\nVotre code : *${ctx.voucher_code}*\nValable jusqu'au ${ctx.valid_until}. Présentez ce code à votre prochaine visite.\n\nÀ très bientôt !`;
  }
  if (ctx.lang === "ar") {
    return `كل عام وأنت بخير ${ctx.name} 🎂\n\nفريق ${ctx.business} يقدم لك هدية: ${ctx.voucher_label}.\n\nرمزك: *${ctx.voucher_code}*\nصالح حتى ${ctx.valid_until}. أبرز الرمز عند زيارتك القادمة.\n\nنراك قريبا!`;
  }
  return `Happy birthday, ${ctx.name}! 🎂\n\nThe team at ${ctx.business} got you something: ${ctx.voucher_label}.\n\nYour code: *${ctx.voucher_code}*\nValid until ${ctx.valid_until}. Show this code at your next visit.\n\nSee you soon!`;
}

async function runForBusiness(sb: any, businessId: string, opts: { force?: boolean; only_client_id?: string } = {}) {
  const { data: biz } = await sb.from("businesses").select("id, name, birthday_config").eq("id", businessId).maybeSingle();
  if (!biz) return { ok: false, error: "business not found" };

  const cfg = biz.birthday_config || {};
  if (!cfg.enabled && !opts.force) {
    return { ok: true, sent: 0, note: "disabled" };
  }
  const validityDays = parseInt(cfg.validity_days || "30", 10) || 30;
  const voucherLabel = cfg.voucher_label || "Free birthday gift";

  // Today (server local) — month/day match
  const now = new Date();
  const m = now.getUTCMonth() + 1;
  const d = now.getUTCDate();

  // Find candidates
  let q = sb.from("clients")
    .select("id, name, phone, birthday, profile, language:birthday_message_lang")
    .eq("business_id", businessId)
    .not("birthday", "is", null);
  if (opts.only_client_id) q = q.eq("id", opts.only_client_id);
  const { data: clients = [] } = await q;

  const matches = (clients as any[]).filter((c) => {
    if (!c.birthday) return false;
    const bd = new Date(c.birthday + "T00:00:00Z");
    return (bd.getUTCMonth() + 1) === m && bd.getUTCDate() === d;
  });

  if (matches.length === 0) {
    return { ok: true, sent: 0, candidates: 0 };
  }

  let sent = 0;
  for (const c of matches) {
    if (!c.phone) continue;

    // Don't double-send: skip if we already issued a voucher to this client this calendar year
    const yearStart = `${now.getUTCFullYear()}-01-01`;
    const { data: existing } = await sb
      .from("birthday_vouchers")
      .select("id")
      .eq("business_id", businessId)
      .eq("client_id", c.id)
      .gte("issued_at", yearStart)
      .maybeSingle();
    if (existing && !opts.force) continue;

    // Mint a unique code (retry up to 5 times if collision)
    let code = "";
    for (let i = 0; i < 5; i++) {
      code = generateCode();
      const { data: clash } = await sb.from("birthday_vouchers").select("id").eq("code", code).maybeSingle();
      if (!clash) break;
      code = "";
    }
    if (!code) continue;

    const expiresAt = new Date(now.getTime() + validityDays * 86400_000);
    const validUntil = expiresAt.toISOString().slice(0, 10);

    const lang = c.language || c.profile?.language || "en";
    const firstName = (c.name || "").split(" ")[0] || c.name || "";
    const message = composeMessage(cfg.message_template, {
      name: firstName,
      business: biz.name || "",
      voucher_label: voucherLabel,
      voucher_code: code,
      valid_until: validUntil,
      lang,
    });

    // Insert voucher first so a webhook redemption attempt mid-send still finds the row
    const { error: insErr } = await sb.from("birthday_vouchers").insert({
      business_id: businessId,
      client_id: c.id,
      code,
      label: voucherLabel,
      value_amount: cfg.voucher_value || 0,
      expires_at: expiresAt.toISOString(),
    });
    if (insErr) { console.error("voucher insert failed:", insErr); continue; }

    const ok = await sendWhatsApp(c.phone, message);
    if (ok) {
      sent++;
      await sb.from("messages").insert({
        business_id: businessId,
        client_id: c.id,
        direction: "out",
        channel: "whatsapp",
        text: message,
        intent: "birthday_voucher",
      });
      await sb.from("notifications").insert({
        business_id: businessId,
        type: "info",
        title: "Birthday voucher sent",
        message: `Sent ${voucherLabel} to ${c.name} (code ${code}). Expires ${validUntil}.`,
      });
    }
  }

  return { ok: true, candidates: matches.length, sent };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    if (body.mode === "run_all") {
      const { data: bizs = [] } = await sb.from("businesses").select("id, birthday_config");
      const out: any[] = [];
      for (const b of bizs) {
        if (!b.birthday_config?.enabled) continue;
        try { out.push({ business_id: b.id, ...(await runForBusiness(sb, b.id)) }); }
        catch (e) { console.error(e); }
      }
      return new Response(JSON.stringify({ ok: true, scanned: out.length, results: out }),
        { headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (body.mode === "run") {
      if (!body.business_id) return new Response(JSON.stringify({ error: "business_id required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      const r = await runForBusiness(sb, body.business_id, { force: !!body.force });
      return new Response(JSON.stringify(r), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (body.mode === "send_test") {
      if (!body.business_id || !body.client_id) {
        return new Response(JSON.stringify({ error: "business_id and client_id required" }),
          { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
      }
      const r = await runForBusiness(sb, body.business_id, { force: true, only_client_id: body.client_id });
      return new Response(JSON.stringify(r), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "unknown mode" }),
      { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
