-- supabase/migrations/voice_avatar_pack.sql
-- VOICE AVATARS — Nova replies in the owner's actual voice
-- ================================================================
-- The owner records 30 seconds of clean speech in the dashboard.
-- We push it to ElevenLabs voice-cloning and store the resulting
-- voice_id. From then on, when Nova answers a WhatsApp message,
-- the webhook also generates a voice note in the owner's voice and
-- sends it alongside (or instead of) the text.
-- ================================================================

alter table public.businesses
  add column if not exists voice_clone_id        text,
  add column if not exists voice_clone_name      text,
  add column if not exists voice_clone_status    text default 'none'
    check (voice_clone_status in ('none','training','ready','failed')),
  add column if not exists voice_enabled         boolean not null default false,
  add column if not exists voice_sample_path     text,
  add column if not exists voice_clone_created_at timestamptz,
  add column if not exists voice_settings        jsonb default jsonb_build_object(
    'stability',        0.45,
    'similarity_boost', 0.85,
    'style',            0.20,
    'speaker_boost',    true
  );

-- Outbound message audio archive (for replay + cost auditing)
alter table public.messages
  add column if not exists tts_audio_path text,
  add column if not exists tts_voice_id   text;

create index if not exists idx_msg_tts on public.messages(business_id, created_at desc)
  where tts_audio_path is not null;


-- Per-business KPI view
create or replace view public.v_voice_kpis as
select
  business_id,
  count(*) filter (where tts_audio_path is not null and created_at > now() - interval '30 days') as voice_replies_30d,
  count(*) filter (where tts_audio_path is not null) as voice_replies_total,
  count(distinct client_id) filter (where tts_audio_path is not null and created_at > now() - interval '30 days') as patients_reached_30d
from public.messages
group by business_id;
