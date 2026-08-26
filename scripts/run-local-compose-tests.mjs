import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const compose = ['compose', '-f', 'docker-compose.local.yml'];

function run(args, options = {}) {
  const result = spawnSync('docker', [...compose, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${[...compose, ...args].join(' ')} failed with exit code ${result.status}`);
}

function diagnostics() {
  spawnSync('docker', [...compose, 'ps'], { cwd: process.cwd(), stdio: 'inherit', shell: false });
  spawnSync('docker', [...compose, 'logs', '--no-color', '--tail', '200', 'app', 'database'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: false,
  });
}

function applyMigration(file) {
  const result = spawnSync('docker', [
    ...compose,
    'exec', '-T', 'database',
    'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
  ], {
    cwd: process.cwd(),
    input: readFileSync(file),
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} failed with exit code ${result.status}`);
}

try {
  console.log('\n[1/7] Building and starting the two-service local stack...');
  run(['up', '--build', '--detach', '--wait']);

  console.log('\n[2/7] Applying the legacy-AI cleanup migration and restarting on schema v2...');
  applyMigration('migrations/20260819_remove_legacy_ai.sql');
  applyMigration('migrations/20260819_remove_legacy_ai.sql');
  run(['restart', 'app']);
  run(['up', '--detach', '--wait', 'app']);

  console.log('\n[3/7] Verifying PostgreSQL-backed application health and legacy-free schema...');
  run(['exec', '-T', 'app', 'node', '-e', [
    "const r=await fetch('http://127.0.0.1:3001/api/health');",
    "const body=await r.json();",
    "if(!r.ok||body.status!=='ok'||body.db!=='ready')throw new Error(JSON.stringify(body));",
    "if('queue' in body)throw new Error('Health response still exposes legacy queue state');",
    "const pg=(await import('pg')).default;",
    "const p=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});",
    "const q=await p.query(`SELECT (SELECT version FROM app_schema_state WHERE id=1) version,to_regclass('public.ai_queue') ai_queue,to_regclass('public.ai_settings') ai_settings,to_regclass('public.user_ai_settings') user_ai_settings,(SELECT COUNT(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='batches' AND column_name IN ('ai_grading_enabled','ai_setting_id')) legacy_columns`);",
    "await p.end();",
    "const s=q.rows[0];",
    "if(Number(s.version)!==2||s.ai_queue!==null||s.ai_settings!==null||!s.user_ai_settings||Number(s.legacy_columns)!==0)throw new Error(JSON.stringify(s));",
  ].join('')]);

  console.log('\n[4/7] Verifying the built React frontend is served by the app container...');
  run(['exec', '-T', 'app', 'node', '-e', [
    "const r=await fetch('http://127.0.0.1:3001/');",
    "const body=await r.text();",
    "if(!r.ok||!body.includes('id=\"root\"'))throw new Error(`Unexpected frontend response: ${r.status}`);",
    "if(body.includes('monaco-editor')||body.includes('StudentExam'))throw new Error('Admin/student entry eagerly preloads exam code');",
  ].join('')]);

  console.log('\n[5/7] Running the complete default regression suite inside the app image...');
  run(['exec', '-T', '-e', 'DATABASE_URL=', 'app', 'npm', 'test']);

  console.log('\n[6/7] Running PostgreSQL integration tests against the Supabase database service...');
  run([
    'exec', '-T',
    '-e', 'DATABASE_URL=',
    '-e', 'TEST_DATABASE_URL=postgresql://postgres:eproc_local_password@database:5432/postgres',
    'app', 'npm', 'run', 'test:postgres',
  ]);

  console.log('\n[7/7] Running AI Grade end-to-end tests through HTTP, PostgreSQL, and a mock LLM...');
  run([
    'exec', '-T',
    '-e', 'AI_GRADE_TEST_DATABASE_URL=postgresql://postgres:eproc_local_password@database:5432/postgres',
    'app', 'node', 'scripts/verify-ai-grade-local.mjs',
  ]);

  console.log('\nLocal Docker verification passed. App: http://localhost:3001, PostgreSQL: localhost:54322');
} catch (error) {
  console.error(`\nLocal Docker verification failed: ${error instanceof Error ? error.message : String(error)}`);
  diagnostics();
  process.exit(1);
}
