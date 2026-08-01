import pg from 'pg';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';

dotenv.config();

const USE_SQLITE = !process.env.DATABASE_URL;

console.log('[DB] Module loading...');
console.log('[DB] Mode:', USE_SQLITE ? 'SQLite (local dev)' : 'PostgreSQL (production)');
console.log('[DB] DATABASE_URL:', process.env.DATABASE_URL ? 'present' : 'MISSING');

let pgPool: pg.Pool | null = null;
let sqliteDb: Database.Database | null = null;

const { Pool } = pg;

async function initPostgres() {
  console.log('[DB] Attempting PostgreSQL connection...');
  
  const poolMax = parseInt(process.env.DB_POOL_MAX || '10');
  const poolMin = parseInt(process.env.DB_POOL_MIN || '2');
  
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: poolMax,
    min: poolMin,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: false }
  });

  pgPool.on('error', (err) => console.error('[DB] Pool error:', err.message));
  pgPool.on('connect', () => console.log('[DB] New PG connection'));

  const client = await pgPool.connect();
  console.log('[DB] PostgreSQL connected!');
  
  await client.query(`SET statement_timeout = '${process.env.STATEMENT_TIMEOUT || '30s'}'`);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS question_bank (
      id VARCHAR(50) PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('Coding', 'Conceptual', 'Fill-in', 'Debug')),
      level TEXT NOT NULL CHECK(level IN ('Easy', 'Medium', 'Hard')),
      module TEXT NOT NULL,
      question_group TEXT,
      question_sample TEXT NOT NULL,
      question_plain TEXT,
      rubric_must_have TEXT NOT NULL,
      rubric_nice_to_have TEXT NOT NULL,
      rubric_optional TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: thêm cột question_group cho DB cũ chưa có
  try {
    await client.query(`ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS question_group TEXT`);
  } catch (_) { /* already exists */ }

  // Migration: thêm cột question_plain (nội dung câu hỏi không có HTML) cho DB cũ chưa có
  try {
    await client.query(`ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS question_plain TEXT`);
  } catch (_) { /* already exists */ }

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
  
  const seqCheck = await client.query("SELECT COALESCE(MAX(id), 0) + 1 as next_id FROM batches");
  await client.query(`SELECT setval('batches_id_seq', ${seqCheck.rows[0].next_id})`);

  // Migration: batch dạng Practice trỏ tới 1 bài practice đã import (NULL = batch thi thường theo blueprint)
  try {
    await client.query(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS practice_exam_id INTEGER`);
  } catch (_) { /* already exists */ }
  console.log('[DB] batches ready');

  // Bài thi Practice: import từ file .docx, quản lý độc lập với question_bank
  await client.query(`
    CREATE TABLE IF NOT EXISTS practice_exams (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      content_html TEXT NOT NULL,
      content_plain TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[DB] practice_exams ready');

  // Bài làm practice: 1 học viên = 1 bài làm duy nhất cho batch practice của mình
  await client.query(`
    CREATE TABLE IF NOT EXISTS practice_submissions (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      practice_exam_id INTEGER NOT NULL,
      answer TEXT,
      ai_score FLOAT,
      ai_feedback TEXT,
      trainer_score FLOAT,
      trainer_feedback TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[DB] practice_submissions ready');
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      access_code VARCHAR(6) NOT NULL,
      status TEXT DEFAULT 'pending',
      exam_started_at TIMESTAMP,
      exam_deadline TIMESTAMP,
      disconnected_at TIMESTAMP,
      recording_password TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: thêm cột mới nếu chưa tồn tại (cho DB cũ)
  const colChecks = [
    { col: 'exam_started_at', def: 'TIMESTAMP' },
    { col: 'exam_deadline', def: 'TIMESTAMP' },
    { col: 'disconnected_at', def: 'TIMESTAMP' },
    { col: 'recording_password', def: 'TEXT' },
  ];
  for (const { col, def } of colChecks) {
    try {
      await client.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS ${col} ${def}`);
    } catch (_) { /* already exists */ }
  }
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('[DB] violation_events ready');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ai_queue (
      id SERIAL PRIMARY KEY,
      exam_question_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Migration: phân biệt job chấm exam_questions vs practice_submissions
  // (kind='practice' thì exam_question_id thực chất là practice_submissions.id)
  try {
    await client.query(`ALTER TABLE ai_queue ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'exam'`);
  } catch (_) { /* already exists */ }
  console.log('[DB] ai_queue ready');
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Migration: thêm cột role cho DB cũ (user cũ mặc định 'admin' để không mất quyền)
  try {
    await client.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin'`);
  } catch (_) { /* already exists */ }
  console.log('[DB] admin_users ready');

  client.release();
  console.log('[DB] All PostgreSQL tables initialized');
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
        question_group TEXT,
        question_sample TEXT NOT NULL,
        question_plain TEXT,
        rubric_must_have TEXT NOT NULL,
        rubric_nice_to_have TEXT NOT NULL,
        rubric_optional TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: thêm cột mới nếu chưa tồn tại (cho SQLite DB cũ)
    const qbCols = sqliteDb.prepare("PRAGMA table_info(question_bank)").all() as { name: string }[];
    const qbColNames = qbCols.map((c) => c.name);
    if (!qbColNames.includes('question_group')) {
      sqliteDb.exec('ALTER TABLE question_bank ADD COLUMN question_group TEXT');
    }
    if (!qbColNames.includes('question_plain')) {
      sqliteDb.exec('ALTER TABLE question_bank ADD COLUMN question_plain TEXT');
    }

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        start_time DATETIME NOT NULL,
        end_time DATETIME NOT NULL,
        duration INTEGER NOT NULL,
        blueprint TEXT,
        practice_exam_id INTEGER,
        record_enabled INTEGER DEFAULT 0,
        record_mode TEXT DEFAULT 'none',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: batch dạng Practice (NULL = batch thi thường theo blueprint)
    const batchCols = sqliteDb.prepare("PRAGMA table_info(batches)").all() as { name: string }[];
    if (!batchCols.map((c) => c.name).includes('practice_exam_id')) {
      sqliteDb.exec('ALTER TABLE batches ADD COLUMN practice_exam_id INTEGER');
    }

    // Bài thi Practice: import từ file .docx, quản lý độc lập với question_bank
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS practice_exams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        content_html TEXT NOT NULL,
        content_plain TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Bài làm practice: 1 học viên = 1 bài làm duy nhất cho batch practice của mình
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS practice_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        practice_exam_id INTEGER NOT NULL,
        answer TEXT,
        ai_score REAL,
        ai_feedback TEXT,
        trainer_score REAL,
        trainer_feedback TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
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
    
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS violation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        student_id INTEGER NOT NULL,
        batch_id INTEGER,
        type TEXT NOT NULL,
        text_length INTEGER,
        content_preview TEXT,
        question_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )
    `);

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS ai_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exam_question_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        error_message TEXT,
        kind TEXT DEFAULT 'exam',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migration: phân biệt job chấm exam_questions vs practice_submissions
    const aiQueueCols = sqliteDb.prepare("PRAGMA table_info(ai_queue)").all() as { name: string }[];
    if (!aiQueueCols.map((c) => c.name).includes('kind')) {
      sqliteDb.exec("ALTER TABLE ai_queue ADD COLUMN kind TEXT DEFAULT 'exam'");
    }

    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const adminCols = sqliteDb.prepare("PRAGMA table_info(admin_users)").all() as { name: string }[];
    if (!adminCols.map((c) => c.name).includes('role')) {
      sqliteDb.exec("ALTER TABLE admin_users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
    }

    // Migration cho SQLite DB cũ: thêm cột nếu chưa có (SQLite không có IF NOT EXISTS cho ADD COLUMN)
    // (cột role của admin_users đã được migrate ở ngay trên)
    const batchColNames = (sqliteDb.prepare("PRAGMA table_info(batches)").all() as { name: string }[]).map(c => c.name);
    if (!batchColNames.includes('record_enabled')) {
      sqliteDb.exec('ALTER TABLE batches ADD COLUMN record_enabled INTEGER DEFAULT 0');
    }
    if (!batchColNames.includes('exam_type')) {
      sqliteDb.exec("ALTER TABLE batches ADD COLUMN exam_type TEXT DEFAULT 'essay'");
    }
    if (!batchColNames.includes('record_mode')) {
      sqliteDb.exec("ALTER TABLE batches ADD COLUMN record_mode TEXT DEFAULT 'none'");
      // Backfill: batch cũ có record_enabled=1 → 's3'
      sqliteDb.exec("UPDATE batches SET record_mode = 's3' WHERE record_enabled = 1 AND (record_mode IS NULL OR record_mode = 'none')");
    }
    // Migration: cột quiz cho question_bank + option_order cho exam_questions (SQLite DB cũ)
    const qbQuizCols = (sqliteDb.prepare("PRAGMA table_info(question_bank)").all() as { name: string }[]).map(c => c.name);
    if (!qbQuizCols.includes('options')) sqliteDb.exec('ALTER TABLE question_bank ADD COLUMN options TEXT');
    if (!qbQuizCols.includes('correct_answers')) sqliteDb.exec('ALTER TABLE question_bank ADD COLUMN correct_answers TEXT');
    if (!qbQuizCols.includes('score')) sqliteDb.exec('ALTER TABLE question_bank ADD COLUMN score REAL DEFAULT 1');
    const eqCols = (sqliteDb.prepare("PRAGMA table_info(exam_questions)").all() as { name: string }[]).map(c => c.name);
    if (!eqCols.includes('option_order')) sqliteDb.exec('ALTER TABLE exam_questions ADD COLUMN option_order TEXT');

    console.log('[DB] All SQLite tables initialized');
  } catch (err) {
    console.error('[DB] SQLite init error:', err);
    throw err;
  }
}

// Seed tài khoản superadmin đầu tiên — chỉ chạy khi bảng admin_users đang trống,
// thay cho form đăng ký admin tự phục vụ (đã bị gỡ bỏ vì lý do bảo mật).
async function seedSuperAdmin() {
  const existing = await query('SELECT COUNT(*) as count FROM admin_users');
  const count = Number(existing.rows[0]?.count ?? existing.rows[0]?.COUNT ?? 0);
  if (count > 0) return;

  const username = process.env.SUPERADMIN_USERNAME || 'supperadmin';
  const password = process.env.SUPERADMIN_PASSWORD || 'superadmin123#2nf';
  const passwordHash = await bcrypt.hash(password, 10);

  await query(
    'INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)',
    [username, passwordHash, 'superadmin']
  );
  console.log('[DB] Seeded initial superadmin account:', username);
}

export async function initDatabase() {
  if (USE_SQLITE) {
    initSqlite();
  } else {
    await initPostgres();
  }
  await seedSuperAdmin();
}

interface DbResult {
  rows: any[];
  rowCount: number;
  lastInsertRowid?: number | bigint;
}

export async function query(text: string, params?: any[]): Promise<DbResult> {
  if (USE_SQLITE && sqliteDb) {
    try {
      const stmt = sqliteDb.prepare(text);
      const upperText = text.trim().toUpperCase();
      if (upperText.startsWith('SELECT') || upperText.includes('RETURNING')) {
        return { rows: stmt.all(...(params || [])), rowCount: 0 };
      } else {
        const result = stmt.run(...(params || []));
        return { rows: [], rowCount: result.changes, lastInsertRowid: result.lastInsertRowid };
      }
    } catch (err) {
      console.error('[DB] SQLite query error:', err);
      throw err;
    }
  }
  
  if (pgPool) {
    if (params && params.length > 0) {
      let paramIndex = 1;
      const pgText = text.replace(/\?/g, () => '$' + paramIndex++);
      const result = await pgPool.query(pgText, params);
      return { rows: result.rows, rowCount: result.rowCount || 0, lastInsertRowid: undefined };
    }
    const result = await pgPool.query(text);
    return { rows: result.rows, rowCount: result.rowCount || 0, lastInsertRowid: undefined };
  }
  
  throw new Error('No database connection available');
}

export function getPool() {
  if (USE_SQLITE) return sqliteDb;
  return pgPool;
}

export default { initDatabase, query, getPool };
