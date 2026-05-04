-- ============================================================
-- Nova AI — PWA Pack
-- Cross-business patient identity. One patient = one PWA login,
-- can be a client of N businesses (clinic + lab + salon + ...)
-- via separate clients rows linked to a single patient_users row.
-- ============================================================

create table if not exists public.patient_users (
  id            uuid primary key default gen_random_uuid(),
  auth_uid      uuid unique references auth.users(id) on delete cascade,
  full_name     text,
  phone         text,
  email         text,
  language      text default 'en' check (language in ('en','fr','ar')),
  push_token    text,                                       -- web-push subscription endpoint
  push_keys     jsonb,                                      -- {p256dh,auth} for web-push
  city          text,
  -- Optional geo for "find businesses near me"
  latitude      double precision,
  longitude     double precision,
  created_at    timestamptz default now()
);
create unique index if not exists ux_patient_users_phone on public.patient_users(phone) where phone is not null;
create unique index if not exists ux_patient_users_email on public.patient_users(email) where email is not null;

-- Link existing per-business clients rows to one cross-business patient_user
alter table public.clients
  add column if not exists patient_user_id uuid references public.patient_users(id) on delete set null;
create index if not exists idx_clients_patient_user on public.clients(patient_user_id);

-- Family members: one patient can manage appointments for their kids/spouse/parents
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

-- ---------- RLS so each patient sees only their own data ----------
alter table public.patient_users  enable row level security;
alter table public.patient_family enable row level security;

drop policy if exists "patient_self_select" on public.patient_users;
create policy "patient_self_select" on public.patient_users
  for select using (auth_uid = auth.uid());
drop policy if exists "patient_self_modify" on public.patient_users;
create policy "patient_self_modify" on public.patient_users
  for all using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());

drop policy if exists "family_self_all" on public.patient_family;
create policy "family_self_all" on public.patient_family
  for all using (patient_user_id in (select id from public.patient_users where auth_uid = auth.uid()))
          with check (patient_user_id in (select id from public.patient_users where auth_uid = auth.uid()));

-- A patient should be able to read THEIR rows in clients across any business.
-- We add a permissive read policy that bypasses tenant isolation when the
-- requesting user is the linked patient_user.
drop policy if exists "clients_patient_self_select" on public.clients;
create policy "clients_patient_self_select" on public.clients
  for select using (
    patient_user_id in (select id from public.patient_users where auth_uid = auth.uid())
    or business_id  = public.current_business_id()
  );

-- Same for appointments / messages / lab_orders / lab_results / appointment_reviews —
-- a patient sees their own rows across every business they are a client of.
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
  raise notice 'Some tables may not have client_id; ignoring: %', sqlerrm;
end$$;

-- ---------- Auto-link clients-to-patient on PWA sign-in ----------
-- Trigger: when a patient_users row is inserted/updated, find existing clients
-- with the same phone or email and link them by setting patient_user_id.
create or replace function public.link_clients_to_patient() returns trigger
language plpgsql security definer as $$
begin
  if NEW.phone is not null then
    update public.clients
    set patient_user_id = NEW.id
    where phone = NEW.phone
      and patient_user_id is null;
  end if;
  if NEW.email is not null then
    update public.clients
    set patient_user_id = NEW.id
    where email = NEW.email
      and patient_user_id is null;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_link_clients_to_patient on public.patient_users;
create trigger trg_link_clients_to_patient
  after insert or update of phone, email on public.patient_users
  for each row execute function public.link_clients_to_patient();

-- ---------- Auto-create patient_users on new auth.users ----------
-- When someone signs in via the PWA for the first time, automatically create
-- a patient_users row keyed to their auth.users.id.
create or replace function public.bootstrap_patient_user() returns trigger
language plpgsql security definer as $$
begin
  insert into public.patient_users (auth_uid, email, full_name)
  values (NEW.id, NEW.email, coalesce(NEW.raw_user_meta_data->>'full_name', NEW.email))
  on conflict (auth_uid) do nothing;
  return NEW;
end;
$$;

drop trigger if exists trg_bootstrap_patient on auth.users;
create trigger trg_bootstrap_patient
  after insert on auth.users
  for each row execute function public.bootstrap_patient_user();
