// supabase/functions/create-package-checkout/index.ts
// Generates a hosted payment URL for a service-package purchase.
// Defaults to Konnect (Tunisian: card + D17 + Flouci, single API),
// falls back to Stripe for international flows.
//
// Body: { business_id, package_id, client_id, provider? }   provider in ('konnect','stripe')
// Returns: { ok: true, payment_url, payment_id, purchase_id }
//
// Required secrets:
//   KONNECT_API_KEY        — get from konnect.network → API Keys
//   KONNECT_WALLET_ID      — your wallet id at Konnect
//   STRIPE_SECRET_KEY      — only if using Stripe fallback
//   APP_URL                — e.g. https://nova-ai-s8i6.vercel.app
//
// Deploy:  supabase functions deploy create-package-checkout --no-verify-jwt

import { serve }        from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY       = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KONNECT_API_KEY   = Deno.env.get("KONNECT_API_KEY") || "";
const KONNECT_WALLET_ID = Deno.env.get("KONNECT_WALLET_ID") || "";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const APP_URL           = Deno.env.get("APP_URL") || "https://nova-ai-s8i6.vercel.app";

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function konnectInit(opts: {
  amount_millimes: number; description: string; first_name: string; last_name: string;
  email: string; phone: string; webhook: string; success_url: string; fail_url: string;
}) {
  const res = await fetch("https://api.konnect.network/api/v2/payments/init-payment", {
    method: "POST",
    headers: { "x-api-key": KONNECT_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      receiverWalletId:   KONNECT_WALLET_ID,
      token:              "TND",
      amount:             opts.amount_millimes,             // Konnect amounts are in millimes (TND × 1000)
      type:               "immediate",
      description:        opts.description.slice(0, 250),
      acceptedPaymentMethods: ["bank_card", "wallet"],      // cards + D17/Flouci wallets
      lifespan:            10,                              // minutes the link stays valid
      checkoutForm:        true,
      addPaymentFeesToAmount: false,
      firstName:           opts.first_name || "Client",
      lastName:            opts.last_name  || "Nova",
      phoneNumber:         opts.phone || "",
      email:               opts.email || "noreply@example.com",
      orderId:             "nova-" + Date.now(),
      webhook:             opts.webhook,
      successUrl:          opts.success_url,
      failUrl:              opts.fail_url,
      theme:                "light",
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Konnect: ${res.status} ${txt}`);
  }
  const out = await res.json();
  // out: { payUrl, paymentRef }
  return { url: out.payUrl, id: out.paymentRef };
}

async function stripeCheckout(opts: {
  amount_cents: number; currency: string; product_name: string; success_url: string; cancel_url: string;
  metadata: Record<string, string>;
}) {
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", opts.success_url);
  params.append("cancel_url",  opts.cancel_url);
  params.append("line_items[0][price_data][currency]",     opts.currency.toLowerCase());
  params.append("line_items[0][price_data][unit_amount]",  String(opts.amount_cents));
  params.append("line_items[0][price_data][product_data][name]", opts.product_name);
  params.append("line_items[0][quantity]",                 "1");
  for (const [k, v] of Object.entries(opts.metadata)) params.append(`metadata[${k}]`, v);

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method:  "POST",
    headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body:    params.toString(),
  });
  if (!res.ok) throw new Error(`Stripe: ${res.status} ${await res.text()}`);
  const out = await res.json();
  return { url: out.url, id: out.id };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { business_id, package_id, client_id, provider = "konnect" } = await req.json();
    if (!business_id || !package_id || !client_id) {
      return new Response(JSON.stringify({ error: "business_id, package_id, client_id required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    const [{ data: pkg }, { data: client }, { data: biz }] = await Promise.all([
      sb.from("service_packages").select("*").eq("id", package_id).maybeSingle(),
      sb.from("clients").select("name, phone, email").eq("id", client_id).maybeSingle(),
      sb.from("businesses").select("name").eq("id", business_id).maybeSingle(),
    ]);
    if (!pkg)    return new Response(JSON.stringify({ error: "package not found" }), { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
    if (!client) return new Response(JSON.stringify({ error: "client not found" }),  { status: 404, headers: { ...cors, "Content-Type": "application/json" } });

    const successUrl = `${APP_URL}/pwa/?package_paid=1&pid=${encodeURIComponent(package_id)}`;
    const failUrl    = `${APP_URL}/pwa/?package_paid=0`;
    const webhookUrl = `${SUPABASE_URL}/functions/v1/payment-webhook?provider=${provider}`;

    // 1. Insert pending purchase row first
    const { data: pending, error: insErr } = await sb.from("package_purchases").insert({
      business_id, client_id, package_id,
      status: "pending",
      sessions_remaining: 0,
      payment_provider:   provider,
    }).select().single();
    if (insErr) throw new Error(insErr.message);

    // 2. Generate the hosted payment URL
    let url = "", id = "";
    if (provider === "konnect") {
      if (!KONNECT_API_KEY || !KONNECT_WALLET_ID) {
        return new Response(JSON.stringify({ error: "Konnect not configured (KONNECT_API_KEY / KONNECT_WALLET_ID secrets missing)" }), {
          status: 500, headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      const millimes = Math.round(Number(pkg.price) * 1000);
      const nameParts = (client.name || "").trim().split(/\s+/);
      const r = await konnectInit({
        amount_millimes: millimes,
        description:     `${pkg.name} — ${biz?.name || "Nova"} (${pkg.total_sessions} séances)`,
        first_name:      nameParts[0] || "Client",
        last_name:       nameParts.slice(1).join(" ") || "Nova",
        email:           client.email || "noreply@example.com",
        phone:           (client.phone || "").replace(/^\+/, ""),
        webhook:         webhookUrl,
        success_url:     successUrl,
        fail_url:         failUrl,
      });
      url = r.url; id = r.id;
    } else if (provider === "stripe") {
      if (!STRIPE_SECRET_KEY) {
        return new Response(JSON.stringify({ error: "Stripe not configured" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
      }
      const r = await stripeCheckout({
        amount_cents: Math.round(Number(pkg.price) * 100),
        currency:     (pkg.currency || "EUR").toLowerCase(),
        product_name: `${pkg.name} (${pkg.total_sessions} sessions)`,
        success_url:  successUrl + "&session_id={CHECKOUT_SESSION_ID}",
        cancel_url:   failUrl,
        metadata:     { purchase_id: pending.id, business_id, package_id, client_id },
      });
      url = r.url; id = r.id;
    } else {
      return new Response(JSON.stringify({ error: "unknown provider" }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }

    // 3. Patch the pending row with the provider's id + payment URL
    await sb.from("package_purchases")
      .update({ payment_id: id, payment_url: url })
      .eq("id", pending.id);

    return new Response(JSON.stringify({ ok: true, payment_url: url, payment_id: id, purchase_id: pending.id }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("create-package-checkout error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
