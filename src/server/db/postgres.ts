import pg from 'pg';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { recordDbQuery } from '../observability/dbMetrics.js';
import { BOOTSTRAP_SCHEMA_VERSION, MINIMUM_SCHEMA_VERSION, isSupportedSchemaVersion } from './schemaVersion.js';
import {
  ReadinessController,
  isPermanentDatabaseStartupError,
} from './readiness.js';

dotenv.config();

const USE_SQLITE = !process.env.DATABASE_URL;
console.log('[DB] Module loading...');
console.log('[DB] Mode:', USE_SQLITE ? 'SQLite (local dev)' : 'PostgreSQL (production)');
console.log('[DB] DATABASE_URL:', process.env.DATABASE_URL ? 'present' : 'MISSING');

let pgPool: pg.Pool | null = null;
let sqliteDb: Database.Database | null = null;
let schemaBootstrapPerformed = false;

const { Pool } = pg;

async function initPostgres() {
  console.log('[DB] Attempting PostgreSQL connection...');
  
  const poolMax = parseInt(process.env.DB_POOL_MAX || '4');
  const poolMin = parseInt(process.env.DB_POOL_MIN || '0');
  const connectionTimeoutMs = Math.max(1000, parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '15000') || 15000);
  const connectionAttempts = Math.max(1, Math.min(5, parseInt(process.env.DB_CONNECT_ATTEMPTS || '2') || 2));
  const databaseSsl = process.env.DATABASE_SSL?.trim().toLowerCase() === 'false'
    ? false
    : { rejectUnauthorized: false };
  console.log('[DB] Pool config:', { max: poolMax, min: poolMin, connectionTimeoutMs, ssl: databaseSsl !== false });
  
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: poolMax,
    min: poolMin,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: connectionTimeoutMs,
    ssl: databaseSsl
  });

  pgPool.on('error', (err) => console.error('[DB] Pool error:', err.message));
  pgPool.on('connect', () => console.log('[DB] New PG connection'));

  let client: pg.PoolClient | null = null;
  let lastConnectionError: unknown;
  for (let attempt = 1; attempt <= connectionAttempts; attempt++) {
    try {
      client = await pgPool.connect();
      break;
    } catch (error) {
      lastConnectionError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[DB] PostgreSQL connection attempt ${attempt}/${connectionAttempts} failed: ${message}`);
      if (attempt < connectionAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  if (!client) {
    throw lastConnectionError instanceof Error
      ? lastConnectionError
      : new Error('PostgreSQL connection failed');
  }
  try {
    console.log('[DB] PostgreSQL connected!');
  
  await client.query(`SET statement_timeout = '${process.env.STATEMENT_TIMEOUT || '30s'}'`);

  let installedSchemaVersion: number | null = null;
  try {
    const versionResult = await client.query(
      'SELECT version FROM app_schema_state WHERE id = 1'
    );
    installedSchemaVersion = versionResult.rows[0]?.version == null
      ? null
      : Number(versionResult.rows[0].version);
  } catch (error: any) {
    if (error?.code !== '42P01') throw error;
  }

  if (isSupportedSchemaVersion(installedSchemaVersion)) {
    console.log(`[DB] Schema version ${installedSchemaVersion} ready; skipping runtime DDL`);
    return;
  }

  const allowRuntimeBootstrap = process.env.ALLOW_RUNTIME_SCHEMA_BOOTSTRAP === 'true'
    || (!process.env.VERCEL && process.env.NODE_ENV !== 'production');
  if (!allowRuntimeBootstrap) {
    throw new Error(
      `[schema] expected app_schema_state version >= ${MINIMUM_SCHEMA_VERSION}, got ${installedSchemaVersion ?? '<missing>'}. Run migrations before serving.`
    );
  }
  console.log('[DB] Schema fast path unavailable; running explicit local/fresh-database bootstrap');
  schemaBootstrapPerformed = true;

  // Ownership foreign keys in question_bank and batches reference admin_users,
  // so a clean database must create this parent table before either child.
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS question_bank (
      id VARCHAR(50) PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('Coding', 'Conceptual', 'Fill-in', 'Debug')),
      level TEXT NOT NULL CHECK(level IN ('Easy', 'Medium', 'Hard')),
      module TEXT NOT NULL,
      question_sample TEXT NOT NULL,
      rubric_must_have TEXT NOT NULL,
      rubric_nice_to_have TEXT NOT NULL,
      rubric_optional TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: cập nhật CHECK constraint type cho DB cũ
  // Dùng transaction atomic: check exists → chỉ drop+add nếu constraint chưa đúng
  try {
    await client.query('BEGIN');

    const constraintCheck = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) AS condef
      FROM pg_constraint
      WHERE conrelid = 'question_bank'::regclass
        AND conname = 'question_bank_type_check'
    `);

    const targetDef = `CHECK ((type = ANY (ARRAY['Coding'::text, 'Conceptual'::text, 'Fill-in'::text, 'Debug'::text, 'SingleChoice'::text, 'MultipleChoice'::text])))`;
    const existing = constraintCheck.rows[0];

    if (!existing) {
      // Constraint chưa tồn tại → ADD mới
      console.log('[DB] question_bank_type_check: not found → adding');
      await client.query(`
        ALTER TABLE question_bank
          ADD CONSTRAINT question_bank_type_check
          CHECK(type IN ('Coding', 'Conceptual', 'Fill-in', 'Debug', 'SingleChoice', 'MultipleChoice'))
      `);
    } else if (existing.condef !== targetDef) {
      // Constraint tồn tại nhưng định nghĩa cũ → DROP rồi ADD mới
      console.log('[DB] question_bank_type_check: outdated →', existing.condef);
      await client.query(`ALTER TABLE question_bank DROP CONSTRAINT question_bank_type_check`);
      await client.query(`
        ALTER TABLE question_bank
          ADD CONSTRAINT question_bank_type_check
          CHECK(type IN ('Coding', 'Conceptual', 'Fill-in', 'Debug', 'SingleChoice', 'MultipleChoice'))
      `);
    } else {
      console.log('[DB] question_bank_type_check: already up-to-date, skipping');
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] question_bank_type_check migration error:', err);
  }

  // Migration: cột quiz (SingleChoice/MultipleChoice). Câu tự luận cũ để NULL.
  // options: JSON [{"key":"A","text":"..."}], correct_answers: JSON ["A","C"], score mặc định 1.
  const qbQuizCols = [
    { col: 'options', def: 'TEXT' },
    { col: 'correct_answers', def: 'TEXT' },
    { col: 'score', def: 'REAL DEFAULT 1' },
  ];
  for (const { col, def } of qbQuizCols) {
    try {
      await client.query(`ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS ${col} ${def}`);
    } catch (_) { /* already exists */ }
  }
  // Migration: người upload question (FK → admin_users). Question cũ để NULL.
  try {
    await client.query('ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS uploaded_by INTEGER REFERENCES admin_users(id) ON DELETE SET NULL');
  } catch (_) { /* already exists */ }
  console.log('[DB] question_bank ready');

