-- supabase/migrations/qr_checkin_pack_fix.sql
-- Fix: "column reference 'completed_at' is ambiguous" in apt_end_consultation.
-- Qualifies the column references to disambiguate from the RETURNS TABLE
-- output parameters of the same name. Apply on top of qr_checkin_pack.sql.

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
  update public.appointments a set
    completed_at = now(),
    status       = 'completed'
    where a.id = p_appointment_id and a.completed_at is null
    returning a.* into apt;

  if apt.id is null then
    -- Already completed — return current state instead of erroring
    select * into apt from public.appointments a where a.id = p_appointment_id;
  end if;

  appointment_id      := apt.id;
  arrived_at          := apt.arrived_at;
  completed_at        := apt.completed_at;
  actual_duration_min := apt.actual_duration_min;
  return next;
end; $$;


-- Same defensive rewrite for apt_start_consultation
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

  if apt.arrived_at is null then
    update public.appointments a set
      arrived_at = now(),
      status     = 'confirmed',
      consultation_doctor_id = coalesce(p_doctor_id, a.doctor_id, a.consultation_doctor_id)
      where a.id = apt.id;
    apt.arrived_at := now();
  end if;

  appointment_id := apt.id;
  client_name    := apt.cname;
  client_phone   := apt.cphone;
  service_name   := apt.sname;
  scheduled_at   := apt.date || ' ' || to_char(apt.time, 'HH24:MI');
  arrived_at     := apt.arrived_at;
  doctor_id      := coalesce(p_doctor_id, apt.doctor_id);
  return next;
end; $$;

grant execute on function public.apt_start_consultation(text, uuid) to authenticated;
grant execute on function public.apt_end_consultation(uuid)         to authenticated;
