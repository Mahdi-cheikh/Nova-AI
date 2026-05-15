-- waitlist_pack.sql
-- Adds the smart-waitlist + race-to-claim auto-fill system on top of the
-- existing appointments / clients schema. No destructive changes.
--
-- Tables:
--   waitlist           one row per patient waiting for a slot at a business
--   waitlist_offers    one row per WhatsApp offer sent (parallel = several
--                      offers can target the same freed slot — first 'Yes'
--                      wins the race, the others get 'lost')
--
-- RPC:
--   waitlist_match_for_slot(business, date, time, doctor, service, top_n)
--     Returns up to top_n best-matching waiting entries for this slot,
--     ranked by a hand-tuned score (doctor match > service > date proximity
--     > time-window match > FIFO age > manual priority). Excludes entries
--     that already have a pending offer for the SAME slot to prevent
--     double-offering on rapid retries.

------------------------------------------------------------------------
-- 1. WAITLIST
------------------------------------------------------------------------
create table if not exists public.waitlist (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  client_id       uuid references public.clients(id) on delete set null,
  client_name     text not null,
  client_phone    text not null,
  language        text not null default 'fr' check (language in ('fr','ar','en')),

  -- Patient preferences (all nullable = "no preference")
  doctor_id       uuid,
  service_id      uuid,
  service_name    text,
  preferred_date  date,             -- a specific day they want
  preferred_window jsonb,           -- {"from":"08:00","to":"12:00"} or null = anytime
  preferred_days  jsonb,            -- ["mon","tue","fri"] or null = any day
  notes           text,

  -- Bookkeeping
  priority        int  not null default 0,    -- manual boost from owner
  status          text not null default 'waiting'
                  check (status in ('waiting','offered','claimed','cancelled','expired')),
  last_offered_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_waitlist_business_status
  on public.waitlist (business_id, status);
create index if not exists idx_waitlist_business_doctor
  on public.waitlist (business_id, doctor_id) where status = 'waiting';
create index if not exists idx_waitlist_business_date
  on public.waitlist (business_id, preferred_date) where status = 'waiting';
create index if not exists idx_waitlist_phone
  on public.waitlist (business_id, client_phone);

------------------------------------------------------------------------
-- 2. WAITLIST OFFERS
------------------------------------------------------------------------
create table if not exists public.waitlist_offers (
  id              uuid primary key default gen_random_uuid(),
  waitlist_id     uuid not null references public.waitlist(id) on delete cascade,
  business_id     uuid not null references public.businesses(id) on delete cascade,

  -- The slot being offered
  slot_date       date not null,
  slot_time       time not null,
  doctor_id       uuid,
  service_id      uuid,

  -- WhatsApp tracking
  wa_message_id   text,
  sent_at         timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '30 minutes'),

  -- Race state
  status          text not null default 'pending'
                  check (status in ('pending','claimed','declined','expired','lost')),
  claimed_at      timestamptz,
  appointment_id  uuid references public.appointments(id) on delete set null
);

create index if not exists idx_offers_pending_slot
  on public.waitlist_offers (business_id, slot_date, slot_time)
  where status = 'pending';
create index if not exists idx_offers_waitlist_id
  on public.waitlist_offers (waitlist_id);
create index if not exists idx_offers_expires
  on public.waitlist_offers (expires_at) where status = 'pending';

------------------------------------------------------------------------
-- 3. updated_at trigger on waitlist
------------------------------------------------------------------------
create or replace function public._waitlist_set_updated()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_waitlist_updated on public.waitlist;
create trigger trg_waitlist_updated
  before update on public.waitlist
  for each row execute function public._waitlist_set_updated();

