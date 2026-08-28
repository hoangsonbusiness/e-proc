-- WebRTC media is never stored here. These rows only audit an administrator's
-- explicit request to view an active candidate screen.
CREATE TABLE IF NOT EXISTS public.live_monitor_audit (
  viewer_session_id UUID PRIMARY KEY,
  admin_user_id INTEGER NOT NULL REFERENCES public.admin_users(id) ON DELETE RESTRICT,
  student_id INTEGER NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL REFERENCES public.batches(id) ON DELETE CASCADE,
  attempt_jti_hash CHAR(64) NOT NULL,
  outcome VARCHAR(20) NOT NULL DEFAULT 'connecting',
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_live_monitor_audit_student_started
  ON public.live_monitor_audit(student_id, started_at);

-- `realtime.messages` is Supabase-managed and has RLS enabled by default.
-- Hosted projects intentionally reject ALTER TABLE on it; policies are the
-- supported customization point. Each short-lived JWT is scoped to one topic.
DROP POLICY IF EXISTS live_monitor_topic_read ON realtime.messages;
DROP POLICY IF EXISTS live_monitor_topic_write ON realtime.messages;
CREATE POLICY live_monitor_topic_read ON realtime.messages FOR SELECT TO authenticated
  USING (realtime.messages.extension = 'broadcast'
    AND realtime.topic() = (current_setting('request.jwt.claims', true)::jsonb ->> 'live_topic'));
CREATE POLICY live_monitor_topic_write ON realtime.messages FOR INSERT TO authenticated
  WITH CHECK (realtime.messages.extension = 'broadcast'
    AND realtime.topic() = (current_setting('request.jwt.claims', true)::jsonb ->> 'live_topic'));

CREATE TABLE IF NOT EXISTS public.app_schema_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO public.app_schema_state (id, version, updated_at) VALUES (1, 5, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO UPDATE SET version = GREATEST(app_schema_state.version, EXCLUDED.version), updated_at = CURRENT_TIMESTAMP;
