-- Marks a database that has received all migrations required by the current runtime.
-- Deploy this migration before source that enables the schema-version startup fast path.
BEGIN;

CREATE TABLE IF NOT EXISTS public.app_schema_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.app_schema_state (id, version, updated_at)
VALUES (1, 1, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO UPDATE
SET version = EXCLUDED.version, updated_at = CURRENT_TIMESTAMP;

COMMIT;

SELECT id, version, updated_at
FROM public.app_schema_state
WHERE id = 1;
