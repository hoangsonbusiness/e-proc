import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { stripHtml } from '../utils/string.js';

dotenv.config();

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

interface AnswerCache {
  studentId: number;
  questionOrder: number;
  answer: string;
  timestamp: number;
}

interface QueueJob {
  id: string;
  // kind='exam': id của exam_questions; kind='practice': id của practice_submissions
  examQuestionId: number;
  studentId: number;
  kind: 'exam' | 'practice';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  createdAt: number;
  updatedAt: number;
  result?: {
    score: number;
    feedback: string;
  };
  error?: string;
}

interface AISettings {
  provider: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

class FileCache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private answerBuffer: Map<string, AnswerCache> = new Map();
  private queue: Map<string, QueueJob> = new Map();
  private flushInterval: NodeJS.Timeout | null = null;
  private queueFlushInterval: NodeJS.Timeout | null = null;
  private cachedAISettings: AISettings | null = null;
  private settingsLastFetched: number = 0;
  
  private dataDir: string = path.join(process.cwd(), 'data');
  private queueFile: string = path.join(process.cwd(), 'data', 'queue.json');

  constructor() {
    this.ensureDataDir();
    // Call loadQueue - for async DB load we need to handle separately
    this.loadQueue();
    this.startFlushInterval();
    this.startQueueProcessor();
  }

