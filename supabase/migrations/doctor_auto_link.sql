-- ===========================================================
-- Doctor account auto-link
--
-- When a clinic admin adds a doctor on the Team page, only a
-- public.users row is created (with email, no auth_uid). When
-- that doctor signs up later via magic link / Google with the
-- same email, this trigger automatically links their auth.users
-- row to the existing public.users row.
-- ===========================================================

create or replace function public.link_doctor_account()
returns trigger language plpgsql security definer as $$
begin
  -- Case-insensitive + whitespace-tolerant match. Without this, "Doctor@x.com"
  -- in the team page won't link to "doctor@x.com" used at sign-in.
  update public.users
  set auth_uid = NEW.id
  where lower(trim(email)) = lower(trim(NEW.email))
    and auth_uid is null;
  return NEW;
end;
$$;

-- One-time backfill: link any doctor accounts that signed in BEFORE this fix.
update public.users pu
set auth_uid = au.id
from auth.users au
where pu.auth_uid is null
  and lower(trim(pu.email)) = lower(trim(au.email));

drop trigger if exists trg_link_doctor on auth.users;
create trigger trg_link_doctor
  after insert on auth.users
  for each row execute function public.link_doctor_account();

-- Also handle email confirmations / OAuth verification (auth.users updates)
drop trigger if exists trg_link_doctor_update on auth.users;
create trigger trg_link_doctor_update
  after update of email on auth.users
  for each row execute function public.link_doctor_account();
