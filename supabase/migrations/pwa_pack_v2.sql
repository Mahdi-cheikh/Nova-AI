-- ============================================================
-- Nova AI — PWA Pack v2 (proper version)
-- - patient_users + patient_family for cross-business identity
-- - NO auto-bootstrap trigger on auth.users (the v1 blocker)
-- - patient_users created explicitly by the PWA on opt-in
-- - phone OTP table for WhatsApp verification on first onboarding
-- - auto-link trigger fires only when phone is verified (set)
-- - role-aware: clients/appointments/etc. visible cross-business to
--   the linked patient, owners/doctors keep tenant view
-- ============================================================

-- Roll back v1 first (idempotent — safe if already rolled back)
drop trigger if exists trg_bootstrap_patient on auth.users;
drop function if exists public.bootstrap_patient_user();

create table if not exists public.patient_users (
  id            uuid primary key default gen_random_uuid(),
  auth_uid      uuid unique not null references auth.users(id) on delete cascade,
  full_name     text,
  phone         text,
  phone_verified boolean default false,
  email         text,
  language      text default 'en' check (language in ('en','fr','ar')),
  push_token    text,
  push_keys     jsonb,
  city          text,
  latitude      double precision,
  longitude     double precision,
  created_at    timestamptz default now()
);
create unique index if not exists ux_patient_users_phone on public.patient_users(phone) where phone is not null;
create unique index if not exists ux_patient_users_email on public.patient_users(email) where email is not null;

alter table public.clients
  add column if not exists patient_user_id uuid references public.patient_users(id) on delete set null;
create index if not exists idx_clients_patient_user on public.clients(patient_user_id);

create table if not exists public.patient_family (
  id                uuid primary key default gen_random_uuid(),
  patient_user_id   uuid not null references public.patient_users(id) on delete cascade,
  full_name         text not null,
  relationship      text check (relationship in ('child','spouse','parent','other')),
  birth_year        int,
  notes             text,
  created_at        timestamptz default now()
);
create index if not exists idx_pf_patient on public.patient_family(patient_user_id);

-- Phone-OTP storage. One pending OTP per patient at a time.
create table if not exists public.patient_phone_otps (
  patient_user_id uuid primary key references public.patient_users(id) on delete cascade,
  phone           text not null,
  code_hash       text not null,
  attempts        int default 0,
  expires_at      timestamptz not null,
  created_at      timestamptz default now()
);

-- ---------- RLS ----------
alter table public.patient_users      enable row level security;
alter table public.patient_family     enable row level security;
alter table public.patient_phone_otps enable row level security;

drop policy if exists "patient_self_all" on public.patient_users;
create policy "patient_self_all" on public.patient_users
  for all using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());

drop policy if exists "family_self_all" on public.patient_family;
create policy "family_self_all" on public.patient_family
  for all using (patient_user_id in (select id from public.patient_users where auth_uid = auth.uid()))
          with check (patient_user_id in (select id from public.patient_users where auth_uid = auth.uid()));

drop policy if exists "otp_self_all" on public.patient_phone_otps;
create policy "otp_self_all" on public.patient_phone_otps
  for all using (patient_user_id in (select id from public.patient_users where auth_uid = auth.uid()))
          with check (patient_user_id in (select id from public.patient_users where auth_uid = auth.uid()));

-- Cross-business read: a patient sees their own rows in clients/appointments/etc.
drop policy if exists "clients_patient_self_select" on public.clients;
create policy "clients_patient_self_select" on public.clients
  for select using (
    patient_user_id in (select id from public.patient_users where auth_uid = auth.uid())
    or business_id  = public.current_business_id()
  );

do $$
declare t text;
begin
  for t in select unnest(array['appointments','messages','lab_orders','lab_results','appointment_reviews']) loop
    execute format($f$
      drop policy if exists "%1$s_patient_self_select" on public.%1$s;
      create policy "%1$s_patient_self_select" on public.%1$s
        for select using (
          client_id in (
            select id from public.clients
            where patient_user_id in (select id from public.patient_users where auth_uid = auth.uid())
          )
          or business_id = public.current_business_id()
        );
    $f$, t);
  end loop;
exception when others then
  raise notice 'skipping table without client_id: %', sqlerrm;
end$$;

-- ---------- Auto-link trigger: fires only when phone is VERIFIED ----------
create or replace function public.link_clients_to_patient_on_verify() returns trigger
language plpgsql security definer as $$
begin
  -- Only run when phone_verified flips to true (or stays true with phone changing)
  if NEW.phone_verified = true and NEW.phone is not null
     and (OLD is null or OLD.phone is distinct from NEW.phone or OLD.phone_verified is distinct from NEW.phone_verified) then
    update public.clients
    set patient_user_id = NEW.id
    where phone = NEW.phone
      and patient_user_id is null;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_link_on_verify on public.patient_users;
create trigger trg_link_on_verify
  after update of phone, phone_verified on public.patient_users
  for each row execute function public.link_clients_to_patient_on_verify();

-- ---------- RPCs called by the PWA ----------
-- Create a patient_users row for the currently signed-in user (idempotent).
-- Called by the PWA when the user opts into the patient experience.
create or replace function public.pwa_ensure_patient_user(p_full_name text default null)
returns public.patient_users
language plpgsql security definer as $$
declare
  v_email text;
  v_row public.patient_users;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.patient_users (auth_uid, email, full_name)
  values (auth.uid(), v_email, p_full_name)
  on conflict (auth_uid) do update
    set full_name = coalesce(public.patient_users.full_name, excluded.full_name)
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.pwa_ensure_patient_user(text) to anon, authenticated;

-- After verifying the OTP, called by pwa-verify-otp Edge Function with service role.
-- Sets phone + phone_verified=true, which fires the auto-link trigger.
create or replace function public.pwa_claim_phone(p_patient_user_id uuid, p_phone text)
returns void
language plpgsql security definer as $$
begin
  update public.patient_users
  set phone = p_phone, phone_verified = true
  where id = p_patient_user_id;

  delete from public.patient_phone_otps where patient_user_id = p_patient_user_id;
end;
$$;

grant execute on function public.pwa_claim_phone(uuid, text) to service_role;

select 'pwa_pack_v2 applied' as status;
