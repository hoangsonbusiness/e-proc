# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

### Backend
- Install root dependencies: `npm install`
- Run backend dev server: `npm run dev`
  - Starts the TypeScript server from `src/server/server.ts` via `tsx`
- Build backend TypeScript: `npm run build:server`
- Run built backend: `npm start`

### Frontend
- Install frontend dependencies: `cd client && npm install`
- Run frontend dev server: `cd client && npm run dev`
  - Vite dev server runs on port `5173`
  - `/api` is proxied to `http://localhost:3001`
- Build frontend: `npm run build:client`
  - This builds into `client/dist`

### Full build
- Build both frontend and backend: `npm run build`

### Type-check only (no emit)
- Backend: `npx tsc --noEmit` (from project root)
- Frontend: `npx tsc --noEmit` (from `client/`)

### Tests and dependency checks
- SQLite/default regression suite: `npm test`
- PostgreSQL race/integration suite: copy `.env.test.example` to `.env.test.local`, set a **non-production** `TEST_DATABASE_URL`, then run `npm run test:postgres`
- Required local Docker verification: `npm run test:local`
  - Builds and starts exactly two services from `docker-compose.local.yml`: `app` (built frontend + backend) and `database` (Supabase PostgreSQL).
  - Verifies `/api/health`, verifies the built React app is actually served, runs the complete default suite inside the app image, runs PostgreSQL integration tests, and exercises manual AI Grade end to end through a mock LLM against the local Supabase database.
  - `npm run local:up`, `npm run local:logs`, and `npm run local:down` are available for manual investigation.
- Optional real-provider AI Grade diagnostic: configure the ignored `.env.ai-grade.local` file, keep the local stack running, then run `npm run test:ai-grade:real`. This sends real provider traffic and may incur cost.
- Production dependency audits: `npm audit --omit=dev` and `cd client && npm audit --omit=dev`

### Mandatory completion gate for AI coding tasks
- After any source-code, test, build, dependency, Docker, or runtime configuration change, the coding agent **must run `npm run test:local`**.
- The agent may report a task as done only when the command exits successfully, including Docker image build, both service healthchecks, served-frontend check, default tests, and PostgreSQL integration tests.
- Host-only `npm test`, a TypeScript build, mocked tests, or source inspection do not replace this gate.
- If Docker is unavailable, the image cannot be pulled, or any verification step fails, the task is **not done**. Report the exact blocker/failure; never claim completion.
- Documentation-only edits may be checked by reading/diffing the files and do not require rebuilding the application stack unless they change commands or runtime behavior.

## Repository structure

This is a full-stack technical assessment platform with a React/Vite frontend and an Express/TypeScript backend.

### Source of truth vs generated artifacts
- **Edit application source in**:
  - `client/src/**` for frontend
  - `src/**` for backend and shared server-side logic
- **Do not treat these as source of truth** unless you are intentionally updating deployed/static artifacts:
  - `public/assets/**`
  - `client/dist/**`
  - `dist/**`
- Important: the app may be served from `public/index.html`, which points to a specific built asset in `public/assets`. After changing frontend source, rebuilding `client/dist` alone is not enough if runtime is using `public/`; you must also sync the new built asset into `public/assets` and update `public/index.html` to the new hashed filename.

## High-level architecture

### Frontend
- Main router: `client/src/App.tsx`
- Student flow routes:
  - `/` → login (access code entry)
  - `/confirm` → confirm email / start exam
  - `/exam` → active exam page
  - `/submit` → submission complete page
- Admin flow routes:
  - `/admin`, `/admin/setup`, `/admin/dashboard`, `/admin/questions`, `/admin/questions/new`, `/admin/questions/:id/edit`, `/admin/batches`, `/admin/batches/:id/students`, `/admin/batches/:id/results`, `/admin/settings`, `/admin/users`
- API wrapper: `client/src/services/api.ts`
  - `adminApi` contains admin CRUD/reporting endpoints; attaches admin JWT via request interceptor
  - `studentApi` contains exam lifecycle endpoints and violation reporting; attaches student JWT via request interceptor (see **Student auth** section below)

### Backend
- HTTP server entry: `src/server/server.ts`
- Express app setup: `src/server/index.ts`
  - mounts `/api/admin` and `/api/student`
  - exposes readiness health (`/api/health`) and authenticated DB/cache diagnostics
  - startup readiness is single-flight; transient DB/network failures close the failed pool and retry with bounded backoff, while schema/auth/config failures remain blocked
- Admin routes: `src/server/routes/admin.ts`
- Student routes: `src/server/routes/student.ts`
- Middleware:
  - `src/server/middleware/auth.ts` — admin JWT middleware (`authMiddleware`)
  - `src/server/middleware/studentAuth.ts` — student JWT middleware (`studentAuthMiddleware`)

### Data/storage model
- DB layer: `src/server/db/postgres.ts`
- Runtime chooses DB mode from environment:
  - if `DATABASE_URL` is absent, local dev uses SQLite via `better-sqlite3`
  - if `DATABASE_URL` is present, production-style PostgreSQL path is used
- Core tables are created by explicit local/fresh-database bootstrap; production uses migrations plus `app_schema_state` fast-path verification:
  - `question_bank`
  - `batches`
  - `students`
  - `exam_questions`
  - `violations`
  - `violation_events` (append-only forensic log — one row per violation occurrence; see Anti-Cheat v2 section)
  - `recording_parts` (S3 part metadata acknowledged after the browser observes PUT 2xx; unique per student + part index)
  - `recording_upload_reservations` (durable client `upload_id` → part/key reservation; prevents resume/reload cursor races and S3 overwrites)
  - `exam_sessions` (anti-cheat session tracking — one row per `(student_id, jti, ip)`; `last_seen` upserted on each exam request; used to detect concurrent multi-client/multi-IP use — see Concurrent-session detection section)
  - `user_ai_settings` (one encrypted, verified LLM connection per admin/mod)
  - `admin_users`
  - `app_schema_state` (aggregate runtime schema contract version)
  - `schema_migrations` (VPS migration ledger)

### Security model

#### Admin authentication & roles
- `POST /api/admin/login` → returns JWT (`expiresIn: 24h`) + `role`; login response and the JWT payload both carry `role` (read from `admin_users.role`, no longer hard-coded)
- Stored in `localStorage.adminToken` (+ `localStorage.adminRole`); sent as `Authorization: Bearer <token>` header
- All `/api/admin/*` routes after `/login` and `/setup` require `authMiddleware`
- **Roles (added 2026-07-29):** `admin_users.role` ∈ `{'admin', 'mod'}` (default `'admin'`; pre-existing users migrate to `'admin'`). `requireAdmin` middleware (`src/server/middleware/auth.ts`) gates admin-only routes with 403.
  - **User management** (`GET/POST/DELETE /api/admin/users`) is `requireAdmin`-only. Frontend page `/admin/users` (`UserManagement.tsx`); the nav link and page are hidden/redirected for mods via `useAuth().isAdmin` — but the **backend `requireAdmin` is the real gate**, the frontend hiding is only UX.
  - **Recording mode per batch** (`batches.record_mode` ∈ `{'none','local','s3'}`, default `'none'`; replaced the old boolean `batches.record_enabled` toggle — 2026-07-30): only `role === 'admin'` may set it to anything other than `'none'`. Enforced server-side in `POST/PUT /api/admin/batches` — on create a mod's requested mode is **forced to `'none'`**; on update a mod's request **keeps the existing DB `record_mode` unchanged** (mod can neither enable nor change it, for `local` OR `s3`). The batch form dropdown is `disabled` for mods (UX only). `record_enabled` is kept in sync (`= record_mode === 's3'`) for backward compat but `record_mode` is the source of truth. The `UserManagement.tsx` role selector labels mod as "cannot enable screen recording".
  - **Ownership:** mods may create questions/batches, but can edit/delete only rows whose `uploaded_by`/`created_by` matches their JWT user id. Admins may manage all rows. A mod may clone any visible batch into a new batch they own, but the server still forces the clone's recording mode to `none`.
