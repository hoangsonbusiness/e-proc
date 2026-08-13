import app, { startupReady } from './index.js';
import { cache } from './cache.js';
import dotenv from 'dotenv';
dotenv.config();
const PORT = parseInt(process.env.PORT || '3001');
// [P2-review] KHÔNG mở socket trước khi schema verification thành công. Trước đây listen() gọi
// ngay, chỉ đóng server SAU khi dbReady fail — trong lúc dbReady còn pending, các operational
// endpoint (/api/test-db, /api/queue/*, /api/cache/flush, /api/stats, /api/health) đã có thể nhận
// request và chạm DB/cache khi init chưa xong. Giờ await dbReady TRƯỚC listen().
async function main() {
    try {
        await startupReady;
        const server = app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
            console.log(`Health: http://localhost:${PORT}/api/health`);
            console.log(`API Base: http://localhost:${PORT}/api`);
        });
        process.on('SIGINT', () => {
            console.log('\nShutting down...');
            cache.destroy();
            server.close(() => {
                console.log('Server closed');
                process.exit(0);
            });
        });
        process.on('SIGTERM', () => {
            cache.destroy();
            server.close(() => process.exit(0));
        });
    }
    catch (error) {
        console.error('FATAL: database schema not ready, refusing to serve:', error?.message);
        process.exit(1);
    }
}
void main();
