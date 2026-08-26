import { Router, Request, Response } from 'express';
import multer from 'multer';
import db from '../db/postgres.js';
import { normalizeUnicode } from '../../utils/string.js';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import crypto from 'crypto';
import { parseBlueprintCompat } from '../services/blueprint.js';
import cache from '../cache.js';
import { ExamResetError, reopenExamAttempt } from '../services/examReset.js';
import { runWithDbMetrics } from '../observability/dbMetrics.js';
import {
  loadBatchExportData,
  loadBatchResultsLegacy,
  loadBatchResultsSummary,
  loadStudentResultDetail,
} from '../services/adminResults.js';
import {
  insertQuestion,
  isDuplicateQuestionIdError,
  isQuestionIdAvailable,
  loadPagedQuestions,
  loadQuestionCatalogSummary,
  QuestionValidationError,
  validateQuestionCreate,
  validateQuestionId,
  validateQuestionUpdate,
  type QuestionCategory,
} from '../services/adminQuestions.js';
import { getOwnedAiSetting, saveOwnedAiSetting, testOwnedAiSetting } from '../services/aiSettings.js';
import { AiGradingError, gradeBatchManually, gradeStudentManually } from '../services/batchAiGrading.js';
import { loadPagedBatches, loadPagedStudents } from '../services/adminLists.js';

dotenv.config();

const USE_SQLITE = !process.env.DATABASE_URL;
const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
let xlsxModulePromise: Promise<typeof import('xlsx')> | null = null;

function loadXlsx() {
  xlsxModulePromise ||= import('xlsx');
  return xlsxModulePromise;
}

console.log('[Admin] USE_SQLITE:', USE_SQLITE, 'NODE_ENV:', process.env.NODE_ENV);

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_FILE_BYTES, files: 1 },
});

// Enable full baseline logs with ADMIN_PERF_LOGS=true. Without it, only requests slower
// than ADMIN_SLOW_REQUEST_MS (default 1000 ms) are logged to keep production noise bounded.
router.use((req: Request, res: Response, next) => {
  const requestId = String(req.headers['x-request-id'] || crypto.randomUUID());
  const startedAt = Number(res.locals.adminRequestStartedAt) || performance.now();
  const startupWaitMs = Number(res.locals.startupWaitMs) || 0;
  const instanceUptimeAtStart = Number(res.locals.instanceUptimeAtStart)
    || Math.round(process.uptime() * 1000);
  res.setHeader('x-request-id', requestId);

  runWithDbMetrics((metrics) => {
    const originalWriteHead = res.writeHead;
    (res as any).writeHead = function (...args: any[]) {
      if (!res.headersSent) {
        const totalMs = performance.now() - startedAt;
        const appMs = Math.max(0, totalMs - startupWaitMs);
        res.setHeader(
          'Server-Timing',
          `startup;dur=${startupWaitMs.toFixed(1)}, db;dur=${metrics.dbMs.toFixed(1)}, app;dur=${appMs.toFixed(1)}`
        );
      }
      return (originalWriteHead as any).apply(res, args);
    };

    res.once('finish', () => {
      const totalMs = performance.now() - startedAt;
      const slowThreshold = Math.max(0, Number(process.env.ADMIN_SLOW_REQUEST_MS || 1000));
      if (process.env.ADMIN_PERF_LOGS !== 'true' && totalMs < slowThreshold) return;
      console.log('[admin-perf]', JSON.stringify({
        requestId,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        totalMs: Math.round(totalMs * 10) / 10,
        startupWaitMs: Math.round(startupWaitMs * 10) / 10,
        handlerMs: Math.round(Math.max(0, totalMs - startupWaitMs) * 10) / 10,
        dbMs: Math.round(metrics.dbMs * 10) / 10,
        queryCount: metrics.queryCount,
        responseBytes: Number(res.getHeader('content-length') || 0),
        instanceUptimeAtStart,
        region: process.env.VERCEL_REGION || null,
      }));
    });
    next();
  });
});