- Internal DB/cache diagnostic endpoints require admin JWT

#### Student authentication
After the security hardening (2026-07), student auth works via a signed JWT rather than an unverified header:

1. Student enters access code → `POST /api/student/verify`
2. Server validates and returns `student_token` (JWT, `expiresIn: 4h`, payload: `{ studentId, batchId, jti }`) and stores the fresh `jti` in `students.active_jti`
3. `StudentLogin.tsx` passes token through React Router state → `StudentConfirm.tsx`
4. On "Start exam", `StudentConfirm.tsx` stores `studentToken` and `studentId` in `localStorage`
5. All subsequent student API calls (`getQuestions`, `saveAnswer`, `submit`, `reportViolation`, etc.) attach the token via the axios request interceptor in `api.ts`
6. Backend `studentAuthMiddleware` verifies the JWT and checks that its `jti` still equals `students.active_jti`; a later `/verify` revokes the older token. `req.studentPayload.studentId` is authoritative — **`x-student-id` is not trusted**
7. `POST /exam/disconnect` (sendBeacon) cannot set custom headers, so the token is placed inside the request body (`student_token` field); `studentAuthMiddleware` accepts it from either location

When debugging student exam state, inspect:
- `localStorage.studentId` (display only, not used for auth)
- `localStorage.studentToken` (JWT used for all student API calls)
- Network `Authorization: Bearer ...` header on student requests

#### CORS
- `ALLOWED_ORIGINS` env var controls which origins are permitted (comma-separated)
- Default: `http://localhost:5173`
- For production Vercel deploys: set `ALLOWED_ORIGINS` to the actual deployment URL(s) in the Vercel environment variable dashboard

### Exam lifecycle
- Student verification and exam start live in `src/server/routes/student.ts`
- Frontend exam behavior lives mainly in `client/src/pages/StudentExam.tsx`
- Answers are persisted directly to `exam_questions` rather than relying on process-local durability:
  - essay/code answers use a separate 5-second timer per question
  - quiz answers use a 500ms timer per question
  - `POST /exam/answers` batches dirty answers; manual submit sends the full current answer set inside the idempotent submission transaction
  - `cache.ts` still contains legacy answer-buffer helpers and `/exam/flush`, but the active exam save path does not depend on them
- Violations are reported through `studentApi.reportViolation(type)`; counter-eligible types update `violations`, while every new occurrence is written to `violation_events`
- Client-reportable violation types are defined by `CLIENT_REPORTABLE_VIOLATION_TYPES` in `src/server/services/violationPolicy.ts`: `tab_switch`, `fullscreen_exit`, `copy_attempt`, `cut_attempt`, `paste_attempt`, `devtools_open`, `view_source`, `extension_panel`, `screenshot_attempt`, `print_attempt`, `suspicious_paste`, `focus_lost`, `recording_stopped`, `rapid_text_insertion`, `multiple_display_detected`. `concurrent_session` is server-owned and `POST /api/student/violation` rejects a client-supplied value with 400.
- Locking occurs when `violation_count >= 2` for any single lockable type or `total_violations >= 2`. `focus_lost` remains lockable; `suspicious_paste`, `rapid_text_insertion`, `multiple_display_detected`, and `concurrent_session` are forensic-only in the `violations` table. **`recording_stopped` is a special case: it locks the exam on the FIRST occurrence** — stopping screen share is treated as deliberate evasion.
- **Backend enforces the lock itself:** `persistViolation()` atomically inserts/idempotently replays the event and counter; `ensureViolationLock()` calls the shared transactional `submitExamAtomically()` with reason `violation` or `recording_stopped`. A replay retries enforcement if the first submit failed, so ignoring the client response cannot keep the attempt writable past the threshold.
- **`concurrent_session` (2026-08-09) locks via a different path** — not the count thresholds above; it auto-submits when time-overlapping requests from ≥2 IPs are seen. See Concurrent-session detection section.
- Every new logical violation occurrence is appended to `violation_events`; transport retries reuse `event_id` and do not append duplicates. `suspicious_paste` carries the first 500 chars as `content_preview`.
- `rapid_text_insertion` and `multiple_display_detected` are **forensic-only**: they are appended to `violation_events` with `metadata_json`, but are not inserted/incremented in `violations` and never contribute to auto-lock thresholds.
- Anti-cheat behavior is concentrated in `client/src/pages/StudentExam.tsx`:
  - clipboard attempts (`copy_attempt`, `cut_attempt`, `paste_attempt`) are intercepted inside the Monaco CodeEditor via `addCommand()` and reported as violations
  - fullscreen must succeed on `/confirm` before navigation to `/exam`; denial stops recording and blocks entry. During the exam, both `fullscreenchange` and a 1-second watchdog feed the same timer state. Staying out for 5 seconds records the first `fullscreen_exit`; remaining out for another 5 seconds records the second violation and triggers client auto-submit.
  - tab switching (visibilitychange) reports `tab_switch` violation
  - DevTools/View Source shortcuts cover Windows/Linux modifiers and macOS Command/Option modifiers. DevTools reports `devtools_open`; View Source reports `view_source`.
  - `beforeprint`, Ctrl/Cmd+P report `print_attempt`; PrintScreen and macOS screenshot shortcuts are intercepted on a best-effort basis and report `screenshot_attempt` (OS-reserved shortcuts are not guaranteed to reach browser JavaScript).
  - multiple-display preflight is fail-closed: `/confirm` blocks both an extended display and a browser that does not expose boolean `screen.isExtended`. This effectively requires a recent desktop Chrome/Edge. A display appearing mid-exam produces forensic-only `multiple_display_detected`. There is no self-attestation/checklist fallback.
  - **Extension side-panel detection (`extension_panel`, added 2026-07)**: detects Chrome side-panel extensions (e.g. Monica AI) that open alongside the exam while remaining fullscreen. See dedicated subsection below — the detection metric matters and is easy to get wrong.
  - locking occurs when `violation_count >= 2` for any single lockable type or `total_violations >= 2`; forensic-only types are excluded

#### Extension side-panel detection (`extension_panel`)
Chrome side-panel extensions (Monica AI and similar "AI sidebar" extensions) render via the browser's native Side Panel API. This panel visually shrinks the page's rendered layout while `document.fullscreenElement` remains set — no `fullscreenchange` event fires, so the pre-existing fullscreen-exit detection never sees it.

**Critical, counter-intuitive measurement finding (confirmed via live testing 2026-07-21):** while fullscreen and a side panel is open, `window.innerWidth`, `window.screen.width`, and `window.outerWidth` all stay **frozen** at their pre-panel values — they do not reflect the shrink at all. Only `document.documentElement.getBoundingClientRect().width` (equivalently `document.body.clientWidth`) reflects the real layout shrink (~465px observed with Monica). An earlier implementation attempt compared `window.screen.width - window.innerWidth` and silently never triggered because of this — do not reintroduce that comparison.

