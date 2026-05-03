-- =============================================================
-- Nova AI — Enhancement Pack v1
-- Adds: client memory, FAQ knowledge base, waitlist, doctor
-- block-time, service packages, deposits, post-visit reviews,
-- client files, platform admins, classification quota, triage,
-- analytics view, reactivation tracking. All RLS-aware.
-- =============================================================

-- 1. CLIENT MEMORY ---------------------------------------------
-- Per-client free-form profile so Nova greets returning patients
-- by name, remembers preferred doctor, allergies, language, etc.
alter table public.clients
  add column if not exists profile               jsonb       not null default '{}'::jsonb,
  add column if not exists last_visit_at         timestamptz,
  add column if not exists last_reactivation_at  timestamptz,
  add column if not exists age                   int;

-- 2. FAQ KNOWLEDGE BASE ----------------------------------------
create table if not exists public.business_faqs (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  question     text not null,
  answer       text not null,
  language     text default 'en' check (language in ('en','fr','ar')),
  active       boolean default true,
  created_at   timestamptz default now()
);
create index if not exists idx_faq_biz on public.business_faqs(business_id) where active;

-- 3. WAITLIST --------------------------------------------------
create table if not exists public.waitlist (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses(id) on delete cascade,
  client_id              uuid not null references public.clients(id) on delete cascade,
  service_id             uuid references public.services(id) on delete set null,
  doctor_id              uuid references public.users(id) on delete set null,
  preferred_date         date,
  preferred_time_window  text,
  language               text default 'en',
  status                 text default 'active' check (status in ('active','notified','booked','cancelled','expired')),
  notified_at            timestamptz,
  created_at             timestamptz default now()
);
create index if not exists idx_wait_biz on public.waitlist(business_id, status);

-- 4. DOCTOR BLOCK-TIME (vacation, surgery, lunch, holiday) -----
create table if not exists public.doctor_blocks (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  doctor_id    uuid not null references public.users(id) on delete cascade,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  reason       text,
  created_at   timestamptz default now()
);
create index if not exists idx_blocks_doc on public.doctor_blocks(doctor_id, starts_at);

-- 5. SERVICE PACKAGES (10-session bundles, etc.) ---------------
create table if not exists public.service_packages (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  name            text not null,
  service_id      uuid references public.services(id) on delete set null,
  total_sessions  int  not null default 1,
  price           numeric not null,
  validity_days   int default 365,
  active          boolean default true,
  created_at      timestamptz default now()
);

create table if not exists public.package_purchases (
  id                         uuid primary key default gen_random_uuid(),
  business_id                uuid not null references public.businesses(id) on delete cascade,
  client_id                  uuid not null references public.clients(id) on delete cascade,
  package_id                 uuid not null references public.service_packages(id) on delete restrict,
  sessions_remaining         int not null,
  expires_at                 timestamptz,
  stripe_payment_intent_id   text,
  status                     text default 'active' check (status in ('active','exhausted','expired','refunded')),
  created_at                 timestamptz default now()
);
create index if not exists idx_pkg_purch_client on public.package_purchases(client_id, status);

-- 6. APPOINTMENTS — DEPOSITS, CONFIRM, TRIAGE, PACKAGE LINK ----
alter table public.appointments
  add column if not exists deposit_status            text default 'none'  check (deposit_status in ('none','required','pending','paid','refunded')),
  add column if not exists deposit_amount            numeric,
  add column if not exists deposit_payment_intent_id text,
  add column if not exists confirmed_by_patient      boolean default false,
  add column if not exists triage_level              text check (triage_level in ('routine','urgent','non_medical')),
  add column if not exists package_purchase_id       uuid references public.package_purchases(id) on delete set null,
  add column if not exists reminder_24h_sent_at      timestamptz,
  add column if not exists reminder_1h_sent_at       timestamptz,
  add column if not exists review_prompt_sent_at     timestamptz;

-- 7. POST-VISIT REVIEWS ----------------------------------------
create table if not exists public.appointment_reviews (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  appointment_id  uuid unique not null references public.appointments(id) on delete cascade,
  client_id       uuid not null references public.clients(id) on delete cascade,
  doctor_id       uuid references public.users(id) on delete set null,
  rating          int check (rating between 1 and 5),
  comment         text,
  prompted_at     timestamptz default now(),
  responded_at    timestamptz
);

-- 8. CLIENT-UPLOADED FILES -------------------------------------
create table if not exists public.client_files (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  client_id       uuid not null references public.clients(id) on delete cascade,
  appointment_id  uuid references public.appointments(id) on delete set null,
  storage_path    text not null,
  filename        text,
  mime_type       text,
  size_bytes      int,
  uploaded_at     timestamptz default now()
);

