import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let requestStore;
let raw;

before(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(
      new URL('../src/server/services/violationRequestStore.ts', import.meta.url),
    )],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64');
  requestStore = await import(`data:text/javascript;base64,${encoded}`);
});

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE students (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(student_id, type)
    );
    CREATE TABLE violation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      batch_id INTEGER,
      type TEXT NOT NULL,
      text_length INTEGER,
      content_preview TEXT,
      question_id TEXT,
      metadata_json TEXT,
      event_id TEXT
    );
    CREATE UNIQUE INDEX ux_violation_events_student_event
      ON violation_events(student_id, event_id) WHERE event_id IS NOT NULL;
  `);
});

function sqliteExecutor(database) {
  return {
    async query(text, params = []) {
      const statement = database.prepare(text);
      if (text.trimStart().toUpperCase().startsWith('SELECT')) {
        return { rows: statement.all(...params), rowCount: 0 };
      }
      const result = statement.run(...params);
      return { rows: [], rowCount: result.changes };
    },
  };
}

function violationInput(overrides = {}) {
  return {
    studentId: 7,
    batchId: 3,
    type: 'recording_stopped',
    eventId: 'recording-stop-after-submit',
    forensicOnly: false,
    textLength: null,
    contentPreview: null,
    questionId: null,
    metadataJson: null,
    lockStudentRow: false,
    ...overrides,
  };
}

test('a recording-stopped event arriving after submit is ignored without forensic or counter writes', async () => {
  raw.prepare("INSERT INTO students (id, status) VALUES (7, 'submitted')").run();

  const result = await requestStore.persistViolationIfInProgress(
    sqliteExecutor(raw),
    violationInput(),
  );

  assert.deepEqual(result, {
    ignored: true,
    replay: false,
    currentCount: 0,
    total: 0,
  });
  assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM violations').get().count, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM violation_events').get().count, 0);
});

test('the same recording-stopped event is persisted while the attempt is in progress', async () => {
  raw.prepare("INSERT INTO students (id, status) VALUES (7, 'in_progress')").run();

  const result = await requestStore.persistViolationIfInProgress(
    sqliteExecutor(raw),
    violationInput({ eventId: 'recording-stop-during-exam' }),
  );

  assert.deepEqual(result, {
    ignored: false,
    replay: false,
    currentCount: 1,
    total: 1,
  });
  assert.deepEqual(
    raw.prepare('SELECT type, count FROM violations').get(),
    { type: 'recording_stopped', count: 1 },
  );
  assert.deepEqual(
    raw.prepare('SELECT type, event_id FROM violation_events').get(),
    { type: 'recording_stopped', event_id: 'recording-stop-during-exam' },
  );
});

test('a missing student is reported instead of silently treating the request as terminal', async () => {
  await assert.rejects(
    requestStore.persistViolationIfInProgress(sqliteExecutor(raw), violationInput()),
    (error) => error?.code === 'STUDENT_NOT_FOUND',
  );
});
