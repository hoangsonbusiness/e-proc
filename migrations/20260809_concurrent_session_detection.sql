-- Concurrent session / multi-IP detection migration
-- Target: Supabase PostgreSQL
-- Safe to run more than once.

BEGIN;

-- Theo dõi phiên thi để phát hiện dùng đồng thời nhiều client/IP.
-- Mỗi cặp (student × jti × ip) một dòng; đổi IP tạo dòng mới.
-- last_seen cập nhật mỗi request thi (do middleware sessionTracker upsert).
CREATE TABLE IF NOT EXISTS public.exam_sessions (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL
    REFERENCES public.students(id) ON DELETE CASCADE,
  batch_id INTEGER,
  jti TEXT,
  ip TEXT,
  user_agent TEXT,
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (student_id, jti, ip)
);

CREATE INDEX IF NOT EXISTS idx_exam_sessions_student
  ON public.exam_sessions(student_id);

COMMIT;

-- Verification output: expect one row describing exam_sessions.student_id.
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'exam_sessions'
  AND column_name = 'student_id'
ORDER BY table_name, column_name;
