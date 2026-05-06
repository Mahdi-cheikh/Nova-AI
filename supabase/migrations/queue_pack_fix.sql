-- supabase/migrations/queue_pack_fix.sql
-- FIX: "position" is a reserved word in PostgreSQL — Postgres parses it as the
-- start of POSITION(substring IN string) and bails with a syntax error in
-- RETURNS TABLE definitions. Rename to queue_pos everywhere.
-- Apply this AFTER queue_pack.sql (or instead of it on a fresh project).
-- ================================================================

-- 1. Make sure the table exists (idempotent)
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
  served_min    int generated always as (
    case when called_at is not null and completed_at is not null
         then greatest(0, (extract(epoch from (completed_at - called_at)) / 60))::int
    end
  ) stored
);
create index if not exists idx_queue_biz_status_joined on public.queue_entries(business_id, status, joined_at);
create index if not exists idx_queue_completed on public.queue_entries(business_id, completed_at) where completed_at is not null;

-- 2. Drop the broken functions if they exist
drop function if exists public.queue_join(uuid, text, text, uuid, uuid);
drop function if exists public.queue_status(uuid);
drop function if exists public.queue_call_next(uuid);
drop function if exists public.queue_complete(uuid);
drop function if exists public.queue_leave(uuid);
drop view if exists public.v_queue_today;

-- 3. Recreate with queue_pos instead of position
create or replace function public.queue_join(
  p_business_id   uuid,
  p_name          text,
  p_phone         text default null,
  p_client_id     uuid default null,
  p_appointment_id uuid default null
) returns table (
  entry_id      uuid,
  queue_pos     int,
  eta_minutes   int,
  avg_serve_min numeric
) language plpgsql security definer as $$
declare
  new_id uuid;
  pos    int;
  avg_min numeric;
begin
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

  select count(*) + 1 into pos
    from public.queue_entries q
    where q.business_id = p_business_id
      and q.status = 'waiting'
      and q.joined_at < (select joined_at from public.queue_entries where id = new_id);

  select coalesce(avg(served_min), 8)::numeric
    into avg_min
    from (
      select served_min from public.queue_entries
      where business_id = p_business_id and served_min is not null
      order by completed_at desc limit 20
    ) t;

  return query select new_id, pos, ((pos - 1) * avg_min)::int, avg_min;
end; $$;


create or replace function public.queue_status(p_entry_id uuid)
returns table (
  status         text,
  queue_pos      int,
  eta_minutes    int,
  ahead_count    int,
  avg_serve_min  numeric,
  joined_at      timestamptz,
  called_at      timestamptz,
  completed_at   timestamptz,
  business_name  text
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


create or replace function public.queue_call_next(p_business_id uuid)
returns table (
  entry_id   uuid,
  name       text,
  phone      text,
  queue_pos  int
) language plpgsql security definer as $$
declare
  next_id uuid;
  next_name text;
  next_phone text;
begin
  select id, name, phone into next_id, next_name, next_phone
    from public.queue_entries
    where business_id = p_business_id and status = 'waiting'
    order by joined_at asc limit 1
    for update skip locked;

  if next_id is null then return; end if;

  update public.queue_entries
    set status = 'in_progress', called_at = now()
    where id = next_id;

  return query select next_id, next_name, next_phone, 0;
end; $$;


create or replace function public.queue_complete(p_entry_id uuid)
returns void language sql security definer as $$
  update public.queue_entries
    set status = 'completed', completed_at = now()
    where id = p_entry_id and status = 'in_progress';
$$;


create or replace function public.queue_leave(p_entry_id uuid)
returns void language sql security definer as $$
  update public.queue_entries
    set status = 'left'
    where id = p_entry_id and status = 'waiting';
$$;


-- 4. Recreate the view with queue_pos
create or replace view public.v_queue_today as
select
  q.id, q.business_id, q.name, q.phone, q.status,
  q.joined_at, q.called_at, q.completed_at, q.served_min,
  case when q.status = 'waiting' then
    (select count(*) + 1 from public.queue_entries q2
       where q2.business_id = q.business_id
         and q2.status = 'waiting'
         and q2.joined_at < q.joined_at)
  end as queue_pos
from public.queue_entries q
where q.joined_at::date = current_date
order by q.joined_at;


-- 5. Realtime publication (idempotent)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    perform 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'queue_entries';
    if not found then
      execute 'alter publication supabase_realtime add table public.queue_entries';
    end if;
  end if;
end $$;


-- 6. RLS
alter table public.queue_entries enable row level security;
drop policy if exists qe_owner on public.queue_entries;
create policy qe_owner on public.queue_entries
  for all using (
    business_id in (select id from public.businesses where owner_user_id = auth.uid())
    or business_id in (select business_id from public.users where auth_uid = auth.uid())
  );

grant execute on function public.queue_join(uuid, text, text, uuid, uuid)   to anon, authenticated;
grant execute on function public.queue_status(uuid)                         to anon, authenticated;
grant execute on function public.queue_call_next(uuid)                      to authenticated;
grant execute on function public.queue_complete(uuid)                       to authenticated;
grant execute on function public.queue_leave(uuid)                          to anon, authenticated;