Current implementation in `sidePanelDetector.ts`, `StudentConfirm.tsx`, and `StudentExam.tsx`:
- `/confirm` captures `document.documentElement.getBoundingClientRect().width` once, after fullscreen settles, and stores it in `sessionStorage` under `examFullscreenBaselineWidth`. `/exam` only reads this immutable baseline; it never re-baselines to a potentially shrunken width after navigation/F5.
- A `setInterval` poller (`VIEWPORT_CHECK_INTERVAL_MS` = 1500ms) runs only while `started && !locked && !submitting` and `document.fullscreenElement` is set.
- Each tick compares the stored baseline with the current document width using `SIDE_PANEL_SHRINK_THRESHOLD_PX` (80px).
- The shrink must persist for `SIDE_PANEL_SUSTAIN_POLLS` (2) consecutive ticks (~3s). The pure detector reserves at most two logical reports (`SIDE_PANEL_MAX_REPORTS=2`), prevents overlapping in-flight reports, and the normal two-violation rule locks the exam.
- No `resize`/`visualViewport.resize` event is relied on, since side-panel open/close doesn't reliably fire those in all browsers — polling is used instead.

If this detection stops working again, verify in this order before touching the logic: (1) confirm the deployed bundle actually contains the fix (see Vercel deploy note below — this bit twice), (2) re-measure `documentElement`/`innerWidth`/`screen.width` live with a throwaway static HTML page served over `http://localhost` (not `file://` — extensions don't inject into `file://` pages) since browser/extension internals can change behavior across Chrome versions.

#### Anti-Cheat v2 (added 2026-07-28)

Two new detection layers were added to handle vectors that bypass existing clipboard intercept:

**1. `suspicious_paste` — Maccy (macOS) and `Win+V` (Windows clipboard history) detection**

Maccy and Windows built-in clipboard history (`Win+V`) inject text via the OS Accessibility API, bypassing Monaco's `addCommand()` keyboard intercept entirely. The text appears in the editor as if typed, but Monaco still fires `onDidChangeModelContent` with a large `change.text.length`.

Detection in `client/src/components/CodeEditor.tsx` (`handleEditorMount`):
- Attaches `editor.onDidChangeModelContent` listener (only when prop `onSuspiciousPaste` is provided)
- Uses a distinct Monaco `path`/model per question and skips both `isFlush: true` and controlled-value synchronization events; question navigation and resume loads must not be classified as student insertions
- **Threshold: 300 characters per single change event** (lowered from 1200 on 2026-07-29 — the old 1200 let typical Notes-copied answers of 300–800 chars slip through, which was the actual bypass being exploited)
  - **⚠️ False-positive caveat:** the larger IntelliSense snippets (`SpringController` 366, `JpaEntity` 422, `MockMvcTest` 403, `HandlerInterceptor` 546, `WebMvcConfigurer` 869, `GlobalExceptionHandler` 1093) now exceed the threshold and **would be flagged if typed**. This is currently safe **only because those snippets are not in use**. If they are re-enabled, the length-only check must be paired with a snippet exclusion (e.g. check whether the Monaco suggest widget is open at the time of the change) before keeping the 300 threshold. Snippets still safely below threshold: `psvm` (~30), `hashequals` (220).
- On trigger, passes the first 500 chars of `change.text` and the true `change.text.length` to `onSuspiciousPaste(preview, textLength)`
- Before rejecting a large insertion, compares it with the `insertText` of the application's registered Monaco completions for the active language. Exact suggestion/snippet data (allowing Monaco's placeholder expansion and indentation conversion) is kept; unmatched content is immediately undone and every rejected occurrence is logged with a unique `event_id`
- Calls `onSuspiciousPaste(preview, length)` prop → `handleSuspiciousPaste()` in `StudentExam.tsx` → `handleViolation('suspicious_paste', { contentPreview, textLength, questionId })`
- Backend: **forensic-only** (changed 2026-08-13 after confirmed navigation/programmatic-update false positives); the preview is stored in `violation_events.content_preview`, but the event does not increment `violations` or cause auto-lock

**2. `focus_lost` — window focus heartbeat (macOS Split View / Notes alongside exam)**

On macOS, when a student opens another app (Notes, TextEdit) alongside the browser (without entering Split View fullscreen), `document.hidden` stays `false` and `visibilitychange` does not fire. The exam appears uninterrupted from the system's perspective.

Detection in `client/src/pages/StudentExam.tsx` (rewritten 2026-07-29 — replaced the old 5s polling heartbeat):
- Listens to `window` `blur`/`focus` events (not polling) while `started && !locked && !submitting`
- On `blur`, starts a **3-second grace timer** (`focusLostTimeoutRef`); if `focus` returns before it fires, the timer is cleared and no violation is recorded
- If the timer fires and `document.hasFocus()` is still false → `handleViolation('focus_lost')`
- **Grace rationale (3s):** once fullscreen, there's no legitimate reason for window focus to leave; 3s clears the genuine noise — fullscreen transitions (~0.5s), the fullscreen permission dialog, Windows notifications (~1–2s), macOS Spotlight (~2s) — while Maccy/Notes usage always exceeds it
- **Why event-based, not polling:** a poll every 5s aliases — a short focus-loss can fall entirely between two ticks and never be seen; `blur`/`focus` measure the real duration
- Backend: **lockable** (as of 2026-07-29 — no longer log-only). `focus_lost` events carry no `content_preview` (nothing to store), only timestamp + type

**3. Dynamic watermark (same 2026-07-28 update)**

Previously the forensic watermark timestamp was frozen at the time React rendered the watermark JSX (once on mount). It now updates every **15 seconds**, includes email/student ID + timestamp, and shifts position over time so screenshots and recordings can be correlated more accurately and the watermark is harder to crop consistently.

**4. Admin Results page — violations breakdown (2026-07-28, updated 2026-07-29)**

`GET /api/admin/batches/:id/results` returns `violations_breakdown: { [type]: count }` alongside the existing `violations` (total). `client/src/pages/Results.tsx` displays counted violation types as orange badges. `rapid_text_insertion` and `multiple_display_detected` appear only in the detailed forensic event list because they do not increment `violations`.

**5. Forensic `violation_events` table + paste-content popup (added 2026-07-29)**

The `violations` table is keyed by `(student_id, type)` and only stores a running count — it cannot record individual occurrences or their content. A new append-only table `violation_events` was added (created in `src/server/db/postgres.ts` for both SQLite and PostgreSQL):
- Columns: `id, student_id, batch_id, type, text_length, content_preview (VARCHAR 500), question_id, metadata_json, created_at`
- `POST /api/student/violation` inserts one row per report, reading optional `content_preview` / `text_length` / `question_id` / structured `metadata` from the request body. `content_preview` is server-side truncated to 500 chars; metadata is serialized and capped before storage.
- `GET /api/admin/batches/:id/results` returns a `violation_events` array per student.
- `client/src/pages/Results.tsx` shows a "🔍 Xem chi tiết (N)" button that opens a modal listing each event (type, timestamp, char length, question id, and the paste preview in a monospace block) — so admins can adjudicate a flag from the actual pasted text without querying the DB.
- Server-side timer guard in `GET /exam/questions`: if `exam_deadline` has passed, the server auto-submits and returns `410 Gone` with `reason: 'timeout'`
- Disconnect guard: if `disconnected_at` is set for > 120 seconds, the server auto-submits on next `GET /exam/questions` and returns `410 Gone` with `reason: 'absent_too_long'`

**6. Rapid insertion telemetry + multiple-display telemetry (added 2026-08-08)**

