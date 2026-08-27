import { before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let persistence;
let raw;

before(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(
      new URL('../src/server/services/recordingPersistence.ts', import.meta.url),
    )],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64');
  persistence = await import(`data:text/javascript;base64,${encoded}`);
});

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE batches (
      id INTEGER PRIMARY KEY,
      record_mode TEXT NOT NULL DEFAULT 's3',
      record_enabled BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE students (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'in_progress',
      active_jti TEXT,
      exam_deadline TEXT,
      submitted_at TEXT,
      recording_incomplete BOOLEAN NOT NULL DEFAULT FALSE,
      recording_finalized_at TEXT,
      recording_final_part_index INTEGER,
      recording_manifest_sealed_at TEXT,
      recording_expected_part_count INTEGER,
      attempt_record_mode TEXT
    );
    CREATE TABLE recording_parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      batch_id INTEGER NOT NULL,
      part_index INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      uploaded_at TEXT NOT NULL,
      is_final BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE(student_id, part_index)
    );
    CREATE TABLE recording_upload_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      batch_id INTEGER NOT NULL,
      upload_id TEXT NOT NULL,
      part_index INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(student_id, upload_id),
      UNIQUE(student_id, part_index)
    );
    INSERT INTO batches (id) VALUES (3);
    INSERT INTO students (id, batch_id, active_jti) VALUES (7, 3, 'session-a');
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

test('a duplicate recording-complete request reads back the existing committed part', async () => {
  const db = sqliteExecutor(raw);
  const input = {
    studentId: 7,
    batchId: 3,
    partIndex: 0,
    objectKey: 'recordings/3/7/part000.webm',
    byteSize: 1234,
    uploadedAt: '2026-08-27T01:00:00.000Z',
  };

  assert.deepEqual(await persistence.recordCompletedRecordingPart(db, input), {
    already: false,
    objectKey: input.objectKey,
    byteSize: input.byteSize,
  });
  assert.deepEqual(
    await persistence.recordCompletedRecordingPart(db, {
      ...input,
      objectKey: 'untrusted-retry-value',
      byteSize: 9999,
    }),
    {
      already: true,
      objectKey: input.objectKey,
      byteSize: input.byteSize,
    },
    'the idempotent response must describe the row that actually won the unique key',
  );

  assert.equal(
    raw.prepare('SELECT COUNT(*) AS count FROM recording_parts').get().count,
    1,
  );
});

test('stable upload reservations replay the same index and allocate around legacy parts', async () => {
  const db = sqliteExecutor(raw);
  raw.prepare(`
    INSERT INTO recording_parts
      (student_id, batch_id, part_index, object_key, byte_size, uploaded_at)
    VALUES (7, 3, 0, 'recordings/3/7/part000.webm', 500, ?)
  `).run('2026-08-27T01:00:00.000Z');

  const first = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'upload-a',
    sessionId: 'session-a',
    useSqlite: true,
    nowMs: Date.parse('2026-08-27T01:01:00.000Z'),
  });
  const replay = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'upload-a',
    sessionId: 'session-a',
    useSqlite: true,
    nowMs: Date.parse('2026-08-27T01:02:00.000Z'),
  });
  const second = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'upload-b',
    sessionId: 'session-a',
    useSqlite: true,
    nowMs: Date.parse('2026-08-27T01:03:00.000Z'),
  });

  assert.equal(first.partIndex, 1);
  assert.equal(first.objectKey, persistence.recordingObjectKey(3, 7, 'session-a', 1));
  assert.match(first.objectKey, /^recordings\/3\/7\/session-[0-9a-f]{32}\/part001\.webm$/);
  assert.equal(first.already, false);
  assert.equal(replay.partIndex, first.partIndex);
  assert.equal(replay.objectKey, first.objectKey);
  assert.equal(replay.already, true);
  assert.equal(second.partIndex, 2);
  assert.equal(await persistence.findNextRecordingPartIndex(db, 7), 3);
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS count FROM recording_upload_reservations').get().count,
    2,
  );
});

