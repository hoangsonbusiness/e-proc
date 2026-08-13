import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import dotenv from 'dotenv';

// Read only DATABASE_URL from an app .env for the production/test equality guard.
// Do not let .env become an implicit source of TEST_DATABASE_URL.
const appEnv = existsSync('.env') ? dotenv.parse(readFileSync('.env')) : {};
dotenv.config({ path: '.env.test.local', override: false });

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  console.error([
    'Missing TEST_DATABASE_URL.',
    '1. Copy .env.test.example to .env.test.local',
    '2. Paste the Transaction Pooler URI of a NON-PRODUCTION PostgreSQL project',
    '3. Run: npm run test:postgres',
  ].join('\n'));
  process.exit(1);
}

if (/PROJECT_REF|URL_ENCODED_DB_PASSWORD|REGION|\.\.\./i.test(connectionString)) {
  console.error('TEST_DATABASE_URL still contains placeholder text. Replace it with the full test database URI.');
  process.exit(1);
}

let target;
try {
  target = new URL(connectionString);
} catch {
  console.error('TEST_DATABASE_URL is not a valid PostgreSQL URL.');
  process.exit(1);
}

if (!['postgres:', 'postgresql:'].includes(target.protocol)) {
  console.error('TEST_DATABASE_URL must start with postgres:// or postgresql://.');
  process.exit(1);
}

const appDatabaseUrl = process.env.DATABASE_URL || appEnv.DATABASE_URL;
if (appDatabaseUrl && appDatabaseUrl === connectionString) {
  console.error('Refusing to run: TEST_DATABASE_URL is identical to DATABASE_URL. Use a separate test project.');
  process.exit(1);
}

console.log(`PostgreSQL integration target: ${target.hostname}/${target.pathname.replace(/^\//, '') || 'postgres'}`);
console.log('The test will recreate only the schema named test_violation; schema public is not modified.');

const child = spawn(
  process.execPath,
  ['--test', 'test/violation-postgres.integration.test.mjs'],
  { stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: connectionString } },
);

child.on('error', (error) => {
  console.error('Could not start PostgreSQL integration tests:', error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`PostgreSQL integration tests terminated by signal ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
