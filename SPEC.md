# E-Audit Platform — Technical Specification

**Version:** 2.0

**Last Updated:** 2026-08-16
**Basis:** current TypeScript/React source, migrations and runtime configuration

## 1. System architecture

```text
React 18 + Vite SPA
        │ /api, Axios JWT interceptors
        ▼
Express 4 + TypeScript
  ├─ /api/admin   admin/mod JWT
  ├─ /api/student student JWT + active jti
  ├─ readiness/operations
  ├─ durable AI queue
  └─ S3 presigning + HeadObject verification
        │
        ├─ SQLite/better-sqlite3 (DATABASE_URL absent)
        └─ PostgreSQL/Supabase (DATABASE_URL present)
```

Source of truth:

- Frontend: `client/src/**`.
- Backend: `src/**`.
- Production schema changes: `migrations/**`.
- Generated/legacy paths: `client/dist/**`, `dist/**`, `public/**`, root `server/**`, `index.js`.

Runtime entry points:

- Local backend: `src/server/server.ts`, port 3001.
- Vite: port 5173, `/api` proxy to 3001.
- Vercel: `dist/server/index.js` for `/api/*`; `client/dist/**` for SPA.
- VPS: generated Docker multi-stage build, Caddy HTTPS and Compose from `deploy-vps.sh`.

## 2. Technology and build

| Area | Current implementation |
|---|---|
| Runtime | Node.js `20.x || 22.x || 24.x` |
| Backend | Express, TypeScript, `pg`, `better-sqlite3` |
| Frontend | React 18, Vite 6, React Router 7, Tailwind 4 + global CSS |
| Editor | Monaco via `@monaco-editor/react` |
| Auth | `jsonwebtoken`, `bcryptjs` |
| Excel | SheetJS `xlsx@0.20.3` official tarball, Multer memory storage |
| AI | Gemini SDK plus OpenAI-compatible/fetch integrations |
| Recording | MediaRecorder, File System Access, zip.js AES-256, AWS SDK S3 |
| Tests | Node test runner; SQLite/default suite + optional PostgreSQL integration |

Commands:

```bash
npm run dev
npm run build
npm test
npm run test:postgres
cd client && npm run dev
```

There is no lint script. Backend/frontend type-checks are `npx tsc --noEmit` in their respective directories.

## 3. Database selection and readiness

`DATABASE_URL` is the active switch:

- absent → SQLite at `data/eaudit.db`, WAL mode;
- present → PostgreSQL with SSL, default pool min 0/max 4.

`dbReady` performs initialize + `verifyRequiredSchema()`. `startupReady` then initializes cache/queue state. Local server does not listen until ready; serverless routes await the same promise. `/api/health` returns:

- `503 not_ready` while pending;
- `503 degraded` on startup/schema error;
- `200 {status:'ok',db:'ready'}` only when DB/schema/cache are ready.

PostgreSQL readiness checks required columns and the actual definitions of unique indexes, including partial predicate correctness.

## 4. Database schema

SQLite uses INTEGER booleans and TEXT JSON; PostgreSQL uses BOOLEAN/JSONB where defined. The logical schema is:

### `question_bank`

| Column | Notes |
|---|---|
| `id VARCHAR(50)` | PK, case-sensitive semantics |
| `type` | Coding, Conceptual, Fill-in, Debug, SingleChoice, MultipleChoice |
| `level` | Easy, Medium, Hard |
| `module`, `question_sample` | required |
| `rubric_must_have`, `rubric_nice_to_have`, `rubric_optional` | required strings |
| `options TEXT` | quiz JSON `[{key,text}]` |
| `correct_answers TEXT` | quiz JSON key array; never returned to candidate |
| `score REAL` | quiz points, default 1 |
| `uploaded_by` | owner id, nullable legacy rows |
| timestamps | created/updated |

### `batches`

