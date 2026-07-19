import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import db from '../db/postgres.js';
import { normalizeUnicode, stripHtml, sanitizeFilename, buildContentDisposition } from '../../utils/string.js';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { authMiddleware, requireSuperAdmin } from '../middleware/auth.js';

dotenv.config();

const USE_SQLITE = !process.env.DATABASE_URL;

console.log('[Admin] USE_SQLITE:', USE_SQLITE, 'NODE_ENV:', process.env.NODE_ENV);

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Rate limit riêng cho login: 10 request/phút
const loginRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// =============================================
// AUTH ROUTES (không require JWT)
// =============================================
// Lưu ý: chức năng tự đăng ký admin (/is-initialized, /setup) đã bị gỡ bỏ vì lý
// do bảo mật. Tài khoản superadmin đầu tiên được seed tự động khi admin_users
// còn trống (xem seedSuperAdmin() trong src/server/db/postgres.ts); các tài
// khoản admin khác chỉ được tạo bởi superadmin qua /api/admin/users.

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
    console.log('[Auth] Login success:', username);
    return res.json({ token, expiresAt, role });
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

// =============================================
// USER MANAGEMENT — Chỉ superadmin (require JWT + role superadmin)
// =============================================

// GET /api/admin/users — Danh sách tài khoản admin (không trả password_hash)
router.get('/users', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      'SELECT id, username, role, created_at, updated_at FROM admin_users ORDER BY created_at ASC'
    );
    return res.json(result.rows);
  } catch (err: any) {
    console.error('[Users] List error:', err);
    return res.status(500).json({ error: 'Failed to list admin users' });
  }
});

// POST /api/admin/users — Tạo tài khoản admin mới
router.post('/users', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const { username, password, role } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (role !== 'admin' && role !== 'superadmin') {
      return res.status(400).json({ error: "role must be 'admin' or 'superadmin'" });
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

    console.log('[Users] Created admin user:', username, 'role:', role, 'by:', req.adminUser!.username);
    return res.status(201).json({ success: true });
  } catch (err: any) {
    console.error('[Users] Create error:', err);
    return res.status(500).json({ error: 'Failed to create admin user' });
  }
});

// PUT /api/admin/users/:id — Đổi role và/hoặc reset password của một tài khoản admin
router.put('/users/:id', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { role, password } = req.body;

    const existing = await db.query('SELECT * FROM admin_users WHERE id = ?', [id]);
    const target = existing.rows[0];
    if (!target) {
      return res.status(404).json({ error: 'Admin user not found' });
    }

    if (role !== undefined) {
      if (role !== 'admin' && role !== 'superadmin') {
        return res.status(400).json({ error: "role must be 'admin' or 'superadmin'" });
      }
      // Không cho phép tự hạ quyền chính mình xuống 'admin' — tránh tự khoá bản thân
      if (Number(id) === req.adminUser!.id && role !== 'superadmin') {
        return res.status(400).json({ error: 'You cannot demote your own account' });
      }
      await db.query('UPDATE admin_users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [role, id]);
    }

    if (password !== undefined) {
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      await db.query('UPDATE admin_users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [passwordHash, id]);
    }

    console.log('[Users] Updated admin user:', target.username, 'by:', req.adminUser!.username);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[Users] Update error:', err);
    return res.status(500).json({ error: 'Failed to update admin user' });
  }
});

