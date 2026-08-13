-- Per-batch AI grading switch and global worker pause switch.
-- Idempotent: safe to run more than once on PostgreSQL/Supabase.

ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS ai_grading_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.ai_settings (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  apiKey TEXT,
  model TEXT NOT NULL,
  temperature REAL DEFAULT 0.3,
  maxTokens INTEGER DEFAULT 2048,
  worker_enabled BOOLEAN NOT NULL DEFAULT TRUE
);

ALTER TABLE public.ai_settings
  ADD COLUMN IF NOT EXISTS worker_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_exam_sessions_student_last_seen
  ON public.exam_sessions(student_id, last_seen);