// Rate limit riêng cho login: 10 request/phút
const loginRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// [C-5] Rate limit cho setup: 5 lần/giờ — chỉ dùng một lần trong vòng đời app
const setupRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 giờ
  max: 5,
  message: { error: 'Too many setup attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// =============================================
// AUTH ROUTES (không require JWT)
// =============================================

// GET /api/admin/is-initialized — Kiểm tra xem admin đã được tạo chưa
router.get('/is-initialized', async (req: Request, res: Response) => {
  try {
    const existing = await db.query('SELECT COUNT(*) as count FROM admin_users');
    const count = Number(existing.rows[0]?.count ?? existing.rows[0]?.COUNT ?? 0);
    return res.json({ initialized: count > 0 });
  } catch (err: any) {
    console.error('[Auth] is-initialized error:', err);
    return res.status(500).json({ error: 'Failed to check initialization status' });
  }
});

// POST /api/admin/setup — Tạo admin lần đầu (chỉ hoạt động khi bảng trống)
router.post('/setup', setupRateLimit, async (req: Request, res: Response) => {

  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Kiểm tra xem đã có admin chưa
    const existing = await db.query('SELECT COUNT(*) as count FROM admin_users');
    const count = Number(existing.rows[0]?.count ?? existing.rows[0]?.COUNT ?? 0);
    if (count > 0) {
      return res.status(403).json({ error: 'Admin already initialized. Use change-password to update credentials.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await db.query(
      'INSERT INTO admin_users (username, password_hash) VALUES (?, ?)',
      [username.trim(), passwordHash]
    );

    console.log('[Auth] Admin user created:', username);
    return res.status(201).json({ success: true, message: 'Admin account created successfully' });
  } catch (err: any) {
    console.error('[Auth] Setup error:', err);
    return res.status(500).json({ error: 'Failed to create admin account' });
  }
});

// POST /api/admin/login — Đăng nhập, nhận JWT
router.post('/login', loginRateLimit, async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const result = await db.query(
      'SELECT * FROM admin_users WHERE username = ?',
      [username.trim()]
    );

    const user = result.rows[0];
    if (!user) {
      // Trả về cùng message để tránh user enumeration
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ error: 'Server configuration error' });
    }

    const expiresIn = '24h';
    const role = user.role || 'admin';
    const token = jwt.sign(
      { id: user.id, username: user.username, role },
      secret,
      { expiresIn }
    );

    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    console.log('[Auth] Login success:', username, 'role:', role);
    return res.json({ token, expiresAt, role, userId: user.id });
  } catch (err: any) {
    console.error('[Auth] Login error:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/admin/logout — Client xóa token (stateless)
router.post('/logout', (req: Request, res: Response) => {
  return res.json({ success: true });
});

// =============================================
// PROTECTED ROUTES — Require JWT từ đây trở xuống
// =============================================
router.use(authMiddleware);

// ── Quản lý user (chỉ admin) ─────────────────────────────────────────────

// GET /api/admin/users — liệt kê user (chỉ admin)
router.get('/users', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await db.query(
      'SELECT id, username, role, created_at FROM admin_users ORDER BY id ASC'
    );
    return res.json(result.rows);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users — tạo user với role 'admin' hoặc 'mod' (chỉ admin)
router.post('/users', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (role !== 'admin' && role !== 'mod') {
      return res.status(400).json({ error: 'Role must be "admin" or "mod"' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await db.query('SELECT id FROM admin_users WHERE username = ?', [username.trim()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await db.query(
      'INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)',
      [username.trim(), passwordHash, role]
    );
    console.log('[Auth] User created:', username, 'role:', role);
    return res.status(201).json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:id — xóa user (chỉ admin; không cho tự xóa chính mình)
router.delete('/users/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const targetId = parseInt(req.params.id);
    if (req.adminUser?.id === targetId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const ownedBatches = await db.query('SELECT COUNT(*) AS count FROM batches WHERE created_by = ?', [targetId]);
    if (Number(ownedBatches.rows[0]?.count || 0) > 0) {
      return res.status(409).json({ error: 'Cannot delete a user who still owns batches. Delete or transfer those batches first.' });
    }
    await db.withTransaction(async (tx) => {
      await tx.query('DELETE FROM user_ai_settings WHERE user_id = ?', [targetId]);
      await tx.query('DELETE FROM admin_users WHERE id = ?', [targetId]);
    });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/change-password — Đổi password (require JWT)
router.put('/change-password', async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const adminUser = req.adminUser;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const result = await db.query(
      'SELECT * FROM admin_users WHERE id = ?',
      [adminUser!.id]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.query(
      'UPDATE admin_users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newHash, adminUser!.id]
    );

    console.log('[Auth] Password changed for user:', adminUser!.username);
    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (err: any) {
    console.error('[Auth] Change password error:', err);
    return res.status(500).json({ error: 'Failed to change password' });
  }
});

// Client gửi UTC ISO string, server chỉ cần validate và normalize
const toStorageTime = (isoStr: string): string => {
  if (!isoStr) return isoStr;
  return new Date(isoStr).toISOString();
};

// Test endpoint to debug blueprint
router.get('/test-blueprint/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    console.log('=== TEST BLUEPRINT ===');
    console.log('batchId:', id);
    
    const batchResult = await db.query('SELECT id, blueprint FROM batches WHERE id = ?', [parseInt(id)]);
    const batch = batchResult.rows[0];
    
    console.log('Batch found:', batch ? 'YES' : 'NO');
    console.log('Blueprint raw:', batch?.blueprint);
    console.log('Blueprint type:', typeof batch?.blueprint);
    
    if (!batch) {
      return res.json({ error: 'Batch not found' });
    }
    
    let blueprint;
    try {
      blueprint = typeof batch.blueprint === 'string' ? JSON.parse(batch.blueprint) : batch.blueprint;
    } catch (e) {
      console.log('JSON parse error:', e);
      blueprint = [];
    }
    
    console.log('Blueprint parsed:', JSON.stringify(blueprint));
    
    // Check question_bank
    const modulesResult = await db.query('SELECT DISTINCT module FROM question_bank');
    console.log('Available modules:', modulesResult.rows.map(r => r.module));
    
    const { items: blueprintItems } = parseBlueprintCompat(blueprint);
    for (const item of blueprintItems) {
      const easy = item.easy || 0;
      const medium = item.medium || 0;
      const hard = item.hard || 0;
      
      console.log(`Module ${item.module}: easy=${easy}, medium=${medium}, hard=${hard}`);
      
      if (easy > 0) {
        const r = await db.query('SELECT COUNT(*) as cnt FROM question_bank WHERE module = ? AND level = ?', [item.module, 'Easy']);
        console.log(`  Easy: ${r.rows[0].cnt} available`);
      }
      if (medium > 0) {
        const r = await db.query('SELECT COUNT(*) as cnt FROM question_bank WHERE module = ? AND level = ?', [item.module, 'Medium']);
        console.log(`  Medium: ${r.rows[0].cnt} available`);
      }
      if (hard > 0) {
        const r = await db.query('SELECT COUNT(*) as cnt FROM question_bank WHERE module = ? AND level = ?', [item.module, 'Hard']);
        console.log(`  Hard: ${r.rows[0].cnt} available`);
      }
    }
    
    res.json({ 
      batch: batch?.id,
      blueprint: blueprint,
      availableModules: modulesResult.rows.map(r => r.module)
    });
  } catch (error: any) {
    console.log('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

function extractRubric(rubricStr: string): { mustHave: string; niceToHave: string; optional: string } {
  if (!rubricStr) return { mustHave: '', niceToHave: '', optional: '' };
  
  const parts = rubricStr.split('\n').filter((s: string) => s.trim());
  return {
    mustHave: parts.join('\n'),
    niceToHave: '',
    optional: ''
  };
}

router.post('/questions/import', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const XLSX = await loadXlsx();
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 }) as any[][];
    
    if (rawData.length < 3) {
      return res.status(400).json({ error: 'Invalid file format' });
    }

    const header = rawData[0];
    const rubricHeader = rawData[1];
    
    const colIndex: Record<string, number> = {};
    header.forEach((col, i) => {
      if (col) colIndex[col.toString().trim()] = i;
    });

    let rubricMustHaveCol = colIndex['Rubric (Must-have) (70%)'] ?? 5;
    let rubricNiceCol = colIndex['Nice-to-have (20%)'] ?? 6;
    let rubricOptCol = colIndex['Optional (10%)'] ?? 7;

    console.log('[Import] Header:', header);
    console.log('[Import] Rubric header:', rubricHeader);

    const validLevels = ['Easy', 'Medium', 'Hard'];
    const validTypes = ['Coding', 'Conceptual', 'Fill-in', 'Debug'];
    const errors: string[] = [];
    let imported = 0;
    let updated = 0;
    let skipped = 0;

    for (let i = 2; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row || row.length === 0) continue;
      
      const id = colIndex['ID'] !== undefined ? row[colIndex['ID']] : row[0];
      const type = colIndex['Type'] !== undefined ? row[colIndex['Type']] : row[1];
      const level = colIndex['Level'] !== undefined ? row[colIndex['Level']] : row[2];
      const module = colIndex['Topic'] !== undefined ? row[colIndex['Topic']] : (colIndex['Module'] !== undefined ? row[colIndex['Module']] : row[3]);
      const question = colIndex['Question Sample'] !== undefined ? row[colIndex['Question Sample']] : row[4];
      
      const rubricMustHave = row[rubricMustHaveCol]?.toString() || '';
      const rubricNice = row[rubricNiceCol]?.toString() || '';
      const rubricOpt = row[rubricOptCol]?.toString() || '';
      
      console.log('[Import] Row', i, { id, type, level, module, question: question?.substring(0, 30) });
      
      if (!id || !type || !level || !module || !question) {
        skipped++;
        continue;
      }

      if (!validLevels.includes(level)) {
        errors.push(`Invalid Level "${level}" for ID ${id}`);
        continue;
      }

      if (!validTypes.includes(type)) {
        errors.push(`Invalid Type "${type}" for ID ${id}`);
        continue;
      }

      const normalizedModule = normalizeUnicode(module.toString());

      const existing = await db.query('SELECT id FROM question_bank WHERE id = $1', [id]);
      
      if (existing.rows.length > 0) {
        updated++;
      } else {
        imported++;
      }

      if (USE_SQLITE) {
        await db.query(`
          INSERT OR REPLACE INTO question_bank 
          (id, type, level, module, question_sample, rubric_must_have, rubric_nice_to_have, rubric_optional, updated_at, uploaded_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
        `, [id, type, level, normalizedModule, question, rubricMustHave, rubricNice, rubricOpt, req.adminUser?.id ?? null]);
      } else {
        const pgQuery = `
          INSERT INTO question_bank 
          (id, type, level, module, question_sample, rubric_must_have, rubric_nice_to_have, rubric_optional, updated_at, uploaded_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9)
          ON CONFLICT (id) DO UPDATE SET
            type = EXCLUDED.type,
            level = EXCLUDED.level,
            module = EXCLUDED.module,
            question_sample = EXCLUDED.question_sample,
            rubric_must_have = EXCLUDED.rubric_must_have,
            rubric_nice_to_have = EXCLUDED.rubric_nice_to_have,
            rubric_optional = EXCLUDED.rubric_optional,
            updated_at = CURRENT_TIMESTAMP,
            uploaded_by = EXCLUDED.uploaded_by
        `;
        console.log('[Import] PG Query:', pgQuery);
        await db.query(pgQuery, [id, type, level, normalizedModule, question, rubricMustHave, rubricNice, rubricOpt, req.adminUser?.id ?? null]);
      }
    }

    console.log(`[Import] Imported: ${imported}, Updated: ${updated}, Skipped: ${skipped}`);
    
    res.json({
      success: true,
      imported,
      updated,
      skipped,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error: any) {
    console.error('Import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Import ngân hàng câu hỏi QUIZ (SingleChoice / MultipleChoice) từ Excel.
// Template MỚI (header 1 dòng): ID | Type | Level | Topic | Question Sample |
//   Option A | Option B | Option C | Option D | Option E | Option F | Correct | Score
// Correct: chữ cái (A) cho single; nhiều chữ cách nhau phẩy (A,C,D) cho multiple.
// Score: điểm câu (mặc định 1). Option để trống → câu ít lựa chọn hơn.
router.post('/questions/quiz/import', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const XLSX = await loadXlsx();
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 }) as any[][];

    if (rawData.length < 2) {
      return res.status(400).json({ error: 'Invalid file format' });
    }

    const header = rawData[0];
    const colIndex: Record<string, number> = {};
    header.forEach((col, i) => {
      if (col) colIndex[col.toString().trim()] = i;
    });

    const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F'];
    const validLevels = ['Easy', 'Medium', 'Hard'];
    const validTypes = ['SingleChoice', 'MultipleChoice'];
    const errors: string[] = [];
    let imported = 0;
    let updated = 0;
    let skipped = 0;

    const get = (row: any[], name: string) =>
      colIndex[name] !== undefined ? row[colIndex[name]] : undefined;

    for (let i = 1; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row || row.length === 0) continue;

      const id = get(row, 'ID');
      const type = get(row, 'Type')?.toString().trim();
      const level = get(row, 'Level')?.toString().trim();
      const module = (get(row, 'Topic') ?? get(row, 'Module'))?.toString();
      const question = get(row, 'Question Sample')?.toString();

      if (!id || !type || !level || !module || !question) {
        skipped++;
        continue;
      }
      if (!validLevels.includes(level)) {
        errors.push(`Invalid Level "${level}" for ID ${id}`);
        continue;
      }
      if (!validTypes.includes(type)) {
        errors.push(`Invalid Type "${type}" for ID ${id} (expected SingleChoice/MultipleChoice)`);
        continue;
      }

      // Đọc các option A–F, bỏ qua ô trống
      const options: { key: string; text: string }[] = [];
      for (const key of OPTION_KEYS) {
        const text = get(row, `Option ${key}`);
        if (text !== undefined && text !== null && text.toString().trim() !== '') {
          options.push({ key, text: text.toString() });
        }
      }
      if (options.length < 2) {
        errors.push(`ID ${id}: needs at least 2 options`);
        continue;
      }

      // Correct: "A" hoặc "A,C,D" → mảng key, phải nằm trong options
      const correctRaw = get(row, 'Correct')?.toString() || '';
      const correct = correctRaw
        .split(',')
        .map((s: string) => s.trim().toUpperCase())
        .filter((s: string) => s.length > 0);
      const availableKeys = options.map((o) => o.key);
      const invalidCorrect = correct.filter((c: string) => !availableKeys.includes(c));
      if (correct.length === 0) {
        errors.push(`ID ${id}: missing correct answer (Correct column)`);
        continue;
      }
      if (invalidCorrect.length > 0) {
        errors.push(`ID ${id}: answer "${invalidCorrect.join(',')}" is not among the options`);
        continue;
      }
      if (type === 'SingleChoice' && correct.length !== 1) {
        errors.push(`ID ${id}: SingleChoice must have exactly 1 correct answer, found ${correct.length}`);
        continue;
      }

      const scoreRaw = get(row, 'Score');
      const score = scoreRaw !== undefined && scoreRaw !== '' && !isNaN(Number(scoreRaw))
        ? Number(scoreRaw)
        : 1;

      const normalizedModule = normalizeUnicode(module);
      const optionsJson = JSON.stringify(options);
      const correctJson = JSON.stringify(correct);

      const existing = await db.query('SELECT id FROM question_bank WHERE id = $1', [id]);
      if (existing.rows.length > 0) updated++; else imported++;

      // rubric_* là NOT NULL trong schema → điền '' cho câu quiz
      if (USE_SQLITE) {
        await db.query(`
          INSERT OR REPLACE INTO question_bank
          (id, type, level, module, question_sample, rubric_must_have, rubric_nice_to_have, rubric_optional, options, correct_answers, score, updated_at, uploaded_by)
          VALUES (?, ?, ?, ?, ?, '', '', '', ?, ?, ?, datetime('now'), ?)
        `, [id, type, level, normalizedModule, question, optionsJson, correctJson, score, req.adminUser?.id ?? null]);
      } else {
        await db.query(`
          INSERT INTO question_bank
          (id, type, level, module, question_sample, rubric_must_have, rubric_nice_to_have, rubric_optional, options, correct_answers, score, updated_at, uploaded_by)
          VALUES ($1, $2, $3, $4, $5, '', '', '', $6, $7, $8, CURRENT_TIMESTAMP, $9)
          ON CONFLICT (id) DO UPDATE SET
            type = EXCLUDED.type,
            level = EXCLUDED.level,
            module = EXCLUDED.module,
            question_sample = EXCLUDED.question_sample,
            options = EXCLUDED.options,
            correct_answers = EXCLUDED.correct_answers,
            score = EXCLUDED.score,
            updated_at = CURRENT_TIMESTAMP,
            uploaded_by = EXCLUDED.uploaded_by
        `, [id, type, level, normalizedModule, question, optionsJson, correctJson, score, req.adminUser?.id ?? null]);
      }
    }

    console.log(`[QuizImport] Imported: ${imported}, Updated: ${updated}, Skipped: ${skipped}`);
    res.json({
      success: true,
      imported,
      updated,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error: any) {
    console.error('Quiz import error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/questions/paged', async (req: Request, res: Response) => {
  try {
    const requestedPage = Number(req.query.page || 1);
    const pageSize = Number(req.query.pageSize || 25);
    const moduleName = typeof req.query.module === 'string' ? req.query.module.trim() : '';
    const category = typeof req.query.category === 'string' ? req.query.category : 'all';
    const allowedPageSizes = new Set([10, 25, 50]);
    if (!Number.isInteger(requestedPage) || requestedPage < 1) return res.status(400).json({ error: 'Invalid page' });
    if (!allowedPageSizes.has(pageSize)) return res.status(400).json({ error: 'Invalid page size' });
    if (!['all', 'essay', 'quiz'].includes(category)) return res.status(400).json({ error: 'Invalid category' });

    res.json(await loadPagedQuestions(db, {
      page: requestedPage,
      pageSize,
      moduleName,
      category: category as QuestionCategory,
    }));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/questions/catalog-summary', async (_req: Request, res: Response) => {
  try {
    res.json(await loadQuestionCatalogSummary(db));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/questions/check-id', async (req: Request, res: Response) => {
  try {
    return res.json(await isQuestionIdAvailable(db, req.query.id));
  } catch (error: any) {
    if (error instanceof QuestionValidationError) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

router.get('/questions', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM question_bank ORDER BY module, level');
    res.json(result.rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/questions', async (req: Request, res: Response) => {
  try {
    const uploadedBy = req.adminUser?.id;
    if (!Number.isInteger(uploadedBy)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const question = validateQuestionCreate(req.body);
    await insertQuestion(db, question, uploadedBy as number);
    return res.status(201).json({ success: true, id: question.id });
  } catch (error: any) {
    if (error instanceof QuestionValidationError) {
      return res.status(400).json({ error: error.message });
    }
    if (isDuplicateQuestionIdError(error)) {
      const id = (() => {
        try { return validateQuestionId(req.body?.id); } catch (_) { return ''; }
      })();
      return res.status(409).json({ error: `Question ID "${id}" already exists` });
    }
    return res.status(500).json({ error: error.message });
  }
});

router.put('/questions/:id', async (req: Request, res: Response) => {
  try {
    const existing = await db.query('SELECT id, uploaded_by FROM question_bank WHERE id = ?', [req.params.id]);
    const question = existing.rows[0];
    if (!question) return res.status(404).json({ error: 'Question not found' });
    if (req.adminUser?.role !== 'admin' && question.uploaded_by !== req.adminUser?.id) {
      return res.status(403).json({ error: 'Forbidden: You can only edit questions you uploaded' });
    }

    const update = validateQuestionUpdate(req.body);
    await db.query(`
      UPDATE question_bank
      SET type = ?, level = ?, module = ?, question_sample = ?,
          rubric_must_have = ?, rubric_nice_to_have = ?, rubric_optional = ?,
          options = ?, correct_answers = ?, score = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      update.type,
      update.level,
      normalizeUnicode(update.module),
      update.question_sample,
      update.rubric_must_have,
      update.rubric_nice_to_have,
      update.rubric_optional,
      update.options ? JSON.stringify(update.options) : null,
      update.correct_answers ? JSON.stringify(update.correct_answers) : null,
      update.score,
      req.params.id,
    ]);
    return res.json({ success: true, id: req.params.id });
  } catch (error: any) {
    if (error instanceof QuestionValidationError) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: error.message });
  }
});

router.get('/questions/modules', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT DISTINCT module FROM question_bank ORDER BY module');
    res.json(result.rows.map((m: any) => m.module));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Returns question counts per module broken down by difficulty level
router.get('/questions/module-stats', async (req: Request, res: Response) => {
  try {
    const result = await db.query(`
      SELECT
        module,
        SUM(CASE WHEN LOWER(level) = 'easy'   THEN 1 ELSE 0 END) AS easy,
        SUM(CASE WHEN LOWER(level) = 'medium' THEN 1 ELSE 0 END) AS medium,
        SUM(CASE WHEN LOWER(level) = 'hard'   THEN 1 ELSE 0 END) AS hard
      FROM question_bank
      GROUP BY module
      ORDER BY module
    `);
    res.json(result.rows.map((r: any) => ({
      module: r.module,
      easy:   Number(r.easy)   || 0,
      medium: Number(r.medium) || 0,
      hard:   Number(r.hard)   || 0,
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Returns question counts per type broken down by difficulty level
router.get('/questions/type-stats', async (req: Request, res: Response) => {
  try {
    const result = await db.query(`
      SELECT
        type,
        SUM(CASE WHEN LOWER(level) = 'easy'   THEN 1 ELSE 0 END) AS easy,
        SUM(CASE WHEN LOWER(level) = 'medium' THEN 1 ELSE 0 END) AS medium,
        SUM(CASE WHEN LOWER(level) = 'hard'   THEN 1 ELSE 0 END) AS hard
      FROM question_bank
      GROUP BY type
      ORDER BY type
    `);
    res.json(result.rows.map((r: any) => ({
      type:   r.type,
      easy:   Number(r.easy)   || 0,
      medium: Number(r.medium) || 0,
      hard:   Number(r.hard)   || 0,
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Returns question counts per (module, type) combination broken down by difficulty level
router.get('/questions/module-type-stats', async (req: Request, res: Response) => {
  try {
    const result = await db.query(`
      SELECT
        module,
        type,
        SUM(CASE WHEN LOWER(level) = 'easy'   THEN 1 ELSE 0 END) AS easy,
        SUM(CASE WHEN LOWER(level) = 'medium' THEN 1 ELSE 0 END) AS medium,
        SUM(CASE WHEN LOWER(level) = 'hard'   THEN 1 ELSE 0 END) AS hard
      FROM question_bank
      GROUP BY module, type
      ORDER BY module, type
    `);
    res.json(result.rows.map((r: any) => ({
      module: r.module,
      type:   r.type,
      easy:   Number(r.easy)   || 0,
      medium: Number(r.medium) || 0,
      hard:   Number(r.hard)   || 0,
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Keep the dynamic GET route after every /questions/* static GET route so IDs
// such as "modules" cannot shadow the catalog/statistics endpoints.
router.get('/questions/:id', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM question_bank WHERE id = ?', [req.params.id]);
    const question = result.rows[0];
    if (!question) return res.status(404).json({ error: 'Question not found' });
    if (req.adminUser?.role !== 'admin' && question.uploaded_by !== req.adminUser?.id) {
      return res.status(403).json({ error: 'Forbidden: You can only edit questions you uploaded' });
    }

    const parseJsonArray = (value: unknown): unknown[] => {
      if (Array.isArray(value)) return value;
      if (typeof value !== 'string' || !value) return [];
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    };

    return res.json({
      ...question,
      options: parseJsonArray(question.options),
      correct_answers: parseJsonArray(question.correct_answers),
      score: Number(question.score ?? 1),
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/questions/bulk-delete', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No question IDs provided' });
    }

    // Kiểm tra quyền: mod chỉ được xóa question của mình
    if (req.adminUser?.role !== 'admin') {
      const userId = req.adminUser?.id;
      if (USE_SQLITE) {
        const placeholders = ids.map(() => '?').join(', ');
        const owned = await db.query(
          `SELECT id FROM question_bank WHERE id IN (${placeholders}) AND uploaded_by = ?`,
          [...ids, userId]
        );
        const ownedIds = new Set(owned.rows.map((r: any) => r.id));
        const forbidden = ids.filter(id => !ownedIds.has(id));
        if (forbidden.length > 0) {
          return res.status(403).json({ error: 'Forbidden: You can only delete questions you uploaded' });
        }
      } else {
        const owned = await db.query(
          `SELECT id FROM question_bank WHERE id = ANY($1::text[]) AND uploaded_by = $2`,
          [ids, userId]
        );
        const ownedIds = new Set(owned.rows.map((r: any) => r.id));
        const forbidden = ids.filter(id => !ownedIds.has(id));
        if (forbidden.length > 0) {
          return res.status(403).json({ error: 'Forbidden: You can only delete questions you uploaded' });
        }
      }
    }

    if (USE_SQLITE) {
      const placeholders = ids.map(() => '?').join(', ');
      await db.query(`DELETE FROM question_bank WHERE id IN (${placeholders})`, ids);
    } else {
      await db.query(`DELETE FROM question_bank WHERE id = ANY($1::text[])`, [ids]);
    }

    res.json({ success: true, deleted: ids.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/questions/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // Kiểm tra quyền: mod chỉ được xóa question của mình
    if (req.adminUser?.role !== 'admin') {
      const own = await db.query('SELECT uploaded_by FROM question_bank WHERE id = ?', [id]);
      if (!own.rows[0] || own.rows[0].uploaded_by !== req.adminUser?.id) {
        return res.status(403).json({ error: 'Forbidden: You can only delete questions you uploaded' });
      }
    }
    await db.query('DELETE FROM question_bank WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/batches', async (req: Request, res: Response) => {
  try {
    const { name, start_time, end_time, duration, blueprint, record_mode, exam_type } = req.body;
    console.log('[CreateBatch] Input:', { name, start_time, end_time, duration, blueprint, exam_type, record_mode });
    const examType = exam_type === 'quiz' ? 'quiz' : 'essay';

    if (!name || !start_time || !end_time || !duration) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Support both legacy array format and new { blueprintMode, items } object format
    const { items: blueprintItems } = parseBlueprintCompat(blueprint);
    const totalQuestions = blueprintItems.reduce((sum: number, item: any) => sum + (item.easy || 0) + (item.medium || 0) + (item.hard || 0), 0);
    if (totalQuestions < 1 || totalQuestions > 100) {
      return res.status(400).json({ error: 'Total questions must be between 1 and 100' });
    }

    const blueprintJson = JSON.stringify(blueprint);
    console.log('[CreateBatch] Blueprint JSON:', blueprintJson);
    
    const startUTC = toStorageTime(start_time);
    const endUTC = toStorageTime(end_time);
    console.log('[CreateBatch] Times (UTC stored):', { start_time: startUTC, end_time: endUTC });
    
    // Chế độ record ('none' | 'local' | 's3') chỉ được đặt khác 'none' bởi role 'admin'.
    // Mod tạo batch → luôn ép 'none'. record_enabled giữ đồng bộ (= mode==='s3') để tương thích ngược.
    const RECORD_MODES = ['none', 'local', 's3'];
    let recordMode = RECORD_MODES.includes(record_mode) ? record_mode : 'none';
    if (req.adminUser?.role !== 'admin') recordMode = 'none';
    const recordFlag = recordMode === 's3' ? 1 : 0;

    // Lưu người tạo batch
    const createdBy = req.adminUser?.id ?? null;

    let result;
    if (USE_SQLITE) {
      result = await db.query(`
        INSERT INTO batches (name, start_time, end_time, duration, blueprint, record_enabled, record_mode, exam_type, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [name, startUTC, endUTC, duration, blueprintJson, recordFlag, recordMode, examType, createdBy]);
    } else {
      result = await db.query(`
        INSERT INTO batches (name, start_time, end_time, duration, blueprint, record_enabled, record_mode, exam_type, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id
      `, [name, startUTC, endUTC, duration, blueprintJson, !!recordFlag, recordMode, examType, createdBy]);
    }
    console.log('[CreateBatch] Success, id:', result.lastInsertRowid);
    res.json({ success: true, id: result.lastInsertRowid || result.rows?.[0]?.id });
  } catch (error: any) {
    console.error('[CreateBatch] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/batches', async (req: Request, res: Response) => {
  try {
    const result = await db.query(`
      SELECT b.*, COUNT(s.id) as students_count 
      FROM batches b 
      LEFT JOIN students s ON b.id = s.batch_id 
      GROUP BY b.id 
      ORDER BY b.created_at DESC
    `);
    const batches = result.rows.map((b: any) => ({
      ...b,
      students_count: b.students_count || 0,
      blueprint: b.blueprint ? (typeof b.blueprint === 'string' ? JSON.parse(b.blueprint) : b.blueprint) : null
    }));
    res.json(batches);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/batches/paged', async (req: Request, res: Response) => {
  try {
    const page = Number(req.query.page || 1);
    const pageSize = Number(req.query.pageSize || 10);
    const includeBlueprint = req.query.includeBlueprint === 'true';
    const allowedPageSizes = new Set([10, 25, 50]);
    if (!Number.isInteger(page) || page < 1) return res.status(400).json({ error: 'Invalid page' });
    if (!allowedPageSizes.has(pageSize)) return res.status(400).json({ error: 'Invalid page size' });
    const [result, aiSetting] = await Promise.all([
      loadPagedBatches(db, { page, pageSize, includeBlueprint }),
      includeBlueprint && req.adminUser?.id
        ? getOwnedAiSetting(db, req.adminUser.id)
        : Promise.resolve({ testStatus: 'not_requested' }),
    ]);
    return res.json({
      ...result,
      aiSettingsVerified: aiSetting.testStatus === 'verified',
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/batches/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await db.query('SELECT * FROM batches WHERE id = ?', [parseInt(id)]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Batch not found' });
    }
    
    const batch = result.rows[0];
    res.json({
      ...batch,
      blueprint: batch.blueprint ? (typeof batch.blueprint === 'string' ? JSON.parse(batch.blueprint) : batch.blueprint) : null
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/batches/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const batchId = parseInt(id);
    const { name, start_time, end_time, duration, blueprint, record_mode, exam_type } = req.body;
    const examType = exam_type === 'quiz' ? 'quiz' : 'essay';

    const currentResult = await db.query(
      'SELECT created_by, record_mode FROM batches WHERE id = ?',
      [batchId]
    );
    const currentBatch = currentResult.rows[0];
    if (!currentBatch) return res.status(404).json({ error: 'Batch not found' });

    // Kiểm tra quyền: mod chỉ được sửa batch của mình
    if (req.adminUser?.role !== 'admin') {
      if (currentBatch.created_by !== req.adminUser?.id) {
        return res.status(403).json({ error: 'Forbidden: You can only edit batches you created' });
      }
    }

    const startUTC = toStorageTime(start_time);
    const endUTC = toStorageTime(end_time);

    // Chế độ record: admin dùng giá trị client gửi; mod KHÔNG đổi được → giữ nguyên mode cũ trong DB.
    const RECORD_MODES = ['none', 'local', 's3'];
    let recordMode: string;
    if (req.adminUser?.role === 'admin') {
      recordMode = RECORD_MODES.includes(record_mode) ? record_mode : 'none';
    } else {
      recordMode = currentBatch.record_mode || 'none';
    }
    const recordFlag = recordMode === 's3' ? 1 : 0;

    await db.query(`
      UPDATE batches SET name = ?, start_time = ?, end_time = ?, duration = ?, blueprint = ?, record_enabled = ?, record_mode = ?, exam_type = ?
      WHERE id = ?
    `, [name, startUTC, endUTC, duration, JSON.stringify(blueprint), USE_SQLITE ? recordFlag : !!recordFlag, recordMode, examType, batchId]);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/batches/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const batchId = parseInt(id);

    // Kiểm tra quyền: mod chỉ được xóa batch của mình
    if (req.adminUser?.role !== 'admin') {
      const own = await db.query('SELECT created_by FROM batches WHERE id = ?', [batchId]);
      if (!own.rows[0] || own.rows[0].created_by !== req.adminUser?.id) {
        return res.status(403).json({ error: 'Forbidden: You can only delete batches you created' });
      }
    }
    
    // Delete cascade: exam_questions -> students -> batch
    await db.query('DELETE FROM exam_questions WHERE student_id IN (SELECT id FROM students WHERE batch_id = ?)', [batchId]);
    await db.query('DELETE FROM violations WHERE student_id IN (SELECT id FROM students WHERE batch_id = ?)', [batchId]);
    await db.query('DELETE FROM students WHERE batch_id = ?', [batchId]);
    await db.query('DELETE FROM batches WHERE id = ?', [batchId]);
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/batches/:id/check-feasibility', async (req: Request, res: Response) => {
  try {
    const { blueprint } = req.body;
    const errors: string[] = [];
    const { blueprintMode, items: blueprintItems } = parseBlueprintCompat(blueprint);

    for (const item of blueprintItems) {
      for (const level of ['Easy', 'Medium', 'Hard'] as const) {
        const count = item[level.toLowerCase() as 'easy' | 'medium' | 'hard'];
        if (count > 0) {
          const typeSql = blueprintMode === 'type' ? 'AND LOWER(type) = LOWER(?)' : '';
          const params = blueprintMode === 'type'
            ? [item.module, level, item.type]
            : [item.module, level];
          const result = await db.query(`
            SELECT COUNT(*) as count FROM question_bank
            WHERE LOWER(module) = LOWER(?) AND LOWER(level) = LOWER(?) ${typeSql}
          `, params);

          const available = parseInt(result.rows[0].count);
          if (available < count) {
            errors.push(`Module ${item.module} Level ${level} has only ${available} questions, need ${count}`);
          }
        }
      }
    }

    res.json({ feasible: errors.length === 0, errors });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/batches/:id/students/import', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { emails } = req.body;
    
    console.log('==== IMPORT STUDENTS START ====');
    console.log('batchId:', id);
    console.log('emails:', emails);

    if (!emails || !Array.isArray(emails)) {
      return res.status(400).json({ error: 'Invalid emails array' });
    }

    const generateCode = () => {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let i = 0; i < 8; i++) {
        code += chars.charAt(crypto.randomInt(chars.length));
      }
      return code;
    };

    const batchId = parseInt(id);
    const students: {email: string; code: string}[] = [];
    
    console.log('Fetching batch...');
    const batchResult = await db.query('SELECT id, blueprint FROM batches WHERE id = ?', [batchId]);
    const batch = batchResult.rows[0];
    console.log('Batch found:', batch ? 'yes' : 'no');
    console.log('Batch blueprint:', batch?.blueprint);
    
    if (!batch || !batch.blueprint) {
      console.log('[Import Students] ERROR: Batch has no blueprint');
      return res.status(400).json({ error: 'Batch has no blueprint' });
    }
    
    let blueprint;
    try {
      if (typeof batch.blueprint === 'string') {
        blueprint = JSON.parse(batch.blueprint);
      } else {
        blueprint = batch.blueprint;
      }
    } catch (e) {
      console.log('[Import Students] JSON parse error:', e);
      blueprint = [];
    }
    
    console.log('Parsed blueprint:', JSON.stringify(blueprint));
    
    // Support both legacy array and new { blueprintMode, items } formats
    const { items: parsedBlueprintItems } = parseBlueprintCompat(blueprint);
    if (!parsedBlueprintItems || parsedBlueprintItems.length === 0) {
      return res.status(400).json({ error: 'Blueprint is empty' });
    }
    
    const existingResult = await db.query(
      'SELECT LOWER(email) as email FROM students WHERE batch_id = ?', 
      [batchId]
    );
    const existingEmailSet = new Set(existingResult.rows.map((r: any) => r.email));

    const skippedEmails: string[] = [];
    const seenInRequest = new Set();

    const validEmails = emails.filter((email: string) => {
      const emailLower = email.trim().toLowerCase();
      
      if (existingEmailSet.has(emailLower)) {
        skippedEmails.push(email);
        return false;
      }
      
      if (seenInRequest.has(emailLower)) {
        skippedEmails.push(email);
        return false;
      }
      
      seenInRequest.add(emailLower);
      existingEmailSet.add(emailLower);
      return true;
    });

    if (skippedEmails.length > 0) {
      console.log('[Import] Skipped duplicate emails:', skippedEmails);
    }

    for (const email of validEmails) {
      let code = '';
      let studentResult: any = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        code = generateCode();
        try {
          studentResult = await db.query(`
            INSERT INTO students (batch_id, email, access_code, status)
            VALUES (?, ?, ?, 'pending')
            RETURNING id
          `, [batchId, email.trim(), code]);
          break;
        } catch (error: any) {
          const uniqueCollision = error?.code === '23505' || String(error?.message || '').includes('UNIQUE constraint failed');
          if (!uniqueCollision || attempt === 4) throw error;
        }
      }
      if (!studentResult) throw new Error('Could not generate a unique access code');
      
      const studentId = studentResult.rows[0]?.id;
      console.log('Student created:', studentId);
      
      if (!studentId) continue;
      
      const questionIds: string[] = [];

      // Parse blueprint supporting both legacy (array) and new ({ blueprintMode, items }) formats
      const { blueprintMode, items: blueprintItems } = parseBlueprintCompat(blueprint);
      console.log(`[Import Students] blueprintMode=${blueprintMode}, items count=${blueprintItems.length}`);
      
      for (const item of blueprintItems) {
        const easy   = item.easy   || 0;
        const medium = item.medium || 0;
        const hard   = item.hard   || 0;

        if (blueprintMode === 'type') {
          // By Module + Type: query WHERE module = ? AND type = ? AND level = ?
          const moduleName = (item.module || '').toLowerCase().trim();
          const typeName   = (item.type   || '').toLowerCase().trim();
          console.log(`Processing by module+type: ${item.module}/${item.type}, easy=${easy}, medium=${medium}, hard=${hard}`);

          if (easy > 0) {
            const r = await db.query('SELECT id FROM question_bank WHERE LOWER(module) = ? AND LOWER(type) = ? AND LOWER(level) = ? ORDER BY RANDOM() LIMIT ?', [moduleName, typeName, 'easy', easy]);
            console.log(`  Module+Type Easy: found ${r.rows.length}`);
            r.rows.forEach((q: any) => questionIds.push(q.id));
          }
          if (medium > 0) {
            const r = await db.query('SELECT id FROM question_bank WHERE LOWER(module) = ? AND LOWER(type) = ? AND LOWER(level) = ? ORDER BY RANDOM() LIMIT ?', [moduleName, typeName, 'medium', medium]);
            console.log(`  Module+Type Medium: found ${r.rows.length}`);
            r.rows.forEach((q: any) => questionIds.push(q.id));
          }
          if (hard > 0) {
            const r = await db.query('SELECT id FROM question_bank WHERE LOWER(module) = ? AND LOWER(type) = ? AND LOWER(level) = ? ORDER BY RANDOM() LIMIT ?', [moduleName, typeName, 'hard', hard]);
            console.log(`  Module+Type Hard: found ${r.rows.length}`);
            r.rows.forEach((q: any) => questionIds.push(q.id));
          }
        } else {
          // Default: By Module only
          const moduleName = (item.module || '').toLowerCase().trim();
          console.log(`Processing by module: ${item.module} -> ${moduleName}, easy=${easy}, medium=${medium}, hard=${hard}`);

          if (easy > 0) {
            const r = await db.query('SELECT id FROM question_bank WHERE LOWER(module) = ? AND LOWER(level) = ? ORDER BY RANDOM() LIMIT ?', [moduleName, 'easy', easy]);
            console.log(`  Module Easy: found ${r.rows.length}`);
            r.rows.forEach((q: any) => questionIds.push(q.id));
          }
          if (medium > 0) {
            const r = await db.query('SELECT id FROM question_bank WHERE LOWER(module) = ? AND LOWER(level) = ? ORDER BY RANDOM() LIMIT ?', [moduleName, 'medium', medium]);
            console.log(`  Module Medium: found ${r.rows.length}`);
            r.rows.forEach((q: any) => questionIds.push(q.id));
          }
          if (hard > 0) {
            const r = await db.query('SELECT id FROM question_bank WHERE LOWER(module) = ? AND LOWER(level) = ? ORDER BY RANDOM() LIMIT ?', [moduleName, 'hard', hard]);
            console.log(`  Module Hard: found ${r.rows.length}`);
            r.rows.forEach((q: any) => questionIds.push(q.id));
          }
        }
      }
      
      console.log('Total questions:', questionIds.length);
      
      // Insert into exam_questions
      for (let i = 0; i < questionIds.length; i++) {
        await db.query('INSERT INTO exam_questions (student_id, question_id, question_order) VALUES (?, ?, ?)', [studentId, questionIds[i], i + 1]);
      }
      console.log('Inserted into exam_questions');
      
      students.push({ email: email.trim(), code });
    }

    res.json({ 
      success: true, 
      count: validEmails.length, 
      students,
      skippedEmails: skippedEmails.length > 0 ? skippedEmails : undefined
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/batches/:id/students', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await db.query('SELECT * FROM students WHERE batch_id = ?', [parseInt(id)]);
    res.json(result.rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/batches/:id/students/paged', async (req: Request, res: Response) => {
  try {
    const batchId = Number(req.params.id);
    const page = Number(req.query.page || 1);
    const pageSize = Number(req.query.pageSize || 25);
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 200) : '';
    const allowedPageSizes = new Set([10, 25, 50]);
    if (!Number.isInteger(batchId) || batchId < 1) return res.status(400).json({ error: 'Invalid batch id' });
    if (!Number.isInteger(page) || page < 1) return res.status(400).json({ error: 'Invalid page' });
    if (!allowedPageSizes.has(pageSize)) return res.status(400).json({ error: 'Invalid page size' });
    const result = await loadPagedStudents(db, batchId, { page, pageSize, search });
    if (!result) return res.status(404).json({ error: 'Batch not found' });
    return res.json(result);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/students/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM exam_questions WHERE student_id = ?', [parseInt(id)]);
    await db.query('DELETE FROM violations WHERE student_id = ?', [parseInt(id)]);
    await db.query('DELETE FROM students WHERE id = ?', [parseInt(id)]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/batches/:id/students/export', async (req: Request, res: Response) => {
  try {
    const XLSX = await loadXlsx();
    const { id } = req.params;
    const result = await db.query('SELECT email, access_code FROM students WHERE batch_id = ?', [parseInt(id)]);
    const students = result.rows;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=students-${id}.xlsx`);

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(students);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Students');
    const buffer = XLSX.write(workbook, { type: 'buffer' });
    res.send(buffer);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/students/:studentId/reset', async (req: Request, res: Response) => {
  try {
    const studentId = Number(req.params.studentId);
    const durationMinutes = Number(req.body?.duration_minutes);

    // Preserve any last edits that are still waiting in the answer buffer.
    await cache.flushStudentAnswers(studentId);
    const result = await db.withTransaction((tx) =>
      reopenExamAttempt(tx, studentId, durationMinutes, new Date(), !USE_SQLITE)
    );
    // The transaction also clears the old session/recording metadata.
    res.json({
      success: true,
      message: 'Exam reopened. The student must sign in again with the access code.',
      ...result,
    });
  } catch (error: any) {
    if (error instanceof ExamResetError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    res.status(500).json({ error: error.message });
  }
});

router.get('/batches/:id/results/summary', async (req: Request, res: Response) => {
  try {
    const batchId = Number(req.params.id);
    const requestedPage = Number(req.query.page || 1);
    const requestedPageSize = Number(req.query.pageSize || 25);
    const allowedPageSizes = new Set([10, 25, 50]);
    if (!Number.isInteger(batchId) || batchId < 1) return res.status(400).json({ error: 'Invalid batch id' });
    if (!Number.isInteger(requestedPage) || requestedPage < 1) return res.status(400).json({ error: 'Invalid page' });
    if (!allowedPageSizes.has(requestedPageSize)) return res.status(400).json({ error: 'Invalid page size' });

    const userId = req.adminUser?.id;
    const [result, batchResult, aiSetting] = await Promise.all([
      loadBatchResultsSummary(db, batchId, {
        page: requestedPage,
        pageSize: requestedPageSize,
      }),
      db.query(`
        SELECT id, name, duration, record_mode, exam_type, created_by
        FROM batches WHERE id = ?
      `, [batchId]),
      userId ? getOwnedAiSetting(db, userId) : Promise.resolve({ testStatus: 'not_configured' }),
    ]);
    const batch = batchResult.rows[0];
    if (!batch) return res.status(404).json({ error: 'Batch not found' });
    res.json({
      ...result,
      batch,
      canAiGrade: batch.exam_type === 'essay'
        && Number(batch.created_by) === Number(userId)
        && aiSetting.testStatus === 'verified',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// One button click is one backend invocation. Inside it, each submitted student is
// graded with an independent LLM request (with per-student chunk fallback).
router.post('/batches/:id/ai-grade', async (req: Request, res: Response) => {
  try {
    const batchId = Number(req.params.id);
    const userId = req.adminUser?.id;
    if (!Number.isInteger(batchId) || batchId < 1) return res.status(400).json({ error: 'Invalid batch id' });
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    return res.json(await gradeBatchManually(db, batchId, userId));
  } catch (error: any) {
    if (error instanceof AiGradingError) return res.status(error.statusCode).json({ error: error.message });
    console.error('[AI Grade] Batch grading failed:', error?.message || error);
    const batchId = Number(req.params.id);
    if (Number.isInteger(batchId) && req.adminUser?.id) {
      await db.query(`
        UPDATE batches SET ai_grading_status = 'partial', ai_grading_started_at = NULL
        WHERE id = ? AND created_by = ? AND ai_grading_status = 'processing'
      `, [batchId, req.adminUser.id]).catch(() => {});
    }
    return res.status(500).json({ error: error?.message || 'AI grading failed' });
  }
});

router.post('/batches/:batchId/students/:studentId/ai-grade', async (req: Request, res: Response) => {
  try {
    const batchId = Number(req.params.batchId);
    const studentId = Number(req.params.studentId);
    const userId = req.adminUser?.id;
    if (!Number.isInteger(batchId) || batchId < 1) return res.status(400).json({ error: 'Invalid batch id' });
    if (!Number.isInteger(studentId) || studentId < 1) return res.status(400).json({ error: 'Invalid student id' });
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    return res.json(await gradeStudentManually(db, batchId, studentId, userId));
  } catch (error: any) {
    if (error instanceof AiGradingError) return res.status(error.statusCode).json({ error: error.message });
    console.error('[AI Grade] Student grading failed:', error?.message || error);
    return res.status(500).json({ error: error?.message || 'AI grading failed' });
  }
});

router.get('/students/:studentId/result-detail', async (req: Request, res: Response) => {
  try {
    const studentId = Number(req.params.studentId);
    if (!Number.isInteger(studentId) || studentId < 1) return res.status(400).json({ error: 'Invalid student id' });
    const detail = await loadStudentResultDetail(db, studentId);
    if (!detail) return res.status(404).json({ error: 'Student not found' });
    res.json(detail);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Backward-compatible endpoint for older clients. It keeps the old response contract,
// but uses five bulk queries instead of five queries for every student.
router.get('/batches/:id/results', async (req: Request, res: Response) => {
  try {
    const batchId = Number(req.params.id);
    if (!Number.isInteger(batchId) || batchId < 1) return res.status(400).json({ error: 'Invalid batch id' });
    res.json(await loadBatchResultsLegacy(db, batchId));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/results/:studentId', async (req: Request, res: Response) => {
  try {
    const { studentId } = req.params;
    const { trainer_score, trainer_feedback } = req.body;
    const parsedStudentId = Number(studentId);
    if (!Number.isInteger(parsedStudentId) || parsedStudentId < 1) {
      return res.status(400).json({ error: 'Invalid student id' });
    }
    await db.query(`
      UPDATE exam_questions
      SET trainer_score = ?, trainer_feedback = ?
      WHERE student_id = ?
    `, [trainer_score, trainer_feedback, parsedStudentId]);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/batches/:id/results/export', async (req: Request, res: Response) => {
  try {
    const XLSX = await loadXlsx();
    const { id } = req.params;
    const batchId = Number(id);
    if (!Number.isInteger(batchId) || batchId < 1) return res.status(400).json({ error: 'Invalid batch id' });
    const exportResults = await loadBatchExportData(db, batchId);

    const workbook = XLSX.utils.book_new();
    const usedSheetNames = new Set<string>();

    for (const result of exportResults) {
      const student = result.student;
      const data = result.questions.map((q: any) => ({
        ID: q.question_id,
        Type: q.type,
        Level: q.level,
        Module: q.module,
        Question: q.question_sample,
        Answer: q.answer || '',
        'Rubric Must-have': q.rubric_must_have,
        'Rubric Nice-to-have': q.rubric_nice_to_have,
        'Rubric Optional': q.rubric_optional,
        'AI Feedback': q.ai_feedback || '',
        'AI Score': q.ai_score || 0,
        'AI Final Score (10)': student.ai_final_score ?? '',
        'AI Summary Feedback': student.ai_summary_feedback || '',
        'Trainer Feedback': q.trainer_feedback || '',
        'Trainer Score': (q.trainer_score ?? q.ai_score) || 0,
        'Violation Count': result.violations
      }));

      const sheet = XLSX.utils.json_to_sheet(data);
      const rawBase = (student.email.split('@')[0] || `Student_${student.id}`)
        .replace(/[\\/?*\[\]:]/g, '_')
        .trim();
      let sheetName = (rawBase || `Student_${student.id}`).substring(0, 31);
      if (usedSheetNames.has(sheetName)) {
        const suffix = `_${student.id}`;
        sheetName = `${sheetName.substring(0, 31 - suffix.length)}${suffix}`;
      }
      let duplicate = 2;
      const uniqueBase = sheetName;
      while (usedSheetNames.has(sheetName)) {
        const suffix = `_${duplicate++}`;
        sheetName = `${uniqueBase.substring(0, 31 - suffix.length)}${suffix}`;
      }
      usedSheetNames.add(sheetName);
      XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=results-${id}.xlsx`);
    res.send(XLSX.write(workbook, { type: 'buffer' }));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/settings/ai', async (req: Request, res: Response) => {
  try {
    return res.json(await getOwnedAiSetting(db, req.adminUser!.id));
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/settings/ai/test', async (req: Request, res: Response) => {
  try {
    return res.json(await testOwnedAiSetting(db, req.adminUser!.id, req.body));
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

router.put('/settings/ai', async (req: Request, res: Response) => {
  try {
    return res.json(await saveOwnedAiSetting(db, req.adminUser!.id, req.body));
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
});

export default router;
