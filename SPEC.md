# E-Audit Platform — Technical Specification

**Version:** 2.2

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
  ├─ creator-triggered manual AI grading
  └─ S3 PutObject-only presigning + client PUT-2xx acknowledgement
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
- Local Docker gate: `docker-compose.local.yml` runs exactly `app` and Supabase PostgreSQL `database`; `SERVE_STATIC=true` serves the built `client/dist`, and `DATABASE_SSL=false` is local-only.
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
| AI | Fetch-based adapters for OpenAI Chat/Responses, Anthropic Messages, Gemini Generate Content and Ollama Generate |
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

`ensureDatabaseReady()` performs initialize + `verifyRequiredSchema()` through a single-flight readiness controller; `ensureStartupReady()` then initializes cache state. A transient connection/network timeout closes the failed pool, waits with bounded exponential backoff, and can recover on a later request in the same Vercel instance. Schema/auth/config failures remain blocked. Local server retries transient failures before listening; serverless routes share the current attempt. `/api/health` returns:

- `503 not_ready` while initializing or waiting to retry;
- `503 degraded` on permanent schema/auth/config error;
- `200 {status:'ok',db:'ready'}` only when DB/schema/cache are ready.

PostgreSQL readiness checks required columns and the actual definitions of unique indexes, including partial predicate correctness.

Production PostgreSQL uses `app_schema_state` plus batched schema verification and does not execute runtime DDL. Explicit runtime bootstrap is limited to local/fresh databases; SQLite still initializes its local schema directly.

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
| `live_enabled` | boolean, default `false`; requires capture-only Live for `record_mode='none'` |
| `exam_type` | `essay` or `quiz` |
| `ai_grading_status` | `idle`, `processing`, `partial`, or `completed` |
| `ai_grading_started_at`, `ai_graded_at` | manual run timestamps |
| `created_by` | owner id |
| `created_at` | timestamp |

### `students`

| Column group | Columns |
|---|---|
| Identity | `id`, `batch_id`, `email`, `access_code` (VARCHAR(8), unique in production) |
| Lifecycle | `status`, `exam_started_at`, `exam_deadline`, `disconnected_at` |
| Session | `active_jti` |
| Submit | `submitted_at`, `submit_reason` |
| Recording | `recording_password`, `attempt_record_mode`, `recording_finalized_at`, `recording_final_part_index`, `recording_incomplete`, `recording_manifest_sealed_at`, `recording_expected_part_count` |
| AI grading | `ai_final_score`, `ai_summary_feedback`, `ai_grading_status`, `ai_grading_error`, `ai_graded_at`, `ai_grading_started_at`, `ai_grading_attempt_token` |
| AI grading | `ai_final_score`, `ai_summary_feedback`, `ai_grading_status`, `ai_grading_error`, `ai_graded_at` |
| Audit | `created_at` |

### `exam_questions`

`id`, `student_id`, `question_id`, `question_order`, `option_order`, `answer`, `ai_score`, `ai_feedback`, `trainer_score`, `trainer_feedback`, `created_at`.

Required unique key: `(student_id, question_order)`.

### Integrity, forensic and recording tables

- `violations`: unique `(student_id,type)`, running `count`.
- `violation_events`: one occurrence with `batch_id`, type, `text_length`, preview ≤500, `question_id`, `metadata_json` ≤2000, client `event_id` ≤64, timestamp. Partial unique `(student_id,event_id) WHERE event_id IS NOT NULL`.
- `recording_parts`: unique `(student_id,part_index)`, object key, bytes, uploaded time, `is_final`.
- `recording_upload_reservations`: stable logical `upload_id`, server-assigned part/key and completion marker; unique `(student_id,upload_id)` and `(student_id,part_index)`.
- `exam_sessions`: unique `(student_id,jti,ip)`, batch, UA, first/last seen; indexes by student and `(student,last_seen)`.

### AI/admin tables

- `user_ai_settings`: one row per `user_id`; provider label, `api_protocol`, Base URL, AES-256-GCM encrypted API key/IV/auth tag/version/mask, model, test status/config hash/timestamps. Plaintext secret is never returned by API.
- `admin_users`: username unique, bcrypt hash, role (`admin|mod`), timestamps.
- `app_schema_state`: aggregate runtime schema contract version; current Live/capture-only schema is version 6.
- `schema_migrations`: deploy-vps ledger keyed by migration filename.