test('reservation rejects an empty or unsafe logical upload identity', async () => {
  const db = sqliteExecutor(raw);
  for (const uploadId of ['', 'contains whitespace', '../path']) {
    await assert.rejects(
      persistence.reserveRecordingUpload(db, {
        studentId: 7,
        batchId: 3,
        uploadId,
        sessionId: 'session-a',
        useSqlite: true,
      }),
      (error) => error?.code === 'INVALID_UPLOAD_ID',
    );
  }
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS count FROM recording_upload_reservations').get().count,
    0,
  );
});

test('cursor returns the first gap across completed parts and reservations', async () => {
  const db = sqliteExecutor(raw);
  const insertPart = raw.prepare(`
    INSERT INTO recording_parts
      (student_id, batch_id, part_index, object_key, byte_size, uploaded_at)
    VALUES (7, 3, ?, ?, 500, ?)
  `);
  insertPart.run(0, 'recordings/3/7/part000.webm', '2026-08-27T01:00:00.000Z');
  insertPart.run(2, 'recordings/3/7/part002.webm', '2026-08-27T01:00:00.000Z');

  assert.equal(await persistence.findNextRecordingPartIndex(db, 7), 1);
});

test('reserved PUT acknowledgement is atomic, idempotent, and cannot change metadata', async () => {
  const db = sqliteExecutor(raw);
  const reservation = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'upload-a',
    sessionId: 'session-a',
    useSqlite: true,
    nowMs: Date.parse('2026-08-27T01:00:00.000Z'),
  });
  const completionInput = {
    studentId: 7,
    batchId: 3,
    uploadId: 'upload-a',
    byteSize: 1234,
    useSqlite: true,
    sessionId: 'session-a',
    nowMs: Date.parse('2026-08-27T01:01:00.000Z'),
  };

  assert.deepEqual(
    await persistence.acknowledgeReservedRecordingPart(db, completionInput),
    {
      uploadId: 'upload-a',
      partIndex: 0,
      objectKey: reservation.objectKey,
      byteSize: 1234,
      already: false,
    },
  );
  assert.deepEqual(
    await persistence.acknowledgeReservedRecordingPart(db, completionInput),
    {
      uploadId: 'upload-a',
      partIndex: 0,
      objectKey: reservation.objectKey,
      byteSize: 1234,
      already: true,
    },
    'the same browser acknowledgement is idempotent',
  );
  await assert.rejects(
    persistence.acknowledgeReservedRecordingPart(db, {
      ...completionInput,
      byteSize: 9999,
    }),
    (error) => error?.code === 'RECORDING_RESERVATION_CONFLICT',
  );
  assert.deepEqual(
    await persistence.acknowledgeReservedRecordingPart(db, {
      ...completionInput,
      // Extra transport fields from an untrusted/internal JS caller cannot
      // replace reservation-owned metadata or the server acknowledgement time.
      objectKey: 'recordings/3/7/part999.webm',
      uploadedAt: '1999-01-01T00:00:00.000Z',
    }),
    {
      uploadId: 'upload-a',
      partIndex: 0,
      objectKey: reservation.objectKey,
      byteSize: 1234,
      already: true,
    },
  );

  const stored = raw.prepare(`
    SELECT p.object_key, p.byte_size, p.uploaded_at, r.completed_at
    FROM recording_parts p JOIN recording_upload_reservations r
      ON r.student_id = p.student_id AND r.part_index = p.part_index
    WHERE p.student_id = 7
  `).get();
  assert.equal(stored.object_key, reservation.objectKey);
  assert.equal(stored.byte_size, 1234);
  assert.equal(stored.uploaded_at, '2026-08-27T01:01:00.000Z');
  assert.equal(stored.completed_at, '2026-08-27T01:01:00.000Z');
});