- `CodeEditor.tsx` retains the existing single-change `suspicious_paste` threshold (>=300 chars), and additionally aggregates inserted characters in a rolling **2.5-second** window. If total insertion reaches 300 while each individual change remains below 300, it reports `rapid_text_insertion` with `insertedChars`, `changeCount`, `windowMs`, and `maxSingleChange`.
- `rapid_text_insertion` is forensic-only to avoid auto-lock false positives from Monaco completion/formatting behavior. Calibrate from production evidence before ever making it lockable.
- `examEnvironment.ts` reads `screen.isExtended`. `StudentConfirm` blocks Start if it is `true` **or unavailable**; `StudentExam` polls every 3 seconds and records forensic-only `multiple_display_detected` if an additional display appears mid-exam.
- The API remains a browser signal, not proof against spoofing, but unsupported browsers now fail closed. There is no candidate checkbox/acknowledgement fallback because self-attestation is not a security control.

**7. Concurrent-session / multi-IP detection (`concurrent_session`, added 2026-08-09)**

Addresses the highest-risk attack vector for a technical candidate: driving the exam via the HTTP API / a second client using the same valid student JWT, which produces none of the frontend anti-cheat events. Detection is purely **server-side** (the frontend has no involvement).

- **`jti`:** each `POST /student/verify` mints a fresh `jti` (`crypto.randomUUID()`) into the JWT payload (`StudentTokenPayload.jti`). Distinct browser sessions therefore carry distinct `jti`s.
- **Tracking:** `sessionTracker` middleware (`src/server/middleware/sessionTracker.ts`) runs **after `studentAuthMiddleware`** on `/exam/questions`, `/exam/answer`, `/violation` (deliberately **not** on `/exam/disconnect` — beacon IP/UA are unreliable). It upserts one `exam_sessions` row per `(student_id, jti, ip)` (`ON CONFLICT ... DO UPDATE last_seen, user_agent` — valid on both PostgreSQL and better-sqlite3), refreshing `last_seen` and storing the User-Agent. `req.ip` is authoritative because `app.set('trust proxy', 1)` is set — verify Vercel forwards `x-forwarded-for` correctly, otherwise all rows collapse to one IP.
- **Evaluation:** `detectConcurrentSession(studentId)` reads rows with `last_seen` within `SESSION_WINDOW_SECONDS` (60s) and computes four signals: ≥2 distinct IPs, ≥2 distinct User-Agents, ≥2 distinct `jti`s, and **time-overlap** (two rows with *different* IPs whose `last_seen` differ by < `OVERLAP_SECONDS` = 10s). `suspicious` = any signal; **`lockable` = time-overlap only**.
- **Why only overlap locks:** a candidate legitimately switching wifi→4G changes IP *sequentially*, not overlapping — that is `suspicious` (logged) but **not** locked, avoiding the most common false positive. Two genuinely-concurrent clients produce overlapping requests.
- **Enforcement:** the server-owned enforcer from `concurrentSessionEnforcer.ts` is invoked before writes on `/exam/questions`, `/exam/answers`, `/exam/answer`, and `/violation`. Suspicious evidence is deduplicated in-process for 60 seconds and appended as `concurrent_session`; different-IP overlap directly submits with reason `concurrent_session`, independent of counters. Client-supplied `concurrent_session` is rejected. Startup schema readiness requires the session table/index, while tracking/logging failures are treated as non-fatal where explicitly caught.
- **Reset:** `POST /admin/students/:id/reset` deletes `exam_sessions` rows so a re-attempt does not false-positive against the prior attempt's sessions.
- **Admin UI:** `Results.tsx` shows a pulsing red `⚠️ Multi-session (N IP) ×count` badge on any student with `concurrent_session` events; the forensic detail popup renders the IP/UA/jti metadata.
- **Constants** (`SESSION_WINDOW_SECONDS` = 60, `OVERLAP_SECONDS` = 10) live in `sessionTracker.ts` and are the tuning knobs; adjust there if false-positive/negative rates warrant.
- **Migration:** `migrations/20260809_concurrent_session_detection.sql` (idempotent) creates `exam_sessions` + index for Supabase; run it manually before deploying, like the other migrations. The DB layer also creates the table automatically on startup for both PostgreSQL and SQLite.
- **Limits:** heartbeat/tracking can be spoofed by an attacker who fully controls the client and mimics one IP/UA — this is a risk signal and forensic aid, not absolute proof. Strong anti-automation still requires a managed device / kiosk browser.

#### Backend request-guard hardening (2026-08-09)

Beyond the anti-cheat layers, several backend guards were added/tightened the same day:

- **Rate limits:** global API limit is 1200 req/min/IP; `/student/verify` is 60 req/min/IP to allow a 25–50 candidate room behind one NAT; admin login is 10 req/min/IP and initial setup is 5 req/hour/IP.
- **`/exam/answer` status guard:** rejects with `410` when the student is `submitted` or past `exam_deadline` — previously it buffered blindly, so answers could be overwritten after a lock/auto-submit.
- **`/exam/submit` idempotency:** the transaction returns `{ already: true }` when already submitted, so answers/status are not rewritten. Quiz finalization still runs afterward and is intentionally idempotent; essay AI grading is never triggered by submit.
- **Security headers / CSP:** `src/server/index.ts` sets `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, and (prod) HSTS via a hand-rolled middleware (no `helmet` dependency). **The CSP intentionally allows `'unsafe-eval'` and `blob:` in `script-src`/`worker-src` because Monaco requires it** — do not remove those or the editor breaks. This is a deliberate trade-off, not an oversight.

#### Screen recording — three modes: `none` / `local` / `s3` (per-batch `record_mode`)

The exam can record the candidate's full screen. Since 2026-07-30 the per-batch setting is a **3-value `record_mode`** (`batches.record_mode`, replacing the old boolean `record_enabled` — admin-only, see Admin roles):

- **`none`** — no recording. `StudentConfirm` skips screen-share entirely; `StudentExam` skips the `recording_stopped` handler and resume-after-reload guard.
- **`s3`** — records and uploads **directly to AWS S3** via presigned PUT URLs during the exam (details below). The video never resides on the candidate's machine.
- **`local`** — records to a folder the candidate picks (File System Access `showDirectoryPicker`); each part is **compressed + AES-256 encrypted into a `.zip` client-side** with a password the **server generates and stores, never shown to the candidate**. Candidate commits the zip folder to GitLab after the exam; an admin retrieves the password to decrypt. See the "`local` mode" subsection below. **Security caveat:** this revives (in a hardened form) the very "save-local + candidate-commits" model that S3 replaced — the candidate still controls the evidence file (can fail to commit / commit a corrupt file), and because the client must receive the password to encrypt, a technical candidate can in principle read it from the `/verify` response. `local` only limits leak damage per-batch; it does not close the hole the way `s3` does. Prefer `s3` when leak-resistance matters.

**Flow of the setting:** `/verify` returns `record_mode` (and, for `local`, `recording_password`); it flows login → `/confirm` (router state) → `localStorage.recordMode` (+ `localStorage.recordingPassword` for local) → `/exam`. `StudentExam` derives `recordEnabled = recordMode !== 'none'` so all existing recording guards keep working for both `local` and `s3`. The `POST /exam/recording-url` endpoint **rechecks `batches.record_mode === 's3'` server-side** (returns 403 otherwise), so S3 URLs cannot be obtained for `local`/`none` batches. `record_enabled` is still written (`= record_mode === 's3'`) for backward compat but `record_mode` is authoritative.

**S3 mode** (`record_mode === 's3'`): the video uploads **directly to AWS S3** during the exam (via presigned PUT URLs). The video never resides on the candidate's machine.

Architecture (presigned URL — sidesteps Vercel serverless payload/timeout limits, since the video goes client→S3, not through the backend):
```
Client records → every 5 min cuts a part → asks backend for a presigned PUT URL
  → PUTs the blob straight to S3 → calls recording-complete
  → browser persists a small PUT-2xx acknowledgement and calls recording-complete
  → backend atomically persists the canonical reserved key + acknowledged byte size
  → retry-queue on failure (does not block the exam)
