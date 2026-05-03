-- ===============================================================
-- Nova AI — Laboratoire Pack
-- Adds lab-specific tables (test catalog, orders, results,
-- prescription uploads), columns on appointments for lab metadata,
-- RLS, indexes, and a seed catalog of ~30 common tests in EN/FR/AR.
-- ===============================================================

-- 1. LAB TEST CATALOG ------------------------------------------
-- One row per offered test. Each business curates its own list,
-- but we ship a starter catalog for any business with type='laboratoire'.
create table if not exists public.lab_tests (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  code              text,                                      -- internal code (CBC, GLU, HBA1C, ...)
  name              text not null,                             -- patient-facing name
  name_fr           text,
  name_ar           text,
  category          text check (category in ('hematology','biochemistry','hormones','infection','urine','stool','genetic','allergy','tumor_markers','vitamin','other')),
  sample_type       text check (sample_type in ('blood','urine','stool','swab','saliva','tissue','other')) default 'blood',
  fasting_required  boolean default false,
  fasting_hours     int default 0,
  turnaround_hours  int default 24,                            -- typical time-to-result
  price             numeric not null default 0,
  reference_range   text,                                      -- "70-110 mg/dL" etc.
  active            boolean default true,
  created_at        timestamptz default now(),
  unique (business_id, code)
);
create index if not exists idx_labtests_biz on public.lab_tests(business_id) where active;

-- 2. LAB ORDERS (line items per appointment) -------------------
create table if not exists public.lab_orders (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  appointment_id  uuid not null references public.appointments(id) on delete cascade,
  test_id         uuid not null references public.lab_tests(id) on delete restrict,
  status          text default 'requested' check (status in ('requested','sample_collected','in_analysis','ready','delivered','cancelled')),
  collected_at    timestamptz,
  analysed_at     timestamptz,
  ready_at        timestamptz,
  delivered_at    timestamptz,
  price_charged   numeric,
  notes           text,
  created_at      timestamptz default now()
);
create index if not exists idx_lo_apt on public.lab_orders(appointment_id);
create index if not exists idx_lo_status on public.lab_orders(business_id, status);

-- 3. LAB RESULTS (uploaded files / numeric values) -------------
create table if not exists public.lab_results (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  lab_order_id    uuid not null references public.lab_orders(id) on delete cascade,
  numeric_value   numeric,
  text_value      text,
  unit            text,
  is_critical     boolean default false,
  reference_range text,
  pdf_path        text,                                       -- supabase storage path
  uploaded_by     uuid references public.users(id) on delete set null,
  uploaded_at     timestamptz default now()
);
create index if not exists idx_lr_order on public.lab_results(lab_order_id);

-- 4. PRESCRIPTION UPLOADS --------------------------------------
-- Patient sends a photo of a doctor's prescription via WhatsApp.
-- We store the original + Claude Vision OCR + parsed test list.
create table if not exists public.prescription_uploads (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.businesses(id) on delete cascade,
  client_id           uuid not null references public.clients(id) on delete cascade,
  appointment_id      uuid references public.appointments(id) on delete set null,
  storage_path        text not null,
  ocr_text            text,
  parsed_tests        jsonb,                                  -- [{code,name,confidence}]
  prescriber_name     text,
  prescription_date   date,
  status              text default 'received' check (status in ('received','parsed','reviewed','rejected')),
  uploaded_at         timestamptz default now()
);
create index if not exists idx_presc_client on public.prescription_uploads(client_id);

-- 5. APPOINTMENT COLUMNS — LAB-SPECIFIC METADATA ---------------
alter table public.appointments
  add column if not exists prescription_upload_id  uuid references public.prescription_uploads(id) on delete set null,
  add column if not exists fasting_required        boolean default false,
  add column if not exists home_collection         boolean default false,
  add column if not exists collection_address      text,
  add column if not exists results_delivery        text default 'whatsapp' check (results_delivery in ('whatsapp','email','pickup','portal')),
  add column if not exists results_ready_at        timestamptz,
  add column if not exists results_sent_at         timestamptz,
  add column if not exists total_amount            numeric;

