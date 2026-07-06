import pg from 'pg';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

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

    const targetDef = `CHECK ((type = ANY (ARRAY['Coding'::text, 'Conceptual'::text, 'Fill-in'::text, 'Debug'::text])))`;
    const existing = constraintCheck.rows[0];

    if (!existing) {
      // Constraint chưa tồn tại → ADD mới
      console.log('[DB] question_bank_type_check: not found → adding');
      await client.query(`
        ALTER TABLE question_bank
          ADD CONSTRAINT question_bank_type_check
          CHECK(type IN ('Coding', 'Conceptual', 'Fill-in', 'Debug'))
      `);
    } else if (existing.condef !== targetDef) {
      // Constraint tồn tại nhưng định nghĩa cũ → DROP rồi ADD mới
      console.log('[DB] question_bank_type_check: outdated →', existing.condef);
      await client.query(`ALTER TABLE question_bank DROP CONSTRAINT question_bank_type_check`);
      await client.query(`
        ALTER TABLE question_bank
          ADD CONSTRAINT question_bank_type_check
          CHECK(type IN ('Coding', 'Conceptual', 'Fill-in', 'Debug'))
      `);
    } else {
      console.log('[DB] question_bank_type_check: already up-to-date, skipping');
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] question_bank_type_check migration error:', err);
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  const seqCheck = await client.query("SELECT COALESCE(MAX(id), 0) + 1 as next_id FROM batches");
  await client.query(`SELECT setval('batches_id_seq', ${seqCheck.rows[0].next_id})`);
  console.log('[DB] batches ready');
  
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: thêm cột mới nếu chưa tồn tại (cho DB cũ)
  const colChecks = [
    { col: 'exam_started_at', def: 'TIMESTAMP' },
    { col: 'exam_deadline', def: 'TIMESTAMP' },
    { col: 'disconnected_at', def: 'TIMESTAMP' },
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
  console.log('[DB] ai_queue ready');
  
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
      CREATE TABLE IF NOT EXISTS ai_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        exam_question_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
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
