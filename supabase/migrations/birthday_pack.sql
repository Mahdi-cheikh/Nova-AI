-- supabase/migrations/birthday_pack.sql
-- AI BIRTHDAY SURPRISE
-- ================================================================
-- Every morning Nova scans the client list. Anyone whose birthday is
-- today (any year) gets a personalised WhatsApp + a unique voucher
-- code redeemable for whatever the owner configured (free service,
-- add-on, discount). Each voucher is single-use, scoped to one
-- patient, and expires automatically.
-- ================================================================

-- 1. Patient birthday (date — separate from `age` int so we know the actual day)
alter table public.clients
  add column if not exists birthday date,
  add column if not exists birthday_message_lang text;

create index if not exists idx_clients_birthday_md
  on public.clients (extract(month from birthday), extract(day from birthday))
  where birthday is not null;


-- 2. Per-business birthday config (lives on the businesses row as JSONB)
alter table public.businesses
  add column if not exists birthday_config jsonb not null default jsonb_build_object(
    'enabled',           false,
    'voucher_label',     'Free 30-min add-on of your choice',
    'voucher_value',     0,
    'validity_days',     30,
    'message_template',  null
  );


-- 3. Vouchers — every issuance tracked here
create table if not exists public.birthday_vouchers (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  client_id         uuid not null references public.clients(id)    on delete cascade,
  code              text not null unique,
  label             text not null,
  value_amount      numeric default 0,
  issued_at         timestamptz not null default now(),
  expires_at        timestamptz not null,
  redeemed_at       timestamptz,
  redeemed_appointment_id uuid references public.appointments(id) on delete set null,
  redeemed_by       uuid references public.users(id) on delete set null
);
create index if not exists idx_bv_business_issued on public.birthday_vouchers(business_id, issued_at desc);
create index if not exists idx_bv_client          on public.birthday_vouchers(client_id, issued_at desc);
create index if not exists idx_bv_expires_active  on public.birthday_vouchers(expires_at) where redeemed_at is null;


-- 4. KPI view
create or replace view public.v_birthday_kpis as
select
  business_id,
  count(*) filter (where issued_at > now() - interval '12 months')          as issued_12m,
  count(*) filter (where redeemed_at is not null and issued_at > now() - interval '12 months') as redeemed_12m,
  count(*) filter (where redeemed_at is null and expires_at > now())        as active_now,
  coalesce(sum(value_amount) filter (where redeemed_at is not null), 0)    as total_redeemed_value,
  round(
    100.0 * count(*) filter (where redeemed_at is not null and issued_at > now() - interval '12 months')::numeric
    / nullif(count(*) filter (where issued_at > now() - interval '12 months'), 0),
  1)                                                                       as redemption_rate_pct
from public.birthday_vouchers
group by business_id;


-- 5. RPC: lookup a voucher by code (for staff at checkout, or webhook redemption)
create or replace function public.find_birthday_voucher(p_code text)
returns table (
  voucher_id    uuid,
  business_id   uuid,
  client_id     uuid,
  client_name   text,
  label         text,
  value_amount  numeric,
  issued_at     timestamptz,
  expires_at    timestamptz,
  redeemed_at   timestamptz,
  status        text
) language sql security definer as $$
  select
    v.id, v.business_id, v.client_id, c.name, v.label, v.value_amount,
    v.issued_at, v.expires_at, v.redeemed_at,
    case
      when v.redeemed_at is not null then 'redeemed'
      when v.expires_at < now()      then 'expired'
      else 'active'
    end
  from public.birthday_vouchers v
  left join public.clients c on c.id = v.client_id
  where upper(v.code) = upper(p_code)
  limit 1;
$$;
grant execute on function public.find_birthday_voucher(text) to authenticated, anon, service_role;


-- 6. RPC: mark a voucher as redeemed (called from the dashboard or webhook)
create or replace function public.redeem_birthday_voucher(
  p_code           text,
  p_appointment_id uuid default null,
  p_redeemed_by    uuid default null
) returns table (ok boolean, status text, voucher_id uuid)
language plpgsql security definer as $$
declare v record;
begin
  select * into v from public.birthday_vouchers where upper(code) = upper(p_code);
  if v.id is null then
    return query select false, 'not_found'::text, null::uuid; return;
  end if;
  if v.redeemed_at is not null then
    return query select false, 'already_redeemed'::text, v.id; return;
  end if;
  if v.expires_at < now() then
    return query select false, 'expired'::text, v.id; return;
  end if;

  update public.birthday_vouchers set
    redeemed_at = now(),
    redeemed_appointment_id = p_appointment_id,
    redeemed_by = p_redeemed_by
    where id = v.id;

  return query select true, 'redeemed'::text, v.id;
end; $$;
grant execute on function public.redeem_birthday_voucher(text, uuid, uuid) to authenticated;


-- 7. RLS
alter table public.birthday_vouchers enable row level security;
drop policy if exists bv_owner on public.birthday_vouchers;
create policy bv_owner on public.birthday_vouchers
  for all using (
    business_id in (select id from public.businesses where owner_user_id = auth.uid())
    or business_id in (select business_id from public.users where auth_uid = auth.uid())
  );


-- 8. Cron: every morning at 09:00 (server time)
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'birthday-runner-daily',
      '0 9 * * *',
      $cmd$
      select net.http_post(
        url := current_setting('app.settings.supabase_url') || '/functions/v1/birthday-runner',
        headers := jsonb_build_object('Content-Type','application/json',
          'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')),
        body := jsonb_build_object('mode','run_all')
      );
      $cmd$
    );
  end if;
end $$;
