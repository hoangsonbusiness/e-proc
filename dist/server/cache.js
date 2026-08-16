import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import db from './db/postgres.js';
import { claimQueueJob, enqueueQueueJob, recoverStaleQueueJobs, updateQueueJob } from './services/queueStore.js';
dotenv.config();
class FileCache {
    cache = new Map();
    answerBuffer = new Map();
    queue = new Map();
    flushInterval = null;
    queueFlushInterval = null;
    cachedAISettings = null;
    settingsLastFetched = 0;
    initialized = false;
    dataDir;
    queueFile;
    constructor() {
        this.dataDir = path.join(process.cwd(), 'data');
        this.queueFile = path.join(this.dataDir, 'queue.json');
    }
    async init() {
        if (this.initialized)
            return;
        if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
            await this.loadQueueFromDB();
        }
        else {
            this.ensureDataDir();
            this.loadQueue();
        }
        // Vercel có thể freeze instance sau response; interval nền không phải scheduler tin cậy.
        if (!process.env.VERCEL) {
            this.startFlushInterval();
            if (process.env.LEGACY_AI_QUEUE_ENABLED === 'true')
                this.startQueueProcessor();
        }
        this.initialized = true;
    }
    ensureDataDir() {
        // Skip on Vercel (read-only)
        if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
            return;
        }
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }
    async getAISettings(forceRefresh = false) {
        const now = Date.now();
        if (!forceRefresh && this.cachedAISettings && (now - this.settingsLastFetched) < 60000) {
            return this.cachedAISettings;
        }
        try {
            const { query } = await import('../server/db/postgres.js');
            const result = await query('SELECT * FROM ai_settings WHERE id = 1');
            if (result.rows.length > 0) {
                this.cachedAISettings = {
                    ...result.rows[0],
                    worker_enabled: result.rows[0].worker_enabled !== false && result.rows[0].worker_enabled !== 0,
                };
            }
            else {
                this.cachedAISettings = {
                    provider: 'gemini',
                    apiKey: process.env.GEMINI_API_KEY || '',
                    model: 'gemini-2.0-flash',
                    temperature: 0.3,
                    maxTokens: 2048,
                    worker_enabled: true
                };
            }
            this.settingsLastFetched = now;
            return this.cachedAISettings;
        }
        catch (err) {
            console.error('[Queue] Failed to get AI settings:', err);
            return {
                provider: 'gemini',
                apiKey: process.env.GEMINI_API_KEY || '',
                model: 'gemini-2.0-flash',
                temperature: 0.3,
                maxTokens: 2048,
                worker_enabled: true
            };
        }
    }
    async callAI(prompt, settings) {
        console.log(`[AI] Using provider: ${settings.provider}, model: ${settings.model}`);
        if (settings.provider === 'gemini') {
            const { GoogleGenerativeAI } = await import('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(settings.apiKey);
            const model = genAI.getGenerativeModel({ model: settings.model });
            const result = await model.generateContent(prompt);
            return { text: result.response.text() };
        }
        if (settings.provider === 'groq') {
            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${settings.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: prompt }],
                    model: settings.model || 'llama-3.1-70b-versatile',
                    temperature: settings.temperature,
                    max_tokens: settings.maxTokens
                })
            });
            if (!response.ok) {
                const err = await response.text();
                throw new Error(`Groq API error: ${response.status} - ${err}`);
            }
            const data = await response.json();
            return { text: data.choices?.[0]?.message?.content || '' };
        }
        if (settings.provider === 'openai' || settings.provider === 'azure') {
            const OpenAI = (await import('openai')).default;
            const client = settings.provider === 'azure'
                ? new OpenAI({ apiKey: settings.apiKey, baseURL: process.env.AZURE_OPENAI_ENDPOINT })
                : new OpenAI({ apiKey: settings.apiKey });
            const model = settings.provider === 'azure'
                ? (process.env.AZURE_OPENAI_DEPLOYMENT || settings.model)
                : settings.model;
            const chat = await client.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: model,
                temperature: settings.temperature,
                max_tokens: settings.maxTokens
            });
            return { text: chat.choices[0]?.message?.content || '' };
        }
        if (settings.provider === 'deepseek') {
            const OpenAI = (await import('openai')).default;
            const client = new OpenAI({
                apiKey: settings.apiKey,
                baseURL: 'https://api.deepseek.com'
            });
            const chat = await client.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: settings.model,
                temperature: settings.temperature,
                max_tokens: settings.maxTokens
            });
            return { text: chat.choices[0]?.message?.content || '' };
        }
        if (settings.provider === 'openrouter') {
            const OpenAI = (await import('openai')).default;
            const client = new OpenAI({
                apiKey: settings.apiKey,
                baseURL: 'https://openrouter.ai/api/v1'
            });
            const chat = await client.chat.completions.create({
                messages: [{ role: 'user', content: prompt }],
                model: settings.model,
                temperature: settings.temperature,
                max_tokens: settings.maxTokens
            });
            return { text: chat.choices[0]?.message?.content || '' };
        }
        if (settings.provider === 'ollama') {
            const response = await fetch(`${settings.apiKey}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: settings.model,
                    prompt: prompt,
                    temperature: settings.temperature,
                    stream: false
                })
            });
            const data = await response.json();
            return { text: data.response || '' };
        }
        throw new Error(`Unsupported provider: ${settings.provider}`);
    }
    set(key, data, ttlMs = 60000) {
        this.cache.set(key, {
            data,
            timestamp: Date.now(),
            ttl: ttlMs
        });
    }
    get(key) {
        const entry = this.cache.get(key);
        if (!entry)
            return null;
        if (Date.now() - entry.timestamp > entry.ttl) {
            this.cache.delete(key);
            return null;
        }
        return entry.data;
    }
    delete(key) {
        this.cache.delete(key);
    }
    bufferAnswer(studentId, questionOrder, answer) {
        const key = `${studentId}:${questionOrder}`;
        this.answerBuffer.set(key, {
            studentId,
            questionOrder,
            answer,
            timestamp: Date.now()
        });
    }
    async flushAnswers() {
        if (this.answerBuffer.size === 0)
            return;
        const answers = Array.from(this.answerBuffer.values());
        this.answerBuffer.clear();
        console.log(`[Cache] Flushing ${answers.length} answers to database`);
        for (const answer of answers) {
            try {
                const { query } = await import('../server/db/postgres.js');
                await query(`
          UPDATE exam_questions SET answer = ? 
          WHERE student_id = ? AND question_order = ?
        `, [answer.answer, answer.studentId, answer.questionOrder]);
            }
            catch (err) {
                console.error('[Cache] Failed to flush answer:', err);
                this.answerBuffer.set(`${answer.studentId}:${answer.questionOrder}`, answer);
            }
        }
    }
    startFlushInterval() {
        const interval = parseInt(process.env.ANSWER_FLUSH_INTERVAL || '5000');
        this.flushInterval = setInterval(() => {
            this.flushAnswers().catch(console.error);
        }, interval);
    }
    async addToQueue(examQuestionId, studentId) {
        // Deterministic id makes submission/finalization retries idempotent.
        const dbId = examQuestionId;
        const id = `job_${dbId}`;
        const job = {
            id,
            examQuestionId,
            studentId,
            status: 'pending',
            attempts: 0,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        // Persist trước khi trả về. Fire-and-forget có thể bị Vercel freeze sau response và mất job.
        await this.saveQueueToDB(job, dbId);
        this.queue.set(id, job);
        console.log(`[Queue] Added job ${id} for exam_question ${examQuestionId}`);
        return id;
    }
    async saveQueueToDB(job, dbId) {
        await enqueueQueueJob(db, {
            id: dbId,
            examQuestionId: job.examQuestionId,
            studentId: job.studentId,
            status: job.status,
            attempts: job.attempts,
            createdAt: new Date(job.createdAt),
            updatedAt: new Date(job.updatedAt),
        });
    }
    async flushStudentAnswers(studentId) {
        const answers = Array.from(this.answerBuffer.entries())
            .filter(([, answer]) => answer.studentId === studentId);
        if (answers.length === 0)
            return;
        console.log(`[Cache] Flushing ${answers.length} answers for student ${studentId}`);
        for (const [key, answer] of answers) {
            try {
                await db.query('UPDATE exam_questions SET answer = ? WHERE student_id = ? AND question_order = ?', [answer.answer, answer.studentId, answer.questionOrder]);
                this.answerBuffer.delete(key);
            }
            catch (err) {
                console.error('[Cache] Failed to flush student answer:', err);
                throw err;
            }
        }
    }
    discardQueueForStudent(studentId) {
        for (const [id, job] of this.queue) {
            if (job.studentId === studentId)
                this.queue.delete(id);
        }
    }
    loadQueue() {
        try {
            if (fs.existsSync(this.queueFile)) {
                const data = JSON.parse(fs.readFileSync(this.queueFile, 'utf-8'));
                for (const [id, job] of Object.entries(data)) {
                    this.queue.set(id, job);
                }
                console.log(`[Queue] Loaded ${this.queue.size} jobs from file`);
            }
        }
        catch (err) {
            console.error('[Queue] Failed to load queue:', err);
        }
    }
    async loadQueueFromDB() {
        const { query } = await import('../server/db/postgres.js');
        const result = await query(`SELECT id, exam_question_id, student_id, status, attempts, created_at, updated_at
       FROM ai_queue WHERE status = ?`, ['pending']);
        for (const [id, job] of this.queue) {
            if (job.status === 'pending' || job.status === 'processing')
                this.queue.delete(id);
        }
        for (const row of result.rows) {
            const id = `job_${row.id}`;
            this.queue.set(id, {
                id,
                examQuestionId: row.exam_question_id,
                studentId: row.student_id,
                status: row.status,
                attempts: row.attempts,
                createdAt: new Date(row.created_at).getTime(),
                updatedAt: new Date(row.updated_at).getTime()
            });
        }
        console.log(`[Queue] Loaded ${result.rows.length} pending jobs from database`);
    }
    async updateQueueInDB(job) {
        const dbId = parseInt(job.id.replace('job_', ''));
        await updateQueueJob(db, {
            id: dbId,
            status: job.status,
            attempts: job.attempts,
            updatedAt: new Date(job.updatedAt),
        });
    }
    /** Atomic DB claim: nhiều Vercel instance chỉ một instance đổi pending -> processing. */
    async claimQueueJob(job) {
        const dbId = parseInt(job.id.replace('job_', ''));
        const now = new Date();
        const claimed = await claimQueueJob(db, dbId, now);
        if (!claimed)
            return false;
        job.status = 'processing';
        job.attempts += 1;
        job.updatedAt = now.getTime();
        return true;
    }
    async recoverStaleProcessingJobs() {
        const parsed = parseInt(process.env.AI_QUEUE_STALE_MS || String(15 * 60_000));
        const staleMs = Number.isFinite(parsed) && parsed >= 60_000 ? parsed : 15 * 60_000;
        const cutoff = new Date(Date.now() - staleMs);
        await recoverStaleQueueJobs(db, cutoff, new Date());
    }
    async processQueue(limit = 5) {
        if (process.env.LEGACY_AI_QUEUE_ENABLED !== 'true') {
            console.log('[Queue] Legacy per-question AI queue is disabled');
            return 0;
        }
        const usesDatabaseQueue = !!process.env.VERCEL || process.env.NODE_ENV === 'production';
        if (usesDatabaseQueue) {
            await this.recoverStaleProcessingJobs();
            await this.loadQueueFromDB();
        }
        const pendingJobs = Array.from(this.queue.values())
            .filter(j => j.status === 'pending')
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(0, limit);
        if (pendingJobs.length === 0)
            return 0;
        // Worker control is operational state, so do not use the 60-second settings cache here.
        const aiSettings = await this.getAISettings(true);
        if (!aiSettings.worker_enabled) {
            console.log('[Queue] Worker is disabled; pending jobs remain untouched');
            return 0;
        }
        console.log(`[Queue] Processing ${pendingJobs.length} jobs with ${aiSettings.provider}`);
        let processed = 0;
        const promises = pendingJobs.map(async (job) => {
            try {
                const claimed = await this.claimQueueJob(job);
                if (!claimed) {
                    this.queue.delete(job.id);
                    return;
                }
                processed += 1;
                const { query } = await import('../server/db/postgres.js');
                const examResult = await query(`
          SELECT eq.*, q.question_sample, q.rubric_must_have, q.rubric_nice_to_have, q.rubric_optional,
                 b.ai_grading_enabled
          FROM exam_questions eq
          JOIN question_bank q ON eq.question_id = q.id
          JOIN students s ON s.id = eq.student_id
          JOIN batches b ON b.id = s.batch_id
          WHERE eq.id = ?
        `, [job.examQuestionId]);
                if (examResult.rows.length === 0) {
                    throw new Error('Question not found');
                }
                const eq = examResult.rows[0];
                if (eq.ai_grading_enabled === false || eq.ai_grading_enabled === 0) {
                    job.status = 'cancelled';
                    job.updatedAt = Date.now();
                    await this.updateQueueInDB(job);
                    console.log(`[Queue] Job ${job.id} cancelled: AI grading is disabled for its batch`);
                    return;
                }
                if (!eq.answer) {
                    await query(`UPDATE exam_questions SET ai_score = 0.0, ai_feedback = 'No answer provided'
            WHERE id = ? AND EXISTS (
              SELECT 1 FROM ai_queue aq WHERE aq.id = ? AND aq.status = 'processing'
            )`, [job.examQuestionId, parseInt(job.id.replace('job_', ''))]);
                    job.status = 'completed';
                    job.updatedAt = Date.now();
                    await this.updateQueueInDB(job);
                    console.log(`[Queue] Job ${job.id} completed: no answer`);
                    return;
                }
                const prompt = `You are an expert technical interviewer. Evaluate the following answer based on the rubric.

Question: ${eq.question_sample}
Answer: ${eq.answer}

Rubric Must-have (70%): ${eq.rubric_must_have}
Rubric Nice-to-have (20%): ${eq.rubric_nice_to_have}
Rubric Optional (10%): ${eq.rubric_optional}

Provide a JSON response with "score" (0-10) and "feedback" (detailed feedback):
`;
                const aiResult = await this.callAI(prompt, aiSettings);
                const text = aiResult.text;
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    await query(`UPDATE exam_questions SET ai_score = ?, ai_feedback = ?
            WHERE id = ? AND EXISTS (
              SELECT 1 FROM ai_queue aq WHERE aq.id = ? AND aq.status = 'processing'
            )`, [parsed.score, parsed.feedback, job.examQuestionId, parseInt(job.id.replace('job_', ''))]);
                    job.status = 'completed';
                    job.result = { score: parsed.score, feedback: parsed.feedback };
                    job.updatedAt = Date.now();
                    await this.updateQueueInDB(job);
                    console.log(`[Queue] Job ${job.id} completed: Score ${parsed.score}`);
                }
                else {
                    throw new Error('No JSON in AI response: ' + text.substring(0, 100));
                }
            }
            catch (error) {
                console.error(`[Queue] Job ${job.id} failed:`, error.message);
                if (job.attempts >= 3) {
                    job.status = 'failed';
                    job.error = error.message;
                    job.updatedAt = Date.now();
                    const { query } = await import('../server/db/postgres.js');
                    await query(`UPDATE exam_questions SET ai_score = 0.0, ai_feedback = ?
            WHERE id = ? AND EXISTS (
              SELECT 1 FROM ai_queue aq WHERE aq.id = ? AND aq.status = 'processing'
            )`, ['AI Evaluation Failed: ' + error.message, job.examQuestionId, parseInt(job.id.replace('job_', ''))]);
                    await this.updateQueueInDB(job);
                }
                else {
                    job.status = 'pending';
                    job.updatedAt = Date.now();
                    await this.updateQueueInDB(job);
                }
            }
        });
        await Promise.all(promises);
        return processed;
    }
    startQueueProcessor() {
        const interval = parseInt(process.env.QUEUE_PROCESS_INTERVAL || '10000');
        this.queueFlushInterval = setInterval(async () => {
            await this.processQueue(5).catch(console.error);
        }, interval);
    }
    getQueueStats() {
        const stats = {
            pending: 0,
            processing: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
            total: this.queue.size
        };
        for (const job of this.queue.values()) {
            stats[job.status]++;
        }
        return stats;
    }
    getCachedAnswers(studentId) {
        const answers = new Map();
        for (const [key, entry] of this.answerBuffer) {
            if (entry.studentId === studentId) {
                answers.set(entry.questionOrder, entry.answer);
            }
        }
        return answers;
    }
    destroy() {
        if (this.flushInterval)
            clearInterval(this.flushInterval);
        if (this.queueFlushInterval)
            clearInterval(this.queueFlushInterval);
        this.flushAnswers().catch(console.error);
    }
}
export const cache = new FileCache();
export default cache;