// DELETE /api/admin/users/:id — Xoá tài khoản admin
router.delete('/users/:id', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    if (Number(id) === req.adminUser!.id) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    const existing = await db.query('SELECT * FROM admin_users WHERE id = ?', [id]);
    const target = existing.rows[0];
    if (!target) {
      return res.status(404).json({ error: 'Admin user not found' });
    }

    // Không cho xoá superadmin cuối cùng — tránh khoá toàn bộ hệ thống quản trị
    if (target.role === 'superadmin') {
      const superAdmins = await db.query("SELECT COUNT(*) as count FROM admin_users WHERE role = 'superadmin'");
      const count = Number(superAdmins.rows[0]?.count ?? superAdmins.rows[0]?.COUNT ?? 0);
      if (count <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last remaining superadmin' });
      }
    }

    await db.query('DELETE FROM admin_users WHERE id = ?', [id]);
    console.log('[Users] Deleted admin user:', target.username, 'by:', req.adminUser!.username);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('[Users] Delete error:', err);
    return res.status(500).json({ error: 'Failed to delete admin user' });
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
    
    for (const item of blueprint || []) {
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
      const questionGroupRaw = colIndex['QuestionGroup'] ?? colIndex['Question Set'] ?? colIndex['Bộ đề'];
      const questionGroup = (questionGroupRaw !== undefined ? row[questionGroupRaw]?.toString().trim() : '') || '';

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
      const questionPlain = stripHtml(question.toString());

      const existing = await db.query('SELECT id FROM question_bank WHERE id = ?', [id]);

      if (existing.rows.length > 0) {
        updated++;
      } else {
        imported++;
      }

      if (USE_SQLITE) {
        await db.query(`
          INSERT OR REPLACE INTO question_bank
          (id, type, level, module, question_group, question_sample, question_plain, rubric_must_have, rubric_nice_to_have, rubric_optional, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `, [id, type, level, normalizedModule, questionGroup, question, questionPlain, rubricMustHave, rubricNice, rubricOpt]);
      } else {
        const pgQuery = `
          INSERT INTO question_bank
          (id, type, level, module, question_group, question_sample, question_plain, rubric_must_have, rubric_nice_to_have, rubric_optional, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
          ON CONFLICT (id) DO UPDATE SET
            type = EXCLUDED.type,
            level = EXCLUDED.level,
            module = EXCLUDED.module,
            question_group = EXCLUDED.question_group,
            question_sample = EXCLUDED.question_sample,
            question_plain = EXCLUDED.question_plain,
            rubric_must_have = EXCLUDED.rubric_must_have,
            rubric_nice_to_have = EXCLUDED.rubric_nice_to_have,
            rubric_optional = EXCLUDED.rubric_optional,
            updated_at = CURRENT_TIMESTAMP
        `;
        console.log('[Import] PG Query:', pgQuery);
        await db.query(pgQuery, [id, type, level, normalizedModule, questionGroup, question, questionPlain, rubricMustHave, rubricNice, rubricOpt]);
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

router.get('/questions', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM question_bank ORDER BY module, level');
    res.json(result.rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
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

router.get('/questions/question-groups', async (req: Request, res: Response) => {
  try {
    const result = await db.query(`
      SELECT DISTINCT question_group FROM question_bank
      WHERE question_group IS NOT NULL AND question_group != ''
      ORDER BY question_group
    `);
    res.json(result.rows.map((r: any) => r.question_group));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Distinct (module, question_group) combos — used to disambiguate modules that
// exist under multiple question groups (e.g. "Unit Testing" in both CPP_EMB_PRINT_IOT
// and CPP_EMB_AUTOSAR) when building exam blueprints.
router.get('/questions/module-groups', async (req: Request, res: Response) => {
  try {
    const result = await db.query(`
      SELECT DISTINCT module, question_group FROM question_bank
      ORDER BY module, question_group
    `);
    res.json(result.rows.map((r: any) => ({
      module: r.module,
      question_group: r.question_group || '',
    })));
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

// Returns question counts per (module, question_group) combination broken down by difficulty level
router.get('/questions/module-group-stats', async (req: Request, res: Response) => {
  try {
    const result = await db.query(`
      SELECT
        module,
        question_group,
        SUM(CASE WHEN LOWER(level) = 'easy'   THEN 1 ELSE 0 END) AS easy,
        SUM(CASE WHEN LOWER(level) = 'medium' THEN 1 ELSE 0 END) AS medium,
        SUM(CASE WHEN LOWER(level) = 'hard'   THEN 1 ELSE 0 END) AS hard
      FROM question_bank
      GROUP BY module, question_group
      ORDER BY module, question_group
    `);
    res.json(result.rows.map((r: any) => ({
      module: r.module,
      question_group: r.question_group || '',
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

// Returns question counts per (module, question_group, type) combination broken down by difficulty level
router.get('/questions/module-group-type-stats', async (req: Request, res: Response) => {
  try {
    const result = await db.query(`
      SELECT
        module,
        question_group,
        type,
        SUM(CASE WHEN LOWER(level) = 'easy'   THEN 1 ELSE 0 END) AS easy,
        SUM(CASE WHEN LOWER(level) = 'medium' THEN 1 ELSE 0 END) AS medium,
        SUM(CASE WHEN LOWER(level) = 'hard'   THEN 1 ELSE 0 END) AS hard
      FROM question_bank
      GROUP BY module, question_group, type
      ORDER BY module, question_group, type
    `);
    res.json(result.rows.map((r: any) => ({
      module: r.module,
      question_group: r.question_group || '',
      type:   r.type,
      easy:   Number(r.easy)   || 0,
      medium: Number(r.medium) || 0,
      hard:   Number(r.hard)   || 0,
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Parse blueprint supporting both formats:
 *  - Legacy (array): [{ module, easy, medium, hard }]
 *  - New (object):   { blueprintMode: 'module'|'type', items: [...] }
 */
function parseBlueprintCompat(raw: any): { blueprintMode: 'module' | 'type'; items: any[] } {
  if (Array.isArray(raw)) {
    return { blueprintMode: 'module', items: raw };
  }
  if (raw && typeof raw === 'object' && raw.blueprintMode) {
    return { blueprintMode: raw.blueprintMode || 'module', items: raw.items || [] };
  }
  return { blueprintMode: 'module', items: [] };
}

router.post('/questions/bulk-delete', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'No question IDs provided' });
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
    await db.query('DELETE FROM question_bank WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// =============================================
// PRACTICE EXAMS — Quản lý riêng, import từ .docx
// =============================================

// POST /api/admin/practice/import — Upload file .docx + tên bài, convert sang HTML
router.post('/practice/import', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const name = (req.body.name || '').toString().trim() || req.file.originalname.replace(/\.docx?$/i, '');

    if (!/\.docx$/i.test(req.file.originalname)) {
      return res.status(400).json({ error: 'Only .docx files are supported' });
    }

    const conversion = await mammoth.convertToHtml({ buffer: req.file.buffer });
    const contentHtml = conversion.value;
    if (!contentHtml || contentHtml.trim().length === 0) {
      return res.status(400).json({ error: 'Could not extract any content from the .docx file' });
    }
    const contentPlain = stripHtml(contentHtml);

    const result = await db.query(
      `INSERT INTO practice_exams (name, content_html, content_plain) VALUES (?, ?, ?) RETURNING id`,
      [name, contentHtml, contentPlain]
    );
    const id = result.rows[0]?.id ?? result.lastInsertRowid;

    console.log('[Practice] Imported:', name, 'id:', id, 'html length:', contentHtml.length);
    res.status(201).json({ success: true, id, name, warnings: conversion.messages?.map((m: any) => m.message) });
  } catch (error: any) {
    console.error('[Practice] Import error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/practice — Danh sách bài practice (kèm số batch đang dùng)
router.get('/practice', async (req: Request, res: Response) => {
  try {
    const result = await db.query(`
      SELECT p.id, p.name, p.created_at,
             (SELECT COUNT(*) FROM batches b WHERE b.practice_exam_id = p.id) as batches_count
      FROM practice_exams p
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/practice/:id — Chi tiết (kèm content_html để preview)
router.get('/practice/:id', async (req: Request, res: Response) => {
  try {
    const result = await db.query('SELECT * FROM practice_exams WHERE id = ?', [parseInt(req.params.id)]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Practice exam not found' });
    }
    res.json(result.rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/admin/practice/:id — Chặn xoá nếu còn batch đang tham chiếu
router.delete('/practice/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const used = await db.query('SELECT COUNT(*) as count FROM batches WHERE practice_exam_id = ?', [id]);
    const count = Number(used.rows[0]?.count ?? used.rows[0]?.COUNT ?? 0);
    if (count > 0) {
      return res.status(400).json({ error: `Practice exam is used by ${count} batch(es). Delete those batches first.` });
    }
    await db.query('DELETE FROM practice_exams WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/batches', async (req: Request, res: Response) => {
  try {
    const { name, start_time, end_time, duration, blueprint, practice_exam_id } = req.body;
    console.log('[CreateBatch] Input:', { name, start_time, end_time, duration, blueprint, practice_exam_id });

    if (!name || !start_time || !end_time || !duration) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const isPractice = practice_exam_id !== undefined && practice_exam_id !== null && practice_exam_id !== '';
    let blueprintJson: string | null = null;

    if (isPractice) {
      // Batch dạng Practice: không dùng blueprint; xác nhận bài practice tồn tại
      const pe = await db.query('SELECT id FROM practice_exams WHERE id = ?', [parseInt(practice_exam_id)]);
      if (pe.rows.length === 0) {
        return res.status(400).json({ error: 'Practice exam not found' });
      }
    } else {
      // Support both legacy array format and new { blueprintMode, items } object format
      const { items: blueprintItems } = parseBlueprintCompat(blueprint);
      const totalQuestions = blueprintItems.reduce((sum: number, item: any) => sum + (item.easy || 0) + (item.medium || 0) + (item.hard || 0), 0);
      if (totalQuestions < 1 || totalQuestions > 20) {
        return res.status(400).json({ error: 'Total questions must be between 1 and 20' });
      }
      blueprintJson = JSON.stringify(blueprint);
      console.log('[CreateBatch] Blueprint JSON:', blueprintJson);
    }

    const startUTC = toStorageTime(start_time);
    const endUTC = toStorageTime(end_time);
    console.log('[CreateBatch] Times (UTC stored):', { start_time: startUTC, end_time: endUTC });

    const practiceExamId = isPractice ? parseInt(practice_exam_id) : null;
    let result;
    if (USE_SQLITE) {
      result = await db.query(`
        INSERT INTO batches (name, start_time, end_time, duration, blueprint, practice_exam_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [name, startUTC, endUTC, duration, blueprintJson, practiceExamId]);
    } else {
      result = await db.query(`
        INSERT INTO batches (name, start_time, end_time, duration, blueprint, practice_exam_id)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [name, startUTC, endUTC, duration, blueprintJson, practiceExamId]);
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
    const { name, start_time, end_time, duration, blueprint, practice_exam_id } = req.body;

    const startUTC = toStorageTime(start_time);
    const endUTC = toStorageTime(end_time);

    const isPractice = practice_exam_id !== undefined && practice_exam_id !== null && practice_exam_id !== '';
    const blueprintJson = isPractice ? null : JSON.stringify(blueprint);
    const practiceExamId = isPractice ? parseInt(practice_exam_id) : null;

    await db.query(`
      UPDATE batches SET name = ?, start_time = ?, end_time = ?, duration = ?, blueprint = ?, practice_exam_id = ?
      WHERE id = ?
    `, [name, startUTC, endUTC, duration, blueprintJson, practiceExamId, parseInt(id)]);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/batches/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const batchId = parseInt(id);
    
    // Delete cascade: exam_questions/practice_submissions -> students -> batch
    await db.query('DELETE FROM exam_questions WHERE student_id IN (SELECT id FROM students WHERE batch_id = ?)', [batchId]);
    await db.query('DELETE FROM practice_submissions WHERE student_id IN (SELECT id FROM students WHERE batch_id = ?)', [batchId]);
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

    for (const item of blueprint) {
      for (const level of ['Easy', 'Medium', 'Hard'] as const) {
        const count = item[level.toLowerCase() as 'easy' | 'medium' | 'hard'];
        if (count > 0) {
          const conditions = ['module = ?', 'level = ?'];
          const params: any[] = [item.module, level];
          if (item.question_group) {
            conditions.push('question_group = ?');
            params.push(item.question_group);
          }

          const result = await db.query(`
            SELECT COUNT(*) as count FROM question_bank
            WHERE ${conditions.join(' AND ')}
          `, params);

          const label = item.question_group ? `${item.module} (${item.question_group})` : item.module;
          const available = parseInt(result.rows[0].count);
          if (available < count) {
            errors.push(`Module ${label} Level ${level} has only ${available} questions, need ${count}`);
          }
        }
      }
    }

    res.json({ feasible: errors.length === 0, errors });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/** Randomly pick `count` question IDs matching module/level (+ optional type, question_group). */
async function pickQuestionIds(opts: { module: string; level: string; type?: string; questionGroup?: string; count: number }): Promise<string[]> {
  const { module, level, type, questionGroup, count } = opts;
  if (count <= 0) return [];

  const conditions = ['LOWER(module) = ?', 'LOWER(level) = ?'];
  const params: any[] = [module.toLowerCase().trim(), level.toLowerCase().trim()];
  if (type) {
    conditions.push('LOWER(type) = ?');
    params.push(type.toLowerCase().trim());
  }
  if (questionGroup) {
    conditions.push('LOWER(question_group) = ?');
    params.push(questionGroup.toLowerCase().trim());
  }
  params.push(count);

  const r = await db.query(
    `SELECT id FROM question_bank WHERE ${conditions.join(' AND ')} ORDER BY RANDOM() LIMIT ?`,
    params
  );
  return r.rows.map((q: any) => q.id);
}

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
      for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return code;
    };

    const batchId = parseInt(id);
    const students: {email: string; code: string}[] = [];
    
    console.log('Fetching batch...');
    const batchResult = await db.query('SELECT id, blueprint, practice_exam_id FROM batches WHERE id = ?', [batchId]);
    const batch = batchResult.rows[0];
    console.log('Batch found:', batch ? 'yes' : 'no');
    console.log('Batch blueprint:', batch?.blueprint, 'practice_exam_id:', batch?.practice_exam_id);

    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    // Batch dạng Practice: không gán câu hỏi từ question_bank — học viên làm bài
    // practice gắn với batch, chỉ cần tạo student + access code.
    const isPracticeBatch = batch.practice_exam_id !== null && batch.practice_exam_id !== undefined;

    let blueprint: any = [];
    if (!isPracticeBatch) {
      if (!batch.blueprint) {
        console.log('[Import Students] ERROR: Batch has no blueprint');
        return res.status(400).json({ error: 'Batch has no blueprint' });
      }

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
      const code = generateCode();
      const studentResult = await db.query(`
        INSERT INTO students (batch_id, email, access_code, status)
        VALUES (?, ?, ?, 'pending')
        RETURNING id
      `, [batchId, email.trim(), code]);
      
      const studentId = studentResult.rows[0]?.id;
      console.log('Student created:', studentId);

      if (!studentId) continue;

      // Batch dạng Practice: không gán câu hỏi từ question_bank
      if (isPracticeBatch) {
        students.push({ email: email.trim(), code });
        continue;
      }

      const questionIds: string[] = [];

      // Parse blueprint supporting both legacy (array) and new ({ blueprintMode, items }) formats
      const { blueprintMode, items: blueprintItems } = parseBlueprintCompat(blueprint);
      console.log(`[Import Students] blueprintMode=${blueprintMode}, items count=${blueprintItems.length}`);
      
      for (const item of blueprintItems) {
        const easy   = item.easy   || 0;
        const medium = item.medium || 0;
        const hard   = item.hard   || 0;
        const module = item.module || '';
        const questionGroup = item.question_group || '';
        const type = blueprintMode === 'type' ? (item.type || '') : undefined;

        console.log(`Processing ${blueprintMode === 'type' ? `${module}/${type}` : module}${questionGroup ? ` (${questionGroup})` : ''}, easy=${easy}, medium=${medium}, hard=${hard}`);

        for (const [level, count] of [['easy', easy], ['medium', medium], ['hard', hard]] as const) {
          const ids = await pickQuestionIds({ module, level, type, questionGroup, count });
          console.log(`  ${level}: found ${ids.length}`);
          questionIds.push(...ids);
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

router.delete('/students/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM exam_questions WHERE student_id = ?', [parseInt(id)]);
    await db.query('DELETE FROM practice_submissions WHERE student_id = ?', [parseInt(id)]);
    await db.query('DELETE FROM violations WHERE student_id = ?', [parseInt(id)]);
    await db.query('DELETE FROM students WHERE id = ?', [parseInt(id)]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/batches/:id/students/export', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const batchId = parseInt(id);

    const batchResult = await db.query('SELECT name FROM batches WHERE id = ?', [batchId]);
    const batchName = batchResult.rows[0]?.name;
    const filenameBase = `${sanitizeFilename(batchName || `batch-${id}`)}-students`;

    const result = await db.query('SELECT email, access_code FROM students WHERE batch_id = ?', [batchId]);
    const students = result.rows;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', buildContentDisposition(filenameBase, 'xlsx'));

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
    const { studentId } = req.params;
    
    await db.query(`
      UPDATE students 
      SET status = 'pending', exam_started_at = NULL, exam_deadline = NULL, disconnected_at = NULL 
      WHERE id = ?
    `, [parseInt(studentId)]);
    
    await db.query('DELETE FROM exam_questions WHERE student_id = ?', [parseInt(studentId)]);
    await db.query('DELETE FROM practice_submissions WHERE student_id = ?', [parseInt(studentId)]);

    res.json({ success: true, message: 'Student exam reset successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/batches/:id/results', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const batchId = parseInt(id);

    const studentsResult = await db.query(`
      SELECT s.*, 
        AVG(eq.ai_score) as avg_ai_score,
        COUNT(eq.id) as questions_count
      FROM students s
      LEFT JOIN exam_questions eq ON s.id = eq.student_id
      WHERE s.batch_id = ?
      GROUP BY s.id
    `, [batchId]);

    const results = [];
    for (const student of studentsResult.rows) {
      const questionsResult = await db.query(`
        SELECT eq.*, q.type, q.level, q.module, q.question_sample, q.rubric_must_have, q.rubric_nice_to_have, q.rubric_optional
        FROM exam_questions eq
        JOIN question_bank q ON eq.question_id = q.id
        WHERE eq.student_id = ?
        ORDER BY eq.question_order
      `, [student.id]);

      const violationsResult = await db.query(`
        SELECT SUM(count) as total FROM violations WHERE student_id = ?
      `, [student.id]);

      results.push({
        student,
        questions: questionsResult.rows,
        violations: parseInt(violationsResult.rows[0]?.total) || 0
      });
    }

    res.json(results);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/results/:studentId', async (req: Request, res: Response) => {
  try {
    const { studentId } = req.params;
    const { trainer_score, trainer_feedback } = req.body;

    const questionsResult = await db.query('SELECT id FROM exam_questions WHERE student_id = ?', [parseInt(studentId)]);

    for (const q of questionsResult.rows) {
      await db.query(`
        UPDATE exam_questions
        SET trainer_score = ?, trainer_feedback = ?
        WHERE id = ?
      `, [trainer_score, trainer_feedback, q.id]);
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/batches/:id/practice-results — Kết quả batch dạng Practice
router.get('/batches/:id/practice-results', async (req: Request, res: Response) => {
  try {
    const batchId = parseInt(req.params.id);

    const result = await db.query(`
      SELECT s.id as student_id, s.email, s.status, s.exam_started_at,
             ps.id as submission_id, ps.answer, ps.ai_score, ps.ai_feedback,
             ps.trainer_score, ps.trainer_feedback,
             (SELECT SUM(v.count) FROM violations v WHERE v.student_id = s.id) as violations
      FROM students s
      LEFT JOIN practice_submissions ps ON ps.student_id = s.id
      WHERE s.batch_id = ?
      ORDER BY s.email
    `, [batchId]);

    res.json(result.rows.map((r: any) => ({ ...r, violations: parseInt(r.violations) || 0 })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/batches/:id/practice-results/export — Xuất Excel kết quả batch Practice
router.get('/batches/:id/practice-results/export', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const batchId = parseInt(id);

    const batchResult = await db.query('SELECT name FROM batches WHERE id = ?', [batchId]);
    const batchName = batchResult.rows[0]?.name;
    const filenameBase = `${sanitizeFilename(batchName || `batch-${id}`)}-practice-results`;

    const result = await db.query(`
      SELECT s.email, s.status,
             ps.answer, ps.ai_score, ps.ai_feedback, ps.trainer_score, ps.trainer_feedback,
             (SELECT SUM(v.count) FROM violations v WHERE v.student_id = s.id) as violations
      FROM students s
      LEFT JOIN practice_submissions ps ON ps.student_id = s.id
      WHERE s.batch_id = ?
      ORDER BY s.email
    `, [batchId]);

    const data = result.rows.map((r: any) => ({
      Email: r.email,
      Status: r.status,
      'Violation Count': parseInt(r.violations) || 0,
      Answer: r.answer || '',
      'AI Score': r.ai_score ?? 0,
      'AI Feedback': r.ai_feedback || '',
      'Trainer Score': r.trainer_score ?? r.ai_score ?? 0,
      'Trainer Feedback': r.trainer_feedback || '',
    }));

    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Practice Results');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', buildContentDisposition(filenameBase, 'xlsx'));
    res.send(XLSX.write(workbook, { type: 'buffer' }));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/practice-results/:studentId — Trainer chấm/ghi đè điểm bài practice
router.put('/practice-results/:studentId', async (req: Request, res: Response) => {
  try {
    const { studentId } = req.params;
    const { trainer_score, trainer_feedback } = req.body;

    await db.query(`
      UPDATE practice_submissions
      SET trainer_score = ?, trainer_feedback = ?, updated_at = CURRENT_TIMESTAMP
      WHERE student_id = ?
    `, [trainer_score, trainer_feedback, parseInt(studentId)]);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/batches/:id/results/export', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const batchId = parseInt(id);

    const batchResult = await db.query('SELECT name FROM batches WHERE id = ?', [batchId]);
    const batchName = batchResult.rows[0]?.name;
    const filenameBase = `${sanitizeFilename(batchName || `batch-${id}`)}-results`;

    const studentsResult = await db.query('SELECT id, email FROM students WHERE batch_id = ?', [batchId]);

    const workbook = XLSX.utils.book_new();

    for (const student of studentsResult.rows) {
      const questionsResult = await db.query(`
        SELECT eq.*, q.type, q.level, q.module, q.question_sample, q.question_plain,
          q.rubric_must_have, q.rubric_nice_to_have, q.rubric_optional
        FROM exam_questions eq
        JOIN question_bank q ON eq.question_id = q.id
        WHERE eq.student_id = ?
        ORDER BY eq.question_order
      `, [student.id]);

      const violationsResult = await db.query(`
        SELECT SUM(count) as total FROM violations WHERE student_id = ?
      `, [student.id]);

      const data = questionsResult.rows.map((q: any) => ({
        ID: q.question_id,
        Type: q.type,
        Level: q.level,
        Module: q.module,
        Question: q.question_plain || stripHtml(q.question_sample),
        Answer: q.answer || '',
        'Rubric Must-have': q.rubric_must_have,
        'Rubric Nice-to-have': q.rubric_nice_to_have,
        'Rubric Optional': q.rubric_optional,
        'AI Feedback': q.ai_feedback || '',
        'AI Score': q.ai_score || 0,
        'Trainer Feedback': q.trainer_feedback || '',
        'Trainer Score': (q.trainer_score ?? q.ai_score) || 0,
        'Violation Count': parseInt(violationsResult.rows[0]?.total) || 0
      }));

      const sheet = XLSX.utils.json_to_sheet(data);
      const sheetName = student.email.split('@')[0] || `Student_${student.id}`;
      XLSX.utils.book_append_sheet(workbook, sheet, sheetName.substring(0, 31));
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', buildContentDisposition(filenameBase, 'xlsx'));
    res.send(XLSX.write(workbook, { type: 'buffer' }));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/settings/ai', async (req: Request, res: Response) => {
  try {
    if (!USE_SQLITE) {
      await db.query(`
        CREATE TABLE IF NOT EXISTS ai_settings (
          id INTEGER PRIMARY KEY,
          provider TEXT NOT NULL,
          apiKey TEXT,
          model TEXT NOT NULL,
          temperature REAL DEFAULT 0.3,
          maxTokens INTEGER DEFAULT 2048
        )
      `);
    }
    
    const result = await db.query('SELECT * FROM ai_settings LIMIT 1');
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.json({
        provider: 'gemini',
        apiKey: '',
        model: 'gemini-2.0-flash',
        temperature: 0.3,
        maxTokens: 2048
      });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/settings/ai', async (req: Request, res: Response) => {
  try {
    const { provider, apiKey, model, temperature, maxTokens } = req.body;
    
    if (USE_SQLITE) {
      await db.query(`
        CREATE TABLE IF NOT EXISTS ai_settings (
          id INTEGER PRIMARY KEY,
          provider TEXT NOT NULL,
          apiKey TEXT,
          model TEXT NOT NULL,
          temperature REAL DEFAULT 0.3,
          maxTokens INTEGER DEFAULT 2048
        )
      `);
      
      await db.query(`
        INSERT OR REPLACE INTO ai_settings (id, provider, apiKey, model, temperature, maxTokens)
        VALUES (1, ?, ?, ?, ?, ?)
      `, [provider, apiKey || '', model, temperature || 0.3, maxTokens || 2048]);
    } else {
      await db.query(`
        CREATE TABLE IF NOT EXISTS ai_settings (
          id INTEGER PRIMARY KEY,
          provider TEXT NOT NULL,
          apiKey TEXT,
          model TEXT NOT NULL,
          temperature REAL DEFAULT 0.3,
          maxTokens INTEGER DEFAULT 2048
        )
      `);
      
      await db.query(`
        INSERT INTO ai_settings (id, provider, apiKey, model, temperature, maxTokens)
        VALUES (1, $1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET
          provider = EXCLUDED.provider,
          apiKey = EXCLUDED.apiKey,
          model = EXCLUDED.model,
          temperature = EXCLUDED.temperature,
          maxTokens = EXCLUDED.maxTokens
      `, [provider, apiKey || '', model, temperature || 0.3, maxTokens || 2048]);
    }
    
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/settings/ai/test', async (req: Request, res: Response) => {
  try {
    const { provider, apiKey, model } = req.body;
    
    let response = '';
    
    if (provider === 'gemini') {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(apiKey);
      const genModel = genAI.getGenerativeModel({ model: model || 'gemini-2.0-flash' });
      const result = await genModel.generateContent('Say "Hello, connection successful!" in one sentence.');
      response = result.response.text();
    } else if (provider === 'openai' || provider === 'azure') {
      response = 'OpenAI/Azure test requires openai package. Using Gemini as fallback.';
    } else if (provider === 'deepseek') {
      response = 'DeepSeek test requires deepseek package. Configure and test manually.';
    } else {
      response = `Provider ${provider} configured. Manual testing recommended.`;
    }
    
    res.json({ success: true, response });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