  async init(): Promise<void> {
    // For production, load from database
    if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
      await this.loadQueueFromDB();
    }
  }

  private ensureDataDir() {
    // Skip on Vercel (read-only)
    if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
      return;
    }
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  async getAISettings(): Promise<AISettings> {
    const now = Date.now();
    if (this.cachedAISettings && (now - this.settingsLastFetched) < 60000) {
      return this.cachedAISettings;
    }

    try {
      const { query } = await import('../server/db/postgres.js');
      const result = await query('SELECT * FROM ai_settings WHERE id = 1');
      
      if (result.rows.length > 0) {
        this.cachedAISettings = result.rows[0];
      } else {
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
    } catch (err) {
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

  async callAI(prompt: string, settings: AISettings): Promise<{text: string}> {
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
      const data = await response.json() as { choices?: { message?: { content?: string } }[] };
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
      const data = await response.json() as { response?: string };
      return { text: data.response || '' };
    }
    
    throw new Error(`Unsupported provider: ${settings.provider}`);
  }

  set<T>(key: string, data: T, ttlMs: number = 60000): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttlMs
    });
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data as T;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  bufferAnswer(studentId: number, questionOrder: number, answer: string): void {
    const key = `${studentId}:${questionOrder}`;
    this.answerBuffer.set(key, {
      studentId,
      questionOrder,
      answer,
      timestamp: Date.now()
    });
  }

  async flushAnswers(): Promise<void> {
    if (this.answerBuffer.size === 0) return;

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
      } catch (err) {
        console.error('[Cache] Failed to flush answer:', err);
        this.answerBuffer.set(`${answer.studentId}:${answer.questionOrder}`, answer);
      }
    }
  }

  private startFlushInterval() {
    const interval = parseInt(process.env.ANSWER_FLUSH_INTERVAL || '5000');
    this.flushInterval = setInterval(() => {
      this.flushAnswers().catch(console.error);
    }, interval);
  }

  addToQueue(examQuestionId: number, studentId: number, kind: 'exam' | 'practice' = 'exam'): string {
    // Use smaller ID to avoid PostgreSQL integer overflow
    const dbId = Date.now() % 10000000;
    const id = `job_${dbId}`;
    const job: QueueJob = {
      id,
      examQuestionId,
      studentId,
      kind,
      status: 'pending',
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.queue.set(id, job);

    // Save to database instead of file
    this.saveQueueToDB(job, dbId);

    console.log(`[Queue] Added job ${id} (${kind}) for ${kind === 'practice' ? 'practice_submission' : 'exam_question'} ${examQuestionId}`);
    return id;
  }

  private async saveQueueToDB(job: QueueJob, dbId: number): Promise<void> {
    try {
      const { query } = await import('../server/db/postgres.js');
      // Dùng ? (không phải $N) để query() tự dịch sang $N cho Postgres — $N trực tiếp
      // sẽ crash dưới SQLite local dev (xem CLAUDE.md về placeholder styles)
      await query(
        `INSERT INTO ai_queue (id, exam_question_id, student_id, status, attempts, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        [dbId, job.examQuestionId, job.studentId, job.status, job.attempts, job.kind, new Date(job.createdAt).toISOString(), new Date(job.updatedAt).toISOString()]
      );
    } catch (err) {
      console.error('[Queue] Failed to save to DB:', err);
    }
  }

  private loadQueue() {
    // On Vercel/production, load from database instead of file
    if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
      this.loadQueueFromDB();
      return;
    }
    
    try {
      if (fs.existsSync(this.queueFile)) {
        const data = JSON.parse(fs.readFileSync(this.queueFile, 'utf-8'));
        for (const [id, job] of Object.entries(data)) {
          // Jobs lưu trước khi có kind → mặc định 'exam'
          this.queue.set(id, { kind: 'exam', ...(job as QueueJob) });
        }
        console.log(`[Queue] Loaded ${this.queue.size} jobs from file`);
      }
    } catch (err) {
      console.error('[Queue] Failed to load queue:', err);
    }
  }
  
  private async loadQueueFromDB(): Promise<void> {
    try {
      const { query } = await import('../server/db/postgres.js');
      const result = await query('SELECT id, exam_question_id, student_id, status, attempts, kind, created_at, updated_at FROM ai_queue WHERE status IN (?, ?)', ['pending', 'processing']);

      for (const row of result.rows) {
        const id = `job_${row.id}`;
        this.queue.set(id, {
          id,
          examQuestionId: row.exam_question_id,
          studentId: row.student_id,
          kind: row.kind === 'practice' ? 'practice' : 'exam',
          status: row.status,
          attempts: row.attempts,
          createdAt: new Date(row.created_at).getTime(),
          updatedAt: new Date(row.updated_at).getTime()
        });
      }
      console.log(`[Queue] Loaded ${this.queue.size} jobs from database`);
    } catch (err) {
      console.error('[Queue] Failed to load from DB:', err);
    }
  }

  private async updateQueueInDB(job: QueueJob): Promise<void> {
    try {
      const dbId = parseInt(job.id.replace('job_', ''));
      const { query } = await import('../server/db/postgres.js');
      await query(
        `UPDATE ai_queue SET status = ?, attempts = ?, updated_at = ? WHERE id = ?`,
        [job.status, job.attempts, new Date(job.updatedAt).toISOString(), dbId]
      );
    } catch (err) {
      console.error('[Queue] Failed to update in DB:', err);
    }
  }

  async processQueue(limit: number = 5): Promise<number> {
    const pendingJobs = Array.from(this.queue.values())
      .filter(j => j.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);

    if (pendingJobs.length === 0) return 0;

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

        // Bảng đích + prompt tuỳ theo loại job (exam question vs practice submission)
        const targetTable = job.kind === 'practice' ? 'practice_submissions' : 'exam_questions';
        let answer: string;
        let prompt: string;

        if (job.kind === 'practice') {
          const subResult = await query(`
            SELECT ps.*, p.name, p.content_plain
            FROM practice_submissions ps
            JOIN practice_exams p ON ps.practice_exam_id = p.id
            WHERE ps.id = ?
          `, [job.examQuestionId]);

          if (subResult.rows.length === 0) {
            throw new Error('Practice submission not found');
          }
          const sub = subResult.rows[0];
          answer = sub.answer;

          prompt = `You are an expert technical interviewer. A student took a long-form practice exam. Evaluate their complete program/answer against the full exam requirements below.

=== PRACTICE EXAM: ${sub.name} ===
${sub.content_plain}

=== STUDENT'S ANSWER ===
${sub.answer}

Grade holistically: correctness against the stated requirements, architecture/design quality, code quality, and whether the expected console output (if specified in the exam) would be produced.

Provide a JSON response with "score" (0-10) and "feedback" (detailed feedback):
`;
        } else {
          const examResult = await query(`
            SELECT eq.*, q.question_sample, q.question_plain, q.rubric_must_have, q.rubric_nice_to_have, q.rubric_optional
            FROM exam_questions eq
            JOIN question_bank q ON eq.question_id = q.id
            WHERE eq.id = ?
          `, [job.examQuestionId]);

          if (examResult.rows.length === 0) {
            throw new Error('Question not found');
          }
          const eq = examResult.rows[0];
          answer = eq.answer;

          const questionText = eq.question_plain || stripHtml(eq.question_sample);
          prompt = `You are an expert technical interviewer. Evaluate the following answer based on the rubric.

Question: ${questionText}
Answer: ${eq.answer}

Rubric Must-have (70%): ${eq.rubric_must_have}
Rubric Nice-to-have (20%): ${eq.rubric_nice_to_have}
Rubric Optional (10%): ${eq.rubric_optional}

Provide a JSON response with "score" (0-10) and "feedback" (detailed feedback):
`;
        }

        if (!answer) {
          await query(`UPDATE ${targetTable} SET ai_score = 0.0, ai_feedback = 'No answer provided' WHERE id = ?`, [job.examQuestionId]);
          job.status = 'completed';
          job.updatedAt = Date.now();
          await this.updateQueueInDB(job);
          return;
        }

        const aiResult = await this.callAI(prompt, aiSettings);
        const text = aiResult.text;

        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);

          await query(`UPDATE ${targetTable} SET ai_score = ?, ai_feedback = ? WHERE id = ?`,
            [parsed.score, parsed.feedback, job.examQuestionId]);

          job.status = 'completed';
          job.result = { score: parsed.score, feedback: parsed.feedback };
          job.updatedAt = Date.now();
          await this.updateQueueInDB(job);
          console.log(`[Queue] Job ${job.id} completed: Score ${parsed.score}`);
        } else {
          throw new Error('No JSON in AI response: ' + text.substring(0, 100));
        }
      } catch (error: any) {
        console.error(`[Queue] Job ${job.id} failed:`, error.message);

        if (job.attempts >= 3) {
          job.status = 'failed';
          job.error = error.message;
          job.updatedAt = Date.now();

          const failTable = job.kind === 'practice' ? 'practice_submissions' : 'exam_questions';
          const { query } = await import('../server/db/postgres.js');
          await query(`UPDATE ${failTable} SET ai_score = 0.0, ai_feedback = ? WHERE id = ?`,
            ['AI Evaluation Failed: ' + error.message, job.examQuestionId]);
        } else {
          job.status = 'pending';
          job.updatedAt = Date.now();
          await this.updateQueueInDB(job);
        }
      }
    });

    await Promise.all(promises);
    return pendingJobs.length;
  }

  private startQueueProcessor() {
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
      stats[job.status as keyof typeof stats]++;
    }
    
    return stats;
  }

  getCachedAnswers(studentId: number): Map<number, string> {
    const answers = new Map<number, string>();
    for (const [key, entry] of this.answerBuffer) {
      if (entry.studentId === studentId) {
        answers.set(entry.questionOrder, entry.answer);
      }
    }
    return answers;
  }

  destroy(): void {
    if (this.flushInterval) clearInterval(this.flushInterval);
    if (this.queueFlushInterval) clearInterval(this.queueFlushInterval);
    this.flushAnswers().catch(console.error);
  }
}

export const cache = new FileCache();
export default cache;