| Column | Notes |
|---|---|
| `id`, `name`, `start_time`, `end_time`, `duration` | core schedule |
| `blueprint` | legacy array or `{blueprintMode,items}` |
| `record_enabled` | legacy compatibility; true only for `s3` |
| `record_mode` | `none`, `local`, `s3`; source of truth |
| `exam_type` | `essay` or `quiz` |
| `ai_grading_enabled` | explicit per-batch essay grading switch |
| `created_by` | owner id |
| `created_at` | timestamp |

### `students`

| Column group | Columns |
|---|---|
| Identity | `id`, `batch_id`, `email`, `access_code` (VARCHAR(8), unique in production) |
| Lifecycle | `status`, `exam_started_at`, `exam_deadline`, `disconnected_at` |
| Session | `active_jti` |
| Submit | `submitted_at`, `submit_reason` |
| Recording | `recording_password`, `recording_finalized_at`, `recording_final_part_index`, `recording_incomplete` |
| Audit | `created_at` |

### `exam_questions`

`id`, `student_id`, `question_id`, `question_order`, `option_order`, `answer`, `ai_score`, `ai_feedback`, `trainer_score`, `trainer_feedback`, `created_at`.

Required unique key: `(student_id, question_order)`.

### Integrity, forensic and recording tables

- `violations`: unique `(student_id,type)`, running `count`.
- `violation_events`: one occurrence with `batch_id`, type, `text_length`, preview ≤500, `question_id`, `metadata_json` ≤2000, client `event_id` ≤64, timestamp. Partial unique `(student_id,event_id) WHERE event_id IS NOT NULL`.
- `recording_parts`: unique `(student_id,part_index)`, object key, bytes, uploaded time, `is_final`.
- `exam_sessions`: unique `(student_id,jti,ip)`, batch, UA, first/last seen; indexes by student and `(student,last_seen)`.

### AI/admin tables

- `ai_queue`: deterministic `id=exam_question_id`, student id, status (`pending|processing|completed|failed|cancelled`), attempts, error and timestamps.
- `ai_settings`: id 1, provider, API key/base URL value, model, temperature, maxTokens, `worker_enabled`.
- `admin_users`: username unique, bcrypt hash, role (`admin|mod`), timestamps.

## 5. Authentication and authorization

### Admin

- Public: `is-initialized`, `setup`, `login`, `logout`.
- Login token payload `{id,username,role}`, expiry 24h.
- All following admin routes use `authMiddleware`.
- `requireAdmin` protects user management.
- Backend ownership checks protect mod edits/deletes of questions and batches.
- Mod create forces `record_mode='none'`; mod update preserves the stored mode.

### Student

- `/verify` signs `{studentId,batchId,jti}` for 4h and stores `active_jti`.
- `studentAuthMiddleware` verifies signature, payload, jti presence and equality with DB.
- Identity always comes from JWT, never `x-student-id` or request-body student id.
- Disconnect beacon may send `student_token` in JSON body because `sendBeacon` cannot set Authorization.
- A new verify invalidates the previous token for that student row.

## 6. API specification

All paths below are prefixed `/api`. Protected admin routes require admin bearer JWT; protected student routes require student bearer JWT unless beacon body-token is noted.

### 6.1 Admin auth/users

| Method | Path | Behavior |
|---|---|---|
| GET | `/admin/is-initialized` | public initialization state |
| POST | `/admin/setup` | first admin only; 5/hour/IP; password ≥8 |
| POST | `/admin/login` | 10/min/IP; returns token/expiry/role/userId |
| POST | `/admin/logout` | stateless acknowledgement |
| GET/POST | `/admin/users` | admin-only list/create |
| DELETE | `/admin/users/:id` | admin-only; cannot self-delete |
| PUT | `/admin/change-password` | current password + new password ≥8 |

User creation requires a password of at least 6 characters; first-admin setup and password changes require at least 8.

### 6.2 Questions

