import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import db from '../db/postgres.js';
import { normalizeUnicode } from '../../utils/string.js';
import dotenv from 'dotenv';

dotenv.config();

const USE_SQLITE = !process.env.DATABASE_URL;

console.log('[Admin] USE_SQLITE:', USE_SQLITE, 'NODE_ENV:', process.env.NODE_ENV);

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

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
    const validTypes = ['Coding', 'Conceptual'];
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
          (id, type, level, module, question_sample, rubric_must_have, rubric_nice_to_have, rubric_optional, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `, [id, type, level, normalizedModule, question, rubricMustHave, rubricNice, rubricOpt]);
      } else {
        const pgQuery = `
          INSERT INTO question_bank 
          (id, type, level, module, question_sample, rubric_must_have, rubric_nice_to_have, rubric_optional, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
          ON CONFLICT (id) DO UPDATE SET
            type = EXCLUDED.type,
            level = EXCLUDED.level,
            module = EXCLUDED.module,
            question_sample = EXCLUDED.question_sample,
            rubric_must_have = EXCLUDED.rubric_must_have,
            rubric_nice_to_have = EXCLUDED.rubric_nice_to_have,
            rubric_optional = EXCLUDED.rubric_optional,
            updated_at = CURRENT_TIMESTAMP
        `;
        console.log('[Import] PG Query:', pgQuery);
        await db.query(pgQuery, [id, type, level, normalizedModule, question, rubricMustHave, rubricNice, rubricOpt]);
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

router.delete('/questions/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM question_bank WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/batches', async (req: Request, res: Response) => {
  try {
    const { name, start_time, end_time, duration, blueprint } = req.body;
    console.log('[CreateBatch] Input:', { name, start_time, end_time, duration, blueprint });

    if (!name || !start_time || !end_time || !duration) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const totalQuestions = (blueprint as any[])?.reduce((sum: number, item: any) => sum + item.easy + item.medium + item.hard, 0) || 0;
    if (totalQuestions < 1 || totalQuestions > 20) {
      return res.status(400).json({ error: 'Total questions must be between 1 and 20' });
    }

    const blueprintJson = JSON.stringify(blueprint);
    console.log('[CreateBatch] Blueprint JSON:', blueprintJson);
    
    let result;
    if (USE_SQLITE) {
      result = await db.query(`
        INSERT INTO batches (name, start_time, end_time, duration, blueprint, status)
        VALUES (?, ?, ?, ?, ?, 'draft')
      `, [name, start_time, end_time, duration, blueprintJson]);
    } else {
      result = await db.query(`
        INSERT INTO batches (name, start_time, end_time, duration, blueprint, status)
        VALUES ($1, $2, $3, $4, $5, 'draft')
      `, [name, start_time, end_time, duration, blueprintJson]);
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
    const { name, start_time, end_time, duration, blueprint, status } = req.body;

    await db.query(`
      UPDATE batches SET name = ?, start_time = ?, end_time = ?, duration = ?, blueprint = ?, status = ?
      WHERE id = ?
    `, [name, start_time, end_time, duration, JSON.stringify(blueprint), status || 'draft', parseInt(id)]);

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/batches/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM batches WHERE id = ?', [parseInt(id)]);
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
          const result = await db.query(`
            SELECT COUNT(*) as count FROM question_bank
            WHERE module = ? AND level = ?
          `, [item.module, level]);

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
    
    console.log('[Import Students] batchId:', batchId);
    const batchResult = await db.query('SELECT id, blueprint FROM batches WHERE id = ?', [batchId]);
    const batch = batchResult.rows[0];
    console.log('[Import Students] raw batch:', JSON.stringify(batch));
    console.log('[Import Students] blueprint field:', batch?.blueprint);
    console.log('[Import Students] blueprint type raw:', typeof batch?.blueprint);
    
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
    
    console.log('[Import Students] parsed blueprint:', JSON.stringify(blueprint));
    console.log('[Import Students] blueprint is array:', Array.isArray(blueprint));
    
    if (!Array.isArray(blueprint) || blueprint.length === 0) {
      console.log('[Import Students] ERROR: Blueprint is empty or not array');
      return res.status(400).json({ error: 'Blueprint is empty' });
    }
    
    for (const email of emails) {
      const code = generateCode();
      const studentResult = await db.query(`
        INSERT INTO students (batch_id, email, access_code, status)
        VALUES (?, ?, ?, 'pending')
        RETURNING id
      `, [batchId, email.trim(), code]);
      
      console.log('[Import Students] studentResult:', studentResult);
      const studentId = studentResult.rows[0]?.id;
      console.log('[Import Students] studentId:', studentId);
      
      if (!studentId) {
        console.log('[Import Students] ERROR: Could not get student ID');
        continue;
      }
      
      console.log('[Import Students] Processing blueprint items:', blueprint.length);
      const questionIds: string[] = [];
      for (const item of blueprint) {
        console.log('[Import Students] item:', JSON.stringify(item));
        const easy = item.easy || item.Easy || 0;
        const medium = item.medium || item.Medium || 0;
        const hard = item.hard || item.Hard || 0;
        console.log('[Import Students] easy:', easy, 'medium:', medium, 'hard:', hard);
        
        for (const level of ['Easy', 'Medium', 'Hard'] as const) {
          const count = level === 'Easy' ? easy : level === 'Medium' ? medium : hard;
          console.log('[Import Students] module:', item.module, 'level:', level, 'count:', count);
          if (count > 0) {
            // Check what exists in question_bank
            const checkResult = await db.query(`
              SELECT module, level, COUNT(*) as cnt FROM question_bank 
              WHERE module = ? AND level = ?
              GROUP BY module, level
            `, [item.module, level]);
            console.log('[Import Students] check question_bank:', checkResult.rows);
            
            const availableResult = await db.query(`
              SELECT id FROM question_bank
              WHERE module = ? AND level = ?
              ORDER BY RANDOM()
              LIMIT ?
            `, [item.module, level, count]);
            console.log('[Import Students] found questions:', availableResult.rows.length);
            for (const q of availableResult.rows) {
              questionIds.push(q.id);
            }
          }
        }
      }
      console.log('[Import Students] total questionIds:', questionIds.length);
      
      for (let i = 0; i < questionIds.length; i++) {
        await db.query(`
          INSERT INTO exam_questions (student_id, question_id, question_order)
          VALUES (?, ?, ?)
        `, [studentId, questionIds[i], i + 1]);
      }
      
      students.push({ email: email.trim(), code });
    }

    res.json({ success: true, count: emails.length, students });
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
    const { studentId } = req.params;
    
    await db.query("UPDATE students SET status = 'pending' WHERE id = ?", [parseInt(studentId)]);
    
    await db.query('DELETE FROM exam_questions WHERE student_id = ?', [parseInt(studentId)]);
    
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

router.get('/batches/:id/results/export', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const batchId = parseInt(id);

    const studentsResult = await db.query('SELECT id, email FROM students WHERE batch_id = ?', [batchId]);

    const workbook = XLSX.utils.book_new();

    for (const student of studentsResult.rows) {
      const questionsResult = await db.query(`
        SELECT eq.*, q.type, q.level, q.module, q.question_sample, 
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
        Question: q.question_sample,
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
    res.setHeader('Content-Disposition', `attachment; filename=results-${id}.xlsx`);
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
