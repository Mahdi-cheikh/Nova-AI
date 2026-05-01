# Production Deployment Guide

Plan ~45 minutes the first time. None of these steps are throwaway — at the end you have real auth, real AI, real WhatsApp, real Google Calendar, real billing.

---

## 0. Prerequisites

- A Supabase account ([supabase.com](https://supabase.com))
- A Vercel account ([vercel.com](https://vercel.com))
- A Google Cloud account ([console.cloud.google.com](https://console.cloud.google.com))
- A Meta for Developers account ([developers.facebook.com](https://developers.facebook.com)) — for WhatsApp
- A Twilio account ([twilio.com](https://twilio.com)) — for voice calls
- An Anthropic account ([console.anthropic.com](https://console.anthropic.com)) — for Claude
- An OpenAI account ([platform.openai.com](https://platform.openai.com)) — for Whisper voice transcription
- A Stripe account ([stripe.com](https://stripe.com)) — for billing
- The Supabase CLI installed (`npm i -g supabase`)

---

## 1. Supabase project + schema

1. Create a new Supabase project. Save the project URL and the **anon** + **service_role** keys.
2. SQL editor → paste `schema.sql` → Run.
3. **Database → Replication** → toggle Realtime on `notifications`, `appointments`, `messages`.
4. **Storage** → create a private bucket named `voice-recordings`.
5. **Authentication → Providers → Google** → toggle on. You'll fill in client ID and secret in step 4.

---

## 2. Frontend on Vercel

1. Push this folder to GitHub.
2. Vercel → **Add New Project** → import → Framework: **Other** → no build command. Deploy.
3. You get a URL like `https://nova-ai-xxxxx.vercel.app`. Open it.
4. The first-run setup screen asks for your Supabase URL and anon key — paste them. Done.

Note: the app stores the Supabase URL/key in the browser's localStorage. If your users self-host, each customer pastes their own. If you want one shared platform, edit the `CFG_KEY` block at the top of `index.html` to hard-code your URL/key.

---

## 3. Edge Functions

Open a terminal in this folder.

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF

# Deploy all 8 functions
for fn in classify-message send-whatsapp-otp verify-whatsapp-otp \
          google-calendar-create google-calendar-delete \
          whatsapp-webhook twilio-voice-webhook stripe-webhook ; do
  supabase functions deploy "$fn" --no-verify-jwt
done

# Set secrets (do once)
supabase secrets set \
  ANTHROPIC_API_KEY=sk-ant-... \
  OPENAI_API_KEY=sk-... \
  WA_PHONE_ID=... \
  WA_ACCESS_TOKEN=... \
  WA_VERIFY_TOKEN=$(openssl rand -hex 16) \
  GOOGLE_CLIENT_ID=...apps.googleusercontent.com \
  GOOGLE_CLIENT_SECRET=GOCSPX-... \
  STRIPE_SECRET_KEY=sk_live_... \
  STRIPE_WEBHOOK_SECRET=whsec_...
```

Each function lives at `https://<project>.supabase.co/functions/v1/<name>`.

---

## 4. Google OAuth (Sign-in + Calendar)

1. Google Cloud Console → create project "Nova AI".
2. **APIs & Services → Library** → enable:
   - Google Calendar API
   - Google People API
3. **OAuth consent screen** → External. Add scopes:
   - `.../auth/calendar.events`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
4. **Credentials → Create OAuth client ID → Web application**:
   - Authorised origins: `https://your-vercel-url.vercel.app`
   - Authorised redirect URIs: `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`
5. Copy client ID + secret. Paste into:
   - Supabase **Authentication → Providers → Google**
   - Edge Function secrets (you already did this in step 3)

Now "Continue with Google" on the auth page works for sign-in **and** the calendar OAuth in onboarding works for booking sync.

---

## 5. WhatsApp Business setup

1. [developers.facebook.com](https://developers.facebook.com) → create a **Business** type app.
2. Add the **WhatsApp** product. Copy:
   - Phone number ID → set as `WA_PHONE_ID` secret
   - Permanent access token → set as `WA_ACCESS_TOKEN`
3. **WhatsApp → Configuration → Webhook**:
   - Callback URL: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/whatsapp-webhook`
   - Verify token: the value you generated for `WA_VERIFY_TOKEN`
4. Subscribe to `messages` events.
5. Send a real test message to your WhatsApp business number — it should be classified, written to Supabase, and replied to.

---

## 6. Twilio Voice (multilingual auto-detect)

1. Twilio console → **Phone Numbers → Buy a number** in your country.
2. Configure → **A call comes in** → **Webhook**: `POST https://YOUR-PROJECT-REF.supabase.co/functions/v1/twilio-voice-webhook?stage=greet`
3. Save. Call the number — Nova AI greets, captures speech, Whisper detects the language, Claude classifies, replies in the same language, hangs up.

The **same Twilio number** handles AR/FR/EN automatically because Whisper detects the language from the first 5 seconds. No IVR needed.

---

## 7. Stripe (subscriptions)

1. Stripe Dashboard → **Products** → create three:
   - **Starter** — $0/mo (no recurring; just creates a customer)
   - **Pro** — $29/mo recurring (set price nickname to `pro`)
   - **Business** — $79/mo recurring (nickname `business`)
2. **Developers → Webhooks → Add endpoint**:
   - URL: `https://YOUR-PROJECT-REF.supabase.co/functions/v1/stripe-webhook`
   - Events: `customer.subscription.*`, `invoice.payment_failed`
   - Copy the signing secret → `STRIPE_WEBHOOK_SECRET`
3. In `index.html` settings page, the plan selector currently calls `sb.from('businesses').update({subscription_plan: ...})` directly. Replace that with a call to `sb.functions.invoke('create-checkout-session', {body:{plan}})` once you wire a `create-checkout-session` Edge Function. (Not in the starter set — copy the pattern from `stripe-webhook`.)

---

## 8. Android app

`android/BUILD.txt` walks you through building in Android Studio. The only line you change in `MainActivity.kt`:

```kotlin
private val appUrl = "https://nova-ai-xxxxx.vercel.app"
```

The app uses `Theme.AppCompat.DayNight` so it auto-switches between `values/styles.xml` (light) and `values-night/styles.xml` (dark) when the user's phone is in dark mode. The WebView's `prefers-color-scheme` matches the OS, so your page CSS styles itself accordingly without any extra code.

---

## 9. Quick sanity test

Once everything is wired:

1. Sign up a new business in your live frontend. Onboarding wizard runs end-to-end — real OTP arrives on WhatsApp, real Google OAuth window opens.
2. Add a doctor on the **Team** page.
3. Open **Test the assistant** in the dashboard. Type *"Bonjour, je voudrais un rendez-vous demain matin"*. Submit.
4. Watch:
   - The JSON response shows `language: "fr", intent: "book"`
   - A new appointment appears on the **Appointments** page
   - A new entry on **Messages**
   - A new event on the doctor's Google Calendar
   - A real-time toast pops: "New appointment booked"

If all five happen, your platform is alive.

---

## Cost summary

| Stage                                   | Monthly                                                |
| --------------------------------------- | ------------------------------------------------------ |
| First few clinics, all free tiers       | **$0**                                                 |
| 10–50 clinics (Supabase Pro)            | **~$26**                                               |
| Per clinic, WhatsApp pass-through       | $5–15                                                  |
| Per clinic, Twilio voice                | ~$1 number + $0.013/min + Whisper $0.006/min            |
| Anthropic Claude (per 10K classifications) | ~$8                                                  |
| OpenAI Whisper (per 10K minutes voice)  | ~$60                                                   |

Recommended pricing: **flat $30/clinic/month + WhatsApp & Twilio pass-through.** Keeps margin clean as you scale.

---

## Production checklist

- [ ] Move all secrets out of n8n env into Supabase secrets store
- [ ] Custom domain in Vercel
- [ ] Supabase scheduled function for 24h-before reminder messages
- [ ] Encrypt `google_oauth_refresh_token` with Supabase Vault
- [ ] Add a `platform_admins` table + bypass RLS for super-user dashboards (omitted from v3 — add as needed)
- [ ] Firebase Cloud Messaging for native Android push
- [ ] Per-doctor Google Calendar OAuth (not just per-business)
- [ ] Stripe billing portal session for self-serve plan changes
- [ ] Rate-limit `classify-message` per business to prevent runaway costs
- [ ] Monitor Edge Function logs in Supabase dashboard
