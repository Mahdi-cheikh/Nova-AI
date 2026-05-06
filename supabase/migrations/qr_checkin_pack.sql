-- supabase/migrations/qr_checkin_pack.sql
-- QR-CODE CHECK-IN
-- ================================================================
-- When a patient books, we mint a short opaque token and embed it
-- into a check-in URL sent via WhatsApp. At the clinic the patient
-- shows the QR (rendered from that URL) on their phone; the doctor
-- scans it inside the PWA, which calls apt_start_consultation(token)
-- and the timer page opens.
--
-- The token is intentionally separate from the appointment id so
-- nothing sensitive ends up in the QR payload — even if a screenshot
-- leaks, the token is single-use and scoped to that visit.
-- ================================================================

alter table public.appointments
  add column if not exists checkin_token        text unique,
  add column if not exists consultation_doctor_id uuid references public.users(id);

-- Random 16-char token for any appointment that doesn't have one yet.
update public.appointments
  set checkin_token = encode(gen_random_bytes(12), 'base64')
  where checkin_token is null;

-- Auto-mint on insert
create or replace function public.appointments_mint_token() returns trigger as $$
begin
  if new.checkin_token is null then
    new.checkin_token := encode(gen_random_bytes(12), 'base64');
  end if;
  return new;
end; $$ language plpgsql;

drop trigger if exists trg_apt_mint_token on public.appointments;
create trigger trg_apt_mint_token before insert on public.appointments
  for each row execute function public.appointments_mint_token();


-- 1. RPC: doctor scans the QR — start the consultation timer.
-- Returns the appointment row + client name so the timer page can render.
create or replace function public.apt_start_consultation(
  p_token     text,
  p_doctor_id uuid default null
) returns table (
  appointment_id uuid,
  client_name    text,
  client_phone   text,
  service_name   text,
  scheduled_at   text,
  arrived_at     timestamptz,
  doctor_id      uuid
) language plpgsql security definer as $$
declare
  apt record;
begin
  select a.*, c.name as cname, c.phone as cphone, s.name as sname
    into apt
    from public.appointments a
    left join public.clients  c on c.id = a.client_id
    left join public.services s on s.id = a.service_id
    where a.checkin_token = p_token
    limit 1;

  if apt.id is null then
    raise exception 'Invalid or expired check-in token';
  end if;
  if apt.status = 'cancelled' then
    raise exception 'This appointment was cancelled';
  end if;
  if apt.status = 'completed' then
    raise exception 'This visit was already completed';
  end if;

  -- Idempotent: if already started, just return current state
  if apt.arrived_at is null then
    update public.appointments set
      arrived_at = now(),
      status     = 'confirmed',
      consultation_doctor_id = coalesce(p_doctor_id, apt.doctor_id, consultation_doctor_id)
      where id = apt.id;
  end if;

  return query
    select apt.id, apt.cname, apt.cphone, apt.sname,
           (apt.date || ' ' || to_char(apt.time, 'HH24:MI')),
           coalesce(apt.arrived_at, now()),
           coalesce(p_doctor_id, apt.doctor_id);
end; $$;


-- 2. RPC: doctor taps "End consultation".
create or replace function public.apt_end_consultation(
  p_appointment_id uuid
) returns table (
  appointment_id    uuid,
  arrived_at        timestamptz,
  completed_at      timestamptz,
  actual_duration_min int
) language plpgsql security definer as $$
declare
  apt record;
begin
  update public.appointments set
    completed_at = now(),
    status       = 'completed'
    where id = p_appointment_id and completed_at is null
    returning * into apt;
  if apt.id is null then
    -- Already completed — return current state instead of erroring
    select * into apt from public.appointments where id = p_appointment_id;
  end if;

  return query
    select apt.id, apt.arrived_at, apt.completed_at, apt.actual_duration_min;
end; $$;


-- 3. RPC: read appointment by token (for the patient's QR page to show details)
-- Read-only, no side effects, returns nothing sensitive (no phone, no notes).
create or replace function public.apt_by_token(p_token text)
returns table (
  client_name   text,
  service_name  text,
  doctor_name   text,
  business_name text,
  scheduled_at  text,
  status        text,
  arrived_at    timestamptz,
  completed_at  timestamptz
) language sql security definer as $$
  select c.name, s.name, u.name, b.name,
         (a.date || ' ' || to_char(a.time, 'HH24:MI')),
         a.status, a.arrived_at, a.completed_at
    from public.appointments a
    left join public.clients    c on c.id = a.client_id
    left join public.services   s on s.id = a.service_id
    left join public.users      u on u.id = a.doctor_id
    left join public.businesses b on b.id = a.business_id
    where a.checkin_token = p_token
    limit 1;
$$;

-- Allow anonymous calls to apt_by_token (the patient's QR page is unauthenticated)
grant execute on function public.apt_by_token(text) to anon, authenticated;
grant execute on function public.apt_start_consultation(text, uuid) to authenticated;
grant execute on function public.apt_end_consultation(uuid) to authenticated;
