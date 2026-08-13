-- Admin read-path indexes. Run during a maintenance window; regular CREATE INDEX may
-- briefly wait for or block conflicting writes on a busy production database.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_students_batch_id
  ON public.students(batch_id);

CREATE INDEX IF NOT EXISTS idx_violation_events_student_created_at
  ON public.violation_events(student_id, created_at DESC);

COMMIT;

-- Verification: both rows must be returned.
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'idx_students_batch_id',
    'idx_violation_events_student_created_at'
  )
ORDER BY indexname;

-- Rollback (run separately if required):
-- DROP INDEX IF EXISTS public.idx_violation_events_student_created_at;
-- DROP INDEX IF EXISTS public.idx_students_batch_id;