| Method | Path | Behavior |
|---|---|---|
| POST | `/admin/questions/import` | essay Excel upsert, ≤5 MiB |
| POST | `/admin/questions/quiz/import` | quiz Excel upsert, ≤5 MiB |
| GET | `/admin/questions/paged` | page/pageSize 10,25,50; module/category filters |
| GET | `/admin/questions/catalog-summary` | one aggregate response for modules/stats |
| GET | `/admin/questions/check-id?id=` | validates/trims ID and availability |
| GET | `/admin/questions` | legacy full list |
| POST | `/admin/questions` | manual create, 201; duplicate 409 |
| GET | `/admin/questions/:id` | editable detail; ownership enforced |
| PUT | `/admin/questions/:id` | validated update; ID immutable |
| DELETE | `/admin/questions/:id` | ownership enforced |
| POST | `/admin/questions/bulk-delete` | ownership enforced for entire set |
| GET | `/admin/questions/modules` | legacy module list |
| GET | `/admin/questions/module-stats` | counts by module/level |
| GET | `/admin/questions/type-stats` | counts by type/level |
| GET | `/admin/questions/module-type-stats` | counts by module/type/level |

Static `/questions/*` routes must remain before dynamic `/:id`.

### 6.3 Batches/candidates

| Method | Path | Behavior |
|---|---|---|
| POST | `/admin/batches` | create; blueprint total 1–100 |
| GET | `/admin/batches` | full batch list + student counts |
| GET/PUT/DELETE | `/admin/batches/:id` | detail/update/delete; ownership rules |
| POST | `/admin/batches/:id/check-feasibility` | inventory comparison |
| GET | `/admin/test-blueprint/:id` | protected legacy/debug blueprint assignment output |
| POST | `/admin/batches/:id/students/import` | emails → 8-char codes |
| GET | `/admin/batches/:id/students` | candidate list |
| GET | `/admin/batches/:id/students/export` | XLSX email/code |
| DELETE | `/admin/students/:id` | delete candidate attempt |
| POST | `/admin/students/:studentId/reset` | reopen with `duration_minutes` 1–480 |

### 6.4 Results and AI settings

| Method | Path | Behavior |
|---|---|---|
| GET | `/admin/batches/:id/results/summary` | paged 10/25/50 summary |
| GET | `/admin/students/:studentId/result-detail` | lazy questions/events/parts |
| GET | `/admin/batches/:id/results` | legacy full response |
| PUT | `/admin/results/:studentId` | apply trainer score/feedback to all student questions |
| GET | `/admin/batches/:id/results/export` | XLSX, one sheet/student |
| GET/POST | `/admin/settings/ai` | read/upsert provider + worker switch |
| POST | `/admin/settings/ai/test` | full connection test only for Gemini; other providers return guidance/stub text |

### 6.5 Student exam

| Method | Path | Behavior |
|---|---|---|
| POST | `/student/verify` | 60/min/IP; access code → token/context |
| POST | `/student/select-email` | legacy unauthenticated endpoint; unused by current UI |
| POST | `/student/exam/start` | atomic start/resume |
| GET | `/student/exam/questions` | questions + server time; timer/disconnect/concurrency guards |
| POST | `/student/exam/answers` | batch persistence, max 100 answers |
| POST | `/student/exam/answer` | single compatibility persistence |
| POST | `/student/exam/submit` | idempotent transactional submit with full answers |
| POST | `/student/exam/disconnect` | 204 beacon; body token accepted |
| POST | `/student/exam/flush` | legacy buffer flush |
| POST | `/student/violation` | idempotent forensic/counter transaction |
| POST | `/student/exam/recording-url` | presigned S3 PUT URL |
| POST | `/student/exam/recording-complete` | HeadObject + metadata insert |
| POST | `/student/exam/recording-finalize` | contiguous manifest validation |

Common terminal responses use HTTP 410 with `reason` such as `submitted`, `timeout`, `absent_too_long`, or `concurrent_session`.