## 5. Authentication and authorization

### Admin

- Public: `is-initialized`, `setup`, `login`, `logout`.
- Login token payload `{id,username,role}`, expiry 24h.
- All following admin routes use `authMiddleware`.
- `requireAdmin` protects user management.
- Backend ownership checks protect mod edits/deletes of questions and batches.
- Mod create forces `record_mode='none'`; mod update preserves the stored mode.
- Each admin/mod owns one LLM setting. Only exact `batches.created_by` may call manual AI Grade; role `admin` does not bypass this rule. Create/Update Batch has no active AI fields.
- User deletion is rejected while that user owns any batch. Otherwise the owned AI setting and account are deleted in one transaction.

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
| PUT | `/admin/users/:id/password` | admin-only reset; new password ≥8 |
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
| POST | `/admin/batches/:id/ai-grade` | creator-only manual grading of submitted students |
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
| GET | `/admin/settings/ai` | return only the current user's non-secret setting fields/mask/test status |
| POST | `/admin/settings/ai/test` | test draft provider/protocol/Base URL/key/model; returns short-lived config-bound test token |
| PUT | `/admin/settings/ai` | save only after valid Test Connection token; encrypt API key |
| POST | `/admin/batches/:batchId/students/:studentId/ai-grade` | creator-only initial grade, retry or safe regrade for one submitted student |

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
| POST | `/student/exam/recording-complete` | persist PUT-2xx acknowledgement against canonical reservation |
| POST | `/student/exam/recording-seal` | persist the exact logical upload manifest after answer submission |
| GET | `/student/exam/recording-status` | return durable finalization state and part counts |
| POST | `/student/exam/recording-reconcile` | DB-only finalize when every sealed reservation is acknowledged |
| POST | `/student/exam/recording-finalize` | contiguous manifest validation |

Common terminal responses use HTTP 410 with `reason` such as `submitted`, `timeout`, `absent_too_long`, or `concurrent_session`.

### 6.6 Operations

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | public readiness |
| GET | `/test-db` | admin JWT |
| POST | `/cache/flush` | admin JWT |

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
4. Commit without enqueueing essay AI work.
5. After commit, score quiz idempotently. Essay grading is a separate creator-triggered route.

Manual submit supplies the full browser answer map to step 2. Server-owned timeout/violation/concurrent-session calls do not have access to unsent browser state and persist only answers already received. If the process dies after step 4 but before quiz scoring completes, a later idempotent submit/finalization call can repair quiz scores.

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
- S3 retry: up to 5 total attempts per stage with exponential backoff.
- Presigned URL expiry: 15 minutes.
- Object key: `recordings/{batchId}/{studentId}/session-{hash(activeJti)}/partNNN.webm`.
- Completion accepts the byte size reported only after browser-observed PUT 2xx, but derives object key/index exclusively from the authenticated server reservation.
- Submit releases capture, then seals the exact upload-ID manifest before SPA handoff; upload/finalize continues on `/submit`.
- Finalize derives the authoritative highest index from the sealed durable manifest and requires every part from zero.
- The PUT-2xx acknowledgement is written to attempt-scoped `sessionStorage` before `/recording-complete`; lost completion responses/reloads replay it without another PUT, while ambiguous/failed PUT responses are re-uploaded and never acknowledged. Status/reconcile are database-only.
- PutObject-only cannot independently prove object existence from the backend. For server-authoritative verification without `GetObject`/`ListBucket`, consume trusted S3 ObjectCreated events.
- Submitted/incomplete attempts get 60-minute recording-only grace.
- Local file: `exam_{timestamp}_partNNN.zip`, AES-256, compression level 0.

## 10. Manual AI grading specification

### AI Settings

- `GET/POST test/PUT /admin/settings/ai` always scopes data to `req.adminUser.id`; one user cannot read or reuse another user's plaintext secret.
- Supported `api_protocol` values: `openai_chat`, `openai_responses`, `anthropic_messages`, `gemini_generate_content`, `ollama_generate`.
- Provider label, Base URL and model are user-editable. API key is required except for Ollama protocol.
- Test Connection calls the actual endpoint with a 20-second timeout and returns a JWT valid for 10 minutes, bound to user id plus exact normalized config fingerprint. Any config change requires testing again.
- Save encrypts with AES-256-GCM using `AI_SETTINGS_ENCRYPTION_KEY`; GET returns only `keyMask` and `hasApiKey`.
- Production requires HTTPS, rejects URL credentials, localhost/private resolved addresses, follows no redirects, caps response at 1 MB and hides provider response bodies from errors.