S3 key: recordings/{batchId}/{studentId}/session-{hash(activeJti)}/part{NNN}.webm
  (batchId/studentId/jti are authenticated server state, not client-selected)
Deletion: S3 Lifecycle rule auto-expires objects after N days (no backend script)
```

- **Backend:** `POST /api/student/exam/recording-url` (`studentAuthMiddleware`) returns a presigned PUT URL from `src/server/services/s3.ts` (`createRecordingUploadUrl`). AWS credentials live only in backend env; the URL expires in 15 min. The S3 key is built from `batchId`/`studentId` plus a hash of the backend-issued active `jti`, so stale URLs from a reset/revoked attempt cannot overwrite a later attempt. A finalized `(student_id, part_index)` is rejected with 409, preventing later URL issuance/overwrite. Returns `424` if S3 env is not configured.
- **Reservation + PutObject-only completion:** before PUT, the client sends a stable per-blob `uploadId`; the backend reserves the next free part/key under the student row lock and replays that reservation idempotently. Only after `fetch(PUT)` resolves 2xx, the client stores `{uploadId, partIndex, byteSize}` in attempt-scoped `sessionStorage` and calls `/exam/recording-complete`. The backend derives the canonical key/index from the reservation and atomically records the acknowledgement. Callback retries/reloads replay the small acknowledgement without uploading the part again; a failed or ambiguous PUT is never acknowledged. `/recording-reconcile` is database-only. Finalization derives and validates the contiguous manifest server-side rather than trusting a client final index.
- **PutObject-only trust boundary:** the IAM principal intentionally needs no read/list permission, so `finalized` means the authenticated client reported observing PUT 2xx; the backend does not independently prove object existence. If server-authoritative proof is required without `GetObject`/`ListBucket`, use a trusted S3 ObjectCreated event consumer and keep browser acknowledgement only as a UX accelerator.
- **Frontend module** `client/src/services/examRecorder.ts` (singleton **outside React** — survives the `/confirm` → `/exam` navigation; handles **both** `s3` and `local` modes):
  - **Full-screen only:** `getDisplayMedia({ video: { displaySurface: 'monitor' } })`; a shared tab/window (`displaySurface !== 'monitor'`) is refused. Requires **Chrome/Edge + HTTPS**; Safari/Firefox blocked at confirm.
  - **Config:** VP9 (fallback VP8), 5 fps, ~600 kbps → ~22 MB per **5-minute part**. In `s3` mode each part asks for a presigned URL then `fetch(url, { method: 'PUT', body: blob })` straight to S3, with a **retry queue** (exponential backoff, max 5 attempts) in the background. In `local` mode each part is zipped+encrypted and written to the chosen folder.
  - **Mode-aware API:** `isSupported(mode)` (local also needs `showDirectoryPicker`), `requestSetup(mode)` (local also prompts the folder picker **before** `getDisplayMedia`, both inside the click gesture), `start({ mode, password })`. `flushPart()` routes to S3 upload or local zip by mode.
- **Lifecycle:** `requestSetup(recordMode)` runs inside the Start click **before** `requestFullscreen()`; `/confirm` then captures the fullscreen width baseline. On submit, answers are committed first; `stopAndSave()` synchronously enters stopping, drains the final `MediaRecorder` bytes, releases browser sharing, then seals the exact S3 manifest. `/exam` waits only for that capture/seal handoff before navigating; `/submit` observes the continuing upload/finalize promise, replays persisted PUT acknowledgements, and reconciles database state after lost callbacks/reload. Any S3 submission without a finalized manifest is marked `recording_incomplete=true`; sealed recording writes remain allowed for 60 minutes after submit while answers/questions stay closed.
- **`recording_stopped` violation:** `track.onended` (candidate clicks "Stop sharing") → `handleViolation('recording_stopped')`. Backend locks on the **first** occurrence (`type === 'recording_stopped'` short-circuits the `>= 2` rule in `student.ts`). Registered via `examRecorder.setOnRecordingStopped()` after `/exam` mounts; if the track already ended before registration, the callback fires immediately. Applies to both `local` and `s3`.
- **Resume-after-reload:** F5 resets the singleton, so if the candidate re-enters `/exam` while running but `examRecorder.isActive()` is false, a blocking modal (`handleResumeRecording`) forces them to re-share the screen. For `local`, the `dirHandle` does **not** survive F5, so the candidate must re-pick the folder; the password is re-read from `localStorage.recordingPassword` (same value the server issued, so pre- and post-reload zip parts share one password).
- **Env required for `s3` (set on Vercel):** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_RECORDINGS_BUCKET`. The bucket needs a **CORS policy** allowing `PUT` from the deployment origin and a **Lifecycle rule** to auto-delete. IAM needs only `s3:PutObject` on `recordings/*`; do not require `s3:GetObject` or `s3:ListBucket`. `local` mode needs none of these.
- **macOS caveat:** the first `getDisplayMedia` requires granting Screen Recording permission to Chrome in System Settings **and restarting Chrome**. Because exams are time-gated, candidates should do this during a **practice exam** beforehand, not on exam day.

##### `local` mode specifics (added 2026-07-30)
- **Client-side zip encryption:** `client/src/services/examRecorder.ts` uses **`@zip.js/zip.js`** (`ZipWriter` with `password`, `encryptionStrength: 3` = AES-256, `level: 0` — no recompression since webm is already compressed). Each 5-min part becomes `exam_{stamp}_part{NNN}.zip` written to the folder via File System Access API.
- **Password provenance:** `POST /api/student/verify` generates `crypto.randomBytes(24).toString('base64url')` **once per `students` row** and stores it in `students.recording_password` (reused on subsequent `/verify` calls for that row, so resume uses the same password). It is returned to the client **only for `local` mode** (needed to encrypt) and **never displayed to the candidate**.
- **Password scope:** keyed by `students.id`, and since a `students` row is one **(person × batch)**, the same person in different batches gets **different** passwords; all zip parts of one exam attempt share **one** password.
- **Admin retrieval:** the password is surfaced on the **Results page** (`Results.tsx`) next to each student (`r.student.recording_password`, admin-only) so an admin can decrypt the GitLab-committed zip. It rides along in the `/batches/:id/results` payload via `SELECT s.*`.
- **DB schema:** recording metadata uses `recording_parts`, `recording_upload_reservations`, `students.recording_manifest_sealed_at`, `students.recording_expected_part_count`, and the per-attempt frozen `students.attempt_record_mode`; local/fresh bootstrap creates the full schema. Production must apply `migrations/20260827_recording_upload_reservations.sql` and then `migrations/20260827_recording_manifest_recovery.sql` after the 20260819 cleanup migration before deploying schema-v4 code.
- **Reset behavior:** resetting a student deletes both completed-part metadata and upload reservations, clears the frozen attempt mode, but does **not** delete existing S3 objects. New attempts use a different `session-{hash(activeJti)}` namespace, so stale presigned URLs cannot overwrite them; old objects remain until the configured S3 Lifecycle rule expires them.

