import express from 'express';
import cors from 'cors';
import session from 'express-session';
import dotenv from 'dotenv';
import { initDatabase } from './db/postgres.js';
import adminRoutes from './routes/admin.js';
import studentRoutes from './routes/student.js';
import { cache } from './cache.js';
import rateLimit from 'express-rate-limit';
dotenv.config();
console.log('Starting server...');
console.log('DB:', process.env.DATABASE_URL ? 'configured' : 'NOT configured');
console.log('USE_SQLITE:', process.env.USE_SQLITE || 'false (PostgreSQL)');
const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
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
app.get('/api/test-db', async (req, res) => {
    try {
        const { query } = await import('./db/postgres.js');
        const result = await query('SELECT NOW() as time, version() as pg_version');
        res.json({
            success: true,
            time: result.rows[0]?.time,
            pg_version: result.rows[0]?.pg_version,
            mode: process.env.USE_SQLITE === 'false' ? 'PostgreSQL' : 'SQLite'
        });
    }
    catch (e) {
        res.status(500).json({
            error: e.message,
            code: e.code,
            syscall: e.syscall,
            hostname: e.hostname
        });
    }
});
app.post('/api/init-tables', async (req, res) => {
    try {
        const { initDatabase } = await import('./db/postgres.js');
        await initDatabase();
        res.json({ success: true, message: 'Tables initialized' });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/queue/process', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 5;
        const processed = await cache.processQueue(limit);
        res.json({ processed, timestamp: new Date().toISOString() });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.get('/api/queue/stats', async (req, res) => {
    try {
        const stats = cache.getQueueStats();
        res.json(stats);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.post('/api/cache/flush', async (req, res) => {
    try {
        await cache.flushAnswers();
        res.json({ success: true, timestamp: new Date().toISOString() });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.get('/api/stats', (req, res) => {
    res.json({
        queue: cache.getQueueStats(),
        timestamp: new Date().toISOString()
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
    .then(() => cache.processQueue(5))
    .then(() => console.log('Initial queue processed'))
    .catch(err => console.error('Init error:', err));
export default app;
