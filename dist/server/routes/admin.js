import { Router } from 'express';
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
// Client gửi UTC ISO string, server chỉ cần validate và normalize
const toStorageTime = (isoStr) => {
    if (!isoStr)
        return isoStr;
    return new Date(isoStr).toISOString();
};
// Test endpoint to debug blueprint
router.get('/test-blueprint/:id', async (req, res) => {
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
        }
        catch (e) {
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
    }
    catch (error) {
        console.log('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});
function extractRubric(rubricStr) {
    if (!rubricStr)
        return { mustHave: '', niceToHave: '', optional: '' };
    const parts = rubricStr.split('\n').filter((s) => s.trim());
    return {
        mustHave: parts.join('\n'),
        niceToHave: '',
        optional: ''
    };
}
router.post('/questions/import', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
        if (rawData.length < 3) {
            return res.status(400).json({ error: 'Invalid file format' });
        }
        const header = rawData[0];
        const rubricHeader = rawData[1];
        const colIndex = {};
        header.forEach((col, i) => {
            if (col)
                colIndex[col.toString().trim()] = i;
        });
        let rubricMustHaveCol = colIndex['Rubric (Must-have) (70%)'] ?? 5;
        let rubricNiceCol = colIndex['Nice-to-have (20%)'] ?? 6;
        let rubricOptCol = colIndex['Optional (10%)'] ?? 7;
        console.log('[Import] Header:', header);
        console.log('[Import] Rubric header:', rubricHeader);
        const validLevels = ['Easy', 'Medium', 'Hard'];
        const validTypes = ['Coding', 'Conceptual'];
        const errors = [];
        let imported = 0;
        let updated = 0;
        let skipped = 0;
        for (let i = 2; i < rawData.length; i++) {
            const row = rawData[i];
            if (!row || row.length === 0)
                continue;
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
            }
            else {
                imported++;
            }
            if (USE_SQLITE) {
                await db.query(`
          INSERT OR REPLACE INTO question_bank 
          (id, type, level, module, question_sample, rubric_must_have, rubric_nice_to_have, rubric_optional, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `, [id, type, level, normalizedModule, question, rubricMustHave, rubricNice, rubricOpt]);
            }
            else {
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
    }
    catch (error) {
        console.error('Import error:', error);
        res.status(500).json({ error: error.message });
    }
});
router.get('/questions', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM question_bank ORDER BY module, level');
        res.json(result.rows);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.get('/questions/modules', async (req, res) => {
    try {
        const result = await db.query('SELECT DISTINCT module FROM question_bank ORDER BY module');
        res.json(result.rows.map((m) => m.module));
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// Returns question counts per module broken down by difficulty level
router.get('/questions/module-stats', async (req, res) => {
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
        res.json(result.rows.map((r) => ({
            module: r.module,
            easy: Number(r.easy) || 0,
            medium: Number(r.medium) || 0,
            hard: Number(r.hard) || 0,
        })));
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/questions/bulk-delete', async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'No question IDs provided' });
        }
        if (USE_SQLITE) {
            const placeholders = ids.map(() => '?').join(', ');
            await db.query(`DELETE FROM question_bank WHERE id IN (${placeholders})`, ids);
        }
        else {
            await db.query(`DELETE FROM question_bank WHERE id = ANY($1::text[])`, [ids]);
        }
        res.json({ success: true, deleted: ids.length });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.delete('/questions/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM question_bank WHERE id = ?', [id]);
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/batches', async (req, res) => {
    try {
        const { name, start_time, end_time, duration, blueprint } = req.body;
        console.log('[CreateBatch] Input:', { name, start_time, end_time, duration, blueprint });
        if (!name || !start_time || !end_time || !duration) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const totalQuestions = blueprint?.reduce((sum, item) => sum + item.easy + item.medium + item.hard, 0) || 0;
        if (totalQuestions < 1 || totalQuestions > 20) {
            return res.status(400).json({ error: 'Total questions must be between 1 and 20' });
        }
        const blueprintJson = JSON.stringify(blueprint);
        console.log('[CreateBatch] Blueprint JSON:', blueprintJson);
        const startUTC = toStorageTime(start_time);
        const endUTC = toStorageTime(end_time);
        console.log('[CreateBatch] Times (UTC stored):', { start_time: startUTC, end_time: endUTC });
        let result;
        if (USE_SQLITE) {
            result = await db.query(`
        INSERT INTO batches (name, start_time, end_time, duration, blueprint)
        VALUES (?, ?, ?, ?, ?)
      `, [name, startUTC, endUTC, duration, blueprintJson]);
        }
        else {
            result = await db.query(`
        INSERT INTO batches (name, start_time, end_time, duration, blueprint)
        VALUES ($1, $2, $3, $4, $5)
      `, [name, startUTC, endUTC, duration, blueprintJson]);
        }
        console.log('[CreateBatch] Success, id:', result.lastInsertRowid);
        res.json({ success: true, id: result.lastInsertRowid || result.rows?.[0]?.id });
    }
    catch (error) {
        console.error('[CreateBatch] Error:', error);
        res.status(500).json({ error: error.message });
    }
});
router.get('/batches', async (req, res) => {
    try {
        const result = await db.query(`
      SELECT b.*, COUNT(s.id) as students_count 
      FROM batches b 
      LEFT JOIN students s ON b.id = s.batch_id 
      GROUP BY b.id 
      ORDER BY b.created_at DESC
    `);
        const batches = result.rows.map((b) => ({
            ...b,
            students_count: b.students_count || 0,
            blueprint: b.blueprint ? (typeof b.blueprint === 'string' ? JSON.parse(b.blueprint) : b.blueprint) : null
        }));
        res.json(batches);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.get('/batches/:id', async (req, res) => {
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
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.put('/batches/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, start_time, end_time, duration, blueprint } = req.body;
        const startUTC = toStorageTime(start_time);
        const endUTC = toStorageTime(end_time);
        await db.query(`
      UPDATE batches SET name = ?, start_time = ?, end_time = ?, duration = ?, blueprint = ?
      WHERE id = ?
    `, [name, startUTC, endUTC, duration, JSON.stringify(blueprint), parseInt(id)]);
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.delete('/batches/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const batchId = parseInt(id);
        // Delete cascade: exam_questions -> students -> batch
        await db.query('DELETE FROM exam_questions WHERE student_id IN (SELECT id FROM students WHERE batch_id = ?)', [batchId]);
        await db.query('DELETE FROM violations WHERE student_id IN (SELECT id FROM students WHERE batch_id = ?)', [batchId]);
        await db.query('DELETE FROM students WHERE batch_id = ?', [batchId]);
        await db.query('DELETE FROM batches WHERE id = ?', [batchId]);
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/batches/:id/check-feasibility', async (req, res) => {
    try {
        const { blueprint } = req.body;
        const errors = [];
        for (const item of blueprint) {
            for (const level of ['Easy', 'Medium', 'Hard']) {
                const count = item[level.toLowerCase()];
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
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/batches/:id/students/import', async (req, res) => {
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
        const students = [];
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
            }
            else {
                blueprint = batch.blueprint;
            }
        }
        catch (e) {
            console.log('[Import Students] JSON parse error:', e);
            blueprint = [];
        }
        console.log('Parsed blueprint:', JSON.stringify(blueprint));
        if (!Array.isArray(blueprint) || blueprint.length === 0) {
            return res.status(400).json({ error: 'Blueprint is empty' });
        }
        const existingResult = await db.query('SELECT LOWER(email) as email FROM students WHERE batch_id = ?', [batchId]);
        const existingEmailSet = new Set(existingResult.rows.map((r) => r.email));
        const skippedEmails = [];
        const seenInRequest = new Set();
        const validEmails = emails.filter((email) => {
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
            if (!studentId)
                continue;
            const questionIds = [];
            for (const item of blueprint) {
                const moduleName = (item.module || '').toLowerCase().trim();
                const easy = item.easy || 0;
                const medium = item.medium || 0;
                const hard = item.hard || 0;
                console.log(`Processing: ${item.module} -> ${moduleName}, easy=${easy}, medium=${medium}, hard=${hard}`);
                // Easy
                if (easy > 0) {
                    const r = await db.query('SELECT id FROM question_bank WHERE LOWER(module) = ? AND LOWER(level) = ? ORDER BY RANDOM() LIMIT ?', [moduleName, 'easy', easy]);
                    console.log(`  Easy: found ${r.rows.length}`);
                    r.rows.forEach((q) => questionIds.push(q.id));
                }
                // Medium
                if (medium > 0) {
                    const r = await db.query('SELECT id FROM question_bank WHERE LOWER(module) = ? AND LOWER(level) = ? ORDER BY RANDOM() LIMIT ?', [moduleName, 'medium', medium]);
                    console.log(`  Medium: found ${r.rows.length}`);
                    r.rows.forEach((q) => questionIds.push(q.id));
                }
                // Hard
                if (hard > 0) {
                    const r = await db.query('SELECT id FROM question_bank WHERE LOWER(module) = ? AND LOWER(level) = ? ORDER BY RANDOM() LIMIT ?', [moduleName, 'hard', hard]);
                    console.log(`  Hard: found ${r.rows.length}`);
                    r.rows.forEach((q) => questionIds.push(q.id));
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
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.get('/batches/:id/students', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query('SELECT * FROM students WHERE batch_id = ?', [parseInt(id)]);
        res.json(result.rows);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.delete('/students/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM exam_questions WHERE student_id = ?', [parseInt(id)]);
        await db.query('DELETE FROM violations WHERE student_id = ?', [parseInt(id)]);
        await db.query('DELETE FROM students WHERE id = ?', [parseInt(id)]);
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.get('/batches/:id/students/export', async (req, res) => {
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
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/students/:studentId/reset', async (req, res) => {
    try {
        const { studentId } = req.params;
        await db.query(`
      UPDATE students 
      SET status = 'pending', exam_started_at = NULL, exam_deadline = NULL, disconnected_at = NULL 
      WHERE id = ?
    `, [parseInt(studentId)]);
        await db.query('DELETE FROM exam_questions WHERE student_id = ?', [parseInt(studentId)]);
        res.json({ success: true, message: 'Student exam reset successfully' });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.get('/batches/:id/results', async (req, res) => {
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
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.put('/results/:studentId', async (req, res) => {
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
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.get('/batches/:id/results/export', async (req, res) => {
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
            const data = questionsResult.rows.map((q) => ({
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
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.get('/settings/ai', async (req, res) => {
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
        }
        else {
            res.json({
                provider: 'gemini',
                apiKey: '',
                model: 'gemini-2.0-flash',
                temperature: 0.3,
                maxTokens: 2048
            });
        }
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/settings/ai', async (req, res) => {
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
        }
        else {
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
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/settings/ai/test', async (req, res) => {
    try {
        const { provider, apiKey, model } = req.body;
        let response = '';
        if (provider === 'gemini') {
            const { GoogleGenerativeAI } = await import('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(apiKey);
            const genModel = genAI.getGenerativeModel({ model: model || 'gemini-2.0-flash' });
            const result = await genModel.generateContent('Say "Hello, connection successful!" in one sentence.');
            response = result.response.text();
        }
        else if (provider === 'openai' || provider === 'azure') {
            response = 'OpenAI/Azure test requires openai package. Using Gemini as fallback.';
        }
        else if (provider === 'deepseek') {
            response = 'DeepSeek test requires deepseek package. Configure and test manually.';
        }
        else {
            response = `Provider ${provider} configured. Manual testing recommended.`;
        }
        res.json({ success: true, response });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
export default router;
