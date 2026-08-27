-- Seal an exact recording manifest so refresh/lost responses can be reconciled
-- against authenticated, server-reserved S3 keys without guessing the last part.
BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS recording_manifest_sealed_at TIMESTAMP;
ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS recording_expected_part_count INTEGER;
ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS attempt_record_mode VARCHAR(16);

-- Freeze existing active/submitted attempts at the mode visible during rollout.
-- Pending students remain NULL until /verify or start captures their attempt mode.
UPDATE public.students s
SET attempt_record_mode = COALESCE(NULLIF(b.record_mode, ''),
  CASE WHEN b.record_enabled THEN 's3' ELSE 'none' END)
FROM public.batches b
WHERE b.id = s.batch_id
  AND s.attempt_record_mode IS NULL
  AND s.status IN ('in_progress', 'submitted');

CREATE TABLE IF NOT EXISTS public.app_schema_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.app_schema_state (id, version, updated_at)
VALUES (1, 4, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO UPDATE
SET version = GREATEST(app_schema_state.version, EXCLUDED.version),
    updated_at = CURRENT_TIMESTAMP;

COMMIT;

SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'students'
  AND column_name IN (
    'recording_manifest_sealed_at', 'recording_expected_part_count', 'attempt_record_mode'
  )
ORDER BY column_name;

SELECT id, version, updated_at
FROM public.app_schema_state
WHERE id = 1;