-- 9. PLATFORM ADMINS (super-user role across all tenants) ------
create table if not exists public.platform_admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  granted_at  timestamptz default now()
);

create or replace function public.is_platform_admin() returns boolean
  language sql stable security definer as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

-- 10. RATE LIMITING (per-business per-day classification budget)
create table if not exists public.classification_quota (
  business_id  uuid not null references public.businesses(id) on delete cascade,
  date         date not null,
  count        int not null default 0,
  primary key (business_id, date)
);

-- Atomic increment helper called by classify-message before each Anthropic call.
create or replace function public.bump_classification_quota(p_biz uuid, p_limit int)
returns boolean language plpgsql security definer as $$
declare
  current_count int;
begin
  insert into public.classification_quota (business_id, date, count)
  values (p_biz, current_date, 1)
  on conflict (business_id, date) do update
    set count = public.classification_quota.count + 1
  returning count into current_count;
  return current_count <= p_limit;
end;
$$;

-- 11. ANALYTICS VIEW (powers the /insights dashboard) ----------
create or replace view public.v_business_kpis as
select
  b.id   as business_id,
  b.name,
  count(distinct a.id) filter (where a.created_at >= current_date - interval '30 days')                as bookings_30d,
  count(distinct a.id) filter (where a.status = 'no_show'  and a.date >= current_date - interval '30 days') as no_shows_30d,
  count(distinct a.id) filter (where a.status = 'cancelled' and a.date >= current_date - interval '30 days') as cancels_30d,
  count(distinct a.client_id) filter (where a.created_at >= current_date - interval '30 days')         as unique_clients_30d,
  count(distinct a.id) filter (where a.source like 'whatsapp%')                                        as whatsapp_bookings_total,
  count(distinct a.id) filter (where a.source = 'manual')                                              as manual_bookings_total,
  coalesce(avg(r.rating), 0)::numeric(3,2)                                                             as avg_rating
from      public.businesses b
left join public.appointments a        on a.business_id = b.id
left join public.appointment_reviews r on r.business_id = b.id and r.rating is not null
group by  b.id, b.name;

-- 12. RLS POLICIES FOR NEW TABLES ------------------------------
alter table public.business_faqs        enable row level security;
alter table public.waitlist             enable row level security;
alter table public.doctor_blocks        enable row level security;
alter table public.service_packages     enable row level security;
alter table public.package_purchases    enable row level security;
alter table public.appointment_reviews  enable row level security;
alter table public.client_files         enable row level security;
alter table public.classification_quota enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array[
    'business_faqs','waitlist','doctor_blocks','service_packages',
    'package_purchases','appointment_reviews','client_files','classification_quota'
  ]) loop
    execute format($f$
      drop policy if exists "%1$s_tenant_all" on public.%1$s;
      create policy "%1$s_tenant_all" on public.%1$s
        for all using (business_id = public.current_business_id())
                with check (business_id = public.current_business_id());
    $f$, t);
  end loop;
end$$;

-- platform_admins: only platform admins can read it
alter table public.platform_admins enable row level security;
drop policy if exists "padmin_self" on public.platform_admins;
create policy "padmin_self" on public.platform_admins
  for select using (user_id = auth.uid() or public.is_platform_admin());

-- 13. CRON JOB STUBS (uncomment after deploying functions) -----
-- Replace YOUR-PROJECT-REF and YOUR-SERVICE-KEY first.
-- select cron.schedule('post-visit-review',     '*/30 * * * *', $$
--   select net.http_post(
--     url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/post-visit-review',
--     headers := '{"Authorization":"Bearer YOUR-SERVICE-KEY","Content-Type":"application/json"}'::jsonb,
--     body    := '{}'::jsonb
--   );
-- $$);
-- select cron.schedule('reactivation-weekly',   '0 9 * * 1', $$
--   select net.http_post(
--     url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/reactivation-campaign',
--     headers := '{"Authorization":"Bearer YOUR-SERVICE-KEY","Content-Type":"application/json"}'::jsonb,
--     body    := '{}'::jsonb
--   );
-- $$);
-- select cron.schedule('weekly-digest',         '0 8 * * 1', $$
--   select net.http_post(
--     url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/weekly-digest',
--     headers := '{"Authorization":"Bearer YOUR-SERVICE-KEY","Content-Type":"application/json"}'::jsonb,
--     body    := '{}'::jsonb
--   );
-- $$);
