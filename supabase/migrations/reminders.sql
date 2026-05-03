-- =======================================================================
-- REMINDER SYSTEM
--
-- 1) Tracks which appointments already had reminders sent (so we don't spam).
-- 2) Schedules the send-reminders Edge Function every 15 minutes.
--
-- IMPORTANT: replace YOUR-SUPABASE-REF and YOUR-SERVICE-ROLE-KEY before running.
-- =======================================================================

-- 1. Add reminder-tracking columns
alter table public.appointments
  add column if not exists reminder_24h_sent_at timestamptz,
  add column if not exists reminder_1h_sent_at  timestamptz;

-- 2. Enable extensions for cron + outbound HTTP from Postgres
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net  with schema extensions;

-- 3. Schedule the Edge Function every 15 minutes
-- Replace the URL host and bearer token with YOUR values:
--   - URL host: https://YOUR-SUPABASE-REF.supabase.co
--   - Authorization: your service_role key (Project Settings -> API -> service_role)

select cron.schedule(
  'nova-send-reminders',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://blhvzuhufygdcnxpcwqx.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsaHZ6dWh1ZnlnZGNueHBjd3F4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzY1NjM5MywiZXhwIjoyMDkzMjMyMzkzfQ.f8Ib7k1ZsgweBulZiH9NsgDXm-mzYeelX8gOcklPTZE',
      'Content-Type', 'application/json'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- Verify:  select * from cron.job;
-- See run history:  select * from cron.job_run_details order by start_time desc limit 20;
-- Re-schedule (replace existing): select cron.unschedule('nova-send-reminders'); then re-run the schedule above.
