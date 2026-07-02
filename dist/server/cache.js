import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();
class FileCache {
    cache = new Map();
    answerBuffer = new Map();
    queue = new Map();
    flushInterval = null;
    queueFlushInterval = null;
    cachedAISettings = null;
    settingsLastFetched = 0;
    dataDir;
    queueFile;
    constructor() {
        this.ensureDataDir();
        // Call loadQueue - for async DB load we need to handle separately
        this.loadQueue();
        this.startFlushInterval();
        this.startQueueProcessor();
    }
    async init() {
        // For production, load from database
        if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
            await this.loadQueueFromDB();
        }
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
    async getAISettings() {
        const now = Date.now();
        if (this.cachedAISettings && (now - this.settingsLastFetched) < 60000) {
            return this.cachedAISettings;
        }
        try {
            const { query } = await import('../server/db/postgres.js');
            const result = await query('SELECT * FROM ai_settings WHERE id = 1');
            if (result.rows.length > 0) {
                this.cachedAISettings = result.rows[0];
            }
            else {
                this.cachedAISettings = {
                    provider: 'gemini',
                    apiKey: process.env.GEMINI_API_KEY || '',
                    model: 'gemini-2.0-flash',
                    temperature: 0.3,
                    maxTokens: 2048
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
                maxTokens: 2048
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
    addToQueue(examQuestionId, studentId) {
        // Use smaller ID to avoid PostgreSQL integer overflow
        const dbId = Date.now() % 10000000;
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
        this.queue.set(id, job);
        // Save to database instead of file
        this.saveQueueToDB(job, dbId);
        console.log(`[Queue] Added job ${id} for exam_question ${examQuestionId}`);
        return id;
    }
    async saveQueueToDB(job, dbId) {
        try {
            const { query } = await import('../server/db/postgres.js');
            await query(`INSERT INTO ai_queue (id, exam_question_id, student_id, status, attempts, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`, [dbId, job.examQuestionId, job.studentId, job.status, job.attempts, new Date(job.createdAt), new Date(job.updatedAt)]);
        }
        catch (err) {
            console.error('[Queue] Failed to save to DB:', err);
        }
    }
    loadQueue() {
        // On Vercel/production, load from database instead of file
        if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
            this.loadQueueFromDB();
            return;
        }
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
        try {
            const { query } = await import('../server/db/postgres.js');
            const result = await query('SELECT id, exam_question_id, student_id, status, attempts, created_at, updated_at FROM ai_queue WHERE status IN ($1, $2)', ['pending', 'processing']);
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
            console.log(`[Queue] Loaded ${this.queue.size} jobs from database`);
        }
        catch (err) {
            console.error('[Queue] Failed to load from DB:', err);
        }
    }
    async updateQueueInDB(job) {
        try {
            const dbId = parseInt(job.id.replace('job_', ''));
            const { query } = await import('../server/db/postgres.js');
            await query(`UPDATE ai_queue SET status = $1, attempts = $2, updated_at = $3 WHERE id = $4`, [job.status, job.attempts, new Date(job.updatedAt), dbId]);
        }
        catch (err) {
            console.error('[Queue] Failed to update in DB:', err);
        }
    }
    async processQueue(limit = 5) {
        const pendingJobs = Array.from(this.queue.values())
            .filter(j => j.status === 'pending')
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(0, limit);
        if (pendingJobs.length === 0)
            return 0;
        const aiSettings = await this.getAISettings();
        console.log(`[Queue] Processing ${pendingJobs.length} jobs with ${aiSettings.provider}`);
        let processed = 0;
        const promises = pendingJobs.map(async (job) => {
            try {
                job.status = 'processing';
                job.attempts++;
                job.updatedAt = Date.now();
                await this.updateQueueInDB(job);
                const { query } = await import('../server/db/postgres.js');
                const examResult = await query(`
          SELECT eq.*, q.question_sample, q.rubric_must_have, q.rubric_nice_to_have, q.rubric_optional
          FROM exam_questions eq
          JOIN question_bank q ON eq.question_id = q.id
          WHERE eq.id = ?
        `, [job.examQuestionId]);
                if (examResult.rows.length === 0) {
                    throw new Error('Question not found');
                }
                const eq = examResult.rows[0];
                if (!eq.answer) {
                    await query(`UPDATE exam_questions SET ai_score = 0.0, ai_feedback = 'No answer provided' WHERE id = ?`, [job.examQuestionId]);
                    job.status = 'completed';
                    job.updatedAt = Date.now();
                    await this.updateQueueInDB(job);
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
                    await query(`UPDATE exam_questions SET ai_score = ?, ai_feedback = ? WHERE id = ?`, [parsed.score, parsed.feedback, job.examQuestionId]);
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
                    await query(`UPDATE exam_questions SET ai_score = 0.0, ai_feedback = ? WHERE id = ?`, ['AI Evaluation Failed: ' + error.message, job.examQuestionId]);
                }
                else {
                    job.status = 'pending';
                    job.updatedAt = Date.now();
                    await this.updateQueueInDB(job);
                }
            }
        });
        await Promise.all(promises);
        return pendingJobs.length;
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
