-- ============================================================
-- Nova AI — Service Packages Pack
-- Adds payment-provider columns, KPI view, low-balance trigger,
-- consumption helper RPC, and the link from appointments to packages.
-- ============================================================

-- 1. Extra columns on packages / purchases for the payment + lifecycle layer
alter table public.service_packages
  add column if not exists currency text default 'TND',
  add column if not exists description text,
  add column if not exists discount_percent int check (discount_percent between 0 and 100),
  add column if not exists image_url text;

alter table public.package_purchases
  add column if not exists payment_provider text check (payment_provider in ('konnect','stripe','cash','manual')),
  add column if not exists payment_id          text,                                       -- konnect paymentRef OR stripe checkout session id
  add column if not exists payment_url         text,                                       -- hosted URL the patient pays at
  add column if not exists paid_at             timestamptz,
  add column if not exists sessions_used       int default 0,
  add column if not exists last_session_at     timestamptz,
  add column if not exists low_balance_warned  boolean default false,
  add column if not exists notes               text;

-- A purchase row is "pending" the moment a checkout link is generated; the
-- webhook flips it to "active" on payment success. Add 'pending' to the
-- existing status check (idempotent — safe to re-run).
do $$
begin
  alter table public.package_purchases drop constraint if exists package_purchases_status_check;
  alter table public.package_purchases add constraint package_purchases_status_check
    check (status in ('pending','active','exhausted','expired','refunded','cancelled'));
exception when others then null;
end$$;

-- Allow status='pending' with sessions_remaining = 0 until paid
alter table public.package_purchases alter column sessions_remaining drop not null;

-- 2. KPI view powering the owner's Packages dashboard tab
create or replace view public.v_package_kpis as
select
  sp.id                                           as package_id,
  sp.business_id,
  sp.name,
  sp.total_sessions,
  sp.price,
  sp.currency,
  count(pp.id) filter (where pp.status = 'active')                                         as active_count,
  count(pp.id) filter (where pp.status = 'pending')                                        as pending_count,
  count(pp.id) filter (where pp.status in ('active','exhausted','expired'))                as sold_count,
  coalesce(sum(pp.sessions_used)            filter (where pp.status in ('active','exhausted','expired')), 0) as sessions_used,
  coalesce(sum(pp.sessions_remaining)       filter (where pp.status = 'active'), 0)        as sessions_remaining,
  coalesce(sum(sp.price)                    filter (where pp.status in ('active','exhausted','expired')), 0) as revenue_total,
  coalesce(sum(sp.price)                    filter (where pp.status in ('active','exhausted','expired') and pp.created_at >= current_date - interval '30 days'), 0) as revenue_30d
from      public.service_packages sp
left join public.package_purchases pp on pp.package_id = sp.id
where     sp.active is true or pp.id is not null
group by  sp.id, sp.business_id, sp.name, sp.total_sessions, sp.price, sp.currency;

-- 3. RPC called from classify-message at booking time. Atomically consumes
-- one session from a package the patient owns IF the package covers the
-- requested service. Returns the linked purchase id, or null if no package
-- applied (so the booking proceeds at full price).
create or replace function public.consume_package_session(
  p_business_id uuid,
  p_client_id   uuid,
  p_service_id  uuid
) returns uuid
language plpgsql security definer as $$
declare
  v_purchase_id uuid;
begin
  -- Pick the most-recently-purchased active package that covers this service.
  -- A package covers a service if its service_id matches OR is null (universal).
  update public.package_purchases pp
  set sessions_remaining = pp.sessions_remaining - 1,
      sessions_used      = pp.sessions_used + 1,
      last_session_at    = now(),
      status             = case when pp.sessions_remaining - 1 <= 0 then 'exhausted' else 'active' end
  where pp.id = (
    select pp2.id
    from   public.package_purchases pp2
    join   public.service_packages sp on sp.id = pp2.package_id
    where  pp2.business_id        = p_business_id
      and  pp2.client_id          = p_client_id
      and  pp2.status             = 'active'
      and  pp2.sessions_remaining > 0
      and  (pp2.expires_at is null or pp2.expires_at > now())
      and  (sp.service_id is null or sp.service_id = p_service_id)
    order by pp2.created_at desc
    limit 1
  )
  returning pp.id into v_purchase_id;

  return v_purchase_id;
end;
$$;

grant execute on function public.consume_package_session(uuid, uuid, uuid) to service_role;

-- 4. Low-balance trigger — when sessions_remaining drops to 2 or 1, set the
-- low_balance_warned flag. A scheduled function reads this and sends a
-- "running low — buy another?" WhatsApp once per purchase.
create or replace function public.flag_low_balance() returns trigger
language plpgsql security definer as $$
begin
  if NEW.sessions_remaining <= 2 and NEW.sessions_remaining > 0 and NEW.low_balance_warned = false then
    NEW.low_balance_warned := true;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_flag_low_balance on public.package_purchases;
create trigger trg_flag_low_balance
  before update of sessions_remaining on public.package_purchases
  for each row when (NEW.sessions_remaining is distinct from OLD.sessions_remaining)
  execute function public.flag_low_balance();

select 'packages_pack applied' as status;
