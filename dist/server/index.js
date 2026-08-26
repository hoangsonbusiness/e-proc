import express from 'express';
import cors from 'cors';
import session from 'express-session';
import dotenv from 'dotenv';
import { ensureDatabaseReady, getDatabaseReadinessSnapshot } from './db/postgres.js';
import { ReadinessRetryPendingError } from './db/readiness.js';
import adminRoutes from './routes/admin.js';
import studentRoutes from './routes/student.js';
import { cache } from './cache.js';
import rateLimit from 'express-rate-limit';
import { authMiddleware } from './middleware/auth.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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
app.use(cors({
    origin: (origin, callback) => {
        // Cho phép request không có origin (server-to-server, curl, v.v.)
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        }
        else {
            callback(new Error(`CORS: Origin "${origin}" is not allowed`));
        }
    },
    credentials: true,
}));
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
    res.set('Content-Security-Policy', [
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
    ].join('; '));
    next();
});
app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// Một phòng thi có thể có 25-50 thí sinh chung public IP. Autosave và các
// request start/submit của họ phải dùng chung được bucket mà không nhận 429.
app.use(rateLimit({ windowMs: 60_000, max: 1200 }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }
}));
let startupResolved = false;
let startupInFlight = null;
/**
 * Shares one startup attempt across concurrent requests. Unlike the old
 * one-shot Promise, a transient database failure does not poison this Vercel
 * instance forever: after the DB cooldown, a later request can try again.
 */
export function ensureStartupReady() {
    if (startupResolved)
        return Promise.resolve();
    if (startupInFlight)
        return startupInFlight;
    const attempt = (async () => {
        await ensureDatabaseReady();
        await cache.init();
        startupResolved = true;
        console.log('[startup] READY: database schema verified and cache initialized');
    })();
    startupInFlight = attempt;
    void attempt.then(() => {
        if (startupInFlight === attempt)
            startupInFlight = null;
    }, (rawError) => {
        if (startupInFlight === attempt)
            startupInFlight = null;
        if (rawError instanceof ReadinessRetryPendingError)
            return;
        const error = rawError instanceof Error ? rawError : new Error(String(rawError));
        const snapshot = getDatabaseReadinessSnapshot();
        const kind = snapshot.state === 'permanent_failure' ? 'PERMANENT' : 'RETRYABLE';
        console.error(`[startup] ${kind} failure:`, error.message);
    });
    return attempt;
}
// Start eagerly on cold start, while keeping failures recoverable by later requests.
void ensureStartupReady().catch(() => undefined);
function trackAdminRequestStart(_req, res, next) {
    res.locals.adminRequestStartedAt = performance.now();
    res.locals.instanceUptimeAtStart = Math.round(process.uptime() * 1000);
    res.locals.startupWaitMs = 0;
    next();
}
async function requireDbReady(req, res, next) {
    if (startupResolved)
        return next();
    const waitStartedAt = performance.now();
    try {
        await ensureStartupReady();
        if (req.originalUrl.startsWith('/api/admin')) {
            res.locals.startupWaitMs = performance.now() - waitStartedAt;
        }
        next();
    }
    catch {
        if (req.originalUrl.startsWith('/api/admin')) {
            res.locals.startupWaitMs = performance.now() - waitStartedAt;
        }
        const snapshot = getDatabaseReadinessSnapshot();
        if (snapshot.retryAfterMs > 0) {
            res.setHeader('Retry-After', Math.max(1, Math.ceil(snapshot.retryAfterMs / 1000)));
        }
        res.status(503).json({ error: 'Service not ready: startup failed' });
    }
}
app.use('/api/admin', trackAdminRequestStart, requireDbReady, adminRoutes);
app.use('/api/student', requireDbReady, studentRoutes);
app.get('/api/health', async (_req, res) => {
    try {
        await ensureStartupReady();
    }
    catch {
        const snapshot = getDatabaseReadinessSnapshot();
        const permanent = snapshot.state === 'permanent_failure';
        if (snapshot.retryAfterMs > 0) {
            res.setHeader('Retry-After', Math.max(1, Math.ceil(snapshot.retryAfterMs / 1000)));
        }
        return res.status(503).json({
            status: permanent ? 'degraded' : 'not_ready',
            db: permanent ? 'error' : snapshot.state === 'retry_wait' ? 'retrying' : 'initializing',
            timestamp: new Date().toISOString(),
            ...(snapshot.retryAfterMs > 0 ? { retryAfterMs: snapshot.retryAfterMs } : {}),
        });
    }
    return res.status(200).json({
        status: 'ok',
        db: 'ready',
        timestamp: new Date().toISOString(),
        cache: 'active',
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
    }
    catch (e) {
        // [M-1] Không lộ chi tiết lỗi DB ra ngoài
        console.error('[test-db] Error:', e.message);
        res.status(500).json({ error: 'Database connection test failed' });
    }
});
app.post('/api/cache/flush', authMiddleware, async (req, res) => {
    try {
        await cache.flushAnswers();
        res.json({ success: true, timestamp: new Date().toISOString() });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// The local Docker image is deliberately one app service: Express serves both
// the API and the built React SPA. Vercel keeps using its existing static route
// because SERVE_STATIC is not enabled there.
if (process.env.SERVE_STATIC === 'true') {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const clientDist = path.resolve(moduleDir, '../../client/dist');
    const clientIndex = path.join(clientDist, 'index.html');
    if (!fs.existsSync(clientIndex)) {
        throw new Error(`SERVE_STATIC=true but frontend build is missing: ${clientIndex}`);
    }
    app.use(express.static(clientDist, { index: false }));
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/'))
            return next();
        return res.sendFile(clientIndex);
    });
}
export default app;
