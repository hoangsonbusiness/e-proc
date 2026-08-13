-- Violation report idempotency migration
-- Target: Supabase PostgreSQL
-- Safe to run more than once.
--
-- Lý do: POST /api/student/violation KHÔNG idempotent (tăng violations.count +
-- append violation_events). Client retry sau khi server đã commit (chỉ mất response)
-- có thể đếm trùng một sự kiện và khóa oan. event_id do client sinh, giữ nguyên qua
-- mọi retry; unique một phần (student_id, event_id) đảm bảo mỗi sự kiện chỉ tính một lần.

BEGIN;

ALTER TABLE public.violation_events
  ADD COLUMN IF NOT EXISTS event_id VARCHAR(64);

-- Partial unique: chỉ ràng buộc khi event_id NOT NULL, để các row cũ / forensic
-- tự-sinh (event_id NULL) không xung đột với nhau.
CREATE UNIQUE INDEX IF NOT EXISTS ux_violation_events_student_event
  ON public.violation_events(student_id, event_id)
  WHERE event_id IS NOT NULL;

-- [P1-1] UPSERT counter cần unique (student_id, type). Gộp row trùng (nếu có từ đường
-- tăng count cũ không atomic) trước khi tạo index để không lỗi.
UPDATE public.violations v SET count = m.total
FROM (
  SELECT student_id, type, SUM(count) AS total, MIN(id) AS keep_id
  FROM public.violations GROUP BY student_id, type HAVING COUNT(*) > 1
) m
WHERE v.id = m.keep_id;

DELETE FROM public.violations v USING (
  SELECT student_id, type, MIN(id) AS keep_id
  FROM public.violations GROUP BY student_id, type HAVING COUNT(*) > 1
) d
WHERE v.student_id = d.student_id AND v.type = d.type AND v.id <> d.keep_id;

CREATE UNIQUE INDEX IF NOT EXISTS ux_violations_student_type
  ON public.violations(student_id, type);

COMMIT;

-- Verification output: expect one row describing violation_events.event_id,
-- and one row for the unique index.
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'violation_events'
  AND column_name = 'event_id';

SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN ('ux_violation_events_student_event', 'ux_violations_student_type')
ORDER BY indexname;
