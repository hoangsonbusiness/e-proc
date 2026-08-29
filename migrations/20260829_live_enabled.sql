BEGIN;

-- Capture-only Live mode: the candidate must share an entire screen, but no
-- local recording file or S3 recording part is ever created.
ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS live_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.app_schema_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.app_schema_state (id, version, updated_at)
VALUES (1, 6, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO UPDATE
SET version = GREATEST(app_schema_state.version, EXCLUDED.version),
    updated_at = CURRENT_TIMESTAMP;

COMMIT;

