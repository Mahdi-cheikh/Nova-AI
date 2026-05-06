-- supabase/migrations/drug_check_pack.sql
-- DRUG-INTERACTION + ALLERGY CHECKER
-- ================================================================
-- Stores each patient's current medication list + allergy list as
-- structured JSON, plus an audit-trail of every prescription check
-- (the AI's verdict, the doctor's decision, the patient context that
-- was sent). The audit trail is the malpractice-defence asset: if a
-- doctor was warned and chose to override, that's recorded forever.
-- ================================================================

-- 1. Per-patient medications + allergies
-- medications:  [{name:"Loratadine",     dose:"10mg",  freq:"daily",     started_at:"2026-04-01"}, ...]
-- allergies:    [{substance:"Penicillin", severity:"high", reaction:"anaphylaxis"}, ...]
-- conditions:   [{name:"Asthma",          since:"2018"}, ...]   (optional but useful for the AI)
alter table public.clients
  add column if not exists medications jsonb not null default '[]'::jsonb,
  add column if not exists allergies   jsonb not null default '[]'::jsonb,
  add column if not exists conditions  jsonb not null default '[]'::jsonb;


-- 2. Prescription-check audit table
-- Every time a doctor submits a prescription for AI review, we log:
--   • the prescription text
--   • the patient context that was sent (snapshot of meds/allergies/conditions)
--   • the AI's verdict (interactions, allergy hits, severity)
--   • the doctor's final decision (proceeded / cancelled / amended)
create table if not exists public.prescription_checks (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  client_id       uuid not null references public.clients(id)    on delete cascade,
  appointment_id  uuid references public.appointments(id) on delete set null,
  doctor_id       uuid references public.users(id) on delete set null,
  prescription    text not null,
  patient_context jsonb not null default '{}'::jsonb,    -- snapshot at check time
  ai_verdict      jsonb,                                 -- structured response
  highest_severity text check (highest_severity in ('none','low','medium','high','critical')),
  decision        text check (decision in ('safe','warned_proceeded','warned_amended','warned_cancelled')),
  doctor_note     text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_pcheck_client     on public.prescription_checks(client_id, created_at desc);
create index if not exists idx_pcheck_business   on public.prescription_checks(business_id, created_at desc);
create index if not exists idx_pcheck_severity   on public.prescription_checks(business_id, highest_severity);


-- 3. KPI view for the dashboard
create or replace view public.v_prescription_check_kpis as
select
  business_id,
  count(*)                                                                  as checks_total,
  count(*) filter (where created_at > now() - interval '30 days')          as checks_30d,
  count(*) filter (where highest_severity in ('high','critical'))          as warnings_caught,
  count(*) filter (where decision = 'warned_amended')                       as prescriptions_amended,
  count(*) filter (where decision = 'warned_cancelled')                     as prescriptions_cancelled
from public.prescription_checks
group by business_id;


-- 4. RLS — owner + doctors of the same business
alter table public.prescription_checks enable row level security;
drop policy if exists pc_owner on public.prescription_checks;
create policy pc_owner on public.prescription_checks
  for all using (
    business_id in (select id from public.businesses where owner_user_id = auth.uid())
    or business_id in (select business_id from public.users where auth_uid = auth.uid())
  );


-- 5. Helper: bulk-update a patient's medication list (called from the dashboard)
create or replace function public.set_patient_medications(
  p_client_id uuid,
  p_medications jsonb
) returns void language sql security definer as $$
  update public.clients set medications = p_medications where id = p_client_id;
$$;
create or replace function public.set_patient_allergies(
  p_client_id uuid,
  p_allergies jsonb
) returns void language sql security definer as $$
  update public.clients set allergies = p_allergies where id = p_client_id;
$$;
grant execute on function public.set_patient_medications(uuid, jsonb) to authenticated;
grant execute on function public.set_patient_allergies(uuid, jsonb)   to authenticated;
