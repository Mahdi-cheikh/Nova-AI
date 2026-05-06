-- supabase/migrations/queue_pack.sql
-- LIVE QUEUE / WAIT-TIME ETA  (laboratoire only)
-- ================================================================
-- Patients arrive, scan a SHARED reception QR (one per business),
-- enter their name + phone, get a position number. Their PWA shows
-- "You're #3 — about 22 minutes" updating live as the queue moves.
-- Lab workers see the queue in the dashboard, tap "Call next" /
-- "Done" — Nova recomputes ETAs from the trailing average serve time.
-- ================================================================

-- 1. Queue entries
create table if not exists public.queue_entries (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  client_id     uuid references public.clients(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  name          text not null,
  phone         text,
  status        text not null default 'waiting'
                  check (status in ('waiting','in_progress','completed','left','no_show')),
  joined_at     timestamptz not null default now(),
  called_at     timestamptz,
  completed_at  timestamptz,
  -- minutes the entry actually took (called → completed); used for the
  -- trailing average so future ETAs improve over time
  served_min    int generated always as (
    case when called_at is not null and completed_at is not null
         then greatest(0, (extract(epoch from (completed_at - called_at)) / 60))::int
    end
  ) stored
);
create index if not exists idx_queue_biz_status_joined on public.queue_entries(business_id, status, joined_at);
create index if not exists idx_queue_completed on public.queue_entries(business_id, completed_at) where completed_at is not null;


-- 2. RPC: a patient joins the queue
-- Returns the new entry id + initial position + ETA.
create or replace function public.queue_join(
  p_business_id   uuid,
  p_name          text,
  p_phone         text default null,
  p_client_id     uuid default null,
  p_appointment_id uuid default null
) returns table (
  entry_id     uuid,
  position     int,
  eta_minutes  int,
  avg_serve_min numeric
) language plpgsql security definer as $$
declare
  new_id uuid;
  pos    int;
  avg_min numeric;
begin
  -- Reject duplicate active entries for the same phone in the same business
  if p_phone is not null then
    if exists (
      select 1 from public.queue_entries q
      where q.business_id = p_business_id
        and q.phone = p_phone
        and q.status in ('waiting','in_progress')
    ) then
      raise exception 'Already in queue';
    end if;
  end if;

  insert into public.queue_entries (business_id, client_id, appointment_id, name, phone, status)
  values (p_business_id, p_client_id, p_appointment_id, coalesce(p_name, 'Walk-in'), p_phone, 'waiting')
  returning id into new_id;

  -- Compute position: count of entries ahead of this one + 1
  select count(*) + 1 into pos
    from public.queue_entries q
    where q.business_id = p_business_id
      and q.status = 'waiting'
      and q.joined_at < (select joined_at from public.queue_entries where id = new_id);

  -- Average serve time across last 20 completed entries (fallback 8 min)
  select coalesce(avg(served_min), 8)::numeric
    into avg_min
    from (
      select served_min from public.queue_entries
      where business_id = p_business_id and served_min is not null
      order by completed_at desc limit 20
    ) t;

  return query select new_id, pos, ((pos - 1) * avg_min)::int, avg_min;
end; $$;


-- 3. RPC: read current position + ETA for an entry (no auth required for the
--    patient's PWA poll; the entry id acts as the bearer token)
create or replace function public.queue_status(p_entry_id uuid)
returns table (
  status        text,
  position      int,
  eta_minutes   int,
  ahead_count   int,
  avg_serve_min numeric,
  joined_at     timestamptz,
  called_at     timestamptz,
  completed_at  timestamptz,
  business_name text
) language plpgsql security definer as $$
declare
  e record;
  pos int;
  ahead int;
  avg_min numeric;
begin
  select q.*, b.name as bname into e
    from public.queue_entries q
    left join public.businesses b on b.id = q.business_id
    where q.id = p_entry_id;
  if e.id is null then
    raise exception 'Queue entry not found';
  end if;

  select coalesce(avg(served_min), 8)::numeric
    into avg_min
    from (
      select served_min from public.queue_entries
      where business_id = e.business_id and served_min is not null
      order by completed_at desc limit 20
    ) t;

  if e.status = 'waiting' then
    select count(*) into ahead
      from public.queue_entries q
      where q.business_id = e.business_id
        and q.status = 'waiting'
        and q.joined_at < e.joined_at;
    pos := ahead + 1;
    return query select e.status, pos, (ahead * avg_min)::int, ahead, avg_min,
                        e.joined_at, e.called_at, e.completed_at, e.bname;
  elsif e.status = 'in_progress' then
    return query select e.status, 0, 0, 0, avg_min,
                        e.joined_at, e.called_at, e.completed_at, e.bname;
  else
    return query select e.status, -1, 0, 0, avg_min,
                        e.joined_at, e.called_at, e.completed_at, e.bname;
  end if;
end; $$;


-- 4. RPC: lab worker calls next person in line
create or replace function public.queue_call_next(p_business_id uuid)
returns table (
  entry_id   uuid,
  name       text,
  phone      text,
  position   int
) language plpgsql security definer as $$
declare
  next_id uuid;
  next_name text;
  next_phone text;
begin
  -- Pick the oldest waiting entry
  select id, name, phone into next_id, next_name, next_phone
    from public.queue_entries
    where business_id = p_business_id and status = 'waiting'
    order by joined_at asc limit 1
    for update skip locked;

  if next_id is null then
    return;  -- no rows
  end if;

  update public.queue_entries
    set status = 'in_progress', called_at = now()
    where id = next_id;

  return query select next_id, next_name, next_phone, 0;
end; $$;


-- 5. RPC: lab worker marks the in-progress entry as completed
create or replace function public.queue_complete(p_entry_id uuid)
returns void language sql security definer as $$
  update public.queue_entries
    set status = 'completed', completed_at = now()
    where id = p_entry_id and status = 'in_progress';
$$;


-- 6. RPC: patient leaves the queue voluntarily
create or replace function public.queue_leave(p_entry_id uuid)
returns void language sql security definer as $$
  update public.queue_entries
    set status = 'left'
    where id = p_entry_id and status = 'waiting';
$$;


-- 7. View: full queue snapshot for the dashboard
create or replace view public.v_queue_today as
select
  q.id, q.business_id, q.name, q.phone, q.status,
  q.joined_at, q.called_at, q.completed_at, q.served_min,
  -- live position for waiting entries; null otherwise
  case when q.status = 'waiting' then
    (select count(*) + 1 from public.queue_entries q2
       where q2.business_id = q.business_id
         and q2.status = 'waiting'
         and q2.joined_at < q.joined_at)
  end as position
from public.queue_entries q
where q.joined_at::date = current_date
order by q.joined_at;


-- 8. Realtime publication so the patient PWA can subscribe live
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    perform 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'queue_entries';
    if not found then
      execute 'alter publication supabase_realtime add table public.queue_entries';
    end if;
  end if;
end $$;


-- 9. RLS: anyone with a valid entry id can read it; staff sees their business
alter table public.queue_entries enable row level security;

drop policy if exists qe_owner on public.queue_entries;
create policy qe_owner on public.queue_entries
  for all using (
    business_id in (select id from public.businesses where owner_user_id = auth.uid())
    or business_id in (select business_id from public.users where auth_uid = auth.uid())
  );

-- The patient calls queue_status / queue_join via SECURITY DEFINER RPCs,
-- so they don't need direct row access.
grant execute on function public.queue_join(uuid, text, text, uuid, uuid)   to anon, authenticated;
grant execute on function public.queue_status(uuid)                         to anon, authenticated;
grant execute on function public.queue_call_next(uuid)                      to authenticated;
grant execute on function public.queue_complete(uuid)                       to authenticated;
grant execute on function public.queue_leave(uuid)                          to anon, authenticated;
