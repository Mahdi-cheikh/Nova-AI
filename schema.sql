-- =========================================================
--  Nova AI — production Supabase schema (v3)
--  Multi-tenant + RLS + Google OAuth tokens + voice + OTP
-- =========================================================

create extension if not exists pgcrypto;

-- ---------- 1. BUSINESSES ----------
create table if not exists public.businesses (
  id                          uuid primary key default gen_random_uuid(),
  name                        text not null,
  type                        text not null check (type in ('clinic','laboratoire','company','doctor','salon','other')),
  phone                       text unique,                      -- WhatsApp number (must be unique platform-wide so the webhook can route)
  email                       text unique not null,
  owner_user_id               uuid references auth.users(id) on delete set null,
  -- Onboarding state
  whatsapp_verified           boolean default false,
  whatsapp_verified_at        timestamptz,
  google_calendar_connected   boolean default false,
  google_calendar_id          text default 'primary',
  google_oauth_refresh_token  text,            -- encrypt with Supabase Vault in production
  google_email                text,
  onboarding_complete         boolean default false,
  -- Subscription
  subscription_plan           text check (subscription_plan in ('starter','pro','business')),
  subscription_status         text default 'trialing' check (subscription_status in ('trialing','active','past_due','cancelled')),
  trial_ends_at               timestamptz,
  stripe_customer_id          text,
  stripe_subscription_id      text,
  created_at                  timestamptz default now()
);

-- ---------- 2. USERS (staff/doctors) ----------
create table if not exists public.users (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses(id) on delete cascade,
  auth_uid            uuid unique references auth.users(id) on delete cascade,
  name                text not null,
  role                text not null check (role in ('owner','staff','doctor')),
  specialty           text,
  email               text,
  phone               text,
  google_calendar_id  text,
  created_at          timestamptz default now()
);
create index if not exists idx_users_biz on public.users(business_id);
create index if not exists idx_users_auth on public.users(auth_uid);

-- ---------- 3. CLIENTS (patients) ----------
create table if not exists public.clients (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  name            text not null,
  phone           text not null,
  email           text,
  notes           text,
  created_at      timestamptz default now(),
  unique (business_id, phone)
);

-- ---------- 4. SERVICES ----------
create table if not exists public.services (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  name            text not null,
  duration_min    int not null default 30,
  doctor_id       uuid references public.users(id) on delete set null,
  price           numeric,
  category        text,
  created_at      timestamptz default now()
);

-- ---------- 5. APPOINTMENTS ----------
create table if not exists public.appointments (
  id                       uuid primary key default gen_random_uuid(),
  business_id              uuid not null references public.businesses(id) on delete cascade,
  client_id                uuid not null references public.clients(id) on delete cascade,
  doctor_id                uuid references public.users(id) on delete set null,
  service_id               uuid references public.services(id) on delete set null,
  date                     date not null,
  time                     time not null,
  status                   text not null default 'pending' check (status in ('pending','confirmed','cancelled','completed','no_show')),
  source                   text default 'manual' check (source in ('manual','whatsapp_ai','whatsapp_voice','web','api')),
  google_calendar_event_id text,
  notes                    text,
  created_at               timestamptz default now(),
  updated_at               timestamptz default now()
);
create index if not exists idx_apt_biz_date on public.appointments(business_id, date);

create or replace function public.touch_updated_at() returns trigger as $$
begin new.updated_at := now(); return new; end; $$ language plpgsql;
drop trigger if exists trg_apt_updated on public.appointments;
create trigger trg_apt_updated before update on public.appointments
  for each row execute function public.touch_updated_at();

-- ---------- 6. MESSAGES ----------
create table if not exists public.messages (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses(id) on delete cascade,
  client_id           uuid references public.clients(id) on delete set null,
  direction           text not null check (direction in ('in','out')),
  channel             text not null default 'whatsapp' check (channel in ('whatsapp','whatsapp_voice','sms','web')),
  text                text not null,
  voice_url           text,
  intent              text,
  detected_language   text check (detected_language in ('ar','fr','en')),
  ai_payload          jsonb,
  created_at          timestamptz default now()
);
create index if not exists idx_msg_biz on public.messages(business_id, created_at desc);

