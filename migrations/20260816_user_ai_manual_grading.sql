-- User-owned encrypted LLM settings and manual batch-level AI grading state.
-- Requires AI_SETTINGS_ENCRYPTION_KEY in the backend environment before settings can be saved.

CREATE TABLE IF NOT EXISTS public.user_ai_settings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  provider VARCHAR(100) NOT NULL,
  api_protocol VARCHAR(40) NOT NULL,
  base_url TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  key_auth_tag TEXT NOT NULL,
  encryption_key_version INTEGER NOT NULL DEFAULT 1,
  key_mask VARCHAR(32) NOT NULL,
  model VARCHAR(200) NOT NULL,
  test_status VARCHAR(20) NOT NULL DEFAULT 'untested',
  tested_config_hash VARCHAR(64),
  tested_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ck_user_ai_settings_protocol CHECK (api_protocol IN (
    'openai_chat', 'openai_responses', 'anthropic_messages',
    'gemini_generate_content', 'ollama_generate'
  ))
);

ALTER TABLE public.batches ADD COLUMN IF NOT EXISTS ai_setting_id INTEGER REFERENCES public.user_ai_settings(id) ON DELETE RESTRICT;
ALTER TABLE public.batches ADD COLUMN IF NOT EXISTS ai_grading_status VARCHAR(20) NOT NULL DEFAULT 'idle';
ALTER TABLE public.batches ADD COLUMN IF NOT EXISTS ai_grading_started_at TIMESTAMP;
ALTER TABLE public.batches ADD COLUMN IF NOT EXISTS ai_graded_at TIMESTAMP;

ALTER TABLE public.students ADD COLUMN IF NOT EXISTS ai_final_score NUMERIC(4,2);
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS ai_summary_feedback TEXT;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS ai_grading_status VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS ai_grading_error TEXT;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS ai_graded_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_students_batch_ai_grading
  ON public.students(batch_id, status, ai_grading_status);