test('PUT acknowledgement rejects invalid sizes and a revoked recording session', async () => {
  const db = sqliteExecutor(raw);
  const reservation = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'validated-ack',
    sessionId: 'session-a',
    useSqlite: true,
  });
  const base = {
    studentId: 7,
    batchId: 3,
    uploadId: reservation.uploadId,
    useSqlite: true,
    sessionId: 'session-a',
  };

  for (const byteSize of [0, 1.5, 2_147_483_648]) {
    await assert.rejects(
      persistence.acknowledgeReservedRecordingPart(db, { ...base, byteSize }),
      (error) => error?.code === 'INVALID_RECORDING_PART',
    );
  }
  raw.prepare("UPDATE students SET active_jti = 'session-b' WHERE id = 7").run();
  await assert.rejects(
    persistence.acknowledgeReservedRecordingPart(db, { ...base, byteSize: 1234 }),
    (error) => error?.code === 'NOT_IN_PROGRESS',
  );
  assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM recording_parts').get().count, 0);
});

test('different uploadIds cannot reserve or overwrite the same part index or key', async () => {
  const db = sqliteExecutor(raw);
  const first = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'upload-a',
    sessionId: 'session-a',
    useSqlite: true,
  });
  const second = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'upload-b',
    sessionId: 'session-a',
    useSqlite: true,
  });
  assert.notEqual(first.partIndex, second.partIndex);
  assert.notEqual(first.objectKey, second.objectKey);

  const completion = await persistence.acknowledgeReservedRecordingPart(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'upload-b',
    byteSize: 100,
    useSqlite: true,
    sessionId: 'session-a',
    // Deliberately ignored: the helper always commits upload-b's reservation.
    objectKey: first.objectKey,
  });
  assert.equal(completion.partIndex, second.partIndex);
  assert.equal(completion.objectKey, second.objectKey);
  const stored = raw.prepare(
    'SELECT part_index, object_key FROM recording_parts WHERE student_id = 7',
  ).get();
  assert.equal(stored.part_index, second.partIndex);
  assert.equal(stored.object_key, second.objectKey);
});

test('seal atomically reserves pending uploadIds, persists an exact manifest, and blocks new blobs', async () => {
  const db = sqliteExecutor(raw);
  const nowMs = Date.parse('2026-08-27T02:00:00.000Z');
  const first = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'already-reserved',
    sessionId: 'session-a',
    useSqlite: true,
    nowMs: nowMs - 1000,
  });
  await persistence.acknowledgeReservedRecordingPart(db, {
    studentId: 7,
    batchId: 3,
    uploadId: first.uploadId,
    byteSize: 100,
    useSqlite: true,
    sessionId: 'session-a',
    nowMs: nowMs - 500,
  });
  raw.prepare(`
    UPDATE students
    SET status = 'submitted', submitted_at = ?, recording_incomplete = TRUE
    WHERE id = 7
  `).run(new Date(nowMs).toISOString());

  const sealed = await persistence.sealRecordingManifest(db, {
    studentId: 7,
    batchId: 3,
    sessionId: 'session-a',
    parts: [
      { uploadId: 'pending-c', partIndex: 2 },
      { uploadId: 'pending-b', partIndex: 1 },
    ],
    useSqlite: true,
    nowMs: nowMs + 100,
  });
  assert.equal(sealed.already, false);
  assert.equal(sealed.state, 'processing');
  assert.equal(sealed.expectedPartCount, 3);
  assert.equal(sealed.completedPartCount, 1);
  assert.deepEqual(sealed.parts, [
    { uploadId: 'already-reserved', partIndex: 0, completed: true },
    { uploadId: 'pending-b', partIndex: 1, completed: false },
    { uploadId: 'pending-c', partIndex: 2, completed: false },
  ]);

  const stored = raw.prepare(`
    SELECT recording_manifest_sealed_at, recording_expected_part_count
    FROM students WHERE id = 7
  `).get();
  assert.ok(stored.recording_manifest_sealed_at);
  assert.equal(stored.recording_expected_part_count, 3);
  assert.deepEqual(await persistence.getRecordingRecoveryStatus(db, {
    studentId: 7,
    batchId: 3,
    useSqlite: true,
    nowMs: nowMs + 200,
  }), {
    state: 'processing',
    recordMode: 's3',
    expectedPartCount: 3,
    completedPartCount: 1,
    finalPartIndex: 2,
  });

  await assert.rejects(
    persistence.reserveRecordingUpload(db, {
      studentId: 7,
      batchId: 3,
      uploadId: 'late-blob',
      sessionId: 'session-a',
      useSqlite: true,
      nowMs: nowMs + 300,
    }),
    (error) => error?.code === 'MANIFEST_SEALED',
  );
  const replay = await persistence.sealRecordingManifest(db, {
    studentId: 7,
    batchId: 3,
    sessionId: 'session-a',
    parts: [
      { uploadId: 'pending-b', partIndex: 1 },
      { uploadId: 'pending-c', partIndex: 2 },
    ],
    useSqlite: true,
    nowMs: nowMs + 400,
  });
  assert.equal(replay.already, true);
  assert.equal(replay.expectedPartCount, 3);
});