### Batch invocation

- Create/edit does not read, validate or write manual AI settings/flags; an essay batch can be created before its creator configures an LLM.
- Batches List shows **AI Grade** only when `exam_type='essay'`, current user is creator, and the user's current setting is verified. Existing essay batches become eligible automatically after verification.
- One button click creates one inbound request to `/admin/batches/:id/ai-grade`. Submit, startup and cron do not call manual grading.
- The route rejects non-creator (403), quiz batch (400), missing/unverified current creator setting (400), and a non-stale concurrent run (409). It ignores legacy batch flag/setting columns.
- A `processing` batch claim becomes retryable after six minutes to recover a hard-killed invocation.

### Per-student LLM flow

- Query only `students.status='submitted'` whose AI status is not `completed`; completed students are checkpoints and are skipped on rerun.
- Each student is logically independent. The preferred call contains all assigned question IDs/orders/text, current rubrics and answers for that student.
- Pre-split when prompt exceeds `AI_GRADING_MAX_PROMPT_CHARS`. On context/token-size or schema/JSON validation errors, recursively split the affected student's question set; unrelated students are never combined into one prompt.
- Process students through a bounded worker pool. `AI_GRADING_CONCURRENCY` defaults to 3 and clamps to 1–5; `1` restores sequential behavior. Every worker claims one student, loads only that student's rows, performs the external call without holding a DB connection, and publishes through student-scoped transactional updates. Per-call timeout defaults to 60 seconds and clamps to 1–120 seconds.
- A claim writes a UUID attempt token and start timestamp. `AI_GRADING_STALE_MS` defaults to six minutes and is always at least the safe budget plus 60 seconds. The next creator request recovers stale initial attempts to `failed` and stale regrades to `completed` with their old published result intact. Publish/failure updates require the exact token, so a late old worker cannot overwrite a replacement attempt.
- Stop starting another student when the remaining budget cannot cover the LLM timeout plus a 10-second guard. `AI_GRADE_SAFE_BUDGET_MS` defaults to 270 seconds and clamps to 30–290 seconds. Remaining/failed students produce batch status `partial`; clicking again continues them.

### Validation, scoring and persistence

- Preferred JSON: `{request_token,results:[{grading_key,score,feedback}],summary_feedback}`. Every attempt creates a fresh random token and keys such as `g_<token>_q1`.
- With a matching token, short `qN` keys or stable result order are tolerated. Without a matching token, the response is accepted only when every result maps through complete unique request-scoped grading keys or exact expected legacy `exam_question_id` values. Missing/mismatched correlation is never published; `AI_GRADING_CORRELATION_RETRIES` retries only this failure with a fresh token.
- Every expected item must appear exactly once; unknown/duplicate/missing identifiers, score outside 0..1, empty feedback or empty summary reject that student's candidate result.
- Student answer is explicitly untrusted prompt data. System instructions say it cannot modify rubric, role, score or output format; this mitigates but cannot eliminate prompt injection.
- Score per question is rounded to two decimals in `0.00..1.00`; unanswered is forcibly 0 regardless of model output.
- Final score is `ROUND(SUM(per_question_score)/total_assigned_questions*10, 2)` with no weighting.
- One DB transaction per student publishes `exam_questions.ai_score/ai_feedback` and the student final score/summary/status/timestamp only after the full candidate validates. An initial/retry failure becomes `failed` without a synthetic zero; a regrade failure restores `completed` and preserves the previous published scores/feedback while recording the error.
- Batch becomes `completed` only when no failed/remaining student exists; otherwise `partial`.

### Targeted grade and regrade

- Results exposes **AI Grade**, **Retry AI Grade**, or **Regrade AI** only to the batch creator with a verified current setting and only for a submitted essay student with assigned questions.
- The targeted route accepts `pending`, `failed`, or `completed`. It rejects a fresh `processing` lease, but atomically recovers and retries a stale one. It uses the same per-student isolation, chunking, correlation and validation path as batch grading.
- Batch reruns continue to select only `pending` and `failed`; targeted regrade is the explicit path for replacing a completed result.

