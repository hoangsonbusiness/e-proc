-- Free-tier exam integrity hardening (Supabase/PostgreSQL, run manually).
-- Deliberately adds no heartbeat/telemetry history tables.
BEGIN;

ALTER TABLE public.students ALTER COLUMN access_code TYPE VARCHAR(8);
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS submit_reason TEXT;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS active_jti TEXT;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS recording_finalized_at TIMESTAMP;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS recording_final_part_index INTEGER;
ALTER TABLE public.students ADD COLUMN IF NOT EXISTS recording_incomplete BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS public.recording_parts (
  id BIGSERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL,
  part_index INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  byte_size INTEGER,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(student_id, part_index)
);
ALTER TABLE public.recording_parts ADD COLUMN IF NOT EXISTS is_final BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.students GROUP BY access_code HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate students.access_code values exist; resolve them before running this migration';
  END IF;
  IF EXISTS (SELECT 1 FROM public.exam_questions GROUP BY student_id, question_order HAVING COUNT(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate exam question orders exist; resolve them before running this migration';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_students_access_code
  ON public.students(access_code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_questions_student_order
  ON public.exam_questions(student_id, question_order);
COMMIT;

-- Verification: each query should return one row with the expected column/index.
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'students'
  AND column_name IN ('submitted_at', 'submit_reason', 'active_jti',
                      'recording_finalized_at', 'recording_final_part_index', 'recording_incomplete')
ORDER BY column_name;
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('uq_students_access_code', 'uq_exam_questions_student_order')
ORDER BY indexname;
