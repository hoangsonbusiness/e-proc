import { spawnSync } from 'node:child_process';

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

try {
  console.log('\n[1/6] Building and starting the two-service local stack...');
  run(['up', '--build', '--detach', '--wait']);

  console.log('\n[2/6] Verifying PostgreSQL-backed application health...');
  run(['exec', '-T', 'app', 'node', '-e', [
    "const r=await fetch('http://127.0.0.1:3001/api/health');",
    "const body=await r.json();",
    "if(!r.ok||body.status!=='ok'||body.db!=='ready')throw new Error(JSON.stringify(body));",
  ].join('')]);

  console.log('\n[3/6] Verifying the built React frontend is served by the app container...');
  run(['exec', '-T', 'app', 'node', '-e', [
    "const r=await fetch('http://127.0.0.1:3001/');",
    "const body=await r.text();",
    "if(!r.ok||!body.includes('id=\"root\"'))throw new Error(`Unexpected frontend response: ${r.status}`);",
  ].join('')]);

  console.log('\n[4/6] Running the complete default regression suite inside the app image...');
  run(['exec', '-T', '-e', 'DATABASE_URL=', 'app', 'npm', 'test']);

  console.log('\n[5/6] Running PostgreSQL integration tests against the Supabase database service...');
  run([
    'exec', '-T',
    '-e', 'DATABASE_URL=',
    '-e', 'TEST_DATABASE_URL=postgresql://postgres:eproc_local_password@database:5432/postgres',
    'app', 'npm', 'run', 'test:postgres',
  ]);

  console.log('\n[6/6] Running AI Grade end-to-end tests through HTTP, PostgreSQL, and a mock LLM...');
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