------------------------------------------------------------------------
-- 4. MATCH RPC — score waiting entries for a freed slot
------------------------------------------------------------------------
-- Score breakdown (max ~310, but only relative ordering matters):
--   doctor match    +100   (no preference: +50)
--   service match   + 50   (no preference: +30)
--   date proximity  + 40 - 5*|delta_days|, clipped to >=0 (no preference: +20)
--   time-window hit + 30   (no preference: +15)
--   priority bump   priority * 100
--   FIFO            + (days_waiting capped at 30)
--
-- Excludes:
--   * entries with status != 'waiting'
--   * entries that already have a 'pending' offer for this exact slot
create or replace function public.waitlist_match_for_slot(
  p_business_id uuid,
  p_slot_date   date,
  p_slot_time   time,
  p_doctor_id   uuid default null,
  p_service_id  uuid default null,
  p_top_n       int  default 3
)
returns table (
  waitlist_id     uuid,
  client_name     text,
  client_phone    text,
  language        text,
  doctor_id       uuid,
  service_id      uuid,
  service_name    text,
  preferred_date  date,
  notes           text,
  score           numeric
)
language sql stable security definer set search_path = public as $$
  with candidates as (
    select w.*,
      -- doctor score
      case
        when w.doctor_id is null then 50
        when p_doctor_id is not null and w.doctor_id = p_doctor_id then 100
        else -1000   -- hard exclude when patient asked for a SPECIFIC doctor
      end as doctor_score,
      -- service score
      case
        when w.service_id is null then 30
        when p_service_id is not null and w.service_id = p_service_id then 50
        else -1000   -- hard exclude on service mismatch
      end as service_score,
      -- date proximity
      case
        when w.preferred_date is null then 20
        else greatest(0, 40 - 5 * abs(w.preferred_date - p_slot_date))
      end as date_score,
      -- time window
      case
        when w.preferred_window is null then 15
        when (w.preferred_window ->> 'from')::time <= p_slot_time
         and (w.preferred_window ->> 'to')::time   >= p_slot_time then 30
        else 0
      end as window_score,
      -- preferred-day-of-week
      case
        when w.preferred_days is null or jsonb_typeof(w.preferred_days) <> 'array' then 0
        when w.preferred_days @> to_jsonb(
               lower(left(to_char(p_slot_date, 'TMDay'), 3))
             ) then 10
        else -50
      end as day_score,
      -- FIFO: older = higher
      least(30, extract(epoch from (now() - w.created_at)) / 86400)::int as fifo_score
    from public.waitlist w
    where w.business_id = p_business_id
      and w.status      = 'waiting'
      -- prevent double-offering for the SAME slot
      and not exists (
        select 1 from public.waitlist_offers o
        where o.waitlist_id = w.id
          and o.slot_date   = p_slot_date
          and o.slot_time   = p_slot_time
          and o.status      = 'pending'
      )
  )
  select id, client_name, client_phone, language, doctor_id, service_id,
         service_name, preferred_date, notes,
         (doctor_score + service_score + date_score + window_score
          + day_score + fifo_score + priority * 100)::numeric as score
  from candidates
  where doctor_score >= 0 and service_score >= 0
  order by score desc, created_at asc
  limit greatest(1, least(p_top_n, 10));
$$;

------------------------------------------------------------------------
-- 5. RLS — owners see their own waitlist; service role bypasses
------------------------------------------------------------------------
alter table public.waitlist        enable row level security;
alter table public.waitlist_offers enable row level security;

-- waitlist: only the business owner can read/manage
drop policy if exists waitlist_owner_select on public.waitlist;
create policy waitlist_owner_select on public.waitlist
  for select using (
    business_id in (
      select id from public.businesses where owner_user_id = auth.uid()
    )
  );

drop policy if exists waitlist_owner_modify on public.waitlist;
create policy waitlist_owner_modify on public.waitlist
  for all using (
    business_id in (
      select id from public.businesses where owner_user_id = auth.uid()
    )
  );

-- offers: same as waitlist
drop policy if exists offers_owner_select on public.waitlist_offers;
create policy offers_owner_select on public.waitlist_offers
  for select using (
    business_id in (
      select id from public.businesses where owner_user_id = auth.uid()
    )
  );

drop policy if exists offers_owner_modify on public.waitlist_offers;
create policy offers_owner_modify on public.waitlist_offers
  for all using (
    business_id in (
      select id from public.businesses where owner_user_id = auth.uid()
    )
  );

-- Anonymous patients use the public waitlist-add edge function which uses
-- the service-role key, so they don't need direct table access.

------------------------------------------------------------------------
-- 6. CRON: expire stale offers (runs every 5 min)
------------------------------------------------------------------------
-- 1. Mark offers past their expires_at as expired.
-- 2. For waitlist entries whose ALL pending offers are now non-pending
--    (expired, declined, lost), set them back to 'waiting' so they can be
--    re-offered when another slot opens.
create or replace function public.waitlist_sweep_expired()
returns table (expired_count int, requeued_count int)
language plpgsql security definer set search_path = public as $$
declare
  v_expired int;
  v_requeued int;
begin
  with upd as (
    update public.waitlist_offers
    set status = 'expired'
    where status = 'pending' and expires_at < now()
    returning id, waitlist_id
  )
  select count(*) into v_expired from upd;

  with re as (
    update public.waitlist w
    set status = 'waiting'
    where status = 'offered'
      and not exists (
        select 1 from public.waitlist_offers o
        where o.waitlist_id = w.id and o.status = 'pending'
      )
    returning id
  )
  select count(*) into v_requeued from re;

  return query select v_expired, v_requeued;
end $$;

-- Schedule it (no-op if pg_cron isn't installed)
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('waitlist_sweep_expired') from cron.job
      where jobname = 'waitlist_sweep_expired';
    perform cron.schedule('waitlist_sweep_expired', '*/5 * * * *',
                          'select public.waitlist_sweep_expired();');
  end if;
exception when others then
  -- pg_cron not present in this project; that's fine, the sweep can also
  -- be invoked from a Supabase scheduled function.
  null;
end $$;
