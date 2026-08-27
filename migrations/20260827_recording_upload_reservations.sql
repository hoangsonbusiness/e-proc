-- Durable, idempotent logical-upload reservations for direct-to-S3 recordings.
--
-- A client-generated upload_id is stable across presign/PUT/complete retries.
-- The two unique indexes ensure that one logical blob keeps one part index and
-- two different logical blobs can never be assigned the same S3 object key.
BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.recording_upload_reservations (
  id BIGSERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL,
  upload_id VARCHAR(64) NOT NULL CHECK (length(upload_id) BETWEEN 1 AND 64),
  part_index INTEGER NOT NULL CHECK (part_index >= 0),
  object_key TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_recording_upload_reservations_student_upload
  ON public.recording_upload_reservations(student_id, upload_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_recording_upload_reservations_student_part
  ON public.recording_upload_reservations(student_id, part_index);

-- Rolling deployment/backfill: recording_parts existed before durable upload
-- reservations. A completed legacy part must get one canonical reservation so
-- the v4 exact-manifest protocol cannot mistake it for an orphan. Fail closed
-- when an existing reservation claims the same part/upload identity with a
-- different batch, index, or object key.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.recording_parts p
    JOIN public.recording_upload_reservations r
      ON r.student_id = p.student_id AND r.part_index = p.part_index
    WHERE r.batch_id <> p.batch_id OR r.object_key <> p.object_key
  ) THEN
    RAISE EXCEPTION 'recording reservation conflicts with existing recording part';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.recording_parts p
    JOIN public.recording_upload_reservations r
      ON r.student_id = p.student_id
     AND r.upload_id = ('legacy-part:' || p.part_index::text)
    WHERE r.part_index <> p.part_index
       OR r.batch_id <> p.batch_id
       OR r.object_key <> p.object_key
  ) THEN
    RAISE EXCEPTION 'legacy recording upload identity conflicts with an existing reservation';
  END IF;
END $$;

-- Repair the one-sided marker left by a lost/older completion response when
-- the reservation and completed part otherwise match exactly.
UPDATE public.recording_upload_reservations r
SET completed_at = COALESCE(r.completed_at, p.uploaded_at, CURRENT_TIMESTAMP)
FROM public.recording_parts p
WHERE r.student_id = p.student_id
  AND r.part_index = p.part_index
  AND r.batch_id = p.batch_id
  AND r.object_key = p.object_key
  AND r.completed_at IS NULL;

INSERT INTO public.recording_upload_reservations
  (student_id, batch_id, upload_id, part_index, object_key, created_at, completed_at)
SELECT p.student_id, p.batch_id, ('legacy-part:' || p.part_index::text),
       p.part_index, p.object_key,
       COALESCE(p.uploaded_at, CURRENT_TIMESTAMP),
       COALESCE(p.uploaded_at, CURRENT_TIMESTAMP)
FROM public.recording_parts p
WHERE NOT EXISTS (
  SELECT 1
  FROM public.recording_upload_reservations r
  WHERE r.student_id = p.student_id AND r.part_index = p.part_index
);

CREATE TABLE IF NOT EXISTS public.app_schema_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO public.app_schema_state (id, version, updated_at)
VALUES (1, 3, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO UPDATE
SET version = GREATEST(app_schema_state.version, EXCLUDED.version),
    updated_at = CURRENT_TIMESTAMP;

COMMIT;

-- Verification output: seven required columns, two unique indexes, schema v3+.
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'recording_upload_reservations'
  AND column_name IN (
    'student_id', 'batch_id', 'upload_id', 'part_index', 'object_key',
    'created_at', 'completed_at'
  )
ORDER BY column_name;

SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'ux_recording_upload_reservations_student_upload',
    'ux_recording_upload_reservations_student_part'
  )
ORDER BY indexname;

SELECT id, version, updated_at
FROM public.app_schema_state
WHERE id = 1;
