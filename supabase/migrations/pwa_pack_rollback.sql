-- ============================================================
-- Nova AI — Rollback for pwa_pack.sql
-- Removes the PWA / patient-identity layer entirely.
-- Safe to run even if some of the objects don't exist anymore.
-- ============================================================

-- 1. Drop the auth.users bootstrap trigger first (it's what was blocking sign-ups)
drop trigger if exists trg_bootstrap_patient on auth.users;
drop function if exists public.bootstrap_patient_user();

-- 2. Drop the auto-link trigger on patient_users
drop trigger if exists trg_link_clients_to_patient on public.patient_users;
drop function if exists public.link_clients_to_patient();

-- 3. Drop patient-side RLS policies that joined into patient_users
do $$
declare t text;
begin
  for t in select unnest(array['appointments','messages','lab_orders','lab_results','appointment_reviews','clients']) loop
    execute format('drop policy if exists "%1$s_patient_self_select" on public.%1$s;', t);
  end loop;
exception when others then null;
end$$;

drop policy if exists "clients_patient_self_select" on public.clients;
drop policy if exists "patient_self_select"        on public.patient_users;
drop policy if exists "patient_self_modify"        on public.patient_users;
drop policy if exists "family_self_all"            on public.patient_family;

-- 4. Drop the FK column on clients
alter table public.clients drop column if exists patient_user_id;

-- 5. Drop the new tables
drop table if exists public.patient_family cascade;
drop table if exists public.patient_users  cascade;

-- Sanity check
select 'rollback complete' as status;