test('local recording status is not required and cannot seal an S3 manifest', async () => {
  const db = sqliteExecutor(raw);
  raw.prepare("UPDATE batches SET record_mode = 'local', record_enabled = FALSE WHERE id = 3").run();
  assert.deepEqual(await persistence.getRecordingRecoveryStatus(db, {
    studentId: 7,
    batchId: 3,
    useSqlite: true,
  }), {
    state: 'not_required',
    recordMode: 'local',
    expectedPartCount: 0,
    completedPartCount: 0,
  });
  await assert.rejects(
    persistence.sealRecordingManifest(db, {
      studentId: 7,
      batchId: 3,
      sessionId: 'session-a',
      parts: [{ uploadId: 'local-part', partIndex: 0 }],
      useSqlite: true,
    }),
    (error) => error?.code === 'BAD_RECORD_MODE',
  );
});

test('attempt mode remains frozen when an admin changes the batch recording mode', async () => {
  const db = sqliteExecutor(raw);
  const nowMs = Date.parse('2026-08-27T02:00:00.000Z');

  raw.prepare("UPDATE students SET attempt_record_mode = 's3', status = 'submitted', submitted_at = ?, recording_incomplete = TRUE WHERE id = 7")
    .run(new Date(nowMs).toISOString());
  raw.prepare("UPDATE batches SET record_mode = 'local', record_enabled = FALSE WHERE id = 3").run();
  const sealed = await persistence.sealRecordingManifest(db, {
    studentId: 7,
    batchId: 3,
    sessionId: 'session-a',
    parts: [{ uploadId: 'frozen-s3-part', partIndex: 0 }],
    useSqlite: true,
    nowMs,
  });
  assert.equal(sealed.recordMode, 's3');

  raw.exec(`
    DELETE FROM recording_upload_reservations;
    UPDATE students
    SET attempt_record_mode = 'local', status = 'in_progress', submitted_at = NULL,
        recording_incomplete = FALSE, recording_manifest_sealed_at = NULL,
        recording_expected_part_count = NULL
    WHERE id = 7;
    UPDATE batches SET record_mode = 's3', record_enabled = TRUE WHERE id = 3;
  `);
  assert.deepEqual(await persistence.getRecordingRecoveryStatus(db, {
    studentId: 7,
    batchId: 3,
    useSqlite: true,
  }), {
    state: 'not_required',
    recordMode: 'local',
    expectedPartCount: 0,
    completedPartCount: 0,
  });
  await assert.rejects(
    persistence.reserveRecordingUpload(db, {
      studentId: 7,
      batchId: 3,
      uploadId: 'must-not-switch-to-s3',
      sessionId: 'session-a',
      useSqlite: true,
    }),
    (error) => error?.code === 'BAD_RECORD_MODE',
  );
});

