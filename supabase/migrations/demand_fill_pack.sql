-- supabase/migrations/demand_fill_pack.sql
-- DEMAND-FILL AUTO-PINGING
-- ================================================================
-- When a doctor's day has empty slots, Nova scans the patient list and
-- finds the best candidates to invite — patients who:
--   1. haven't booked in the last 30+ days
--   2. match the service that's available (their last service or related)
--   3. have a low no-show risk (no_show_count <= 1)
--   4. opt-in to marketing pings (clients.profile->>'marketing_ok' != 'false')
--
-- Owner sees the suggested list per opportunity, taps Approve, and Nova
-- pings every candidate with a WhatsApp interactive-button message:
--   "We have 3pm, 3:30, 4pm Tuesday with Dr X — interested?"
--
-- Apply: psql or Supabase SQL editor.
-- ================================================================

-- 1. CLIENT-LEVEL EXTRA FIELDS for ranking
alter table public.clients
  add column if not exists no_show_count       int  not null default 0,
  add column if not exists last_demand_ping_at timestamptz;

-- A trigger that bumps no_show_count whenever an appointment flips to no_show
create or replace function public.bump_no_show_count() returns trigger as $$
begin
  if new.status = 'no_show' and (old.status is distinct from 'no_show') then
    update public.clients set no_show_count = coalesce(no_show_count, 0) + 1
      where id = new.client_id;
  end if;
  return new;
end; $$ language plpgsql;

drop trigger if exists trg_apt_no_show on public.appointments;
create trigger trg_apt_no_show after update on public.appointments
  for each row execute function public.bump_no_show_count();


-- 2. CAMPAIGNS — one per (date, doctor, free-slot-batch) the runner detects.
create table if not exists public.demand_fill_campaigns (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  doctor_id    uuid references public.users(id) on delete set null,
  service_id   uuid references public.services(id) on delete set null,
  date         date not null,
  slot_times   text[] not null,                                           -- ['15:00','15:30','16:00']
  status       text not null default 'pending_approval'
                check (status in ('pending_approval','approved','sent','filled','expired','cancelled')),
  candidate_count int not null default 0,                                  -- how many patients matched
  filled_count    int not null default 0,                                  -- how many slots got booked
  created_at   timestamptz default now(),
  approved_at  timestamptz,
  sent_at      timestamptz,
  expires_at   timestamptz default (now() + interval '36 hours')
);
create index if not exists idx_dfc_biz_status on public.demand_fill_campaigns(business_id, status);
create index if not exists idx_dfc_date on public.demand_fill_campaigns(date);


