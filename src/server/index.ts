import express from 'express';
import cors from 'cors';
import session from 'express-session';
import dotenv from 'dotenv';
import { dbReady } from './db/postgres.js';
import adminRoutes from './routes/admin.js';
import studentRoutes from './routes/student.js';
import { cache } from './cache.js';
import rateLimit from 'express-rate-limit';
import { authMiddleware } from './middleware/auth.js';

dotenv.config();

// Validate JWT_SECRET tại startup — không cho phép chạy nếu thiếu
if (!process.env.JWT_SECRET) {
  console.error('FATAL ERROR: JWT_SECRET is not set in environment variables.');
  console.error('Please add JWT_SECRET to your .env file and restart the server.');
  process.exit(1);
}

console.log('Starting server...');

console.log('DB:', process.env.DATABASE_URL ? 'configured' : 'NOT configured');
console.log('USE_SQLITE:', process.env.USE_SQLITE || 'false (PostgreSQL)');

const app = express();

app.set('trust proxy', 1);

// [C-1] CORS: Chỉ cho phép các origin được cấu hình trong ALLOWED_ORIGINS
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Cho phép request không có origin (server-to-server, curl, v.v.)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: Origin "${origin}" is not allowed`));
      }
    },
    credentials: true,
  })
);
// [SEC] Security headers (không dùng helmet để tránh thêm dependency).
// CSP: SPA React + Monaco. Monaco cần 'unsafe-eval' (worker/wasm) và blob: cho worker.
// 'unsafe-inline' style cho Monaco/React inline styles. Ảnh data: cho watermark/avatar.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' blob:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "worker-src 'self' blob:",
      "connect-src 'self' https:",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  next();
});
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(rateLimit({ windowMs: 60000, max: 200 }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }
}));

// [P1-review] Readiness gate. dbReady = initDatabase → verifyRequiredSchema. Trên serverless
// (Vercel), một cold-start instance có thể nhận request TRƯỚC khi init xong; các route thi phụ
// thuộc cứng vào schema mới (/violation đã bỏ fallback). Middleware await dbReady và trả 503
// nếu chưa/không sẵn sàng, thay vì để /violation trả 500 âm thầm rồi mất telemetry.
// [P2-review] startupReady = DB init → schema verify → cache init. Health/gate/listen đều dựa
// vào promise CHUNG này để không báo ready trước khi cả cache sẵn sàng.
const startupReady: Promise<void> = dbReady
  .then(() => console.log('Database initialized and schema verified'))
  .then(() => cache.init())
  .then(() => { console.log('Cache initialized'); });

let startupResolved = false;
let startupError: Error | null = null;
startupReady.then(
  () => { startupResolved = true; },
  (err) => { startupError = err instanceof Error ? err : new Error(String(err)); console.error('[startup] FAILED:', startupError.message); }
);

async function requireDbReady(_req: express.Request, res: express.Response, next: express.NextFunction) {
  if (startupResolved) return next();
  if (startupError) return res.status(503).json({ error: 'Service not ready: startup failed' });
  try {
    await startupReady;
    next();
  } catch {
    res.status(503).json({ error: 'Service not ready: startup failed' });
  }
}

function cronOrAdminAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const cronSecret = process.env.CRON_SECRET;
  const authorization = req.headers.authorization;
  if (cronSecret && authorization === `Bearer ${cronSecret}`) return next();
  return authMiddleware(req, res, next);
}

app.use('/api/admin', requireDbReady, adminRoutes);
app.use('/api/student', requireDbReady, studentRoutes);

app.get('/api/health', (_req, res) => {
  // [P2-review] Readiness probe: CHỈ trả 200 khi startup thực sự xong. Pending → 503 not_ready,
  // lỗi → 503 degraded. Trước đây pending trả 200 + status:ok khiến probe coi instance sẵn sàng
  // quá sớm (và cache có thể chưa init).
  if (startupError) {
    return res.status(503).json({ status: 'degraded', db: 'error', timestamp: new Date().toISOString() });
  }
  if (!startupResolved) {
    return res.status(503).json({ status: 'not_ready', db: 'initializing', timestamp: new Date().toISOString() });
  }
  return res.status(200).json({
    status: 'ok',
    db: 'ready',
    timestamp: new Date().toISOString(),
    cache: 'active',
    queue: cache.getQueueStats(),
  });
});

// Operational endpoints bên dưới cũng chạm DB/cache; serverless phải chờ readiness như routers.
app.use('/api', requireDbReady);

// [C-2] Internal diagnostic/operational endpoints — require admin JWT
// [C-3] POST /api/init-tables đã bị xóa (DB init tự động khi server start)

app.get('/api/test-db', authMiddleware, async (req, res) => {
  try {
    const { query } = await import('./db/postgres.js');
    const result = await query('SELECT NOW() as time, version() as pg_version');
    res.json({
      success: true,
      time: result.rows[0]?.time,
      pg_version: result.rows[0]?.pg_version,
      mode: process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite',
    });
  } catch (e: any) {
    // [M-1] Không lộ chi tiết lỗi DB ra ngoài
    console.error('[test-db] Error:', e.message);
    res.status(500).json({ error: 'Database connection test failed' });
  }
});

app.get('/api/queue/process', cronOrAdminAuth, async (req, res) => {
  try {
    const requested = parseInt(req.query.limit as string) || 5;
    const limit = Math.max(1, Math.min(requested, 5));
    const processed = await cache.processQueue(limit);
    res.json({ processed, timestamp: new Date().toISOString() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/queue/stats', authMiddleware, async (req, res) => {
  try {
    const stats = cache.getQueueStats();
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/cache/flush', authMiddleware, async (req, res) => {
  try {
    await cache.flushAnswers();
    res.json({ success: true, timestamp: new Date().toISOString() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', authMiddleware, (req, res) => {
  res.json({
    queue: cache.getQueueStats(),
    timestamp: new Date().toISOString(),
  });
});

// startupReady (định nghĩa phía trên) đã lo init DB→schema→cache một lần. Không lặp lại
// ở đây để tránh init hai lần. Server.ts await startupReady trước khi listen().
export { dbReady, startupReady };
export default app;
