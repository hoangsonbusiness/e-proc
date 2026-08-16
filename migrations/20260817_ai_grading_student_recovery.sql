-- Durable lease metadata for recovering AI grading attempts interrupted by a
-- serverless hard timeout, deployment, process crash, or network failure.
-- Deploy only when no AI Grade request is actively running.

BEGIN;

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS ai_grading_started_at TIMESTAMP;

ALTER TABLE public.students
  ADD COLUMN IF NOT EXISTS ai_grading_attempt_token VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_students_ai_grading_lease
  ON public.students(batch_id, ai_grading_status, ai_grading_started_at);

-- Existing processing rows have no lease timestamp and are intentionally left
-- untouched here. The next creator-triggered AI Grade request recovers them:
-- prior published results return to completed; otherwise they become retryable.

COMMIT;

SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'students'
  AND column_name IN ('ai_grading_started_at', 'ai_grading_attempt_token')
ORDER BY column_name;

SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname = 'idx_students_ai_grading_lease';