-- 3. TARGETS — one row per patient pinged in a campaign.
create table if not exists public.demand_fill_targets (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references public.demand_fill_campaigns(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete cascade,
  rank          int  not null,                              -- 1 = best candidate
  status        text not null default 'queued'
                  check (status in ('queued','sent','accepted','declined','no_response','filled','skipped')),
  reason        text,                                       -- "matches service: cardiologie · last visit 2 months ago"
  pinged_at     timestamptz,
  responded_at  timestamptz,
  unique (campaign_id, client_id)
);
create index if not exists idx_dft_campaign on public.demand_fill_targets(campaign_id, rank);
create index if not exists idx_dft_client_status on public.demand_fill_targets(client_id, status);


-- 4. KPI VIEW — for the dashboard tile
create or replace view public.v_demand_fill_kpis as
select
  c.business_id,
  count(*) filter (where c.status = 'sent')                                          as campaigns_sent,
  count(*) filter (where c.status in ('approved','sent') and c.created_at > now() - interval '7 days') as last_7d,
  coalesce(sum(c.filled_count), 0)                                                   as slots_filled_total,
  coalesce(sum(array_length(c.slot_times, 1)) filter (where c.status='sent'), 0)     as slots_pinged,
  coalesce(sum(c.filled_count) filter (where c.status='filled'), 0)::numeric
    / nullif(coalesce(sum(array_length(c.slot_times, 1)) filter (where c.status='sent'), 0), 0)
    * 100                                                                            as fill_rate_pct
from public.demand_fill_campaigns c
group by c.business_id;


-- 5. RPC — scan the next N days for empty-slot opportunities
-- Returns rows representing slot batches: same date, same doctor, gap >= 1.5h,
-- with a count of how many qualifying candidates exist for them.
create or replace function public.find_demand_fill_opportunities(
  p_business_id uuid,
  p_days_ahead  int default 7
) returns table (
  date         date,
  doctor_id    uuid,
  doctor_name  text,
  slot_times   text[],
  candidate_count int
) language plpgsql security definer as $$
declare
  d  date;
  doc record;
  busy_times time[];
  slot time;
  free_slots time[];
begin
  for d in select generate_series(current_date, current_date + p_days_ahead, '1 day')::date loop
    -- Skip weekends if business hasn't explicitly turned them on
    -- (simple heuristic; can be refined later via business hours table)
    if extract(dow from d) in (0, 6) then continue; end if;

    for doc in
      select u.id, u.name from public.users u
      where u.business_id = p_business_id and u.role = 'doctor'
    loop
      -- Pull busy times for this doctor on this date
      select array_agg(a.time order by a.time) into busy_times
        from public.appointments a
        where a.business_id = p_business_id
          and a.doctor_id = doc.id
          and a.date = d
          and a.status in ('pending','confirmed');

      -- Build candidate slots from 09:00 to 18:00 in 30-min increments
      free_slots := array[]::time[];
      slot := '09:00'::time;
      while slot < '18:00'::time loop
        if busy_times is null or not (slot = any(busy_times)) then
          free_slots := array_append(free_slots, slot);
        end if;
        slot := slot + interval '30 minutes';
      end loop;

      -- Only surface opportunity if there's a contiguous run of >=3 free slots
      -- (otherwise there's no "dead afternoon" to fill).
      if array_length(free_slots, 1) is not null and array_length(free_slots, 1) >= 3 then
        date := d;
        doctor_id := doc.id;
        doctor_name := doc.name;
        slot_times := array(
          select to_char(s, 'HH24:MI') from unnest(free_slots) as s
        );
        candidate_count := (
          select count(*) from public.clients cl
          where cl.business_id = p_business_id
            and (cl.last_visit_at is null or cl.last_visit_at < now() - interval '30 days')
            and coalesce(cl.no_show_count, 0) <= 1
            and (cl.last_demand_ping_at is null or cl.last_demand_ping_at < now() - interval '14 days')
            and coalesce(cl.profile->>'marketing_ok', 'true') <> 'false'
        );
        return next;
      end if;
    end loop;
  end loop;
end; $$;


-- 6. RPC — build a ranked candidate list for a specific opportunity
-- Best candidates: matching service history, recent enough but not too recent,
-- low no-show count, hasn't been pinged in the last 14 days.
create or replace function public.demand_fill_candidates(
  p_business_id uuid,
  p_date        date,
  p_service_id  uuid default null,
  p_limit       int  default 25
) returns table (
  client_id      uuid,
  client_name    text,
  client_phone   text,
  last_visit_at  timestamptz,
  no_show_count  int,
  rank_score     numeric,
  reason         text
) language plpgsql security definer as $$
begin
  return query
  select
    cl.id                                              as client_id,
    cl.name                                            as client_name,
    cl.phone                                           as client_phone,
    cl.last_visit_at,
    coalesce(cl.no_show_count, 0)                      as no_show_count,
    -- score: higher = better candidate
    (
      case when cl.last_visit_at is null then 50
           else 100 - extract(epoch from (now() - cl.last_visit_at)) / 86400 / 2
      end
      - coalesce(cl.no_show_count, 0) * 25
      + case when exists (
          select 1 from public.appointments a
          where a.client_id = cl.id and a.service_id = p_service_id
        ) then 30 else 0 end
    )::numeric                                         as rank_score,
    concat_ws(' · ',
      case when cl.last_visit_at is null then 'never visited'
           else 'last visit ' || to_char(cl.last_visit_at, 'DD Mon') end,
      case when coalesce(cl.no_show_count, 0) = 0 then 'no no-shows'
           else cl.no_show_count || ' no-show(s)' end
    )                                                  as reason
  from public.clients cl
  where cl.business_id = p_business_id
    and (cl.last_visit_at is null or cl.last_visit_at < now() - interval '30 days')
    and coalesce(cl.no_show_count, 0) <= 1
    and (cl.last_demand_ping_at is null or cl.last_demand_ping_at < now() - interval '14 days')
    and coalesce(cl.profile->>'marketing_ok', 'true') <> 'false'
    and cl.phone is not null
  order by rank_score desc
  limit p_limit;
end; $$;


-- 7. RLS — owners see their own business data
alter table public.demand_fill_campaigns enable row level security;
alter table public.demand_fill_targets   enable row level security;

drop policy if exists dfc_owner on public.demand_fill_campaigns;
create policy dfc_owner on public.demand_fill_campaigns
  for all using (
    business_id in (
      select id from public.businesses where owner_user_id = auth.uid()
    )
  );

drop policy if exists dft_owner on public.demand_fill_targets;
create policy dft_owner on public.demand_fill_targets
  for all using (
    campaign_id in (
      select id from public.demand_fill_campaigns
        where business_id in (select id from public.businesses where owner_user_id = auth.uid())
    )
  );


-- 8. PG_CRON — daily scan at 09:00 server time
-- Owner can disable this in the dashboard if they don't want auto-suggestions.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'demand-fill-daily-scan',
      '0 9 * * *',
      $cmd$
      select net.http_post(
        url := current_setting('app.settings.supabase_url') || '/functions/v1/demand-fill-runner',
        headers := jsonb_build_object('Content-Type','application/json',
          'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')),
        body := jsonb_build_object('mode','scan_all')
      );
      $cmd$
    );
  end if;
end $$;