-- ---------- 7. NOTIFICATIONS ----------
create table if not exists public.notifications (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  doctor_id       uuid references public.users(id) on delete set null,
  type            text not null check (type in ('booking','cancel','reschedule','urgent','info')),
  title           text not null,
  message         text not null,
  urgent          boolean default false,
  read            boolean default false,
  created_at      timestamptz default now()
);
create index if not exists idx_ntf_biz on public.notifications(business_id, created_at desc);

-- ---------- 8. ACTIVITY LOG ----------
create table if not exists public.activity (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  actor_user_id   uuid references public.users(id) on delete set null,
  action          text not null,
  details         text,
  created_at      timestamptz default now()
);

-- ---------- 9. WHATSAPP OTPs (for onboarding verification) ----------
create table if not exists public.whatsapp_otps (
  business_id     uuid primary key references public.businesses(id) on delete cascade,
  phone           text not null,
  code_hash       text not null,
  expires_at      timestamptz not null,
  created_at      timestamptz default now()
);

-- ---------- 10. SUBSCRIPTION EVENTS (Stripe audit) ----------
create table if not exists public.subscription_events (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references public.businesses(id) on delete set null,
  event_type      text not null,
  plan            text,
  amount_usd      numeric,
  raw_payload     jsonb,
  created_at      timestamptz default now()
);

-- ---------- 11. ROW-LEVEL SECURITY ----------
alter table public.businesses           enable row level security;
alter table public.users                enable row level security;
alter table public.clients              enable row level security;
alter table public.services             enable row level security;
alter table public.appointments         enable row level security;
alter table public.messages             enable row level security;
alter table public.notifications        enable row level security;
alter table public.activity             enable row level security;
alter table public.subscription_events  enable row level security;
alter table public.whatsapp_otps        enable row level security;

-- Helper: returns the business_id of the currently signed-in user.
create or replace function public.current_business_id() returns uuid
  language sql stable security definer as $$
  select business_id from public.users where auth_uid = auth.uid() limit 1;
$$;

-- Tenant policies for child tables
do $$
declare t text;
begin
  for t in select unnest(array['users','clients','services','appointments','messages','notifications','activity','subscription_events','whatsapp_otps']) loop
    execute format($f$
      drop policy if exists "%1$s_tenant_select" on public.%1$s;
      create policy "%1$s_tenant_select" on public.%1$s
        for select using (business_id = public.current_business_id());

      drop policy if exists "%1$s_tenant_modify" on public.%1$s;
      create policy "%1$s_tenant_modify" on public.%1$s
        for all using (business_id = public.current_business_id())
                with check (business_id = public.current_business_id());
    $f$, t);
  end loop;
end$$;

-- Businesses: a user can read AND update their own business row.
drop policy if exists "biz_self_select" on public.businesses;
create policy "biz_self_select" on public.businesses
  for select using (id = public.current_business_id() or owner_user_id = auth.uid());

drop policy if exists "biz_self_update" on public.businesses;
create policy "biz_self_update" on public.businesses
  for update using (id = public.current_business_id() or owner_user_id = auth.uid());

drop policy if exists "biz_self_insert" on public.businesses;
create policy "biz_self_insert" on public.businesses
  for insert with check (owner_user_id = auth.uid());

-- ---------- 12. REALTIME ----------
-- Run after the tables exist:
-- alter publication supabase_realtime add table public.notifications;
-- alter publication supabase_realtime add table public.appointments;
-- alter publication supabase_realtime add table public.messages;

-- ---------- 13. STORAGE (for voice recordings) ----------
-- In Supabase dashboard, create a bucket named 'voice-recordings' (private).
