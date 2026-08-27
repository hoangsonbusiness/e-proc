-- macOS exam hardening / recording forensic migration
-- Target: Supabase PostgreSQL
-- Safe to run more than once.

BEGIN;

-- Stores structured forensic metadata for events such as rapid text insertion
-- and multiple-display detection. JSON is serialized by the application.
ALTER TABLE public.violation_events
  ADD COLUMN IF NOT EXISTS metadata_json TEXT;

-- Tracks canonical S3 recording reservations acknowledged after browser-observed PUT 2xx.
-- One finalized part index is allowed per student attempt.
CREATE TABLE IF NOT EXISTS public.recording_parts (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL
    REFERENCES public.students(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL,
  part_index INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  byte_size INTEGER,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (student_id, part_index)
);

COMMIT;

-- Verification output: both rows should be returned after a successful run.
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'violation_events' AND column_name = 'metadata_json')
    OR (table_name = 'recording_parts' AND column_name = 'student_id')
  )
ORDER BY table_name, column_name;
