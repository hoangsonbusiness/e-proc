import db from './db/postgres.js';

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

class FileCache {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private answerBuffer: Map<string, AnswerCache> = new Map();
  private flushInterval: NodeJS.Timeout | null = null;
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;

    // Vercel may freeze the instance after a response. The interval is retained only
    // for the transitional answer buffer used by local/self-hosted runtimes.
    if (!process.env.VERCEL) this.startFlushInterval();
    this.initialized = true;
  }

  set<T>(key: string, data: T, ttlMs: number = 60_000): void {
    this.cache.set(key, { data, timestamp: Date.now(), ttl: ttlMs });
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
      timestamp: Date.now(),
    });
  }

  async flushAnswers(): Promise<void> {
    if (this.answerBuffer.size === 0) return;

    const answers = Array.from(this.answerBuffer.values());
    this.answerBuffer.clear();
    console.log(`[Cache] Flushing ${answers.length} answers to database`);

    for (const answer of answers) {
      try {
        await db.query(
          'UPDATE exam_questions SET answer = ? WHERE student_id = ? AND question_order = ?',
          [answer.answer, answer.studentId, answer.questionOrder],
        );
      } catch (error) {
        console.error('[Cache] Failed to flush answer:', error);
        this.answerBuffer.set(`${answer.studentId}:${answer.questionOrder}`, answer);
      }
    }
  }

  private startFlushInterval(): void {
    const interval = parseInt(process.env.ANSWER_FLUSH_INTERVAL || '5000', 10);
    this.flushInterval = setInterval(() => {
      this.flushAnswers().catch(console.error);
    }, interval);
  }

  async flushStudentAnswers(studentId: number): Promise<void> {
    const answers = Array.from(this.answerBuffer.entries())
      .filter(([, answer]) => answer.studentId === studentId);
    if (answers.length === 0) return;

    console.log(`[Cache] Flushing ${answers.length} answers for student ${studentId}`);
    for (const [key, answer] of answers) {
      try {
        await db.query(
          'UPDATE exam_questions SET answer = ? WHERE student_id = ? AND question_order = ?',
          [answer.answer, answer.studentId, answer.questionOrder],
        );
        this.answerBuffer.delete(key);
      } catch (error) {
        console.error('[Cache] Failed to flush student answer:', error);
        throw error;
      }
    }
  }

  getCachedAnswers(studentId: number): Map<number, string> {
    const answers = new Map<number, string>();
    for (const entry of this.answerBuffer.values()) {
      if (entry.studentId === studentId) answers.set(entry.questionOrder, entry.answer);
    }
    return answers;
  }

  destroy(): void {
    if (this.flushInterval) clearInterval(this.flushInterval);
    this.flushAnswers().catch(console.error);
  }
}

export const cache = new FileCache();
export default cache;