### Runtime and deployment paths
- There are **five** frontend/backend runtime modes in practice — confirm which one is actually being tested before concluding a fix does or doesn't work:
  - Vite dev mode from `client/src/**` (`npm run dev` in `client/`)
  - static/public mode from `public/index.html` + `public/assets/**`; it is a separate build path and is currently out of sync with `client/dist` (`public` references `index-B0b8CXOg.js`, while `client/dist` references `index-DjJvykcg.js`)
  - **Local Docker verification**, via `docker-compose.local.yml`: exactly `app` and `database`; the app serves the built `client/dist` because `SERVE_STATIC=true`, and connects to the Supabase PostgreSQL container with `DATABASE_SSL=false`
  - **Vercel production**, per `vercel.json`: builds/serves `dist/server/index.js` (compiled from `src/**` via the clean `npm run build:server` path) for `/api/*`, and `client/dist/**` as static assets for everything else. This is the actual production path; `public/**` is separate and not served by Vercel.
  - **Ubuntu VPS**, via `deploy-vps.sh`: generates Docker/Caddy/Compose files under `/opt/e-proc/runtime`, rebuilds from a detached checkout under `/opt/e-proc/app`, uses a long-lived DB pool, and applies each migration once through `schema_migrations`.
- A successful `client/dist` or `dist/server` build does not affect a different runtime path unless that path's artifacts are also rebuilt/synced. These paths can silently diverge from `src/**`/`client/src/**`.
- `deploy-vps.sh` currently upserts `admin/admin321` on every run, resetting that account's password. Do not run it on a real production host without accepting/fixing this behavior, and change the credential immediately after bootstrap. The script also hard-resets/cleans only its deployment checkout; never store manual files under `/opt/e-proc/app`.
- **Vercel build cache gotcha (confirmed 2026-07-21):** a fix was correctly committed to `src/server/routes/student.ts` and `dist/server/routes/student.js` (verified present via `git show <commit>:<path>`), Vercel auto-deployed the correct commit, yet the live deployment still served the old behavior. Redeploying with **"Use existing Build Cache" = OFF** resolved it. If a change appears correctly committed and deployed from the right commit but still doesn't take effect live, try a cache-disabled redeploy before assuming the code itself is wrong.

### Queue / AI grading
- AI grading is manual: submitting an essay does not enqueue work. The batch creator clicks **AI Grade** in Batches List, producing one backend invocation for the batch.
- Only `batches.created_by` may run AI grading for that batch; role `admin` is not an ownership bypass. Create/Edit has no AI flag.
- Batches List shows **AI Grade** when `exam_type === 'essay'`, the current user is `created_by`, and that user's current AI setting is `verified`. This applies to old and new essay batches.
- Each submitted student is sent independently with all assigned questions, answers, and rubrics. Oversized/invalid-context payloads fall back to smaller chunks for that student only. Batch grading uses a bounded worker pool (`AI_GRADING_CONCURRENCY`, default 3, clamped 1–5); request tokens, student-scoped reads and student-scoped transactional publish prevent responses from crossing students.
- Every LLM attempt uses a fresh `request_token` and request-scoped grading keys. Missing/mismatched correlation is rejected unless the complete response can be matched by strong unique identifiers; `AI_GRADING_CORRELATION_RETRIES` controls correlation-only retries.
- Each claimed student also receives a persisted `ai_grading_attempt_token` and `ai_grading_started_at`. A stale lease is recovered after `AI_GRADING_STALE_MS` (never less than the safe execution budget plus 60 seconds); a late worker cannot publish or fail the replacement attempt because every write is fenced by its token.
- Per-question scores are 0.00–1.00. Final score is `ROUND(SUM(question scores) / total questions * 10, 2)`; unanswered questions are included as zero.
- Each successful student is published in its own transaction with per-question scores/feedback plus `students.ai_final_score` and `students.ai_summary_feedback`. Completed students are skipped on batch retry after a partial run.
- Results supports creator-only initial grade/retry/regrade through `POST /admin/batches/:batchId/students/:studentId/ai-grade`. A failed regrade preserves the previously completed score and feedback; replacement occurs only after the new complete result passes correlation and validation.
- `user_ai_settings` is user-owned. Manual grading resolves the creator's current verified row at click time rather than a batch-bound setting. API keys are AES-256-GCM encrypted and never returned to the frontend. Save requires a short-lived token proving the exact draft passed Test Connection.
- Provider behavior is selected by `api_protocol`: OpenAI Chat, OpenAI Responses, Anthropic Messages, Gemini Generate Content, or Ollama Generate. Provider name, base URL, key, and model are user-editable.
- Quiz batches never enqueue AI jobs. `submitExamAtomically()` scores exact normalized option sets immediately using each question's configured `score` and writes `Correct`/`Incorrect` feedback.
- The retired per-question queue/global plaintext setting have been removed. Current grading uses only `user_ai_settings` plus grading state on `batches`, `students`, and `exam_questions`.
- `AI_GRADE_SAFE_BUDGET_MS=270000` assumes the deployed Function can run close to 300 seconds; it does not raise the host timeout. `vercel.json` does not explicitly pin `maxDuration`, so verify Fluid Compute/function duration in the deployed project before relying on this budget.

### Question bank and admin read paths
- Question types are `Coding`, `Conceptual`, `Fill-in`, `Debug`, `SingleChoice`, and `MultipleChoice`; levels are `Easy`, `Medium`, and `Hard`.
- Questions can be imported from separate essay/quiz Excel formats or created manually at `/admin/questions/new`. Existing questions can be edited at `/admin/questions/:id/edit`; the primary ID is immutable on edit and case-sensitive on create.
- Manual create/update validation lives in `src/server/services/adminQuestions.ts`. Quiz questions require 2–6 non-empty options keyed A–F, valid correct-answer keys, exactly one correct key for `SingleChoice`, and `score > 0`. Non-quiz writes clear quiz fields and use score `1`.
- Question/rubric text is stored verbatim. Candidate/admin HTML rendering uses a DOMPurify allowlist; the edit page includes a sanitized live preview matching the exam renderer.
- `/questions/paged` and `/questions/catalog-summary` replace full-catalog/aggregate request fan-out for the current Question Bank UI. `/batches/:id/results/summary` is paginated and loads per-student question/event/recording detail lazily. Legacy full-result endpoints remain for compatibility/export.
- `ADMIN_PERF_LOGS=true` logs all admin request timing/DB query metrics; otherwise only requests slower than `ADMIN_SLOW_REQUEST_MS` (default 1000ms) are logged.