test('recovery status and pending helpers lock the attempt before reading dependent tables on PostgreSQL', async () => {
  for (const helperName of ['status', 'pending']) {
    const queries = [];
    const executor = {
      async query(sql) {
        queries.push(sql);
        if (queries.length === 1) {
          return {
            rows: [{
              status: 'submitted',
              submitted_at: '2026-08-27T02:00:00.000Z',
              recording_incomplete: true,
              recording_finalized_at: null,
              recording_manifest_sealed_at: null,
              recording_expected_part_count: null,
              attempt_record_mode: 's3',
              record_mode: 'local',
              record_enabled: false,
            }],
            rowCount: 0,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    if (helperName === 'status') {
      await persistence.getRecordingRecoveryStatus(executor, {
        studentId: 7,
        batchId: 3,
        useSqlite: false,
        nowMs: Date.parse('2026-08-27T02:01:00.000Z'),
      });
    } else {
      await persistence.listPendingRecordingReservations(executor, {
        studentId: 7,
        batchId: 3,
        useSqlite: false,
        nowMs: Date.parse('2026-08-27T02:01:00.000Z'),
      });
    }
    assert.match(queries[0], /FOR UPDATE OF s/);
    assert.match(queries[1], /recording_upload_reservations/);
    assert.match(queries[2], /recording_parts/);
  }
});

test('a reset and new authenticated session cannot reuse a stale S3 object key', async () => {
  const db = sqliteExecutor(raw);
  const previousAttempt = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'same-browser-upload-id',
    sessionId: 'session-a',
    useSqlite: true,
  });

  // Mirrors reset cleanup followed by /verify minting a fresh backend jti.
  raw.prepare('DELETE FROM recording_upload_reservations WHERE student_id = 7').run();
  raw.prepare('DELETE FROM recording_parts WHERE student_id = 7').run();
  raw.prepare("UPDATE students SET active_jti = 'session-b' WHERE id = 7").run();

  await assert.rejects(
    persistence.reserveRecordingUpload(db, {
      studentId: 7,
      batchId: 3,
      uploadId: 'stale-request-after-reset',
      sessionId: 'session-a',
      useSqlite: true,
    }),
    (error) => error?.code === 'NOT_IN_PROGRESS',
  );

  const nextAttempt = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'same-browser-upload-id',
    sessionId: 'session-b',
    useSqlite: true,
  });
  assert.equal(previousAttempt.partIndex, 0);
  assert.equal(nextAttempt.partIndex, 0);
  assert.notEqual(nextAttempt.objectKey, previousAttempt.objectKey);

  await assert.rejects(
    persistence.acknowledgeReservedRecordingPart(db, {
      studentId: 7,
      batchId: 3,
      uploadId: nextAttempt.uploadId,
      byteSize: 100,
      useSqlite: true,
      sessionId: 'session-a',
    }),
    (error) => error?.code === 'NOT_IN_PROGRESS',
  );
  const nextCompletion = await persistence.acknowledgeReservedRecordingPart(db, {
    studentId: 7,
    batchId: 3,
    uploadId: nextAttempt.uploadId,
    byteSize: 100,
    useSqlite: true,
    sessionId: 'session-b',
    objectKey: previousAttempt.objectKey,
  });
  assert.equal(nextCompletion.objectKey, nextAttempt.objectKey);
});

test('one-sided reservation completion metadata fails closed', async () => {
  const db = sqliteExecutor(raw);
  const reservation = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'rolling-deploy-overlap',
    sessionId: 'session-a',
    useSqlite: true,
  });
  raw.prepare(`
    INSERT INTO recording_parts
      (student_id, batch_id, part_index, object_key, byte_size, uploaded_at)
    VALUES (7, 3, ?, ?, 100, ?)
  `).run(reservation.partIndex, reservation.objectKey, new Date().toISOString());

  await assert.rejects(
    persistence.findRecordingUploadReservation(db, 7, reservation.uploadId),
    (error) => error?.code === 'RECORDING_RESERVATION_CONFLICT',
  );

  const nowMs = Date.parse('2026-08-27T02:00:00.000Z');
  raw.prepare(`
    UPDATE students
    SET status = 'submitted', submitted_at = ?, recording_incomplete = TRUE,
        recording_manifest_sealed_at = ?, recording_expected_part_count = 1
    WHERE id = 7
  `).run(new Date(nowMs).toISOString(), new Date(nowMs).toISOString());
  await assert.rejects(
    persistence.finalizeRecordingManifest(db, {
      studentId: 7,
      batchId: 3,
      useSqlite: true,
      nowMs: nowMs + 1000,
    }),
    (error) => error?.code === 'RECORDING_RESERVATION_CONFLICT',
  );
});