-- 6. RLS POLICIES ----------------------------------------------
alter table public.lab_tests             enable row level security;
alter table public.lab_orders            enable row level security;
alter table public.lab_results           enable row level security;
alter table public.prescription_uploads  enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array['lab_tests','lab_orders','lab_results','prescription_uploads']) loop
    execute format($f$
      drop policy if exists "%1$s_tenant_all" on public.%1$s;
      create policy "%1$s_tenant_all" on public.%1$s
        for all using (business_id = public.current_business_id())
                with check (business_id = public.current_business_id());
    $f$, t);
  end loop;
end$$;

-- 7. STORAGE BUCKETS (run only if not already created) ---------
-- Open Supabase Dashboard → Storage → New bucket → 'prescriptions' (private)
-- Open Supabase Dashboard → Storage → New bucket → 'lab-results' (private)

-- 8. SEED CATALOG (only seeds for businesses that have type='laboratoire'
--    AND have zero lab_tests yet — safe to re-run)
insert into public.lab_tests
  (business_id, code, name, name_fr, name_ar, category, sample_type, fasting_required, fasting_hours, turnaround_hours, price, reference_range)
select b.id, t.code, t.name, t.name_fr, t.name_ar, t.category::text, t.sample_type::text, t.fasting, t.fasthrs, t.tat, t.price, t.refrange
from public.businesses b
cross join (values
  ('CBC',        'Complete Blood Count',          'Numération formule sanguine',     'تعداد الدم الكامل',           'hematology',     'blood',  false, 0,  4,  25,  null),
  ('GLU',        'Fasting Glucose',                'Glycémie à jeun',                'سكر الدم صائم',               'biochemistry',   'blood',  true,  12, 4,  12,  '70-110 mg/dL'),
  ('HBA1C',      'HbA1c (Glycated Hemoglobin)',   'Hémoglobine glyquée',            'الهيموجلوبين السكري',          'biochemistry',   'blood',  false, 0,  24, 35,  '<5.7%'),
  ('LIPID',      'Lipid Panel',                    'Bilan lipidique',                 'صورة الدهون',                  'biochemistry',   'blood',  true,  12, 6,  40,  null),
  ('CHOL',       'Total Cholesterol',              'Cholestérol total',               'الكوليسترول الكلي',            'biochemistry',   'blood',  true,  12, 4,  10,  '<200 mg/dL'),
  ('TG',         'Triglycerides',                  'Triglycérides',                   'الدهون الثلاثية',              'biochemistry',   'blood',  true,  12, 4,  10,  '<150 mg/dL'),
  ('LDL',        'LDL Cholesterol',                'LDL cholestérol',                 'الكوليسترول الضار',            'biochemistry',   'blood',  true,  12, 6,  12,  '<100 mg/dL'),
  ('HDL',        'HDL Cholesterol',                'HDL cholestérol',                 'الكوليسترول الجيد',            'biochemistry',   'blood',  true,  12, 6,  12,  '>40 mg/dL'),
  ('CREAT',      'Creatinine',                     'Créatinine',                      'الكرياتينين',                  'biochemistry',   'blood',  false, 0,  4,  10,  '0.6-1.2 mg/dL'),
  ('UREA',       'Urea / BUN',                     'Urée',                            'البولينا',                     'biochemistry',   'blood',  false, 0,  4,  10,  '7-20 mg/dL'),
  ('ALT',        'ALT (SGPT)',                     'ALAT',                            'إنزيمات الكبد ALT',            'biochemistry',   'blood',  false, 0,  6,  12,  '<40 U/L'),
  ('AST',        'AST (SGOT)',                     'ASAT',                            'إنزيمات الكبد AST',            'biochemistry',   'blood',  false, 0,  6,  12,  '<40 U/L'),
  ('TSH',        'TSH (Thyroid)',                  'TSH',                             'هرمون الغدة الدرقية',          'hormones',       'blood',  false, 0,  24, 28,  '0.4-4.0 mIU/L'),
  ('FT4',        'Free T4',                        'T4 libre',                        'تي 4 الحرة',                   'hormones',       'blood',  false, 0,  24, 28,  null),
  ('FT3',        'Free T3',                        'T3 libre',                        'تي 3 الحرة',                   'hormones',       'blood',  false, 0,  24, 28,  null),
  ('VITD',       'Vitamin D (25-OH)',              'Vitamine D',                      'فيتامين د',                    'vitamin',        'blood',  false, 0,  48, 45,  '30-100 ng/mL'),
  ('VITB12',     'Vitamin B12',                    'Vitamine B12',                    'فيتامين ب12',                  'vitamin',        'blood',  false, 0,  48, 35,  '200-900 pg/mL'),
  ('FERR',       'Ferritin',                       'Ferritine',                       'الفيريتين',                    'biochemistry',   'blood',  false, 0,  24, 30,  null),
  ('IRON',       'Iron',                           'Fer sérique',                     'الحديد',                       'biochemistry',   'blood',  false, 0,  6,  18,  null),
  ('CALC',       'Calcium',                        'Calcium',                         'الكالسيوم',                    'biochemistry',   'blood',  false, 0,  4,  10,  '8.5-10.5 mg/dL'),
  ('CRP',        'C-Reactive Protein',             'CRP',                             'بروتين سي التفاعلي',          'biochemistry',   'blood',  false, 0,  6,  15,  '<5 mg/L'),
  ('ESR',        'ESR (Sed rate)',                 'VS',                              'سرعة ترسب الدم',              'hematology',     'blood',  false, 0,  4,  10,  null),
  ('UA',         'Urinalysis',                     'Analyse d''urine',                'تحليل البول',                  'urine',          'urine',  false, 0,  4,  15,  null),
  ('UCULT',      'Urine Culture',                  'ECBU',                            'مزرعة البول',                  'urine',          'urine',  false, 0,  72, 35,  null),
  ('BHCG',       'Beta-HCG (Pregnancy)',           'Bêta-HCG',                        'هرمون الحمل',                  'hormones',       'blood',  false, 0,  4,  25,  null),
  ('HIV',        'HIV (1+2)',                      'VIH',                             'فحص الإيدز',                   'infection',      'blood',  false, 0,  24, 35,  null),
  ('HBSAG',      'Hepatitis B Surface Antigen',    'Antigène HBs',                    'فيروس الكبد ب',                'infection',      'blood',  false, 0,  24, 30,  null),
  ('HCV',        'Hepatitis C Antibody',           'Anti-HCV',                        'فيروس الكبد سي',               'infection',      'blood',  false, 0,  24, 30,  null),
  ('PSA',        'PSA (Prostate)',                 'PSA',                             'مستضد البروستات',              'tumor_markers',  'blood',  false, 0,  24, 35,  null),
  ('ALLERGY',    'Total IgE',                      'IgE totales',                     'الحساسية الكلية',              'allergy',        'blood',  false, 0,  48, 35,  null)
) as t(code, name, name_fr, name_ar, category, sample_type, fasting, fasthrs, tat, price, refrange)
where b.type = 'laboratoire'
  and not exists (select 1 from public.lab_tests lt where lt.business_id = b.id);

-- 9. KPI VIEW for the lab dashboard ----------------------------
create or replace view public.v_lab_kpis as
select
  b.id   as business_id,
  b.name,
  count(*) filter (where lo.status = 'requested')         as awaiting_collection,
  count(*) filter (where lo.status = 'sample_collected')  as awaiting_analysis,
  count(*) filter (where lo.status = 'in_analysis')       as in_analysis,
  count(*) filter (where lo.status = 'ready')             as ready_to_send,
  count(*) filter (where lo.status = 'delivered'
                   and lo.delivered_at >= current_date - interval '30 days') as delivered_30d,
  coalesce(sum(lo.price_charged) filter (where lo.created_at >= current_date - interval '30 days'), 0) as revenue_30d,
  coalesce(avg(extract(epoch from (lo.ready_at - lo.collected_at))/3600)
              filter (where lo.ready_at is not null and lo.collected_at is not null), 0)::numeric(8,1) as avg_tat_hours
from      public.businesses b
left join public.lab_orders lo on lo.business_id = b.id
where     b.type = 'laboratoire'
group by  b.id, b.name;
