BEGIN;

ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS vmware_check_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS environment_check_passed BOOLEAN,
  ADD COLUMN IF NOT EXISTS environment_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS environment_checked_at TIMESTAMP;

CREATE TABLE IF NOT EXISTS public.app_schema_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.app_schema_state (id, version, updated_at)
VALUES (1, 7, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO UPDATE
SET version = GREATEST(app_schema_state.version, EXCLUDED.version),
    updated_at = CURRENT_TIMESTAMP;

COMMIT;
