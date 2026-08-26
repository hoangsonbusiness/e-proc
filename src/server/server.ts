import app, { ensureStartupReady } from './index.js';
import { cache } from './cache.js';
import { getDatabaseReadinessSnapshot } from './db/postgres.js';
import dotenv from 'dotenv';

dotenv.config();

const PORT = parseInt(process.env.PORT || '3001');

async function waitForStartup(): Promise<void> {
  while (true) {
    try {
      await ensureStartupReady();
      return;
    } catch (error) {
      const snapshot = getDatabaseReadinessSnapshot();
      if (snapshot.state === 'permanent_failure') throw error;
      const retryDelayMs = Math.max(250, snapshot.retryAfterMs || 1_000);
      console.error(`[startup] Waiting ${retryDelayMs}ms before retrying initialization`);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

// Persistent/local runtimes wait and retry transient DB failures before opening
// the socket. Vercel invokes ensureStartupReady() through the request gate instead.
async function main() {
  try {
    await waitForStartup();

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
  } catch (error: any) {
    console.error('FATAL: database schema not ready, refusing to serve:', error?.message);
    process.exit(1);
  }
}

void main();