### 6.6 Operations

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | public readiness |
| GET | `/test-db` | admin JWT |
| GET | `/queue/process?limit=1..5` | admin JWT or exact `CRON_SECRET` bearer |
| GET | `/queue/stats` | admin JWT |
| POST | `/cache/flush` | admin JWT |
| GET | `/stats` | admin JWT |

## 7. Exam state machine

```text
pending --start--> in_progress --submit/guard/lock--> submitted
                         ^
                         └── admin reopen (preserve questions/answers, clear scores/session/evidence metadata)
```

Start transaction:

1. Load/lock student and validate schedule/status.
2. Resume if `in_progress` with assigned questions.
3. Otherwise delete stale assignment, parse blueprint, filter by exam type, random-pick and shuffle.
4. Persist questions/option order.
5. Set deadline to `min(now+duration,batch.end)`.

Submit transaction:

1. Lock student; return `already=true` when submitted.
2. Validate/persist supplied answers.
3. Change status, timestamp/reason and recording-incomplete state.
4. Bulk enqueue essay jobs only when enabled.
5. After commit, score quiz idempotently.

## 8. Anti-cheat specification

### Counter policy

- Client whitelist is defined in `violationPolicy.ts`; `concurrent_session` is server-owned.
- `persistViolation()` inserts event, conditionally upserts counter, and reads totals in one transaction.
- PostgreSQL locks the student row so simultaneous different-type events cannot both see total 1.
- Forensic-only set: `suspicious_paste`, `rapid_text_insertion`, `multiple_display_detected`, `concurrent_session`.
- Lock: non-forensic `recording_stopped`, or current count ≥2, or lockable total ≥2.
- Client `event_id` is stable across five exponential-backoff retries; replays do not increment.

### Browser detectors

| Detector | Parameters |
|---|---|
| Fullscreen exit | 5s first report + 5s second; 1s watchdog |
| Focus loss | blur/focus, 3s grace |
| Side panel | document width shrink >80px, 2×1500ms polls, max 2 reports |
| Single insertion | ≥300 chars/change; exact registered suggestions allowed; unmatched undo |
| Rapid insertion | ≥300 chars in 2500ms, max single <300, 10s telemetry cooldown |
| Multiple display | fail-closed preflight; 3s mid-exam polling |
| Watermark | email/SID/time; refresh/position shift 15s |

Clipboard commands/actions and drag/drop are overridden in Monaco. Shortcut/screenshot interception is best effort.

### Concurrent sessions

- Tracker upserts `(student,jti,ip)` on questions, both answer routes and violation.
- Evidence window 60s; different-IP `last_seen` difference <10s is overlap.
- Multiple IP/UA/jti without overlap logs evidence only.
- Overlap invokes server-owned submit reason `concurrent_session`, bypassing counters.
- In-process forensic fingerprint dedupe interval: 60s.

## 9. Recording specification

- Recorder singleton survives `/confirm -> /exam`, but not F5.
- Whole-monitor only; Chrome/Edge desktop; `local` additionally requires directory picker.
- Part interval 5 minutes; timeslice 1 second; VP9/VP8; 5 fps; 600 kbps.
- S3 retry: initial attempt plus up to 5 retries with exponential backoff.
- Presigned URL expiry: 15 minutes.
- Object key: `recordings/{batchId}/{studentId}/partNNN.webm`.
- Completion ignores client byte claim and uses S3 ContentLength.
- Finalize accepts index 0–1000 and requires every part from zero.
- Submitted/incomplete attempts get 15-minute recording-only grace.
- Local file: `exam_{timestamp}_partNNN.zip`, AES-256, compression level 0.

## 10. Queue/grading specification

