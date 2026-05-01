# Nova AI — 24/7 AI Virtual Receptionist

A production multi-tenant SaaS platform that lets clinics, **laboratoires**, independent doctors, companies and salons plug an AI receptionist into WhatsApp (text **and** voice). The assistant understands **Arabic, French and English**, books appointments straight into Google Calendar, and notifies the right doctor in real time.

This folder is the entire production codebase: a static frontend you deploy on Vercel, a Postgres schema with multi-tenant RLS for Supabase, eight Supabase Edge Functions that hold all your API secrets, and an Android WebView wrapper.

---

## What's in this folder

| File / Folder              | What it is                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `index.html`               | Production SPA: real Supabase auth, real CRUD, realtime, light/dark theme, setup screen, OTP onboarding, Google Calendar OAuth, plan selection, doctor view. |
| `schema.sql`               | Postgres schema with multi-tenant RLS, OTP table, Stripe subscription columns             |
| `edge-functions/`          | 8 Supabase Edge Functions — the secure server-side bits (see below)                       |
| `n8n-workflow.json`        | Optional alternative to Edge Functions if you prefer n8n on Render                        |
| `android/`                 | Kotlin WebView wrapper with native dark-mode support                                      |
| `DEPLOY.md`                | Step-by-step real deployment (Supabase + Vercel + Meta + Twilio + Google + Stripe)        |

### Edge Functions

| Function                | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `classify-message`      | The brain — Claude classification + DB writes + dispatch (AR/FR/EN)    |
| `whatsapp-webhook`      | Receives Meta WhatsApp messages, routes to `classify-message`           |
| `twilio-voice-webhook`  | Receives voice calls, transcribes via Whisper, routes to `classify-message` |
| `send-whatsapp-otp`     | Sends 6-digit verification code during onboarding                       |
| `verify-whatsapp-otp`   | Verifies the code, marks the business as `whatsapp_verified`            |
| `google-calendar-create`| Adds a Calendar event for a new appointment (per-doctor calendar)       |
| `google-calendar-delete`| Removes a Calendar event when an appointment is cancelled               |
| `stripe-webhook`        | Updates subscription status from Stripe events                          |

---

## Get running in 15 minutes

The frontend is a single static file. The first time you open it, it shows a setup screen asking for your Supabase project URL and anon key.

1. **Create a Supabase project** at [supabase.com](https://supabase.com).
2. **Run `schema.sql`** in the Supabase SQL editor.
3. **Open `index.html`** — paste your project URL and anon key when prompted.
4. **Sign up or sign in with Google** — it uses real Supabase Auth.
5. **Fill in business name, type, WhatsApp phone** — creates your tenant row.
6. **Onboard**: verify WhatsApp (real OTP via the Edge Function), connect Google Calendar (real OAuth), pick a plan.

Send your first test message in **Test the assistant** — it calls the real `classify-message` Edge Function, runs Claude in your message's language, writes a real appointment, and notifies you in real time.

The full step-by-step including Edge Function deploy, Meta WhatsApp setup, Twilio voice, Google OAuth scopes, and Stripe wiring is in [`DEPLOY.md`](DEPLOY.md).

---

## Architecture

```
┌──────────────┐  text   ┌────────────────────────┐
│ WhatsApp Cl. │────────▶│ whatsapp-webhook       │
└──────────────┘         │   (Edge Function)      │
                         └──────────┬─────────────┘
┌──────────────┐  audio  ┌──────────▼─────────────┐
│  Twilio      │────────▶│ twilio-voice-webhook   │── Whisper STT (auto-detect lang)
└──────────────┘         └──────────┬─────────────┘
                                    │
                         ┌──────────▼─────────────┐
                         │ classify-message       │── Claude Haiku (AR/FR/EN)
                         │   (Edge Function)      │
                         └──┬─────────┬─────┬─────┘
                            │         │     │
                            ▼         ▼     ▼
                  Supabase Postgres  Google  Reply
                  (appts, msgs,       Cal.   sent back
                   notifications)            to channel
                            │
                            │ realtime push
                            ▼
                  ┌──────────────────────────┐
                  │ Vercel SPA (Web)         │
                  │ + Android WebView        │
                  │ light & dark themes      │
                  └──────────────────────────┘
```

Multi-tenant isolation = `business_id` on every row + Postgres RLS policies that resolve `current_business_id()` from `auth.uid()`. No tenant can ever read another tenant's rows, even if you mess up application code.

---

## AI output contract (the important bit)

Every classification returns this exact JSON shape — the rest of the system depends on it:

```json
{
  "intent": "book | cancel | reschedule | faq",
  "language": "ar | fr | en",
  "service": "Cardiology Checkup",
  "date": "2026-05-01",
  "time_preference": "morning",
  "urgent": false
}
```

The classifier sees the message in any of the three languages and replies in the same language. See `edge-functions/classify-message/index.ts` for the full system prompt.

---

## Subscription plans

| Plan       | Price/mo | Messages/mo | Notes                              |
| ---------- | -------- | ----------- | ---------------------------------- |
| Starter    | $0       | 100         | Free to try                        |
| Pro        | $29      | 1,500       | Most clinics pick this             |
| Business   | $79      | 6,000       | Multi-location & laboratoires      |

Stripe wiring → `edge-functions/stripe-webhook/`. The schema already has `stripe_customer_id` and `stripe_subscription_id`.

---

## Themes

Both web and Android respect the user's OS preference and let them override:

- **Web**: CSS variables on `:root` (dark) and `[data-theme="light"]`. JS detects `prefers-color-scheme`, applies, persists to `localStorage` if user toggles. Settings page has Light / Dark / System buttons.
- **Android**: `Theme.AppCompat.DayNight` plus `values-night/styles.xml` automatically swap based on the OS theme. The WebView's `prefers-color-scheme` follows the system setting, so the page styles itself accordingly.

---

## Costs (when you go live)

Free tier sustains a small pilot. For 10–50 active clinics:

- Supabase Pro: **$25/mo**
- Vercel Hobby: **$0**
- Domain: **~$1/mo**
- WhatsApp + Twilio: pass-through to client (~$5–15/clinic/mo)
- Anthropic API: **~$0.0008 per message classification**

So **$26/mo total platform cost** until you cross hundreds of tenants. Detailed math + Stripe pass-through guidance in `DEPLOY.md`.
