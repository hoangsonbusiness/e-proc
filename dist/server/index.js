import express from 'express';
import cors from 'cors';
import session from 'express-session';
import dotenv from 'dotenv';
import { initDatabase } from './db/postgres.js';
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
app.use('/api/admin', adminRoutes);
app.use('/api/student', studentRoutes);
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        cache: 'active',
        queue: cache.getQueueStats()
    });
});
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
app.get('/api/queue/process', authMiddleware, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 5;
        const processed = await cache.processQueue(limit);
        res.json({ processed, timestamp: new Date().toISOString() });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.get('/api/queue/stats', authMiddleware, async (req, res) => {
    try {
        const stats = cache.getQueueStats();
        res.json(stats);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
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
app.get('/api/stats', authMiddleware, (req, res) => {
    res.json({
        queue: cache.getQueueStats(),
        timestamp: new Date().toISOString(),
    });
});
process.on('SIGINT', () => {
    console.log('Shutting down...');
    cache.destroy();
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('Shutting down...');
    cache.destroy();
    process.exit(0);
});
initDatabase()
    .then(() => console.log('Database initialized'))
    .then(() => cache.init())
    .then(() => cache.processQueue(5))
    .then(() => console.log('Initial queue processed'))
    .catch(err => console.error('Init error:', err));
export default app;