### Blueprint modes
Batches support two blueprint formats for question assignment:
- **Legacy (array)**: `[{ module, easy, medium, hard }]` — select by module only
- **New (object)**: `{ blueprintMode: 'module' | 'type', items: [...] }` — `'type'` mode selects by module + question type
- `parseBlueprintCompat()` in `admin.ts` normalizes both formats

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | **Yes** | — | Signs admin and student JWTs. Server exits at startup if missing. Use ≥32 random bytes. |
| `JWT_EXPIRES_IN` | Legacy/unread | — | Current admin login hard-codes `24h`; this env variable has no effect unless the code changes. |
| `DATABASE_URL` | Prod | — | PostgreSQL connection string. Absent = SQLite mode. |
| `ALLOWED_ORIGINS` | No | `http://localhost:5173` | CORS whitelist, comma-separated |
| `SESSION_SECRET` | No | `'secret'` | Express session secret. **Set this in production.** |
| `SKIP_TIME_CHECK` | No | — | Set to `'true'` to bypass exam time-window validation in any mode |
| `AI_SETTINGS_ENCRYPTION_KEY` | **Yes for AI** | — | 32-byte base64 or 64-hex AES key used to encrypt/decrypt user LLM API keys. Keep stable across deployments. |
| `AI_GRADING_CONCURRENCY` | No | `3` | Maximum students graded concurrently inside one batch invocation; clamped to 1–5. Set `1` for sequential fallback. |
| `AI_GRADING_CORRELATION_RETRIES` | No | `2` | Extra retries for response-correlation mismatch; clamped to 0–3, with a fresh request token per attempt. |
| `AI_GRADING_LLM_TIMEOUT_MS` | No | `60000` | Timeout for each LLM request; clamped to 1–120 seconds. |
| `AI_GRADING_MAX_PROMPT_CHARS` | No | `80000` | Pre-emptive per-student chunk threshold. |
| `AI_GRADE_SAFE_BUDGET_MS` | No | `270000` | Stops starting another student before the intended 300-second host ceiling; does not configure Vercel duration. |
| `AI_GRADING_STALE_MS` | No | `360000` | Student/batch lease recovery threshold; clamped to 1–30 minutes and forced to at least safe budget + 60 seconds. |
| `SERVE_STATIC` | Local/self-host | `false` | When `true`, Express serves `client/dist` and fails startup if its `index.html` is missing. |
| `DATABASE_SSL` | Local PostgreSQL | TLS enabled | Set to `false` only for the trusted local Compose database; production PostgreSQL keeps TLS. |
| `ANSWER_FLUSH_INTERVAL` | Legacy | `5000` | The exam answer endpoint now persists directly; retained only for the unused legacy buffer code. |
| `DB_POOL_MAX` | No | `4` | Free-tier/serverless-safe PostgreSQL pool maximum; use the Supabase transaction pooler. |
| `DB_POOL_MIN` | No | `0` | Do not hold minimum idle connections in Vercel serverless instances. |
| `DB_CONNECT_TIMEOUT_MS` | No | `15000` | PostgreSQL connect timeout per attempt. |
| `DB_CONNECT_ATTEMPTS` | No | `2` | PostgreSQL startup connect attempts, clamped to 1–5. |
| `DATABASE_SSL` | No | enabled | Set to `false` only for the local Docker Supabase PostgreSQL service, which does not expose TLS. Production Supabase connections keep SSL enabled by default. |
| `STATEMENT_TIMEOUT` | No | `30s` | PostgreSQL session statement timeout applied during initialization. |
| `ADMIN_PERF_LOGS` | No | — | `true` logs every admin request's wall/DB/query metrics. |
| `ADMIN_SLOW_REQUEST_MS` | No | `1000` | Slow-admin-request log threshold when full perf logs are off. |
| `AZURE_OPENAI_ENDPOINT` | Azure only | — | Base URL for Azure OpenAI-compatible calls. |
| `AZURE_OPENAI_DEPLOYMENT` | Azure only | — | Azure deployment name; overrides the configured model. |
| `AWS_ACCESS_KEY_ID` | Rec | — | IAM key for S3 recording uploads. Absent → recording endpoint returns 503. |
| `AWS_SECRET_ACCESS_KEY` | Rec | — | IAM secret for S3. |
| `AWS_REGION` | No | `us-east-1` | S3 bucket region. |
| `S3_RECORDINGS_BUCKET` | Rec | — | S3 bucket that stores exam screen recordings. |

## Important project-specific notes

- There is drift between current TypeScript source and legacy/generated JS checked into the repo. Prefer `src/**` and `client/src/**` when reasoning about behavior.
- The frontend build uses hashed filenames, so any manual static sync to `public/` must update `public/index.html` to the new hash.
- `npm test` uses Node's default discovery under `test/`. `npm run test:postgres` runs dedicated cases against a non-production database. `npm run test:local` also verifies idempotent schema-v3 → schema-v4 recording migrations, the built app, and manual AI Grade end to end against local PostgreSQL.
- For frontend changes that affect actual exam behavior, verify against the runtime path being served, not just against source edits or `client/dist` output.
- Active server DB mode is selected consistently by `DATABASE_URL`: absent means SQLite; present means PostgreSQL. `src/ai/queue.ts` is a legacy worker with stale `USE_SQLITE` logic and is not the active queue path.
- The DB layer auto-converts `?` placeholders to `$1/$2/...` style when running in PostgreSQL mode (see `query()` in `postgres.ts`). Do not mix placeholder styles in a single query string.
- If a frontend fix appears correct in source but has no effect in manual testing, check `public/index.html`, the hashed asset filename under `public/assets`, and the built bundle contents before debugging the React code further.
- The `admin_users` table is not listed in the DB-layer table descriptions of older doc, but it is created at startup alongside the others.
- Excel imports use Multer `memoryStorage()` with a 5 MiB/one-file limit. Keep the cap because Vercel functions parse the workbook in memory.
- SheetJS is pinned to the official `xlsx@0.20.3` tarball. Do not change it back to the stale npm registry release `0.18.5`; keep treating uploaded workbooks as untrusted input.
- Root and client production dependency audits currently have zero findings. Run both `npm audit --omit=dev` commands when changing dependencies. Minification and disabled source maps are not a security boundary.

## Verification expectations

- Frontend exam changes should be verified against the actual served runtime, not just via source inspection.
- For static/public runtime, the minimum verification loop is:
  1. `npm run build:client`
  2. sync the new `client/dist/assets/*.js` bundle into `public/assets`
  3. update `public/index.html` to the new hash
  4. hard-reload the browser and retest
- For anti-cheat changes, verify both browser behavior and backend recording:
  - browser-side blocking / auto-submit behavior
  - network calls to `/api/student/violation` and `/api/student/exam/submit`
  - resulting counts in admin results / violations data
  - on real macOS Chrome/Edge: Command/Option DevTools/View Source/Print shortcuts, screenshot best-effort telemetry, Mission Control, Spaces, Split View, Hot Corners, external display and Sidecar behavior
  - confirm that `suspicious_paste`, `rapid_text_insertion`, `multiple_display_detected`, and counter records for `concurrent_session` remain forensic-only and never cause counter-based auto-lock
  - for S3 mode: verify observed PUT 2xx → persisted acknowledgement → `/exam/recording-complete` → DB-only finalize, including lost-callback/reload replay without a second PUT
- For student auth changes, verify the full auth flow:
  - `POST /student/verify` returns `student_token`
  - `localStorage.studentToken` is set after confirm page
  - All student API requests carry `Authorization: Bearer <token>` header
  - Requests without token return 401
- Before deploying the 2026-08-08 schema changes to Supabase, run `migrations/20260808_mac_exam_hardening.sql` manually and confirm its verification query returns both expected rows.
- Before deploying the 2026-08-09 concurrent-session detection to Supabase, run `migrations/20260809_concurrent_session_detection.sql` manually and confirm its verification query returns the `exam_sessions.student_id` row. Also confirm `req.ip` resolves to the real client IP behind Vercel (`trust proxy` is on); if every request shows the same IP, concurrent-session detection is neutralized.
- Before deploying the free-tier integrity changes, run `migrations/20260810_free_tier_exam_integrity.sql` manually on Supabase. It deliberately aborts only for duplicate access codes or duplicate question orders; resolve those rows rather than deleting them implicitly. Historical duplicate question assignments are preserved. Atomic start plus the unique question-order index prevents new start races. Confirm the final verification queries return six student columns and two unique indexes.
- Also run `migrations/20260810_violation_event_idempotency.sql` before deploying the idempotent violation handler. Startup schema readiness verifies the required columns and exact unique-index definitions; a half-migrated database remains unavailable (`503`) instead of serving exam traffic.
- Apply the ordered migrations through `20260818_admin_startup_fast_path.sql`, deploy the schema-1/2-compatible cleanup release, wait for old invocations to finish, then apply `20260819_remove_legacy_ai.sql`. The cleanup migration removes the retired queue/global setting and records schema version 2. `DEPLOY.md` is the authoritative production order.
- Drain every active S3 attempt/tab using the old frontend bundle before this release. Old clients do not call `/recording-seal` and intentionally have no insecure legacy-finalize bypass.
- Apply `20260827_recording_upload_reservations.sql` and then `20260827_recording_manifest_recovery.sql` after `20260819_remove_legacy_ai.sql` and before deploying this recording-recovery release. They record schema versions 3 and 4; the current runtime intentionally rejects schema v1/v2/v3.
- Build failures in `StudentExam.tsx` are easy to trigger if old duplicated code blocks are left behind during refactors; if Vite reports a stray `}` or duplicate definitions, inspect the bottom half of the file for leftover blocks from earlier edits.