await client.query(`
    CREATE TABLE IF NOT EXISTS batches (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      start_time TIMESTAMP NOT NULL,
      end_time TIMESTAMP NOT NULL,
      duration INTEGER NOT NULL,
      blueprint JSONB,
      record_enabled BOOLEAN DEFAULT false,
      record_mode VARCHAR(16) DEFAULT 'none',
      vmware_check_enabled BOOLEAN NOT NULL DEFAULT false,
      live_enabled BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Migration: cờ ghi màn hình lên S3 (chỉ admin bật được). Batch cũ mặc định false.
  try {
    await client.query('ALTER TABLE batches ADD COLUMN IF NOT EXISTS record_enabled BOOLEAN DEFAULT false');
  } catch (_) { /* already exists */ }
  // Migration: chế độ ghi màn hình 'none' | 'local' | 's3' (thay cho record_enabled bool).
  // Chỉ admin đặt được mode khác 'none'. Backfill: batch có record_enabled=true → 's3'.
  try {
    await client.query("ALTER TABLE batches ADD COLUMN IF NOT EXISTS record_mode VARCHAR(16) DEFAULT 'none'");
    await client.query("UPDATE batches SET record_mode = 's3' WHERE record_enabled = true AND (record_mode IS NULL OR record_mode = 'none')");
  } catch (_) { /* already exists */ }
  // Migration: loại đề (essay = tự luận/coding, quiz = trắc nghiệm). Batch cũ mặc định 'essay'.
  try {
    await client.query("ALTER TABLE batches ADD COLUMN IF NOT EXISTS exam_type TEXT DEFAULT 'essay'");
  } catch (_) { /* already exists */ }
  try {
    await client.query('ALTER TABLE batches ADD COLUMN IF NOT EXISTS live_enabled BOOLEAN DEFAULT false');
  } catch (_) { /* already exists */ }
  try {
    await client.query('ALTER TABLE batches ADD COLUMN IF NOT EXISTS vmware_check_enabled BOOLEAN NOT NULL DEFAULT false');
  } catch (_) { /* already exists */ }
  // Migration: người tạo batch (FK → admin_users). Batch cũ để NULL.
  try {
    await client.query('ALTER TABLE batches ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES admin_users(id) ON DELETE SET NULL');
  } catch (_) { /* already exists */ }
  
  const seqCheck = await client.query("SELECT COALESCE(MAX(id), 0) + 1 as next_id FROM batches");
  await client.query(`SELECT setval('batches_id_seq', ${seqCheck.rows[0].next_id})`);
  console.log('[DB] batches ready');
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      access_code VARCHAR(8) NOT NULL,
      status TEXT DEFAULT 'pending',
      exam_started_at TIMESTAMP,
      exam_deadline TIMESTAMP,
      disconnected_at TIMESTAMP,
      recording_password TEXT,
      submitted_at TIMESTAMP,
      submit_reason TEXT,
      active_jti TEXT,
      recording_finalized_at TIMESTAMP,
      recording_final_part_index INTEGER,
      recording_incomplete BOOLEAN DEFAULT FALSE,
      recording_manifest_sealed_at TIMESTAMP,
      recording_expected_part_count INTEGER,
      attempt_record_mode VARCHAR(16),
      environment_check_passed BOOLEAN,
      environment_snapshot TEXT,
      environment_checked_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: thêm cột mới nếu chưa tồn tại (cho DB cũ)
  const colChecks = [
    { col: 'exam_started_at', def: 'TIMESTAMP' },
    { col: 'exam_deadline', def: 'TIMESTAMP' },
    { col: 'disconnected_at', def: 'TIMESTAMP' },
    { col: 'recording_password', def: 'TEXT' },
    { col: 'submitted_at', def: 'TIMESTAMP' },
    { col: 'submit_reason', def: 'TEXT' },
    { col: 'active_jti', def: 'TEXT' },
    { col: 'recording_finalized_at', def: 'TIMESTAMP' },
    { col: 'recording_final_part_index', def: 'INTEGER' },
    { col: 'recording_incomplete', def: 'BOOLEAN DEFAULT FALSE' },
    { col: 'recording_manifest_sealed_at', def: 'TIMESTAMP' },
    { col: 'recording_expected_part_count', def: 'INTEGER' },
    { col: 'attempt_record_mode', def: 'VARCHAR(16)' },
    { col: 'environment_check_passed', def: 'BOOLEAN' },
    { col: 'environment_snapshot', def: 'TEXT' },
    { col: 'environment_checked_at', def: 'TIMESTAMP' },
  ];
  for (const { col, def } of colChecks) {
    try {
      await client.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS ${col} ${def}`);
    } catch (_) { /* already exists */ }
  }
  await client.query(`
    UPDATE students s
    SET attempt_record_mode = COALESCE(NULLIF(b.record_mode, ''),
      CASE WHEN b.record_enabled THEN 's3' ELSE 'none' END)
    FROM batches b
    WHERE b.id = s.batch_id
      AND s.attempt_record_mode IS NULL
      AND s.status IN ('in_progress', 'submitted')
  `);
  console.log('[DB] students ready');
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS exam_questions (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      question_id VARCHAR(50) NOT NULL,
      question_order INTEGER NOT NULL,
      answer TEXT,
      ai_score FLOAT,
      ai_feedback TEXT,
      trainer_score FLOAT,
      trainer_feedback TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Migration: thứ tự option đã xáo cho riêng SV (quiz). JSON ["C","A","F","B"]. Câu tự luận để NULL.
  try {
    await client.query('ALTER TABLE exam_questions ADD COLUMN IF NOT EXISTS option_order TEXT');
  } catch (_) { /* already exists */ }
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_students_access_code ON students(access_code)');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_questions_student_order ON exam_questions(student_id, question_order)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_students_batch_id ON students(batch_id)');
  console.log('[DB] exam_questions ready');
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS violations (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[DB] violations ready');

  // [P1-1][P2-2] UPSERT counter cần unique (student_id, type). CHỈ chạy merge legacy MỘT LẦN,
  // khi index chưa tồn tại — nếu không mỗi cold-start Vercel sẽ quét full-table GROUP BY +
  // UPDATE + DELETE vô ích (tốn query/lock Supabase, đi ngược free-tier). Sau lần đầu, index
  // đã có → bỏ qua hoàn toàn. Việc dedupe legacy chuẩn nằm ở migration; đây chỉ là an toàn cho
  // môi trường tự-init (SQLite dev / DB chưa migrate).
  const violationsIdxExists = (await client.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'ux_violations_student_type' LIMIT 1`
  )).rows.length > 0;
  if (!violationsIdxExists) {
    // Merge legacy CHỈ khi index chưa có — dữ liệu bẩn có thể khiến merge lỗi nhưng đó là
    // tình huống cần con người xử lý; không nuốt lỗi ở đây nữa vì CREATE INDEX bên dưới là
    // BẮT BUỘC cho /violation. Nếu bước này lỗi, init fail → readiness fail (đúng ý đồ).
    await client.query(`
      WITH merged AS (
        SELECT student_id, type, SUM(count) AS total, MIN(id) AS keep_id
        FROM violations GROUP BY student_id, type HAVING COUNT(*) > 1
      )
      UPDATE violations v SET count = m.total
      FROM merged m WHERE v.id = m.keep_id
    `);
    await client.query(`
      DELETE FROM violations v USING (
        SELECT student_id, type, MIN(id) AS keep_id
        FROM violations GROUP BY student_id, type HAVING COUNT(*) > 1
      ) d
      WHERE v.student_id = d.student_id AND v.type = d.type AND v.id <> d.keep_id
    `);
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS ux_violations_student_type ON violations(student_id, type)');
  }

  // Anti-Cheat: append-only forensic log — mỗi lần vi phạm một dòng (khác với
  // bảng violations vốn khóa theo (student_id, type) nên chỉ đếm được số lần).
  // content_preview chỉ có với suspicious_paste (500 ký tự đầu); focus_lost để NULL.
  await client.query(`
    CREATE TABLE IF NOT EXISTS violation_events (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      batch_id INTEGER,
      type TEXT NOT NULL,
      text_length INTEGER,
      content_preview VARCHAR(500),
      question_id VARCHAR(50),
      metadata_json TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[DB] violation_events ready');
  try {
    await client.query('ALTER TABLE violation_events ADD COLUMN IF NOT EXISTS metadata_json TEXT');
  } catch (_) { /* already exists */ }
  // [P1-1][P1-review] Idempotency: event_id do client sinh, giữ nguyên qua retry. Unique một
  // phần (chỉ khi NOT NULL) để row cũ / forensic tự-sinh (event_id NULL) không xung đột.
  // KHÔNG nuốt lỗi — /violation bắt buộc index này tồn tại; nếu tạo lỗi thì init phải fail
  // để readiness fail, tránh server healthy nhưng /violation luôn 500. Các câu đều idempotent.
  await client.query('ALTER TABLE violation_events ADD COLUMN IF NOT EXISTS event_id VARCHAR(64)');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS ux_violation_events_student_event ON violation_events(student_id, event_id) WHERE event_id IS NOT NULL');
  await client.query('CREATE INDEX IF NOT EXISTS idx_violation_events_student_created_at ON violation_events(student_id, created_at DESC)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS recording_parts (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      batch_id INTEGER NOT NULL,
      part_index INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      byte_size INTEGER,
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      is_final BOOLEAN DEFAULT FALSE,
      UNIQUE(student_id, part_index)
    )
  `);
  await client.query('ALTER TABLE recording_parts ADD COLUMN IF NOT EXISTS is_final BOOLEAN DEFAULT FALSE');

  // Durable logical-upload reservations prevent a resumed recorder from
  // overwriting an older in-flight part that won the same numeric cursor.
  // upload_id is generated once by the client and remains stable across every
  // presign/PUT/complete retry.
  await client.query(`
    CREATE TABLE IF NOT EXISTS recording_upload_reservations (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      batch_id INTEGER NOT NULL,
      upload_id VARCHAR(64) NOT NULL CHECK (length(upload_id) BETWEEN 1 AND 64),
      part_index INTEGER NOT NULL CHECK (part_index >= 0),
      object_key TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    )
  `);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_recording_upload_reservations_student_upload
    ON recording_upload_reservations(student_id, upload_id)`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_recording_upload_reservations_student_part
    ON recording_upload_reservations(student_id, part_index)`);

  // Anti-Cheat: theo dõi phiên thi để phát hiện dùng đồng thời nhiều client/IP.
  // Mỗi cặp (student × jti × ip) một dòng; đổi IP tạo dòng mới. last_seen cập nhật mỗi request.
  await client.query(`
    CREATE TABLE IF NOT EXISTS exam_sessions (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      batch_id INTEGER,
      jti TEXT,
      ip TEXT,
      user_agent TEXT,
      first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(student_id, jti, ip)
    )
  `);
  try {
    await client.query('CREATE INDEX IF NOT EXISTS idx_exam_sessions_student ON exam_sessions(student_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_exam_sessions_student_last_seen ON exam_sessions(student_id, last_seen)');
  } catch (_) { /* ignore */ }
  console.log('[DB] exam_sessions ready');

  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Migration: thêm cột role cho DB cũ (user cũ mặc định 'admin' để không mất quyền)
  try {
    await client.query("ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'admin'");
  } catch (_) { /* already exists */ }
  console.log('[DB] admin_users ready');

  await client.query(`
    CREATE TABLE IF NOT EXISTS live_monitor_audit (
      viewer_session_id UUID PRIMARY KEY,
      admin_user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      attempt_jti_hash CHAR(64) NOT NULL,
      outcome VARCHAR(20) NOT NULL DEFAULT 'connecting',
      started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at TIMESTAMP
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS idx_live_monitor_audit_student_started ON live_monitor_audit(student_id, started_at)');

  await client.query(`
    CREATE TABLE IF NOT EXISTS user_ai_settings (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES admin_users(id) ON DELETE RESTRICT,
      provider VARCHAR(100) NOT NULL,
      api_protocol VARCHAR(40) NOT NULL,
      base_url TEXT NOT NULL,
      encrypted_api_key TEXT NOT NULL,
      key_iv TEXT NOT NULL,
      key_auth_tag TEXT NOT NULL,
      encryption_key_version INTEGER NOT NULL DEFAULT 1,
      key_mask VARCHAR(32) NOT NULL,
      model VARCHAR(200) NOT NULL,
      test_status VARCHAR(20) NOT NULL DEFAULT 'untested',
      tested_config_hash VARCHAR(64),
      tested_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await client.query("ALTER TABLE batches ADD COLUMN IF NOT EXISTS ai_grading_status VARCHAR(20) NOT NULL DEFAULT 'idle'");
  await client.query('ALTER TABLE batches ADD COLUMN IF NOT EXISTS ai_grading_started_at TIMESTAMP');
  await client.query('ALTER TABLE batches ADD COLUMN IF NOT EXISTS ai_graded_at TIMESTAMP');
  await client.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS ai_final_score NUMERIC(4,2)');
  await client.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS ai_summary_feedback TEXT');
  await client.query("ALTER TABLE students ADD COLUMN IF NOT EXISTS ai_grading_status VARCHAR(20) NOT NULL DEFAULT 'pending'");
  await client.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS ai_grading_error TEXT');
  await client.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS ai_graded_at TIMESTAMP');
  await client.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS ai_grading_started_at TIMESTAMP');
  await client.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS ai_grading_attempt_token VARCHAR(64)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_students_batch_ai_grading ON students(batch_id, status, ai_grading_status)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_students_ai_grading_lease ON students(batch_id, ai_grading_status, ai_grading_started_at)');
  console.log('[DB] user-owned AI settings and manual grading columns ready');

  await client.query(`
    CREATE TABLE IF NOT EXISTS app_schema_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
    console.log('[DB] All PostgreSQL tables initialized');
  } finally {
    client.release();
  }
}

function initSqlite() {
  console.log('[DB] Initializing SQLite...');
  
  const dataDir = path.join(process.cwd(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  const dbPath = path.join(dataDir, 'eaudit.db');
  
  try {
    sqliteDb = new Database(dbPath);
    sqliteDb.pragma('journal_mode = WAL');
    console.log('[DB] SQLite connected at:', dbPath);
    
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS question_bank (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        module TEXT NOT NULL,
        question_sample TEXT NOT NULL,
        rubric_must_have TEXT NOT NULL,
        rubric_nice_to_have TEXT NOT NULL,
        rubric_optional TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        start_time DATETIME NOT NULL,
        end_time DATETIME NOT NULL,
        duration INTEGER NOT NULL,
        blueprint TEXT,
        record_enabled INTEGER DEFAULT 0,
        record_mode TEXT DEFAULT 'none',
        vmware_check_enabled INTEGER NOT NULL DEFAULT 0,
        live_enabled INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL,
        email TEXT NOT NULL,
        access_code TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        exam_started_at DATETIME,
        exam_deadline DATETIME,
        disconnected_at DATETIME,
        recording_password TEXT,
        submitted_at DATETIME,
        submit_reason TEXT,
        active_jti TEXT,
        recording_finalized_at DATETIME,
        recording_final_part_index INTEGER,
        recording_incomplete INTEGER DEFAULT 0,
        recording_manifest_sealed_at DATETIME,
        recording_expected_part_count INTEGER,
        attempt_record_mode TEXT,
        environment_check_passed INTEGER,
        environment_snapshot TEXT,
        environment_checked_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
      )
    `);

    // Migration: thêm cột mới nếu chưa tồn tại (cho SQLite DB cũ)
    const existingCols = sqliteDb.prepare("PRAGMA table_info(students)").all() as { name: string }[];
    const colNames = existingCols.map((c) => c.name);
    if (!colNames.includes('exam_started_at')) {
      sqliteDb.exec('ALTER TABLE students ADD COLUMN exam_started_at DATETIME');
    }
    if (!colNames.includes('exam_deadline')) {
      sqliteDb.exec('ALTER TABLE students ADD COLUMN exam_deadline DATETIME');
    }
    if (!colNames.includes('disconnected_at')) {
      sqliteDb.exec('ALTER TABLE students ADD COLUMN disconnected_at DATETIME');
    }
    if (!colNames.includes('recording_password')) {
      sqliteDb.exec('ALTER TABLE students ADD COLUMN recording_password TEXT');
    }
    const studentAdds: Array<[string, string]> = [
      ['submitted_at', 'DATETIME'], ['submit_reason', 'TEXT'], ['active_jti', 'TEXT'],
      ['recording_finalized_at', 'DATETIME'], ['recording_final_part_index', 'INTEGER'],
      ['recording_incomplete', 'INTEGER DEFAULT 0'],
      ['recording_manifest_sealed_at', 'DATETIME'],
      ['recording_expected_part_count', 'INTEGER'],
      ['attempt_record_mode', 'TEXT'],
      ['environment_check_passed', 'INTEGER'],
      ['environment_snapshot', 'TEXT'],
      ['environment_checked_at', 'DATETIME'],
    ];
    for (const [name, def] of studentAdds) {
      if (!colNames.includes(name)) sqliteDb.exec(`ALTER TABLE students ADD COLUMN ${name} ${def}`);
    }
    sqliteDb.exec(`
      UPDATE students
      SET attempt_record_mode = COALESCE(
        (SELECT NULLIF(record_mode, '') FROM batches WHERE batches.id = students.batch_id),
        CASE WHEN (SELECT record_enabled FROM batches WHERE batches.id = students.batch_id) = 1
          THEN 's3' ELSE 'none' END
      )
      WHERE attempt_record_mode IS NULL AND status IN ('in_progress', 'submitted')
    `);
    sqliteDb.exec('CREATE INDEX IF NOT EXISTS idx_students_batch_id ON students(batch_id)');
    
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS exam_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        question_id TEXT NOT NULL,
        question_order INTEGER NOT NULL,
        answer TEXT,
        ai_score REAL,
        ai_feedback TEXT,
        trainer_score REAL,
        trainer_feedback TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);
    
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS violations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);
    // [P1-1][P2-2] Gộp row trùng rồi tạo unique index — CHỈ khi index chưa tồn tại, tránh
    // quét full-table mỗi lần khởi động (xem ghi chú ở nhánh PostgreSQL). KHÔNG nuốt lỗi:
    // index này bắt buộc cho /violation; lỗi phải làm init fail để readiness fail.
    const violationsIdxExists = sqliteDb.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='index' AND name='ux_violations_student_type' LIMIT 1"
    ).get();
    if (!violationsIdxExists) {
      sqliteDb.exec(`
        UPDATE violations SET count = (
          SELECT SUM(v2.count) FROM violations v2
          WHERE v2.student_id = violations.student_id AND v2.type = violations.type
        )
        WHERE id IN (
          SELECT MIN(id) FROM violations GROUP BY student_id, type HAVING COUNT(*) > 1
        );
        DELETE FROM violations WHERE id NOT IN (
          SELECT MIN(id) FROM violations GROUP BY student_id, type
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ux_violations_student_type ON violations(student_id, type);
      `);
    }

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS violation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        batch_id INTEGER,
        type TEXT NOT NULL,
        text_length INTEGER,
        content_preview TEXT,
        question_id TEXT,
        metadata_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);
    const violationEventCols = sqliteDb.prepare("PRAGMA table_info(violation_events)").all() as { name: string }[];
    if (!violationEventCols.some((col) => col.name === 'metadata_json')) {
      sqliteDb.exec('ALTER TABLE violation_events ADD COLUMN metadata_json TEXT');
    }
    // [P1-1] event_id idempotency (xem bản PostgreSQL). SQLite: partial unique index hợp lệ.
    if (!violationEventCols.some((col) => col.name === 'event_id')) {
      sqliteDb.exec('ALTER TABLE violation_events ADD COLUMN event_id TEXT');
    }
    sqliteDb.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_violation_events_student_event ON violation_events(student_id, event_id) WHERE event_id IS NOT NULL');
    sqliteDb.exec('CREATE INDEX IF NOT EXISTS idx_violation_events_student_created_at ON violation_events(student_id, created_at DESC)');

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS recording_parts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        batch_id INTEGER NOT NULL,
        part_index INTEGER NOT NULL,
        object_key TEXT NOT NULL,
        byte_size INTEGER,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_final INTEGER DEFAULT 0,
        UNIQUE(student_id, part_index),
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);
    const recordingPartCols = (sqliteDb.prepare("PRAGMA table_info(recording_parts)").all() as { name: string }[]).map(c => c.name);
    if (!recordingPartCols.includes('is_final')) sqliteDb.exec('ALTER TABLE recording_parts ADD COLUMN is_final INTEGER DEFAULT 0');

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS recording_upload_reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        batch_id INTEGER NOT NULL,
        upload_id TEXT NOT NULL CHECK (length(upload_id) BETWEEN 1 AND 64),
        part_index INTEGER NOT NULL CHECK (part_index >= 0),
        object_key TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);
    sqliteDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_recording_upload_reservations_student_upload
      ON recording_upload_reservations(student_id, upload_id)`);
    sqliteDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_recording_upload_reservations_student_part
      ON recording_upload_reservations(student_id, part_index)`);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS exam_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        batch_id INTEGER,
        jti TEXT,
        ip TEXT,
        user_agent TEXT,
        first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(student_id, jti, ip),
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);
    sqliteDb.exec('CREATE INDEX IF NOT EXISTS idx_exam_sessions_student ON exam_sessions(student_id)');
    sqliteDb.exec('CREATE INDEX IF NOT EXISTS idx_exam_sessions_student_last_seen ON exam_sessions(student_id, last_seen)');

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS live_monitor_audit (
        viewer_session_id TEXT PRIMARY KEY,
        admin_user_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        batch_id INTEGER NOT NULL,
        attempt_jti_hash TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'connecting',
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE RESTRICT,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
      )
    `);
    sqliteDb.exec('CREATE INDEX IF NOT EXISTS idx_live_monitor_audit_student_started ON live_monitor_audit(student_id, started_at)');

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS user_ai_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        api_protocol TEXT NOT NULL,
        base_url TEXT NOT NULL,
        encrypted_api_key TEXT NOT NULL,
        key_iv TEXT NOT NULL,
        key_auth_tag TEXT NOT NULL,
        encryption_key_version INTEGER NOT NULL DEFAULT 1,
        key_mask TEXT NOT NULL,
        model TEXT NOT NULL,
        test_status TEXT NOT NULL DEFAULT 'untested',
        tested_config_hash TEXT,
        tested_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE RESTRICT
      )
    `);

    // Migration cho SQLite DB cũ: thêm cột nếu chưa có (SQLite không có IF NOT EXISTS cho ADD COLUMN)
    const batchCols = (sqliteDb.prepare("PRAGMA table_info(batches)").all() as { name: string }[]).map(c => c.name);
    if (!batchCols.includes('record_enabled')) {
      sqliteDb.exec('ALTER TABLE batches ADD COLUMN record_enabled INTEGER DEFAULT 0');
    }
    if (!batchCols.includes('exam_type')) {
      sqliteDb.exec("ALTER TABLE batches ADD COLUMN exam_type TEXT DEFAULT 'essay'");
    }
    if (!batchCols.includes('record_mode')) {
      sqliteDb.exec("ALTER TABLE batches ADD COLUMN record_mode TEXT DEFAULT 'none'");
      // Backfill: batch cũ có record_enabled=1 → 's3'
      sqliteDb.exec("UPDATE batches SET record_mode = 's3' WHERE record_enabled = 1 AND (record_mode IS NULL OR record_mode = 'none')");
    }
    if (!batchCols.includes('created_by')) {
      sqliteDb.exec('ALTER TABLE batches ADD COLUMN created_by INTEGER');
    }
    if (!batchCols.includes('live_enabled')) {
      sqliteDb.exec('ALTER TABLE batches ADD COLUMN live_enabled INTEGER DEFAULT 0');
    }
    if (!batchCols.includes('vmware_check_enabled')) {
      sqliteDb.exec('ALTER TABLE batches ADD COLUMN vmware_check_enabled INTEGER NOT NULL DEFAULT 0');
    }
    if (!batchCols.includes('ai_grading_status')) {
      sqliteDb.exec("ALTER TABLE batches ADD COLUMN ai_grading_status TEXT NOT NULL DEFAULT 'idle'");
    }
    if (!batchCols.includes('ai_grading_started_at')) {
      sqliteDb.exec('ALTER TABLE batches ADD COLUMN ai_grading_started_at DATETIME');
    }
    if (!batchCols.includes('ai_graded_at')) {
      sqliteDb.exec('ALTER TABLE batches ADD COLUMN ai_graded_at DATETIME');
    }
    const gradingStudentAdds: Array<[string, string]> = [
      ['ai_final_score', 'REAL'], ['ai_summary_feedback', 'TEXT'],
      ['ai_grading_status', "TEXT NOT NULL DEFAULT 'pending'"],
      ['ai_grading_error', 'TEXT'], ['ai_graded_at', 'DATETIME'],
      ['ai_grading_started_at', 'DATETIME'], ['ai_grading_attempt_token', 'TEXT'],
    ];
    for (const [name, def] of gradingStudentAdds) {
      if (!colNames.includes(name)) sqliteDb.exec(`ALTER TABLE students ADD COLUMN ${name} ${def}`);
    }
    sqliteDb.exec('CREATE INDEX IF NOT EXISTS idx_students_batch_ai_grading ON students(batch_id, status, ai_grading_status)');
    sqliteDb.exec('CREATE INDEX IF NOT EXISTS idx_students_ai_grading_lease ON students(batch_id, ai_grading_status, ai_grading_started_at)');
    const adminCols = (sqliteDb.prepare("PRAGMA table_info(admin_users)").all() as { name: string }[]).map(c => c.name);
    if (!adminCols.includes('role')) {
      sqliteDb.exec("ALTER TABLE admin_users ADD COLUMN role TEXT DEFAULT 'admin'");
    }
    // Migration: cột quiz cho question_bank + option_order cho exam_questions (SQLite DB cũ)
    const qbCols = (sqliteDb.prepare("PRAGMA table_info(question_bank)").all() as { name: string }[]).map(c => c.name);
    if (!qbCols.includes('options')) sqliteDb.exec('ALTER TABLE question_bank ADD COLUMN options TEXT');
    if (!qbCols.includes('correct_answers')) sqliteDb.exec('ALTER TABLE question_bank ADD COLUMN correct_answers TEXT');
    if (!qbCols.includes('score')) sqliteDb.exec('ALTER TABLE question_bank ADD COLUMN score REAL DEFAULT 1');
    if (!qbCols.includes('uploaded_by')) sqliteDb.exec('ALTER TABLE question_bank ADD COLUMN uploaded_by INTEGER');
    const eqCols = (sqliteDb.prepare("PRAGMA table_info(exam_questions)").all() as { name: string }[]).map(c => c.name);
    if (!eqCols.includes('option_order')) sqliteDb.exec('ALTER TABLE exam_questions ADD COLUMN option_order TEXT');

    console.log('[DB] All SQLite tables initialized');
  } catch (err) {
    console.error('[DB] SQLite init error:', err);
    throw err;
  }
}

export async function initDatabase() {
  if (USE_SQLITE) {
    initSqlite();
  } else {
    await initPostgres();
  }
}

/**
 * Xác minh các index BẮT BUỘC không chỉ TỒN TẠI mà đúng ĐỊNH NGHĨA —
 * violation idempotency và recording reservations phụ thuộc cứng vào chúng (ON CONFLICT).
 * Chỉ khớp tên là chưa đủ: một index cùng
 * tên nhưng không unique / sai cột / thiếu predicate `WHERE event_id IS NOT NULL` sẽ khiến
 * ON CONFLICT lỗi runtime dù readiness báo ready. Ta kiểm định nghĩa thật:
 *  - PostgreSQL: pg_index.indisunique/indisvalid/indisready + pg_get_indexdef (chứa cột, UNIQUE,
 *    và WHERE predicate).
 *  - SQLite: PRAGMA index_list (unique) + index_info (cột) + sqlite_master.sql (predicate).
 */
export async function verifyRequiredSchema(): Promise<void> {
  const fail = (msg: string): never => {
    throw new Error(`[schema] ${msg}. Run migrations before serving.`);
  };

  if (USE_SQLITE) {
    if (!sqliteDb) throw new Error('[schema] SQLite not initialized');
    const checkSqlite = (table: string, indexName: string, cols: string[], predicate: string | null) => {
      const list = sqliteDb!.prepare(`PRAGMA index_list(${table})`).all() as { name: string; unique: number }[];
      const entry = list.find((i) => i.name === indexName);
      if (!entry) fail(`index ${indexName} missing on ${table}`);
      if (!entry!.unique) fail(`index ${indexName} is not UNIQUE`);
      const info = sqliteDb!.prepare(`PRAGMA index_info(${indexName})`).all() as { seqno: number; name: string }[];
      const actual = info.sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
      if (actual.join(',') !== cols.join(',')) fail(`index ${indexName} columns ${actual.join(',')} != expected ${cols.join(',')}`);
      const row = sqliteDb!.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(indexName) as { sql: string } | undefined;
      const sql = (row?.sql || '').toLowerCase();
      if (predicate && !sql.includes(predicate.toLowerCase())) fail(`index ${indexName} missing partial predicate "${predicate}"`);
      if (!predicate && sql.includes(' where ')) fail(`index ${indexName} unexpectedly has a WHERE predicate`);
    };
    checkSqlite('violations', 'ux_violations_student_type', ['student_id', 'type'], null);
    checkSqlite('violation_events', 'ux_violation_events_student_event', ['student_id', 'event_id'], 'event_id is not null');
    const studentColumnRows = sqliteDb.prepare('PRAGMA table_info(students)').all() as { name: string }[];
    const studentColumns = studentColumnRows.map((column) => column.name);
    for (const column of [
      'recording_manifest_sealed_at', 'recording_expected_part_count', 'attempt_record_mode',
      'environment_check_passed', 'environment_snapshot', 'environment_checked_at',
    ]) {
      if (!studentColumns.includes(column)) fail(`required column students.${column} missing`);
    }
    const reservationColumnRows = sqliteDb.prepare(
      'PRAGMA table_info(recording_upload_reservations)',
    ).all() as { name: string }[];
    const reservationColumns = reservationColumnRows.map((column) => column.name);
    for (const column of ['student_id', 'batch_id', 'upload_id', 'part_index', 'object_key', 'created_at', 'completed_at']) {
      if (!reservationColumns.includes(column)) {
        fail(`required column recording_upload_reservations.${column} missing`);
      }
    }
    checkSqlite(
      'recording_upload_reservations',
      'ux_recording_upload_reservations_student_upload',
      ['student_id', 'upload_id'],
      null,
    );
    checkSqlite(
      'recording_upload_reservations',
      'ux_recording_upload_reservations_student_part',
      ['student_id', 'part_index'],
      null,
    );
  } else {
    if (!pgPool) throw new Error('[schema] PostgreSQL pool not initialized');
    const requiredColumns: Record<string, string[]> = {
      students: [
        'exam_started_at', 'exam_deadline', 'disconnected_at', 'recording_password',
        'submitted_at', 'submit_reason', 'active_jti', 'recording_finalized_at',
        'recording_final_part_index', 'recording_incomplete',
        'recording_manifest_sealed_at', 'recording_expected_part_count', 'ai_final_score',
        'attempt_record_mode', 'environment_check_passed', 'environment_snapshot', 'environment_checked_at',
        'ai_summary_feedback', 'ai_grading_status', 'ai_grading_error', 'ai_graded_at',
        'ai_grading_started_at', 'ai_grading_attempt_token',
      ],
      batches: ['record_mode', 'vmware_check_enabled', 'live_enabled', 'exam_type',
        'ai_grading_status', 'ai_grading_started_at', 'ai_graded_at'],
      exam_questions: ['option_order'],
      violation_events: ['metadata_json', 'event_id'],
      recording_parts: ['student_id', 'part_index', 'object_key', 'byte_size', 'is_final'],
      recording_upload_reservations: [
        'student_id', 'batch_id', 'upload_id', 'part_index', 'object_key',
        'created_at', 'completed_at',
      ],
      exam_sessions: ['student_id', 'jti', 'ip', 'user_agent', 'last_seen'],
      live_monitor_audit: ['viewer_session_id', 'admin_user_id', 'student_id', 'batch_id', 'attempt_jti_hash', 'outcome'],
      user_ai_settings: ['user_id', 'api_protocol', 'base_url', 'encrypted_api_key',
        'key_iv', 'key_auth_tag', 'key_mask', 'model', 'test_status', 'tested_config_hash'],
    };
    const columnRows = await pgPool.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [Object.keys(requiredColumns)]
    );
    const columnSet = new Set(columnRows.rows.map((r: any) => `${r.table_name}.${r.column_name}`));
    for (const [table, columns] of Object.entries(requiredColumns)) {
      for (const column of columns) {
        if (!columnSet.has(`${table}.${column}`)) fail(`required column ${table}.${column} missing`);
      }
    }

    const indexRows = await pgPool.query(
      `SELECT i.indisunique, i.indisvalid, i.indisready,
              c.relname AS index_name, t.relname AS table_name,
              pg_get_expr(i.indpred, i.indrelid) AS predicate,
              ARRAY(
                SELECT a.attname::text
                FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a
                  ON a.attrelid = i.indrelid AND a.attnum = k.attnum
                WHERE k.ord <= i.indnkeyatts
                ORDER BY k.ord
              ) AS columns
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema()
         AND t.relname = ANY($1)`,
      [[
        'violations', 'violation_events', 'students', 'exam_questions',
        'recording_parts', 'recording_upload_reservations', 'exam_sessions',
      ]]
    );
    const normalizePredicate = (value: unknown): string | null => value == null
      ? null
      : String(value).toLowerCase().replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
    const checkPg = (indexName: string, table: string, cols: string[], predicate: string | null) => {
      const row = indexRows.rows.find((candidate: any) => candidate.index_name === indexName);
      if (!row) fail(`index ${indexName} missing`);
      if (!row.indisunique) fail(`index ${indexName} is not UNIQUE`);
      if (!row.indisvalid) fail(`index ${indexName} is INVALID`);
      if (!row.indisready) fail(`index ${indexName} is not READY`);
      if (row.table_name !== table) fail(`index ${indexName} on wrong table ${row.table_name} (expected ${table})`);
      const actualCols = (row.columns as string[] | null) || [];
      if (actualCols.join(',') !== cols.join(',')) {
        fail(`index ${indexName} columns ${actualCols.join(',')} != expected ${cols.join(',')}`);
      }
      const actualPredicate = normalizePredicate(row.predicate);
      const expectedPredicate = normalizePredicate(predicate);
      if (actualPredicate !== expectedPredicate) {
        fail(`index ${indexName} predicate ${actualPredicate || '<none>'} != expected ${expectedPredicate || '<none>'}`);
      }
    };
    const checkPgUniqueColumns = (table: string, cols: string[]) => {
      const found = indexRows.rows.some((row: any) => row.table_name === table
        && row.indisunique && row.indisvalid && row.indisready && row.predicate == null
        && ((row.columns as string[] | null) || []).join(',') === cols.join(','));
      if (!found) fail(`required UNIQUE index on ${table}(${cols.join(', ')}) missing`);
    };
    checkPg('ux_violations_student_type', 'violations', ['student_id', 'type'], null);
    checkPg('ux_violation_events_student_event', 'violation_events', ['student_id', 'event_id'], 'event_id is not null');
    checkPgUniqueColumns('students', ['access_code']);
    checkPgUniqueColumns('exam_questions', ['student_id', 'question_order']);
    checkPgUniqueColumns('recording_parts', ['student_id', 'part_index']);
    checkPg(
      'ux_recording_upload_reservations_student_upload',
      'recording_upload_reservations',
      ['student_id', 'upload_id'],
      null,
    );
    checkPg(
      'ux_recording_upload_reservations_student_part',
      'recording_upload_reservations',
      ['student_id', 'part_index'],
      null,
    );
    checkPgUniqueColumns('exam_sessions', ['student_id', 'jti', 'ip']);

    for (const performanceIndex of ['idx_students_batch_id', 'idx_violation_events_student_created_at']) {
      if (!indexRows.rows.some((row: any) => row.index_name === performanceIndex && row.indisvalid && row.indisready)) {
        console.warn(`[schema] Performance index ${performanceIndex} is missing; admin reads may be slow`);
      }
    }
  }
  console.log('[DB] Required schema verified (definition-checked)');
}

async function markBootstrappedSchemaReady(): Promise<void> {
  if (!schemaBootstrapPerformed || !pgPool) return;
  await pgPool.query(`
    INSERT INTO app_schema_state (id, version, updated_at)
    VALUES (1, $1, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, updated_at = CURRENT_TIMESTAMP
  `, [BOOTSTRAP_SCHEMA_VERSION]);
  console.log(`[DB] Recorded verified schema version ${BOOTSTRAP_SCHEMA_VERSION}`);
}

async function disposeDatabaseAfterFailedStartup(): Promise<void> {
  if (USE_SQLITE) {
    if (sqliteDb?.open) sqliteDb.close();
    sqliteDb = null;
    return;
  }

  const failedPool = pgPool;
  pgPool = null;
  if (failedPool) await failedPool.end();
}

const retryBaseDelayMs = Math.max(250, parseInt(process.env.DB_READY_RETRY_BASE_MS || '1000') || 1000);
const retryMaxDelayMs = Math.max(
  retryBaseDelayMs,
  parseInt(process.env.DB_READY_RETRY_MAX_MS || '30000') || 30000,
);

const databaseReadiness = new ReadinessController({
  initialize: async () => {
    schemaBootstrapPerformed = false;
    await initDatabase();
    await verifyRequiredSchema();
    await markBootstrappedSchemaReady();
  },
  cleanup: disposeDatabaseAfterFailedStartup,
  isPermanentError: (error) => USE_SQLITE || isPermanentDatabaseStartupError(error),
  baseRetryDelayMs: retryBaseDelayMs,
  maxRetryDelayMs: retryMaxDelayMs,
  onFailure: (error, snapshot) => {
    if (snapshot.state === 'permanent_failure') {
      console.error('[DB] Startup failed permanently:', error.message);
      return;
    }
    console.error(`[DB] Startup failed transiently; retry in ${snapshot.retryAfterMs}ms:`, error.message);
  },
});

/**
 * Retryable, single-flight readiness gate. Network/connection failures can be
 * retried by a later request after cooldown; schema/auth/config failures remain
 * blocked until the deployment or configuration is replaced.
 */
export function ensureDatabaseReady(): Promise<void> {
  return databaseReadiness.ensureReady();
}

export function getDatabaseReadinessSnapshot() {
  return databaseReadiness.getSnapshot();
}

interface DbResult {
  rows: any[];
  rowCount: number;
  lastInsertRowid?: number | bigint;
}

export interface DbExecutor {
  query(text: string, params?: any[]): Promise<DbResult>;
}

function postgresText(text: string, params?: any[]): string {
  if (!params?.length || text.includes('$1')) return text;
  let paramIndex = 1;
  return text.replace(/\?/g, () => '$' + paramIndex++);
}

export async function query(text: string, params?: any[]): Promise<DbResult> {
  const startedAt = performance.now();
  try {
    if (USE_SQLITE && sqliteDb) {
      const stmt = sqliteDb.prepare(text);
      if (text.trim().toUpperCase().startsWith('SELECT')) {
        return { rows: stmt.all(...(params || [])), rowCount: 0 };
      } else {
        const result = stmt.run(...(params || []));
        return { rows: [], rowCount: result.changes, lastInsertRowid: result.lastInsertRowid };
      }
    }

    if (pgPool) {
      if (params && params.length > 0) {
        const result = await pgPool.query(postgresText(text, params), params);
        return { rows: result.rows, rowCount: result.rowCount || 0, lastInsertRowid: undefined };
      }
      const result = await pgPool.query(text);
      return { rows: result.rows, rowCount: result.rowCount || 0, lastInsertRowid: undefined };
    }

    throw new Error('No database connection available');
  } catch (err) {
    if (USE_SQLITE) console.error('[DB] SQLite query error:', err);
    throw err;
  } finally {
    recordDbQuery(performance.now() - startedAt);
  }
}

/** Run all statements on one physical connection. Required for row locks and atomic exam state changes. */
export async function withTransaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T> {
  if (USE_SQLITE && sqliteDb) {
    sqliteDb.exec('BEGIN IMMEDIATE');
    const tx: DbExecutor = { query };
    try {
      const result = await work(tx);
      sqliteDb.exec('COMMIT');
      return result;
    } catch (error) {
      sqliteDb.exec('ROLLBACK');
      throw error;
    }
  }

  if (!pgPool) throw new Error('No database connection available');
  const client = await pgPool.connect();
  const tx: DbExecutor = {
    query: async (text: string, params?: any[]) => {
      const startedAt = performance.now();
      try {
        const result = await client.query(postgresText(text, params), params);
        return { rows: result.rows, rowCount: result.rowCount || 0 };
      } finally {
        recordDbQuery(performance.now() - startedAt);
      }
    },
  };
  try {
    await client.query('BEGIN');
    const result = await work(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function getPool() {
  if (USE_SQLITE) return sqliteDb;
  return pgPool;
}

export default {
  initDatabase,
  query,
  withTransaction,
  getPool,
  verifyRequiredSchema,
  ensureDatabaseReady,
  getDatabaseReadinessSnapshot,
};
