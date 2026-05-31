// supabase/functions/stripe-webhook/index.ts
// Receives Stripe events (subscription created, updated, cancelled,
// payment failed) and updates businesses.subscription_status.
//
// Deploy: supabase functions deploy stripe-webhook --no-verify-jwt
// Secrets: supabase secrets set STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=whsec_...

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Stripe from "https://esm.sh/stripe@16.12.0?target=deno";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
const SIG = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
 const sig = req.headers.get("Stripe-Signature") || "";
 const raw = await req.text();
 let event: Stripe.Event;
 try { event = await stripe.webhooks.constructEventAsync(raw, sig, SIG); }
 catch (err) { return new Response("invalid signature: " + (err as Error).message, { status: 400 }); }

 const sb = createClient(SUPABASE_URL, SERVICE_KEY);

 switch (event.type) {
 case "customer.subscription.created":
 case "customer.subscription.updated": {
 const s = event.data.object as Stripe.Subscription;
 const customerId = s.customer as string;
 const status = s.status; // active | past_due | canceled | trialing | ...
 const planNickname = (s.items.data[0]?.price?.nickname || "").toLowerCase();
 await sb.from("businesses")
 .update({ subscription_status: status, subscription_plan: planNickname || null, stripe_subscription_id: s.id })
 .eq("stripe_customer_id", customerId);
 await sb.from("subscription_events").insert({
 event_type: event.type, plan: planNickname, raw_payload: event,
 amount_usd: (s.items.data[0]?.price?.unit_amount ?? 0) / 100,
 });
 break;
 }
 case "customer.subscription.deleted": {
 const s = event.data.object as Stripe.Subscription;
 await sb.from("businesses").update({ subscription_status: "cancelled" }).eq("stripe_subscription_id", s.id);
 break;
 }
 case "invoice.payment_failed": {
 const inv = event.data.object as Stripe.Invoice;
 await sb.from("businesses").update({ subscription_status: "past_due" }).eq("stripe_customer_id", inv.customer as string);
 break;
 }
 // Successful charge → enqueue a receipt email to