test('expired in-progress deadline rejects new reservations but keeps completed replay idempotent', async () => {
  const db = sqliteExecutor(raw);
  const nowMs = Date.parse('2026-08-27T02:00:00.000Z');
  raw.prepare('UPDATE students SET exam_deadline = ? WHERE id = 7')
    .run('2026-08-27T02:05:00.000Z');
  const reservation = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'completed-upload',
    sessionId: 'session-a',
    useSqlite: true,
    nowMs,
  });
  await persistence.acknowledgeReservedRecordingPart(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'completed-upload',
    byteSize: 100,
    useSqlite: true,
    sessionId: 'session-a',
    nowMs: nowMs + 60_000,
  });
  raw.prepare('UPDATE students SET exam_deadline = ? WHERE id = 7')
    .run('2026-08-27T01:59:59.000Z');

  const replay = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'completed-upload',
    sessionId: 'session-a',
    useSqlite: true,
    nowMs,
  });
  assert.equal(replay.completed, true);
  assert.equal(replay.already, true);
  assert.equal(replay.partIndex, reservation.partIndex);

  await assert.rejects(
    persistence.reserveRecordingUpload(db, {
      studentId: 7,
      batchId: 3,
      uploadId: 'new-upload-after-deadline',
      sessionId: 'session-a',
      useSqlite: true,
      nowMs,
    }),
    (error) => error?.code === 'NOT_IN_PROGRESS',
  );
});

test('finalization derives its manifest from completed reservations without trusting a client index', async () => {
  const db = sqliteExecutor(raw);
  const nowMs = Date.parse('2026-08-27T03:00:00.000Z');
  const reservation = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'derived-manifest-upload',
    sessionId: 'session-a',
    useSqlite: true,
    nowMs,
  });
  await persistence.acknowledgeReservedRecordingPart(db, {
    studentId: 7,
    batchId: 3,
    uploadId: reservation.uploadId,
    byteSize: 512,
    useSqlite: true,
    sessionId: 'session-a',
    nowMs,
  });
  raw.prepare(`
    UPDATE students
    SET status = 'submitted', submitted_at = ?, recording_incomplete = TRUE
    WHERE id = 7
  `).run(new Date(nowMs).toISOString());

  const sealed = await persistence.sealRecordingManifest(db, {
    studentId: 7,
    batchId: 3,
    sessionId: 'session-a',
    parts: [],
    useSqlite: true,
    nowMs: nowMs + 500,
  });
  assert.equal(sealed.expectedPartCount, 1);

  assert.deepEqual(
    await persistence.finalizeRecordingManifest(db, {
      studentId: 7,
      batchId: 3,
      useSqlite: true,
      nowMs: nowMs + 1000,
    }),
    { already: false, finalPartIndex: 0 },
  );
  const student = raw.prepare(`
    SELECT recording_incomplete, recording_final_part_index
    FROM students WHERE id = 7
  `).get();
  assert.equal(student.recording_incomplete, 0);
  assert.equal(student.recording_final_part_index, 0);
  assert.deepEqual(await persistence.getRecordingRecoveryStatus(db, {
    studentId: 7,
    batchId: 3,
    useSqlite: true,
    nowMs: nowMs + 2000,
  }), {
    state: 'finalized',
    recordMode: 's3',
    expectedPartCount: 1,
    completedPartCount: 1,
    finalPartIndex: 0,
  }, 'a lost finalize response is recovered from durable server state');
});