- Production/Vercel loads pending jobs from DB; local non-production can also load a file queue at `data/queue.json`.
- `src/server/cache.ts` is active orchestration. `src/ai/queue.ts` is legacy and must not be treated as current behavior.
- Vercel disables process-local queue intervals; `vercel.json` cron calls `/api/queue/process` daily at `02:00 UTC` and processes at most 5 jobs/call.
- Self-host/non-Vercel interval defaults to 10 seconds.
- Worker cancellation and claim both re-check `batches.ai_grading_enabled` in SQL.
- Stale `processing` rows older than `AI_QUEUE_STALE_MS` return to pending.
- AI JSON parsing extracts the first object-like block; after 3 failed attempts score becomes 0 with failure feedback.

## 11. Security and limits

- Global rate limit: 1200/min/IP; request body: 10 MiB.
- CORS allowlist default `http://localhost:5173`.
- Security headers: CSP, nosniff, DENY frame, no-referrer, Permissions-Policy, production HSTS.
- Monaco requires CSP `'unsafe-eval'` and blob workers.
- Excel upload: 5 MiB, one file, memory storage.
- Answer: 100.000 chars each; batch: max 100 answers.
- Blueprint: 1–100 questions; reset duration: 1–480 minutes.

## 12. Environment variables

| Variable | Default/requirement |
|---|---|
| `JWT_SECRET` | required at startup |
| `DATABASE_URL` | absent = SQLite |
| `PORT` | 3001 |
| `ALLOWED_ORIGINS` | `http://localhost:5173` |
| `SESSION_SECRET` | `secret`; must override production |
| `CRON_SECRET` | required for Vercel cron auth |
| `SKIP_TIME_CHECK` | `true` bypasses schedule |
| `DB_POOL_MIN`, `DB_POOL_MAX` | 0, 4 |
| `DB_CONNECT_TIMEOUT_MS`, `DB_CONNECT_ATTEMPTS` | 15000, 2 |
| `STATEMENT_TIMEOUT` | `30s` |
| `QUEUE_PROCESS_INTERVAL` | 10000, non-Vercel only |
| `AI_QUEUE_STALE_MS` | 900000 |
| `ANSWER_FLUSH_INTERVAL` | 5000, legacy buffer only |
| `ADMIN_PERF_LOGS`, `ADMIN_SLOW_REQUEST_MS` | off, 1000 |
| `GEMINI_API_KEY` | fallback when DB settings absent |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT` | Azure only |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_RECORDINGS_BUCKET` | S3 mode |

`JWT_EXPIRES_IN` is documented in older files but current login code hard-codes 24h; changing the env alone has no effect.

## 13. Migrations and tests

Production migration order:

1. `20260808_mac_exam_hardening.sql`
2. `20260809_concurrent_session_detection.sql`
3. `20260810_free_tier_exam_integrity.sql`
4. `20260810_violation_event_idempotency.sql`
5. `20260813_ai_grading_controls.sql`
6. `20260813_admin_query_performance.sql`

`npm test` uses default discovery and skips PostgreSQL-only tests without `TEST_DATABASE_URL`. Verified on 2026-08-16: 57 total, 51 pass, 6 skip. `npm run test:postgres` requires a separate non-production PostgreSQL URL and runs six integration cases in temporary schema `test_violation`. Root and client `npm audit --omit=dev` both reported zero production vulnerabilities on the same date.

## 14. Known implementation notes

- `/student/select-email`, `/student/exam/flush`, legacy full question/result endpoints and `src/ai/queue.ts` remain for compatibility but are not primary UI paths.
- `/exam/start` contains unreachable legacy code after an early return; reason from the atomic implementation, not that block.
- Batch listing/dashboard pagination is client-side because `/admin/batches` still returns the full list.
- Recording reset deletes DB metadata but not S3 objects; lifecycle policy handles stale objects.
- `deploy-vps.sh` resets the `admin` account password to hard-coded `admin321` on every run and hard-cleans `/opt/e-proc/app`; fix/accept that bootstrap behavior before production use and keep mutable runtime data outside the checkout.
- Client/browser controls can be bypassed by a sufficiently controlled environment; high-stakes use still needs evidence review and procedural controls.
