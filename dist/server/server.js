import app from './index.js';
import dotenv from 'dotenv';
dotenv.config();
const PORT = parseInt(process.env.PORT || '3001');
const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Health: http://localhost:${PORT}/api/health`);
    console.log(`API Base: http://localhost:${PORT}/api`);
});
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