test('a complete manifest cannot be finalized before answer submission', async () => {
  const db = sqliteExecutor(raw);
  const nowMs = Date.parse('2026-08-27T03:00:00.000Z');
  const reservation = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'early-finalize-upload',
    sessionId: 'session-a',
    useSqlite: true,
    nowMs,
  });
  await persistence.acknowledgeReservedRecordingPart(db, {
    studentId: 7,
    batchId: 3,
    uploadId: reservation.uploadId,
    byteSize: 512,
    useSqlite: true,
    sessionId: 'session-a',
    nowMs,
  });

  await assert.rejects(
    persistence.finalizeRecordingManifest(db, {
      studentId: 7,
      batchId: 3,
      useSqlite: true,
      nowMs: nowMs + 1000,
    }),
    (error) => error?.code === 'MANIFEST_NOT_SEALED',
  );
  const state = raw.prepare(`
    SELECT status, recording_finalized_at, recording_final_part_index
    FROM students WHERE id = 7
  `).get();
  assert.equal(state.status, 'in_progress');
  assert.equal(state.recording_finalized_at, null);
  assert.equal(state.recording_final_part_index, null);
});

test('an orphaned reservation blocks finalization instead of silently omitting evidence', async () => {
  const db = sqliteExecutor(raw);
  const nowMs = Date.parse('2026-08-27T03:00:00.000Z');
  await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'orphaned-upload',
    sessionId: 'session-a',
    useSqlite: true,
    nowMs,
  });
  raw.prepare(`
    UPDATE students
    SET status = 'submitted', submitted_at = ?, recording_incomplete = TRUE
    WHERE id = 7
  `).run(new Date(nowMs).toISOString());

  await persistence.sealRecordingManifest(db, {
    studentId: 7,
    batchId: 3,
    sessionId: 'session-a',
    parts: [],
    useSqlite: true,
    nowMs: nowMs + 500,
  });

  await assert.rejects(
    persistence.finalizeRecordingManifest(db, {
      studentId: 7,
      batchId: 3,
      useSqlite: true,
      nowMs: nowMs + 1000,
    }),
    (error) => error?.code === 'RECORDING_INCOMPLETE',
  );
});

test('a fully acknowledged sealed manifest can finalize after the write grace expires', async () => {
  const db = sqliteExecutor(raw);
  const submittedAt = Date.parse('2026-08-27T03:00:00.000Z');
  const reservation = await persistence.reserveRecordingUpload(db, {
    studentId: 7,
    batchId: 3,
    uploadId: 'late-db-finalize',
    sessionId: 'session-a',
    useSqlite: true,
    nowMs: submittedAt - 1000,
  });
  await persistence.acknowledgeReservedRecordingPart(db, {
    studentId: 7,
    batchId: 3,
    uploadId: reservation.uploadId,
    byteSize: 512,
    useSqlite: true,
    sessionId: 'session-a',
    nowMs: submittedAt - 500,
  });
  raw.prepare(`
    UPDATE students
    SET status = 'submitted', submitted_at = ?, recording_incomplete = TRUE
    WHERE id = 7
  `).run(new Date(submittedAt).toISOString());
  await persistence.sealRecordingManifest(db, {
    studentId: 7,
    batchId: 3,
    sessionId: 'session-a',
    parts: [{ uploadId: reservation.uploadId, partIndex: reservation.partIndex }],
    useSqlite: true,
    nowMs: submittedAt + 1000,
  });
  const afterGrace = submittedAt + persistence.SUBMITTED_RECORDING_GRACE_MS + 1000;

  assert.equal((await persistence.getRecordingRecoveryStatus(db, {
    studentId: 7,
    batchId: 3,
    useSqlite: true,
    nowMs: afterGrace,
  })).state, 'processing');
  assert.deepEqual(await persistence.finalizeRecordingManifest(db, {
    studentId: 7,
    batchId: 3,
    useSqlite: true,
    nowMs: afterGrace,
  }), { already: false, finalPartIndex: 0 });
});

