-- Removes the retired per-question AI queue and global plaintext AI setting.
-- The manual AI Grade flow uses user_ai_settings and student/batch grading state.
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.batches
  DROP COLUMN IF EXISTS ai_setting_id;

ALTER TABLE public.batches
  DROP COLUMN IF EXISTS ai_grading_enabled;

DROP TABLE IF EXISTS public.ai_queue;
DROP TABLE IF EXISTS public.ai_settings;

CREATE TABLE IF NOT EXISTS public.app_schema_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.app_schema_state (id, version, updated_at)
VALUES (1, 2, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO UPDATE
SET version = EXCLUDED.version,
    updated_at = CURRENT_TIMESTAMP;

COMMIT;

SELECT id, version, updated_at
FROM public.app_schema_state
WHERE id = 1;
