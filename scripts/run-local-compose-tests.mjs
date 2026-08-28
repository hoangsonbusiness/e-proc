import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const compose = ['compose', '-f', 'docker-compose.local.yml'];

function run(args, { quiet = false, ...options } = {}) {
  const result = spawnSync('docker', [...compose, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (quiet) {
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
    }
    throw new Error(`docker ${[...compose, ...args].join(' ')} failed with exit code ${result.status}`);
  }
}

function diagnostics() {
  spawnSync('docker', [...compose, 'ps'], { cwd: process.cwd(), stdio: 'inherit', shell: false });
  spawnSync('docker', [...compose, 'logs', '--no-color', '--tail', '200', 'app', 'database'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
  });
}

function applyMigration(file) {
  const result = spawnSync('docker', [
    ...compose,
    'exec', '-T', 'database',
    'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
  ], {
    cwd: process.cwd(),
    input: readFileSync(file),
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} failed with exit code ${result.status}`);
}

function expectMigrationFailure(file) {
  const result = spawnSync('docker', [
    ...compose,
    'exec', '-T', 'database',
    'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', `/app/${file}`,
  ], { cwd: process.cwd(), stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status === 0) throw new Error(`${file} unexpectedly accepted conflicting recording metadata`);
}

function applySql(label, sql) {
  const result = spawnSync('docker', [
    ...compose,
    'exec', '-T', 'database',
    'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
  ], {
    cwd: process.cwd(),
    input: sql,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

try {
  console.log('\n[1/8] Building and starting the two-service local stack...');
  run(['up', '--build', '--detach', '--wait'], { quiet: true });

  console.log('\n[2/8] Simulating schema v2, applying migrations twice, and starting on schema v5...');
  run(['stop', 'app']);
  applyMigration('migrations/20260819_remove_legacy_ai.sql');
  applyMigration('migrations/20260819_remove_legacy_ai.sql');
  // Step 1 bootstraps a fresh local database for broad runtime coverage. Drop
  // the new table and restore the v2 marker here so the production v2 -> v3
  // migration itself (not runtime bootstrap) must recreate the full contract.
  applySql('schema v2 recording fixture', `
    DROP TABLE IF EXISTS public.recording_upload_reservations;
    ALTER TABLE public.students DROP COLUMN IF EXISTS recording_manifest_sealed_at;
    ALTER TABLE public.students DROP COLUMN IF EXISTS recording_expected_part_count;
    ALTER TABLE public.students DROP COLUMN IF EXISTS attempt_record_mode;
    DELETE FROM public.batches WHERE id = 900001;
    INSERT INTO public.batches
      (id, name, start_time, end_time, duration, record_enabled, record_mode)
    VALUES
      (900001, 'recording migration fixture', CURRENT_TIMESTAMP - INTERVAL '1 hour',
       CURRENT_TIMESTAMP + INTERVAL '1 hour', 60, TRUE, 's3');
    INSERT INTO public.students
      (id, batch_id, email, access_code, status)
    VALUES
      (900001, 900001, 'recording-migration@example.invalid', 'RBV20001', 'submitted');
    INSERT INTO public.recording_parts
      (student_id, batch_id, part_index, object_key, byte_size, uploaded_at, is_final)
    VALUES
      (900001, 900001, 0, 'recordings/migration/part000.webm', 1234,
       CURRENT_TIMESTAMP - INTERVAL '5 minutes', TRUE);
    INSERT INTO public.app_schema_state (id, version, updated_at)
    VALUES (1, 2, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET version = 2, updated_at = CURRENT_TIMESTAMP;
    DO $$
    BEGIN
      IF to_regclass('public.recording_upload_reservations') IS NOT NULL THEN
        RAISE EXCEPTION 'recording_upload_reservations still exists in v2 fixture';
      END IF;
      IF (SELECT version FROM public.app_schema_state WHERE id = 1) <> 2 THEN
        RAISE EXCEPTION 'schema v2 fixture has the wrong version';
      END IF;
    END $$;
  `);
  applyMigration('migrations/20260827_recording_upload_reservations.sql');
  applySql('schema v3 null completion marker fixture', `
    UPDATE public.recording_upload_reservations
    SET completed_at = NULL
    WHERE student_id = 900001 AND part_index = 0;
  `);
  applyMigration('migrations/20260827_recording_upload_reservations.sql');
  // Assert the migration result while the application is still stopped. This
  // prevents ALLOW_RUNTIME_SCHEMA_BOOTSTRAP from repairing a broken migration
  // and masking the regression before the health checks run.
  applySql('schema v3 migration assertion', `
    DO $$
    DECLARE
      required_columns INTEGER;
      valid_indexes INTEGER;
    BEGIN
      IF (SELECT version FROM public.app_schema_state WHERE id = 1) <> 3 THEN
        RAISE EXCEPTION 'recording reservation migration did not set schema v3';
      END IF;
      IF to_regclass('public.recording_upload_reservations') IS NULL THEN
        RAISE EXCEPTION 'recording_upload_reservations was not created by migration';
      END IF;
      SELECT COUNT(*) INTO required_columns
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'recording_upload_reservations'
        AND column_name IN (
          'student_id', 'batch_id', 'upload_id', 'part_index', 'object_key',
          'created_at', 'completed_at'
        );
      IF required_columns <> 7 THEN
        RAISE EXCEPTION 'recording reservation migration has %/7 required columns', required_columns;
      END IF;
      SELECT COUNT(*) INTO valid_indexes
      FROM pg_index i
      JOIN pg_class index_class ON index_class.oid = i.indexrelid
      JOIN pg_class table_class ON table_class.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = table_class.relnamespace
      WHERE n.nspname = 'public'
        AND table_class.relname = 'recording_upload_reservations'
        AND i.indisunique AND i.indisvalid AND i.indisready
        AND (
          (index_class.relname = 'ux_recording_upload_reservations_student_upload'
           AND ARRAY(
             SELECT a.attname::text
             FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
             WHERE k.ord <= i.indnkeyatts ORDER BY k.ord
           ) = ARRAY['student_id', 'upload_id']::text[])
          OR
          (index_class.relname = 'ux_recording_upload_reservations_student_part'
           AND ARRAY(
             SELECT a.attname::text
             FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
             WHERE k.ord <= i.indnkeyatts ORDER BY k.ord
           ) = ARRAY['student_id', 'part_index']::text[])
        );
      IF valid_indexes <> 2 THEN
        RAISE EXCEPTION 'recording reservation migration has %/2 valid exact indexes', valid_indexes;
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM public.recording_upload_reservations r
        JOIN public.recording_parts p
          ON p.student_id = r.student_id AND p.part_index = r.part_index
        WHERE r.student_id = 900001
          AND r.batch_id = p.batch_id
          AND r.object_key = p.object_key
          AND r.upload_id = 'legacy-part:0'
          AND r.completed_at IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'legacy recording part was not idempotently backfilled/repaired';
      END IF;
    END $$;
  `);
  applySql('schema v3 conflicting reservation fixture', `
    UPDATE public.recording_upload_reservations
    SET object_key = 'recordings/migration/conflict.webm'
    WHERE student_id = 900001 AND part_index = 0;
  `);
  expectMigrationFailure('migrations/20260827_recording_upload_reservations.sql');
  applySql('schema v3 conflicting reservation cleanup', `
    UPDATE public.recording_upload_reservations r
    SET object_key = p.object_key, batch_id = p.batch_id, completed_at = p.uploaded_at
    FROM public.recording_parts p
    WHERE r.student_id = p.student_id AND r.part_index = p.part_index
      AND r.student_id = 900001;
  `);
  applyMigration('migrations/20260827_recording_upload_reservations.sql');
  applyMigration('migrations/20260827_recording_manifest_recovery.sql');
  applyMigration('migrations/20260827_recording_manifest_recovery.sql');
  applySql('schema v4 migration assertion', `
    DO $$
    DECLARE
      recovery_columns INTEGER;
    BEGIN
      IF (SELECT version FROM public.app_schema_state WHERE id = 1) <> 4 THEN
        RAISE EXCEPTION 'recording manifest migration did not set schema v4';
      END IF;
      SELECT COUNT(*) INTO recovery_columns
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'students'
        AND column_name IN (
          'recording_manifest_sealed_at', 'recording_expected_part_count',
          'attempt_record_mode'
        );
      IF recovery_columns <> 3 THEN
        RAISE EXCEPTION 'recording manifest migration has %/3 required columns', recovery_columns;
      END IF;
      IF (SELECT attempt_record_mode FROM public.students WHERE id = 900001) <> 's3' THEN
        RAISE EXCEPTION 'active attempt record mode was not frozen during v4 migration';
      END IF;
    END $$;
  `);
  applyMigration('migrations/20260828_live_monitoring.sql');
  applyMigration('migrations/20260828_live_monitoring.sql');
  applySql('schema v5 live-monitor migration assertion', `
    DO $$
    BEGIN
      IF (SELECT version FROM public.app_schema_state WHERE id = 1) <> 5 THEN
        RAISE EXCEPTION 'live monitor migration did not set schema v5';
      END IF;
      IF to_regclass('public.live_monitor_audit') IS NULL THEN
        RAISE EXCEPTION 'live_monitor_audit was not created by migration';
      END IF;
    END $$;
  `);
  applySql('recording migration fixture cleanup', `
    DELETE FROM public.batches WHERE id = 900001;
  `);
  run(['up', '--detach', '--wait', 'app']);

  console.log('\n[3/8] Verifying PostgreSQL-backed application health and legacy-free schema...');
  run(['exec', '-T', 'app', 'node', '-e', [
    "const r=await fetch('http://127.0.0.1:3001/api/health');",
    "const body=await r.json();",
    "if(!r.ok||body.status!=='ok'||body.db!=='ready')throw new Error(JSON.stringify(body));",
    "if('queue' in body)throw new Error('Health response still exposes legacy queue state');",
    "const pg=(await import('pg')).default;",
    "const p=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});",
    "const q=await p.query(`SELECT (SELECT version FROM app_schema_state WHERE id=1) version,to_regclass('public.ai_queue') ai_queue,to_regclass('public.ai_settings') ai_settings,to_regclass('public.user_ai_settings') user_ai_settings,to_regclass('public.recording_upload_reservations') recording_upload_reservations,to_regclass('public.live_monitor_audit') live_monitor_audit,(SELECT COUNT(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='batches' AND column_name IN ('ai_grading_enabled','ai_setting_id')) legacy_columns,(SELECT COUNT(*)::int FROM pg_indexes WHERE schemaname='public' AND indexname IN ('ux_recording_upload_reservations_student_upload','ux_recording_upload_reservations_student_part')) reservation_indexes`);",
    "await p.end();",
    "const s=q.rows[0];",
    "if(Number(s.version)!==5||s.ai_queue!==null||s.ai_settings!==null||!s.user_ai_settings||!s.recording_upload_reservations||!s.live_monitor_audit||Number(s.legacy_columns)!==0||Number(s.reservation_indexes)!==2)throw new Error(JSON.stringify(s));",
  ].join('')]);

  console.log('\n[4/8] Verifying the built React frontend is served by the app container...');
  run(['exec', '-T', 'app', 'node', '-e', [
    "const r=await fetch('http://127.0.0.1:3001/');",
    "const body=await r.text();",
    "if(!r.ok||!body.includes('id=\"root\"'))throw new Error(`Unexpected frontend response: ${r.status}`);",
    "if(body.includes('monaco-editor')||body.includes('StudentExam'))throw new Error('Admin/student entry eagerly preloads exam code');",
  ].join('')]);

  console.log('\n[5/8] Running the complete default regression suite inside the app image...');
  run(['exec', '-T', '-e', 'DATABASE_URL=', 'app', 'npm', 'test']);

  console.log('\n[6/8] Running PostgreSQL integration tests against the Supabase database service...');
  run([
    'exec', '-T',
    '-e', 'DATABASE_URL=',
    '-e', 'TEST_DATABASE_URL=postgresql://postgres:eproc_local_password@database:5432/postgres',
    'app', 'npm', 'run', 'test:postgres',
  ]);

  console.log('\n[7/8] Running admin password-reset tests through HTTP and PostgreSQL...');
  run([
    'exec', '-T',
    'app', 'node', 'scripts/verify-admin-password-reset-local.mjs',
  ]);

  console.log('\n[8/8] Running AI Grade end-to-end tests through HTTP, PostgreSQL, and a mock LLM...');
  run([
    'exec', '-T',
    '-e', 'AI_GRADE_TEST_DATABASE_URL=postgresql://postgres:eproc_local_password@database:5432/postgres',
    'app', 'node', 'scripts/verify-ai-grade-local.mjs',
  ]);

  const localDbPort = process.env.EPROC_LOCAL_DB_PORT || '54323';
  console.log(`\nLocal Docker verification passed. App: http://localhost:3001, PostgreSQL: localhost:${localDbPort}`);
} catch (error) {
  console.error(`\nLocal Docker verification failed: ${error instanceof Error ? error.message : String(error)}`);
  diagnostics();
  process.exit(1);
}
