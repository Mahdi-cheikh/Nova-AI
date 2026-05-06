-- supabase/migrations/vehicle_pack.sql
-- VEHICLE PROFILES + SERVICE HISTORY  (garage / mecanique only)
-- ================================================================
-- Each car becomes a first-class entity with VIN, mileage, plates,
-- a chronological service log, and photo evidence of damage.
-- WhatsApp messages tagged to a specific vehicle build the file
-- automatically over time.
-- ================================================================

create table if not exists public.vehicles (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses(id) on delete cascade,
  client_id          uuid not null references public.clients(id)    on delete cascade,
  vin                text,
  license_plate      text,
  make               text,
  model              text,
  year               int,
  color              text,
  fuel_type          text check (fuel_type in ('petrol','diesel','hybrid','electric','lpg')),
  transmission       text check (transmission in ('manual','automatic')),
  current_mileage_km int,
  last_oil_change_at        timestamptz,
  last_oil_change_km        int,
  next_oil_change_due_km    int,                -- e.g. last + 10 000
  insurance_expires_at      date,
  inspection_expires_at     date,
  primary_photo_url  text,
  notes              text,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
create index if not exists idx_veh_business on public.vehicles(business_id);
create index if not exists idx_veh_client   on public.vehicles(client_id);
create unique index if not exists ux_veh_plate on public.vehicles(business_id, license_plate)
  where license_plate is not null;
create unique index if not exists ux_veh_vin on public.vehicles(business_id, vin)
  where vin is not null;

drop trigger if exists trg_vehicles_updated on public.vehicles;
create trigger trg_vehicles_updated before update on public.vehicles
  for each row execute function public.touch_updated_at();


-- 2. Service history — each work order or visit
create table if not exists public.vehicle_services (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  vehicle_id      uuid not null references public.vehicles(id)   on delete cascade,
  appointment_id  uuid references public.appointments(id) on delete set null,
  performed_at    timestamptz not null default now(),
  service_type    text not null,        -- "oil_change", "brake_pads", "diagnostic", "tyre_rotation", ...
  description     text,
  parts_used      jsonb not null default '[]'::jsonb,   -- [{name,sku,qty,unit_price}]
  parts_total     numeric default 0,
  labour_total    numeric default 0,
  total_cost      numeric default 0,
  mileage_km      int,
  technician_id   uuid references public.users(id) on delete set null,
  next_service_due_km   int,
  next_service_due_at   timestamptz,
  notes           text,
  photos          jsonb not null default '[]'::jsonb,    -- [{url,caption,kind:'before'|'after'|'damage'}]
  created_at      timestamptz default now()
);
create index if not exists idx_vs_vehicle on public.vehicle_services(vehicle_id, performed_at desc);
create index if not exists idx_vs_business on public.vehicle_services(business_id, performed_at desc);


-- 3. Photo timeline (separate from services so casual photos sent over WhatsApp
-- can land on the file without needing a full service entry).
create table if not exists public.vehicle_photos (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references public.businesses(id) on delete cascade,
  vehicle_id   uuid not null references public.vehicles(id)   on delete cascade,
  message_id   uuid references public.messages(id) on delete set null,
  url          text not null,
  caption      text,
  kind         text default 'general' check (kind in ('general','damage','before','after','dashboard','document')),
  taken_at     timestamptz not null default now(),
  uploaded_by  uuid references public.users(id) on delete set null
);
create index if not exists idx_vph_vehicle on public.vehicle_photos(vehicle_id, taken_at desc);


-- 4. View: vehicle profile with computed flags
create or replace view public.v_vehicle_profile as
select
  v.*,
  c.name  as owner_name,
  c.phone as owner_phone,
  -- Days until insurance / inspection expires (negative = expired)
  case when v.insurance_expires_at  is not null then (v.insurance_expires_at - current_date)::int  end as insurance_days,
  case when v.inspection_expires_at is not null then (v.inspection_expires_at - current_date)::int end as inspection_days,
  -- Km until next oil change (negative = overdue)
  case when v.next_oil_change_due_km is not null and v.current_mileage_km is not null
       then v.next_oil_change_due_km - v.current_mileage_km end as km_until_oil,
  (select count(*) from public.vehicle_services s where s.vehicle_id = v.id) as service_count,
  (select max(performed_at) from public.vehicle_services s where s.vehicle_id = v.id) as last_service_at,
  (select count(*) from public.vehicle_photos p where p.vehicle_id = v.id) as photo_count
from public.vehicles v
left join public.clients c on c.id = v.client_id;


-- 5. RPC: find a vehicle for an incoming WhatsApp message.
-- Tries plate first (most accurate), then VIN, then make/model heuristic
-- on the most recent vehicle this client owns.
create or replace function public.find_vehicle_for_message(
  p_business_id uuid,
  p_client_id   uuid,
  p_text        text default null
) returns table (vehicle_id uuid, match_type text, confidence text)
language plpgsql security definer as $$
declare
  found_id uuid;
  plate_pat text;
  vin_pat   text;
begin
  -- Tunisian plates: 9 digits split as NNN TUN NNN, sometimes shown ТП-style
  -- We just look for any 6-9 contiguous digits as a heuristic.
  if p_text is not null then
    plate_pat := (regexp_match(upper(p_text), '([0-9]{2,4}\s*TU[NS]?\s*[0-9]{2,5}|[0-9]{4,9})'))[1];
    if plate_pat is not null then
      select id into found_id from public.vehicles
        where business_id = p_business_id
          and license_plate is not null
          and regexp_replace(license_plate, '\s+', '', 'g') = regexp_replace(plate_pat, '\s+', '', 'g')
        limit 1;
      if found_id is not null then
        return query select found_id, 'plate'::text, 'high'::text;
        return;
      end if;
    end if;

    -- VIN: 17 alphanumeric chars (excluding I O Q)
    vin_pat := (regexp_match(upper(p_text), '([A-HJ-NPR-Z0-9]{17})'))[1];
    if vin_pat is not null then
      select id into found_id from public.vehicles
        where business_id = p_business_id and upper(vin) = vin_pat limit 1;
      if found_id is not null then
        return query select found_id, 'vin'::text, 'high'::text;
        return;
      end if;
    end if;
  end if;

  -- Fallback: most recently created vehicle for this client
  select id into found_id from public.vehicles
    where business_id = p_business_id and client_id = p_client_id
    order by created_at desc limit 1;
  if found_id is not null then
    return query select found_id, 'client_default'::text, 'medium'::text;
    return;
  end if;

  -- Nothing matched
  return;
end; $$;


-- 6. RPC: append a service entry. Auto-updates the vehicle's mileage +
-- last_oil_change fields when the service_type is oil_change.
create or replace function public.add_vehicle_service(
  p_vehicle_id    uuid,
  p_service_type  text,
  p_description   text,
  p_parts_used    jsonb default '[]'::jsonb,
  p_parts_total   numeric default 0,
  p_labour_total  numeric default 0,
  p_mileage_km    int default null,
  p_notes         text default null,
  p_photos        jsonb default '[]'::jsonb,
  p_technician_id uuid default null,
  p_appointment_id uuid default null
) returns uuid language plpgsql security definer as $$
declare
  v record;
  svc_id uuid;
  total numeric;
begin
  select * into v from public.vehicles where id = p_vehicle_id;
  if v.id is null then raise exception 'Vehicle not found'; end if;
  total := coalesce(p_parts_total, 0) + coalesce(p_labour_total, 0);

  insert into public.vehicle_services (
    business_id, vehicle_id, appointment_id, service_type, description,
    parts_used, parts_total, labour_total, total_cost,
    mileage_km, notes, photos, technician_id
  ) values (
    v.business_id, p_vehicle_id, p_appointment_id, p_service_type, p_description,
    coalesce(p_parts_used,'[]'::jsonb), coalesce(p_parts_total,0), coalesce(p_labour_total,0), total,
    p_mileage_km, p_notes, coalesce(p_photos,'[]'::jsonb), p_technician_id
  ) returning id into svc_id;

  -- Update the vehicle: bump mileage if higher, stamp oil-change fields
  update public.vehicles set
    current_mileage_km = greatest(coalesce(current_mileage_km,0), coalesce(p_mileage_km, current_mileage_km, 0)),
    last_oil_change_at = case when p_service_type = 'oil_change' then now() else last_oil_change_at end,
    last_oil_change_km = case when p_service_type = 'oil_change' then coalesce(p_mileage_km, last_oil_change_km) else last_oil_change_km end,
    next_oil_change_due_km = case when p_service_type = 'oil_change' and p_mileage_km is not null
                                  then p_mileage_km + 10000
                                  else next_oil_change_due_km end,
    updated_at = now()
    where id = p_vehicle_id;

  return svc_id;
end; $$;


-- 7. KPI view for the dashboard
create or replace view public.v_vehicle_kpis as
select
  v.business_id,
  count(*)                                                          as vehicles_total,
  count(*) filter (where v.created_at > now() - interval '30 days') as new_30d,
  count(*) filter (where (v.next_oil_change_due_km - v.current_mileage_km) <= 0) as oil_change_due,
  count(*) filter (where v.insurance_expires_at  is not null and v.insurance_expires_at  - current_date <= 30) as insurance_due,
  count(*) filter (where v.inspection_expires_at is not null and v.inspection_expires_at - current_date <= 30) as inspection_due
from public.vehicles v
group by v.business_id;


-- 8. RLS
alter table public.vehicles         enable row level security;
alter table public.vehicle_services enable row level security;
alter table public.vehicle_photos   enable row level security;

drop policy if exists veh_owner on public.vehicles;
create policy veh_owner on public.vehicles
  for all using (
    business_id in (select id from public.businesses where owner_user_id = auth.uid())
    or business_id in (select business_id from public.users where auth_uid = auth.uid())
  );
drop policy if exists vs_owner on public.vehicle_services;
create policy vs_owner on public.vehicle_services
  for all using (
    business_id in (select id from public.businesses where owner_user_id = auth.uid())
    or business_id in (select business_id from public.users where auth_uid = auth.uid())
  );
drop policy if exists vp_owner on public.vehicle_photos;
create policy vp_owner on public.vehicle_photos
  for all using (
    business_id in (select id from public.businesses where owner_user_id = auth.uid())
    or business_id in (select business_id from public.users where auth_uid = auth.uid())
  );

grant execute on function public.find_vehicle_for_message(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.add_vehicle_service(uuid, text, text, jsonb, numeric, numeric, int, text, jsonb, uuid, uuid) to authenticated, service_role;