## Files worth checking together for exam/anti-cheat work

- `client/src/pages/StudentExam.tsx`
- `client/src/pages/StudentLogin.tsx` (verify flow: access code → studentToken)
- `client/src/pages/StudentConfirm.tsx` (stores studentToken to localStorage)
- `client/src/services/api.ts` (request interceptors for both admin and student tokens)
- `src/server/middleware/studentAuth.ts` (student JWT verification; `StudentTokenPayload.jti`)
- `src/server/middleware/sessionTracker.ts` (concurrent-session tracking + `detectConcurrentSession`)
- `src/server/routes/student.ts`
- `src/server/cache.ts`
- `client/src/hooks/useMonacoJavaCompletions.ts` (IntelliSense snippet sizes — relevant for suspicious_paste threshold calibration)
- `public/index.html` (if testing static runtime)
- `public/assets/*.js` (to confirm the runtime bundle really contains the expected change)

## Notable current behavior

- **Free-tier integrity hardening (2026-08-10):** no periodic heartbeat, Realtime channel, challenge table, or append-only activity stream was added. Existing exam requests remain the only session activity source, avoiding recurring Vercel invocations and Supabase writes.
- A newly verified student JWT has a fresh `jti`, persisted in `students.active_jti`. `studentAuthMiddleware` checks it on every protected student request, so a later verify revokes the previous token. Reset clears `active_jti`.
- Exam start now runs through a single-connection transaction with a student row lock. The deadline is `min(started_at + duration, batch.end_time)` and resume never extends it. A unique index on `(student_id, question_order)` is supplied by the 2026-08-10 migration; historical duplicate question assignments are not destructively rewritten.
- Essay answers debounce for 5 seconds and quiz answers for 500ms, with a separate timer per question. Dirty answers are batch-saved, and the full current answer map is included in manual submit. Backend writes are guarded by `status='in_progress'` plus deadline checks and do not rely on the process-local buffer.
- Server-owned timeout/violation/concurrent-session submission can only commit answers already received by the backend. Browser-only dirty text is not attached to those server-side triggers and can still be lost; HTTP autosave cannot guarantee zero-loss before delivery.
- Assigned attempts reference mutable `question_bank` rows. Manual AI Grade reads current question/rubric values when the button is clicked, and quiz finalization reads current correct answers/score at submit; there is no immutable question version snapshot.
- Manual submit, timeout, violation, recording-stop, concurrent-session, and long-disconnect paths converge on an idempotent transactional submit. `students.submitted_at` and `submit_reason` record the outcome. Essay grading is a separate creator-owned manual action; batch grading skips completed students, while targeted regrade preserves the old published result unless the replacement fully validates.
- S3 recording remains direct browser-to-S3 with 5-minute parts. After the attempt is confirmed `in_progress`, the client reserves the active interval's logical upload identity early; a reload therefore leaves explicit missing evidence instead of silently shortening the manifest. Answer submission completes first; `stopAndSave()` releases screen sharing, seals the exact upload-ID manifest, drains outstanding uploads, and finalizes. A PUT-2xx acknowledgement is saved in attempt-scoped `sessionStorage` before the completion callback; `/submit` can replay it and `/recording-reconcile` only finalizes already-acknowledged database rows. Any submit path with an unfinished S3 manifest sets `recording_incomplete=true` and receives a 60-minute recording-only grace window; answers/questions remain blocked. `attempt_record_mode` is frozen at verification/start so later batch edits cannot switch an active attempt between `none`, `local`, and `s3`.
- Newly imported students receive an 8-character access code generated with `crypto.randomInt`; the login screen accepts legacy 6-character codes as well as new 8-character codes. Supabase uniqueness is enforced by the 2026-08-10 migration with collision retry in the import route.

- Clipboard attempts are counted as violations. Clipboard interception is handled inside the Monaco CodeEditor component (not via DOM events on the wrapper), because Monaco stops DOM event propagation internally.
- Fullscreen must activate successfully on Confirm before `/exam` is entered. During an active exam, event + watchdog reconciliation records `fullscreen_exit` after 5 seconds outside fullscreen and a second event after another 5 seconds, which reaches the normal two-violation lock threshold and triggers client auto-submit.
- Chrome side-panel extensions (e.g. Monica AI) opened during a fullscreen exam are detected as `extension_panel` via a `document.documentElement` width-shrink heuristic — see "Extension side-panel detection" above. Do not use `window.innerWidth`/`window.screen.width` for this; they don't change when a side panel is open.
- Violation locking threshold: `violation_count >= 2` for any single lockable type OR `total_violations >= 2`; `recording_stopped` locks on the first occurrence. `suspicious_paste`, `rapid_text_insertion`, `multiple_display_detected`, and `concurrent_session` are explicit forensic-only counter exceptions and do not increment `violations`. A real concurrent-session overlap still locks directly through the server-owned enforcer.
- `suspicious_paste` is detected via Monaco `onDidChangeModelContent` with threshold ≥ **300 chars** per change event (lowered from 1200 on 2026-07-29 to catch Notes-copied answers; see Anti-Cheat v2 section). **Do not raise it back or re-enable large IntelliSense snippets** without pairing the length check with a snippet exclusion — the larger snippets in `useMonacoJavaCompletions.ts` (up to `GlobalExceptionHandler` at 1093 chars) now exceed 300 and would false-positive if typed; they are only safe because they are currently unused.
- `focus_lost` is detected via `window` `blur`/`focus` events with a **3-second grace timer** (rewritten 2026-07-29, replacing the old 5s×3 polling heartbeat). A `blur` starts the timer; a `focus` before it fires cancels it; if it fires with focus still lost, the violation is reported. Event-based rather than polling to avoid aliasing short focus-losses.
- Each violation report also appends a row to `violation_events` (timestamp, type, `text_length`, `content_preview` ≤500 chars, `question_id`, optional `metadata_json`). Admins review these via the violation-detail popup on the Results page.
- Server auto-submits the exam when the deadline passes (detected on `GET /exam/questions` → returns `410 Gone`, `reason: 'timeout'`).
- Server auto-submits the exam when the student has been disconnected for more than 120 seconds (`reason: 'absent_too_long'`).
- Runtime anti-cheat behavior depends heavily on `client/src/pages/StudentExam.tsx`; many server-side changes alone will not alter what candidates experience in the browser.
- Student API authentication uses JWT (`studentToken`), not the `x-student-id` header. Any code that still reads `x-student-id` from request headers on student endpoints is stale and should be replaced.
- `POST /api/student/exam/start` requires `studentAuthMiddleware` and derives `studentId` from the verified JWT; the legacy `student_id` body field sent by the frontend is ignored for identity.
- There is intentionally no pre-exam checkbox/acknowledgement API or DB gate. Controls must use automatically observed browser/server signals; candidate self-attestation was removed as non-enforcing.
- Internal diagnostic endpoints (`/api/test-db`, `/api/cache/flush`) require admin JWT and await startup readiness. `/api/init-tables`, queue process/stats, and generic queue stats have been removed.