test('same-manifest finalization replay succeeds even after submission grace has expired', async () => {
  let queries = 0;
  const tx = {
    async query(text) {
      queries += 1;
      assert.match(text, /^SELECT s\.status/);
      return {
        rows: [{
          status: 'submitted',
          submitted_at: '2026-08-01T00:00:00.000Z',
          recording_incomplete: 0,
          recording_finalized_at: '2026-08-01T00:01:00.000Z',
          recording_final_part_index: 2,
          record_mode: 's3',
        }],
        rowCount: 0,
      };
    },
  };

  assert.deepEqual(
    await persistence.finalizeRecordingManifest(tx, {
      studentId: 7,
      batchId: 3,
      finalPartIndex: 2,
      useSqlite: true,
      nowMs: Date.parse('2026-08-27T00:00:00.000Z'),
    }),
    { already: true, finalPartIndex: 2 },
  );
  assert.equal(queries, 1, 'a replay must not revalidate or rewrite the completed manifest');
});

test('a finalized recording rejects a retry carrying a different manifest', () => {
  const decision = persistence.decideRecordingFinalization(
    {
      status: 'submitted',
      submitted_at: '2026-08-01T00:00:00.000Z',
      recording_incomplete: 0,
      recording_finalized_at: '2026-08-01T00:01:00.000Z',
      recording_final_part_index: 2,
      record_mode: 's3',
    },
    3,
    Date.parse('2026-08-27T00:00:00.000Z'),
  );

  assert.equal(decision.action, 'reject');
  assert.equal(decision.code, 'MANIFEST_CONFLICT');
});

test('recording writes expire but DB-only finalization remains eligible after the grace period', () => {
  const submittedAt = Date.parse('2026-08-27T01:00:00.000Z');
  const row = {
    status: 'submitted',
    submitted_at: new Date(submittedAt).toISOString(),
    recording_incomplete: 1,
    recording_finalized_at: null,
    recording_final_part_index: null,
    recording_manifest_sealed_at: new Date(submittedAt + 1).toISOString(),
    recording_expected_part_count: 1,
    record_mode: 's3',
  };

  assert.equal(
    persistence.acceptsRecordingWrites(
      row,
      submittedAt + persistence.SUBMITTED_RECORDING_GRACE_MS,
    ),
    true,
    'the exact grace boundary remains accepted',
  );
  assert.equal(
    persistence.acceptsRecordingWrites(row, submittedAt + 16.5 * 60_000),
    true,
    'the window must exceed one worst-case bounded client retry pipeline',
  );
  const expired = persistence.decideRecordingFinalization(
    row,
    0,
    submittedAt + persistence.SUBMITTED_RECORDING_GRACE_MS + 1,
  );
  assert.equal(expired.action, 'finalize');
});

test('PostgreSQL timestamp-without-timezone Date values are interpreted as UTC wall-clock time', () => {
  // node-postgres creates this Date in the Node process timezone for OID 1114.
  const pgParsedDate = new Date(2026, 7, 27, 1, 0, 0, 0);
  const submittedAtUtc = Date.UTC(2026, 7, 27, 1, 0, 0, 0);

  assert.equal(
    persistence.timestampWithoutTimezoneUtcMs(pgParsedDate),
    submittedAtUtc,
  );
  assert.equal(
    persistence.isWithinSubmittedRecordingGrace({
      status: 'submitted',
      submitted_at: pgParsedDate,
      recording_incomplete: 1,
    }, submittedAtUtc + 60_000),
    true,
  );
});

test('an inspected part is rechecked under the manifest lock before it is committed', async () => {
  raw.prepare(`
    UPDATE students
    SET status = 'submitted', submitted_at = ?, recording_incomplete = 0,
        recording_finalized_at = ?, recording_final_part_index = 0
    WHERE id = 7
  `).run('2026-08-27T01:00:00.000Z', '2026-08-27T01:01:00.000Z');

  await assert.rejects(
    persistence.commitInspectedRecordingPart(sqliteExecutor(raw), {
      studentId: 7,
      batchId: 3,
      partIndex: 1,
      objectKey: 'recordings/3/7/part001.webm',
      byteSize: 1234,
      uploadedAt: '2026-08-27T01:01:00.000Z',
      useSqlite: true,
      nowMs: Date.parse('2026-08-27T01:02:00.000Z'),
    }),
    (error) => error?.code === 'NOT_IN_PROGRESS',
  );
  assert.equal(raw.prepare('SELECT COUNT(*) AS count FROM recording_parts').get().count, 0);
});
