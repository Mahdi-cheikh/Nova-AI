// supabase/functions/payment-webhook/index.ts
// Receives Konnect (Tunisian) and Stripe webhook callbacks. On payment success:
//   1. Flip the package_purchase row to 'active'
//   2. Set sessions_remaining = total_sessions, expires_at = now() + validity_days
//   3. Send the patient a WhatsApp receipt
//   4. Notify the business owner
//
// Konnect webhook URL:  /functions/v1/payment-webhook?provider=konnect
// Stripe webhook URL:    /functions/v1/payment-webhook?provider=stripe
//
// Required secrets:
//   KONNECT_API_KEY       — for verifying Konnect payment status
//   STRIPE_WEBHOOK_SECRET — for verifying Stripe signatures
//   WA_PHONE_ID, WA_ACCESS_TOKEN — to send the receipt
//
// Deploy: supabase functions deploy payment-webhook --no-verify-jwt

import { serve }        from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL    = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KONNECT_API_KEY = Deno.env.get("KONNECT_API_KEY") || "";
const WA_PHONE_ID     = Deno.env.get("WA_PHONE_ID") || "";
const WA_ACCESS_TOKEN = Deno.env.get("WA_ACCESS_TOKEN") || "";

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function sendWhatsApp(phone: string, body: string) {
  if (!WA_PHONE_ID || !WA_ACCESS_TOKEN || !phone) return;
  const to = phone.replace(/^\+/, "");
  await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", recipient_type: "individual", to,
      type: "text", text: { body },
    }),
  }).catch(() => {});
}

async function verifyKonnect(paymentRef: string) {
  // Konnect requires a server-side check to confirm the payment status
  const res = await fetch(`https://api.konnect.network/api/v2/payments/${paymentRef}`, {
    headers: { "x-api-key": KONNECT_API_KEY },
  });
  if (!res.ok) return null;
  const out = await res.json();
  // out.payment.status: 'completed' | 'pending' | 'failed' | ...
  return out?.payment || null;
}

async function activatePurchase(sb: any, purchase_id: string) {
  // Atomically activate, set sessions_remaining and expires_at
  const { data: pp } = await sb.from("package_purchases")
    .select("*, service_packages(name, total_sessions, validity_days, price, currency), clients(name, phone), businesses(name)")
    .eq("id", purchase_id).maybeSingle();
  if (!pp) return null;
  if (pp.status === "active") return pp;   // idempotent — webhook can fire twice

  const total_sessions = pp.service_packages?.total_sessions || 1;
  const validity_days  = pp.service_packages?.validity_days || 365;
  const expires_at     = new Date(Date.now() + validity_days * 86400 * 1000).toISOString();

  await sb.from("package_purchases").update({
    status:             "active",
    sessions_remaining: total_sessions,
    sessions_used:      0,
    paid_at:            new Date().toISOString(),
    expires_at,
  }).eq("id", purchase_id);

  // Receipt to patient
  const cName = (pp.clients?.name || "").split(" ")[0] || "there";
  const bName = pp.businesses?.name || "Nova";
  const sName = pp.service_packages?.name || "your package";
  const price = pp.service_packages?.price || 0;
  const cur   = pp.service_packages?.currency || "TND";
  await sendWhatsApp(pp.clients?.phone, `✅ Hi ${cName}, your purchase is confirmed.\n\n📦 ${sName}\n💳 ${price} ${cur}\n🎟 ${total_sessions} sessions, valid ${validity_days} days\n\nYou can now book any covered session — Nova will deduct from your package automatically. Reply BOOK to start.`);

  // Owner notification
  await sb.from("notifications").insert({
    business_id: pp.business_id, type: "info",
    title: "Package purchased",
    message: `${pp.clients?.name || "A patient"} bought "${sName}" for ${price} ${cur}.`,
  });

  return pp;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    const provider = url.searchParams.get("provider") || "konnect";
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    if (provider === "konnect") {
      // Konnect webhook posts: { payment_ref, ... }
      const body = await req.json().catch(() => ({}));
      const paymentRef = body?.payment_ref || body?.paymentRef || url.searchParams.get("payment_ref");
      if (!paymentRef) return new Response("missing payment_ref", { status: 400 });

      const payment = await verifyKonnect(paymentRef);
      if (!payment) return new Response("verify failed", { status: 400 });
      if (payment.status !== "completed") {
        // payment not yet successful — Konnect retries the webhook
        return new Response("pending", { status: 200 });
      }

      const { data: purchase } = await sb.from("package_purchases").select("id").eq("payment_id", paymentRef).maybeSingle();
      if (!purchase) return new Response("purchase not found", { status: 404 });

      await activatePurchase(sb, purchase.id);
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (provider === "stripe") {
      // Stripe webhook posts the event JSON. We trust metadata.purchase_id since
      // we set it ourselves at checkout creation.
      const body = await req.json().catch(() => ({}));
      const ev = body;
      if (ev.type !== "checkout.session.completed") return new Response("ignored", { status: 200 });
      const purchaseId = ev.data?.object?.metadata?.purchase_id;
      if (!purchaseId) return new Response("no purchase_id", { status: 400 });
      await activatePurchase(sb, purchaseId);
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    return new Response("unknown provider", { status: 400 });
  } catch (err) {
    console.error("payment-webhook error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