### Retired queue cleanup

- Per-question queue code, global plaintext settings, queue endpoints and their environment variables have been removed.
- Manual grading uses `user_ai_settings` and grading state on `batches`, `students`, and `exam_questions`; there is no cron/background queue path.

## 11. Security and limits

### 11.1 Live monitoring and capture-only mode

- WebRTC carries screen media directly between candidate and authorized admin viewer. Supabase Realtime private Broadcast only exchanges offer/answer/ICE signaling; Vercel/Supabase never transport screen frames. STUN is tried first and TURN is fallback when P2P cannot connect.
- `live_enabled=false` is the default. The admin-only **Check Live** setting applies to `record_mode='none'`; `local` and `s3` already expose their required capture stream to Live and do not need the flag enabled.
- A capture-only attempt requires the same entire-monitor share as recording (`displaySurface='monitor'`), calls `startLiveCapture()`, and must not instantiate `MediaRecorder` or persist/upload recording data. Share loss remains `recording_stopped`, which locks on first occurrence.
- Live list/session routes use authenticated admin/mod identity and server-enforce `batches.created_by === req.adminUser.id`; another admin is not an ownership bypass. Audit-end is scoped to the `admin_user_id` that created the viewer session. UI exposes Live only to the same creator, only through the inclusive end-date, and only for a batch that has a capture source. `20260828_live_monitoring.sql` installs signaling/audit policy and `20260829_live_enabled.sql` adds `live_enabled` and schema version 6.
- Live configuration is valid only if `LIVE_MONITORING_ENABLED=true`, a HTTPS project URL, publishable key, and a private ES256 key are present. The server signs topic-scoped 10-minute JWTs with `live_topic`, `live_actor`, `aud=authenticated`, and matching `kid`. Generate JWK locally, then import the full private JWK through Supabase Auth → JWT Signing Keys → **Create Standby Key** and Rotate it active; use its unchanged `kid`. A Supabase-generated asymmetric key cannot be used because its private key is unavailable to Vercel. Supabase Realtime → Settings must disable **Allow public access to channels**; source uses `private: true` and migration policy authorizes the private topic.
- Open Relay/Metered credentials are **required for production Live** and fetched server-side with a 5-second limit. Valid returned `stun:`/`turn:`/`turns:` entries are appended after static STUN. Failures/absence use static STUN only and set `turnAvailable=false`, but this is an intentional code degrade path rather than a supported production configuration; production acceptance requires `turnAvailable=true` and a successful cross-network Live test. A free monthly TURN allowance may still require payment-card identity verification.

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
| `AI_SETTINGS_ENCRYPTION_KEY` | required for AI; 32-byte base64 or 64-character hex, stable across deployments |
| `AI_GRADING_CONCURRENCY` | 3, clamped 1–5; 1 restores sequential processing |
| `AI_GRADING_CORRELATION_RETRIES` | 2, clamped 0–3; fresh token per retry |
| `AI_GRADING_LLM_TIMEOUT_MS` | 60000, clamped 1000–120000 ms |
| `AI_GRADING_MAX_PROMPT_CHARS` | 80000, minimum 10000 |
| `AI_GRADE_SAFE_BUDGET_MS` | 270000, clamped 30000–290000 ms |
| `AI_GRADING_STALE_MS` | 360000; clamped 60000–1800000 ms and forced to at least safe budget + 60000 ms |
| `SERVE_STATIC` | false; local/self-host opt-in to serve `client/dist` |
| `DATABASE_SSL` | TLS by default; `false` only for trusted local PostgreSQL |
| `SKIP_TIME_CHECK` | `true` bypasses schedule |
| `DB_POOL_MIN`, `DB_POOL_MAX` | 0, 4 |
| `DB_CONNECT_TIMEOUT_MS`, `DB_CONNECT_ATTEMPTS` | 15000, 2 |
| `STATEMENT_TIMEOUT` | `30s` |
| `ANSWER_FLUSH_INTERVAL` | 5000, legacy buffer only |
| `ADMIN_PERF_LOGS`, `ADMIN_SLOW_REQUEST_MS` | off, 1000 |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_RECORDINGS_BUCKET` | S3 mode |
| `LIVE_MONITORING_ENABLED` | Must equal `true` to issue Live signaling sessions; other values are disabled. |
| `SUPABASE_URL` | Required Live project URL; HTTPS only. |
| `SUPABASE_PUBLISHABLE_KEY` | Required Live publishable `sb_publishable_...` key; passed to browser for Realtime. |
| `SUPABASE_REALTIME_PRIVATE_KEY_BASE64` | Required Live Base64 of complete private ES256 JWK JSON; server-only. PEM fallback exists only as `SUPABASE_REALTIME_PRIVATE_KEY`. |
| `SUPABASE_REALTIME_JWT_KEY_ID` | Required production ES256 `kid`, from the JWK imported through **Create Standby Key** and rotated active. |
| `OPEN_RELAY_CREDENTIALS_URL` | Required production Live HTTPS `*.metered.live` credentials endpoint. |
| `OPEN_RELAY_API_KEY` | Required production Live credential API key; server adds it as `apiKey` query parameter. |

`JWT_EXPIRES_IN` is documented in older files but current login code hard-codes 24h; changing the env alone has no effect.

## 13. Migrations and tests

Production migration order:

1. `20260808_mac_exam_hardening.sql`
2. `20260809_concurrent_session_detection.sql`
3. `20260810_free_tier_exam_integrity.sql`
4. `20260810_violation_event_idempotency.sql`
5. `20260813_ai_grading_controls.sql`
6. `20260813_admin_query_performance.sql`
7. `20260816_user_ai_manual_grading.sql`
8. `20260817_ai_grading_student_recovery.sql`
9. `20260818_admin_startup_fast_path.sql`
10. `20260819_remove_legacy_ai.sql`
11. `20260827_recording_upload_reservations.sql`
12. `20260827_recording_manifest_recovery.sql`
13. `20260828_live_monitoring.sql`
14. `20260829_live_enabled.sql`

`npm test` uses default discovery and skips PostgreSQL-only tests without `TEST_DATABASE_URL`. Verified on 2026-08-16: 73 total, 69 pass, 4 skip. `npm run test:postgres` requires a separate non-production PostgreSQL URL and runs four integration cases in temporary schema `test_violation`.

`npm run test:local` is the full local completion gate: build the two-service stack, construct a schema-v2 fixture, apply migrations through `20260829_live_enabled.sql` (including idempotency checks), restart and verify schema v6, verify app/frontend health, run the default suite, run PostgreSQL cases, then run manual AI Grade E2E through a mock LLM. It verifies Live schema contract only; local Compose does not provide hosted Supabase Realtime or Open Relay TURN, so it cannot prove production WebRTC signaling/media connectivity. `npm run test:ai-grade:real` is optional and uses ignored local secrets to probe a real provider.

## 14. Known implementation notes

- `/student/select-email`, `/student/exam/flush`, and legacy full question/result endpoints remain for compatibility but are not primary UI paths.
- `/exam/start` contains unreachable legacy code after an early return; reason from the atomic implementation, not that block.
- Current Batch Management/dashboard and Student Management paths use server-side pagination; full-list endpoints remain for older clients.
- Recording reset deletes DB metadata but not S3 objects; lifecycle policy handles stale objects.
- Manual AI Grade reads mutable `question_bank` question/rubric values at click time, and quiz finalization reads current correct answers/score at submit time. Assigned attempts do not persist an immutable question/rubric/quiz-key version.
- A single batch request is bounded by hosting duration and provider latency/rate limits. A bounded worker pool improves throughput while per-student correlation, lease fencing and transactions preserve isolation; external LLM calls still cannot be exactly-once.
- Server-owned auto-submit cannot persist browser-only dirty answers that have not reached the backend.
- Quiz finalization is post-commit and idempotent rather than atomic with the submitted transition; a hard crash can leave scores incomplete until a retry reruns finalization.
- `deploy-vps.sh` resets the `admin` account password to hard-coded `admin321` on every run and hard-cleans `/opt/e-proc/app`; fix/accept that bootstrap behavior before production use and keep mutable runtime data outside the checkout.
- Client/browser controls can be bypassed by a sufficiently controlled environment; high-stakes use still needs evidence review and procedural controls.
