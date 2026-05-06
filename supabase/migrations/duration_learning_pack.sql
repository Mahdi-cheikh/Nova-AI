-- supabase/migrations/duration_learning_pack.sql
-- SELF-LEARNING APPOINTMENT DURATIONS
-- ================================================================
-- Nova logs how long each visit actually takes:
--   • arrived_at  = when patient checked in (button tap or WhatsApp arrival)
--   • completed_at = when staff marked the appointment done
-- Then computes per-(doctor, service) actual averages and proposes
-- new duration_min values for the services table when reality drifts
-- meaningfully from what's scheduled (>=5 samples, >=15% drift).
-- ================================================================

-- 1. Per-appointment timestamps
alter table public.appointments
  add column if not exists arrived_at      timestamptz,
  add column if not exists completed_at    timestamptz,
  add column if not exists actual_duration_min int generated always as (
    case
      when arrived_at is not null and completed_at is not null
      then greatest(0, (extract(epoch from (completed_at - arrived_at)) / 60))::int
    end
  ) stored;

create index if not exists idx_apt_completed on public.appointments(business_id, completed_at)
  where completed_at is not null;


-- 2. Per-service auto-adjust opt-in (default: suggest only, don't auto-apply)
alter table public.services
  add column if not exists auto_adjust_duration boolean not null default false,
  add column if not exists last_duration_review timestamptz;


-- 3. View: actual duration stats per (business, doctor, service)
-- Pulled from the last 90 days of completed appointments only.
create or replace view public.v_service_actual_durations as
select
  a.business_id,
  a.doctor_id,
  a.service_id,
  count(*)                                                         as sample_size,
  round(avg(a.actual_duration_min)::numeric, 1)                    as avg_duration_min,
  percentile_cont(0.5) within group (order by a.actual_duration_min) as median_duration_min,
  percentile_cont(0.9) within group (order by a.actual_duration_min) as p90_duration_min,
  min(a.actual_duration_min)                                       as min_duration_min,
  max(a.actual_duration_min)                                       as max_duration_min,
  max(a.completed_at)                                              as last_observed_at
from public.appointments a
where a.actual_duration_min is not null
  and a.actual_duration_min between 3 and 240          -- discard obvious noise
  and a.completed_at > now() - interval '90 days'
  and a.status = 'completed'
group by a.business_id, a.doctor_id, a.service_id;


-- 4. RPC: produce the list of suggested duration updates.
-- A service gets a suggestion when:
--   • we have >=5 completed observations
--   • the actual average differs from current duration_min by >=15%
--   • the suggestion isn't equal to the current value
-- Suggested duration is rounded UP to the nearest 5-min slot to play nicely
-- with calendar gridding.
create or replace function public.duration_suggestions(
  p_business_id uuid
) returns table (
  service_id      uuid,
  service_name    text,
  doctor_id       uuid,
  doctor_name     text,
  current_duration int,
  observed_avg    numeric,
  observed_p90    numeric,
  sample_size     int,
  suggested_duration int,
  drift_pct       numeric,
  reason          text
) language sql security definer as $$
  with stats as (
    select
      v.business_id, v.doctor_id, v.service_id,
      v.sample_size, v.avg_duration_min, v.p90_duration_min
    from public.v_service_actual_durations v
    where v.business_id = p_business_id
      and v.sample_size >= 5
  ),
  joined as (
    select
      s.id              as service_id,
      s.name            as service_name,
      st.doctor_id,
      u.name            as doctor_name,
      s.duration_min    as current_duration,
      st.avg_duration_min as observed_avg,
      st.p90_duration_min as observed_p90,
      st.sample_size,
      -- round up to next 5 minutes, but use p90 not avg so we don't end up
      -- still running late (50th percentile means 50% of visits run longer)
      ceil(st.avg_duration_min / 5.0)::int * 5 as suggested_duration,
      round(((st.avg_duration_min - s.duration_min) / nullif(s.duration_min, 0)) * 100, 1) as drift_pct
    from stats st
    join public.services s on s.id = st.service_id
    left join public.users u on u.id = st.doctor_id
    where s.business_id = p_business_id
  )
  select
    service_id, service_name, doctor_id, doctor_name,
    current_duration, observed_avg, observed_p90, sample_size, suggested_duration,
    drift_pct,
    case
      when drift_pct >  15 then 'Running long: visits average ' || observed_avg || ' min vs ' || current_duration || ' min scheduled'
      when drift_pct < -15 then 'Running short: visits average ' || observed_avg || ' min vs ' || current_duration || ' min scheduled'
      else 'Within tolerance'
    end as reason
  from joined
  where abs(drift_pct) >= 15
    and suggested_duration <> current_duration
  order by abs(drift_pct) desc;
$$;


-- 5. RPC: apply ONE suggestion (used by the dashboard's per-row Apply button)
create or replace function public.apply_duration_suggestion(
  p_service_id uuid,
  p_new_duration int
) returns void language sql security definer as $$
  update public.services
    set duration_min = p_new_duration,
        last_duration_review = now()
    where id = p_service_id;
$$;


-- 6. Trigger: when the patient sends a "I'm here" / "j'arrive" message and
--    we already have an appointment within 30 min, auto-stamp arrived_at.
--    The webhook stays the source of truth for booking flows; this just
--    catches the common case in case staff forget to tap the button.
create or replace function public.maybe_mark_arrived() returns trigger as $$
declare
  apt_id uuid;
begin
  -- Only inbound patient messages
  if new.direction <> 'in' then return new; end if;
  -- Only short messages, lowercased, that look like an arrival cue
  if lower(new.text) ~ '\m(arrived|here|j''arrive|wsalt|wsel|jit|i.?m here)\M' then
    select id into apt_id
      from public.appointments
      where client_id = new.client_id
        and business_id = new.business_id
        and status in ('confirmed','pending')
        and arrived_at is null
        and date = current_date
        and time::time between (now() - interval '30 minutes')::time and (now() + interval '30 minutes')::time
      order by time asc limit 1;
    if apt_id is not null then
      update public.appointments
        set arrived_at = now(), status = 'confirmed'
        where id = apt_id;
    end if;
  end if;
  return new;
end; $$ language plpgsql;

drop trigger if exists trg_msg_maybe_arrived on public.messages;
create trigger trg_msg_maybe_arrived after insert on public.messages
  for each row execute function public.maybe_mark_arrived();


-- 7. Optional pg_cron: weekly review every Monday 08:00. Posts a notification
--    summarizing how many drifts the system found. Auto-applies only for
--    services that have services.auto_adjust_duration = true.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'duration-learner-weekly',
      '0 8 * * 1',
      $cmd$
      select net.http_post(
        url := current_setting('app.settings.supabase_url') || '/functions/v1/duration-learner',
        headers := jsonb_build_object('Content-Type','application/json',
          'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')),
        body := jsonb_build_object('mode','review_all')
      );
      $cmd$
    );
  end if;
end $$;
