# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

## Repository structure

This is a full-stack technical assessment platform with a React/Vite frontend and an Express/TypeScript backend.

### Source of truth vs generated artifacts
- **Edit application source in**:
  - `client/src/**` for frontend
  - `src/**` for backend and shared server-side logic
- **Do not treat these as source of truth** unless you are intentionally updating deployed/static artifacts:
  - `public/assets/**`
  - `client/dist/**`
  - `server/**`
  - `index.js`
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
  - `/admin`, `/admin/dashboard`, `/admin/questions`, `/admin/batches`, `/admin/batches/:id/students`, `/admin/batches/:id/results`, `/admin/settings`
- API wrapper: `client/src/services/api.ts`
  - `adminApi` contains admin CRUD/reporting endpoints; attaches admin JWT via request interceptor
  - `studentApi` contains exam lifecycle endpoints and violation reporting; attaches student JWT via request interceptor (see **Student auth** section below)

### Backend
- HTTP server entry: `src/server/server.ts`
- Express app setup: `src/server/index.ts`
  - mounts `/api/admin` and `/api/student`
  - exposes health (`/api/health`) and internal diagnostic endpoints (require admin JWT)
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
- Core tables are created in the DB layer on startup:
  - `question_bank`
  - `batches`
  - `students`
  - `exam_questions`
  - `violations`
  - `violation_events` (append-only forensic log — one row per violation occurrence; see Anti-Cheat v2 section)
  - `ai_queue`
  - `ai_settings`
  - `admin_users`

### Security model

#### Admin authentication & roles
- `POST /api/admin/login` → returns JWT (`expiresIn: 24h`) + `role`; login response and the JWT payload both carry `role` (read from `admin_users.role`, no longer hard-coded)
- Stored in `localStorage.adminToken` (+ `localStorage.adminRole`); sent as `Authorization: Bearer <token>` header
- All `/api/admin/*` routes after `/login` and `/setup` require `authMiddleware`
- **Roles (added 2026-07-29):** `admin_users.role` ∈ `{'admin', 'mod'}` (default `'admin'`; pre-existing users migrate to `'admin'`). `requireAdmin` middleware (`src/server/middleware/auth.ts`) gates admin-only routes with 403.
  - **User management** (`GET/POST/DELETE /api/admin/users`) is `requireAdmin`-only. Frontend page `/admin/users` (`UserManagement.tsx`); the nav link and page are hidden/redirected for mods via `useAuth().isAdmin` — but the **backend `requireAdmin` is the real gate**, the frontend hiding is only UX.
  - **S3 recording toggle per batch** (`batches.record_enabled`, default false): only `role === 'admin'` may set it. Enforced server-side in `POST/PUT /api/admin/batches` — on create a mod's flag is forced false; on update a mod's request **keeps the existing DB value unchanged** (mod can neither enable nor disable). The batch form checkbox is `disabled` for mods (UX only).
- Internal diagnostic endpoints (`/api/test-db`, `/api/queue/*`, `/api/cache/flush`, `/api/stats`) also require admin JWT

#### Student authentication
After the security hardening (2026-07), student auth works via a signed JWT rather than an unverified header:

1. Student enters access code → `POST /api/student/verify`
2. Server validates and returns `student_token` (JWT, `expiresIn: 4h`, payload: `{ studentId, batchId }`)
3. `StudentLogin.tsx` passes token through React Router state → `StudentConfirm.tsx`
4. On "Start exam", `StudentConfirm.tsx` stores `studentToken` and `studentId` in `localStorage`
5. All subsequent student API calls (`getQuestions`, `saveAnswer`, `submit`, `reportViolation`, etc.) attach the token via the axios request interceptor in `api.ts`
6. Backend `studentAuthMiddleware` verifies the JWT; `req.studentPayload.studentId` is the authoritative source — **`x-student-id` header is no longer used or trusted**
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
- Answers are not written directly on every keystroke:
  - frontend debounces saves (2-second debounce)
  - backend buffers answers through `src/server/cache.ts`
  - buffered answers are flushed periodically or on submit
- Violations are reported from the frontend through `studentApi.reportViolation(type)` and stored in the `violations` table
- Accepted violation types (server-enforced whitelist in `src/server/routes/student.ts`, `validTypes`): `tab_switch`, `fullscreen_exit`, `copy_attempt`, `cut_attempt`, `paste_attempt`, `devtools_open`, `extension_panel`, `screenshot_attempt`, `print_attempt`, `suspicious_paste`, `focus_lost`, `recording_stopped`
- Locking occurs when `violation_count >= 2` for any single type or `total_violations >= 2`. **As of 2026-07-29 the log-only exemption was removed** — `suspicious_paste` and `focus_lost` are now lockable like every other type and count toward `total_violations` (see Anti-Cheat v2 section for the rationale behind the change). **`recording_stopped` is a special case: it locks the exam on the FIRST occurrence** (see Screen recording section) — stopping the screen share is treated as deliberate evasion.
- Every violation report is additionally appended to the `violation_events` table (append-only forensic log); `suspicious_paste` events carry a `content_preview` (first 500 chars of the pasted text) — see Anti-Cheat v2 section
- Anti-cheat behavior is concentrated in `client/src/pages/StudentExam.tsx`:
  - clipboard attempts (`copy_attempt`, `cut_attempt`, `paste_attempt`) are intercepted inside the Monaco CodeEditor via `addCommand()` and reported as violations
  - fullscreen exit triggers a 5-second grace period timer; if the student stays out of fullscreen past the timer, `fullscreen_exit` is recorded and the exam is force-submitted
  - tab switching (visibilitychange) reports `tab_switch` violation
  - DevTools key shortcuts (F12, Ctrl+Shift+I/J/C/K, Ctrl+U) are blocked and report `devtools_open` violation (with 10-second cooldown)
  - `beforeprint` reports `print_attempt`; PrintScreen key reports `screenshot_attempt`
  - **Extension side-panel detection (`extension_panel`, added 2026-07)**: detects Chrome side-panel extensions (e.g. Monica AI) that open alongside the exam while remaining fullscreen. See dedicated subsection below — the detection metric matters and is easy to get wrong.
  - locking occurs when `violation_count >= 2` for any single type or `total_violations >= 2`

#### Extension side-panel detection (`extension_panel`)
Chrome side-panel extensions (Monica AI and similar "AI sidebar" extensions) render via the browser's native Side Panel API. This panel visually shrinks the page's rendered layout while `document.fullscreenElement` remains set — no `fullscreenchange` event fires, so the pre-existing fullscreen-exit detection never sees it.

**Critical, counter-intuitive measurement finding (confirmed via live testing 2026-07-21):** while fullscreen and a side panel is open, `window.innerWidth`, `window.screen.width`, and `window.outerWidth` all stay **frozen** at their pre-panel values — they do not reflect the shrink at all. Only `document.documentElement.getBoundingClientRect().width` (equivalently `document.body.clientWidth`) reflects the real layout shrink (~465px observed with Monica). An earlier implementation attempt compared `window.screen.width - window.innerWidth` and silently never triggered because of this — do not reintroduce that comparison.

Current implementation in `StudentExam.tsx`:
- A baseline `document.documentElement.getBoundingClientRect().width` is recorded in the `fullscreenchange` handler whenever `document.fullscreenElement` becomes truthy (stored in `documentWidthBaselineRef`), and re-recorded lazily by the poller if it mounts after fullscreen was already active (resume-after-reload case).
- A `setInterval` poller (`VIEWPORT_CHECK_INTERVAL_MS` = 1500ms) runs only while `started && !locked && !submitting` and `document.fullscreenElement` is set.
- Each tick compares `documentWidthBaselineRef.current - currentWidth` against `VIEWPORT_SHRINK_THRESHOLD_PX` (80px).
- The shrink must persist for `VIEWPORT_SUSTAIN_POLLS` (2) consecutive ticks (~3s) before firing `handleViolation('extension_panel')`, to avoid false positives from transient layout jitter — following the same debounce lesson as the fullscreen-exit and previously-removed devtools window-size heuristic (see comment near `StudentExam.tsx:325-327` in earlier revisions).
- No `resize`/`visualViewport.resize` event is relied on, since side-panel open/close doesn't reliably fire those in all browsers — polling is used instead.

If this detection stops working again, verify in this order before touching the logic: (1) confirm the deployed bundle actually contains the fix (see Vercel deploy note below — this bit twice), (2) re-measure `documentElement`/`innerWidth`/`screen.width` live with a throwaway static HTML page served over `http://localhost` (not `file://` — extensions don't inject into `file://` pages) since browser/extension internals can change behavior across Chrome versions.

#### Anti-Cheat v2 (added 2026-07-28)

Two new detection layers were added to handle vectors that bypass existing clipboard intercept:

**1. `suspicious_paste` — Maccy (macOS) and `Win+V` (Windows clipboard history) detection**

Maccy and Windows built-in clipboard history (`Win+V`) inject text via the OS Accessibility API, bypassing Monaco's `addCommand()` keyboard intercept entirely. The text appears in the editor as if typed, but Monaco still fires `onDidChangeModelContent` with a large `change.text.length`.

Detection in `client/src/components/CodeEditor.tsx` (`handleEditorMount`):
- Attaches `editor.onDidChangeModelContent` listener (only when prop `onSuspiciousPaste` is provided)
- Skips `isFlush: true` events (fired when value prop is set externally, e.g. resume exam load)
- **Threshold: 300 characters per single change event** (lowered from 1200 on 2026-07-29 — the old 1200 let typical Notes-copied answers of 300–800 chars slip through, which was the actual bypass being exploited)
  - **⚠️ False-positive caveat:** the larger IntelliSense snippets (`SpringController` 366, `JpaEntity` 422, `MockMvcTest` 403, `HandlerInterceptor` 546, `WebMvcConfigurer` 869, `GlobalExceptionHandler` 1093) now exceed the threshold and **would be flagged if typed**. This is currently safe **only because those snippets are not in use**. If they are re-enabled, the length-only check must be paired with a snippet exclusion (e.g. check whether the Monaco suggest widget is open at the time of the change) before keeping the 300 threshold. Snippets still safely below threshold: `psvm` (~30), `hashequals` (220).
- On trigger, passes the first 500 chars of `change.text` and the true `change.text.length` to `onSuspiciousPaste(preview, textLength)`
- 10-second cooldown to avoid duplicate reports from the same paste action
- Calls `onSuspiciousPaste(preview, length)` prop → `handleSuspiciousPaste()` in `StudentExam.tsx` → `handleViolation('suspicious_paste', { contentPreview, textLength, questionId })`
- Backend: **lockable** (as of 2026-07-29 — no longer log-only); the paste preview is stored in `violation_events.content_preview`

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

Previously the forensic watermark timestamp was frozen at the time React rendered the watermark JSX (once on mount). It now uses a `watermarkTime` state that updates every 30 seconds, so screenshots taken later in the exam carry a more accurate timestamp for forensic tracing.

**4. Admin Results page — violations breakdown (2026-07-28, updated 2026-07-29)**

`GET /api/admin/batches/:id/results` returns `violations_breakdown: { [type]: count }` alongside the existing `violations` (total). `client/src/pages/Results.tsx` displays each type as an orange (🟠) badge. (The earlier blue-badge distinction for log-only types was removed on 2026-07-29 when `suspicious_paste`/`focus_lost` became lockable — every type is now a lockable violation.)

**5. Forensic `violation_events` table + paste-content popup (added 2026-07-29)**

The `violations` table is keyed by `(student_id, type)` and only stores a running count — it cannot record individual occurrences or their content. A new append-only table `violation_events` was added (created in `src/server/db/postgres.ts` for both SQLite and PostgreSQL):
- Columns: `id, student_id, batch_id, type, text_length, content_preview (VARCHAR 500), question_id, created_at`
- `POST /api/student/violation` inserts one row per report (in addition to the existing count UPDATE on `violations`), reading optional `content_preview` / `text_length` / `question_id` from the request body. `content_preview` is server-side truncated to 500 chars and is only populated for `suspicious_paste`; `focus_lost` rows store timestamp + type only.
- `GET /api/admin/batches/:id/results` returns a `violation_events` array per student.
- `client/src/pages/Results.tsx` shows a "🔍 Xem chi tiết (N)" button that opens a modal listing each event (type, timestamp, char length, question id, and the paste preview in a monospace block) — so admins can adjudicate a flag from the actual pasted text without querying the DB.
- Server-side timer guard in `GET /exam/questions`: if `exam_deadline` has passed, the server auto-submits and returns `410 Gone` with `reason: 'timeout'`
- Disconnect guard: if `disconnected_at` is set for > 120 seconds, the server auto-submits on next `GET /exam/questions` and returns `410 Gone` with `reason: 'absent_too_long'`

#### Screen recording → AWS S3 (added 2026-07-29, moved to S3 upload)

The exam records the candidate's full screen and uploads it **directly to AWS S3** during the exam (via presigned PUT URLs). The video never resides on the candidate's machine — this closes the exam-leak hole of the earlier "save-local + candidate-commits-to-GitLab" model (the candidate controlled the evidence and could copy the questions out).

**Recording is per-batch (added 2026-07-29):** only applies when the batch has `record_enabled = true` (admin-only toggle — see Admin roles). `/verify` returns `record_enabled`; it flows login → `/confirm` (router state) → `localStorage.recordEnabled` → `/exam`. When false, `StudentConfirm` skips screen-share entirely (candidate enters the exam directly) and `StudentExam` skips the `recording_stopped` handler and the resume-after-reload guard. The `POST /exam/recording-url` endpoint also **rechecks `batches.record_enabled` server-side** and returns 403 if off, so the flag cannot be bypassed client-side. When the batch does have it enabled, recording is mandatory to start.

Architecture (presigned URL — sidesteps Vercel serverless payload/timeout limits, since the video goes client→S3, not through the backend):
```
Client records → every 5 min cuts a part → asks backend for a presigned PUT URL
  → PUTs the blob straight to S3 → retry-queue on failure (does not block the exam)
S3 key: recordings/{batchId}/{studentId}/part{NNN}.webm  (batchId/studentId from JWT, not client)
Deletion: S3 Lifecycle rule auto-expires objects after N days (no backend script)
```

- **Backend:** `POST /api/student/exam/recording-url` (`studentAuthMiddleware`) returns a presigned PUT URL from `src/server/services/s3.ts` (`createRecordingUploadUrl`). AWS credentials live only in backend env; the URL expires in 15 min. The S3 key is built from `batchId`/`studentId` in the JWT so a candidate cannot overwrite another's video. Returns `503` if S3 env is not configured (`isS3Configured()`).
- **Frontend module** `client/src/services/examRecorder.ts` (singleton **outside React** — survives the `/confirm` → `/exam` navigation):
  - **Full-screen only:** `getDisplayMedia({ video: { displaySurface: 'monitor' } })`; a shared tab/window (`displaySurface !== 'monitor'`) is refused. Requires **Chrome/Edge + HTTPS**; Safari/Firefox blocked at confirm.
  - **Config:** VP9 (fallback VP8), 5 fps, ~600 kbps → ~22 MB per **5-minute part**. Each part: ask for a presigned URL, then `fetch(url, { method: 'PUT', body: blob })` straight to S3. Failed uploads go to a **retry queue** (exponential backoff, max 5 attempts) that runs in the background and never blocks the exam.
- **Lifecycle:** `requestSetup()` (monitor share only — **no folder picker** anymore) is called in `StudentConfirm.tsx#handleStartExam` **in the click gesture, BEFORE `requestFullscreen()`** (fullscreen consumes the user-activation that `getDisplayMedia` needs — order matters). `start()` begins recording. `stopAndSave()` at the top of `handleSubmit` in `StudentExam.tsx` covers all three submit paths (manual / cheating auto-submit / timeout); wrapped in try/catch so an upload error never blocks submission.
- **`recording_stopped` violation:** `track.onended` (candidate clicks "Stop sharing") → `handleViolation('recording_stopped')`. Backend locks on the **first** occurrence (`type === 'recording_stopped'` short-circuits the `>= 2` rule in `student.ts`). Registered via `examRecorder.setOnRecordingStopped()` after `/exam` mounts; if the track already ended before registration, the callback fires immediately.
- **Resume-after-reload:** F5 resets the singleton, so if the candidate re-enters `/exam` while running but `examRecorder.isActive()` is false, a blocking modal forces them to re-share the screen.
- **Env required (set on Vercel):** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_RECORDINGS_BUCKET`. The bucket needs a **CORS policy** allowing `PUT` from the deployment origin and a **Lifecycle rule** to auto-delete. IAM user should be scoped to `PutObject` on `recordings/*` only.
- **macOS caveat:** the first `getDisplayMedia` requires granting Screen Recording permission to Chrome in System Settings **and restarting Chrome**. Because exams are time-gated, candidates should do this during a **practice exam** beforehand, not on exam day.

### Static runtime path
- There are **three** frontend/backend runtime modes in practice — confirm which one is actually being tested before concluding a fix does or doesn't work:
  - Vite dev mode from `client/src/**` (`npm run dev` in `client/`)
  - static/public mode from `public/index.html` + `public/assets/**` (a separate, currently-stale build path — last known update predates the `extension_panel` feature; do not assume it's in sync with `client/dist`)
  - **Vercel production**, per `vercel.json`: builds/serves `dist/server/index.js` (compiled from `src/**` via `npm run build:server` → `tsc`, outDir `dist`) for `/api/*`, and `client/dist/**` (via `npm run build:client`) as static assets for everything else. This is the actual production path — `public/**` and the legacy root `server/**` directory are **not** what Vercel serves, despite both existing in the repo (see "Source of truth" note above).
- A successful `client/dist` or `dist/server` build does not affect a different runtime path unless that path's artifacts are also rebuilt/synced. All three paths can silently diverge from `src/**`/`client/src/**` at once.
- **Vercel build cache gotcha (confirmed 2026-07-21):** a fix was correctly committed to `src/server/routes/student.ts` and `dist/server/routes/student.js` (verified present via `git show <commit>:<path>`), Vercel auto-deployed the correct commit, yet the live deployment still served the old behavior. Redeploying with **"Use existing Build Cache" = OFF** resolved it. If a change appears correctly committed and deployed from the right commit but still doesn't take effect live, try a cache-disabled redeploy before assuming the code itself is wrong.

### Queue / AI grading
- Queue and answer-buffer orchestration live in `src/server/cache.ts`
- AI evaluation provider settings are also read there (`ai_settings` plus env fallback)
- The server initializes DB, cache, and queue processing on startup in `src/server/index.ts`
- Supported AI providers: `gemini`, `openai`, `azure`, `deepseek`, `groq`, `openrouter`, `ollama`
- AI API keys are stored in the `ai_settings` table in the database

### Blueprint modes
Batches support two blueprint formats for question assignment:
- **Legacy (array)**: `[{ module, easy, medium, hard }]` — select by module only
- **New (object)**: `{ blueprintMode: 'module' | 'type', items: [...] }` — `'type'` mode selects by module + question type
- `parseBlueprintCompat()` in `admin.ts` normalizes both formats

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | **Yes** | — | Signs admin and student JWTs. Server exits at startup if missing. Use ≥32 random bytes. |
| `JWT_EXPIRES_IN` | No | `24h` | Admin token expiry |
| `DATABASE_URL` | Prod | — | PostgreSQL connection string. Absent = SQLite mode. |
| `ALLOWED_ORIGINS` | No | `http://localhost:5173` | CORS whitelist, comma-separated |
| `SESSION_SECRET` | No | `'secret'` | Express session secret. **Set this in production.** |
| `SKIP_TIME_CHECK` | No | — | Set to `'true'` to bypass exam time-window validation in any mode |
| `GEMINI_API_KEY` | No | — | Fallback AI key if `ai_settings` table is empty |
| `ANSWER_FLUSH_INTERVAL` | No | `5000` | Milliseconds between answer buffer flushes |
| `QUEUE_PROCESS_INTERVAL` | No | `10000` | Milliseconds between AI queue processing ticks |
| `DB_POOL_MAX` | No | `10` | PostgreSQL connection pool max size |
| `DB_POOL_MIN` | No | `2` | PostgreSQL connection pool min size |
| `AWS_ACCESS_KEY_ID` | Rec | — | IAM key for S3 recording uploads. Absent → recording endpoint returns 503. |
| `AWS_SECRET_ACCESS_KEY` | Rec | — | IAM secret for S3. |
| `AWS_REGION` | No | `us-east-1` | S3 bucket region. |
| `S3_RECORDINGS_BUCKET` | Rec | — | S3 bucket that stores exam screen recordings. |

## Important project-specific notes

- There is drift between current TypeScript source and legacy/generated JS checked into the repo. Prefer `src/**` and `client/src/**` when reasoning about behavior.
- The frontend build uses hashed filenames, so any manual static sync to `public/` must update `public/index.html` to the new hash.
- There is no dedicated lint or test script in the current package files. Validation is primarily via `npx tsc --noEmit` (both backend and frontend) and manual runtime verification.
- For frontend changes that affect actual exam behavior, verify against the runtime path being served, not just against source edits or `client/dist` output.
- **`USE_SQLITE` logic is inconsistent across files** — `postgres.ts` and `admin.ts` use `!process.env.DATABASE_URL`; `student.ts` uses `process.env.USE_SQLITE === 'true' || process.env.NODE_ENV !== 'production'`. Before changing DB queries, verify which runtime path is intended.
- The DB layer auto-converts `?` placeholders to `$1/$2/...` style when running in PostgreSQL mode (see `query()` in `postgres.ts`). Do not mix placeholder styles in a single query string.
- If a frontend fix appears correct in source but has no effect in manual testing, check `public/index.html`, the hashed asset filename under `public/assets`, and the built bundle contents before debugging the React code further.
- The `admin_users` table is not listed in the DB-layer table descriptions of older doc, but it is created at startup alongside the others.
- `multer` is configured with `memoryStorage()` only (no disk writes). File size limit is not currently set — consider adding a `limits: { fileSize }` option for production.
- The `xlsx` package (`v0.18.5`) is end-of-life with known vulnerabilities. Treat uploaded Excel files as untrusted input.

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
- For student auth changes, verify the full auth flow:
  - `POST /student/verify` returns `student_token`
  - `localStorage.studentToken` is set after confirm page
  - All student API requests carry `Authorization: Bearer <token>` header
  - Requests without token return 401
- Build failures in `StudentExam.tsx` are easy to trigger if old duplicated code blocks are left behind during refactors; if Vite reports a stray `}` or duplicate definitions, inspect the bottom half of the file for leftover blocks from earlier edits.

## Files worth checking together for exam/anti-cheat work

- `client/src/pages/StudentExam.tsx`
- `client/src/pages/StudentLogin.tsx` (verify flow: access code → studentToken)
- `client/src/pages/StudentConfirm.tsx` (stores studentToken to localStorage)
- `client/src/services/api.ts` (request interceptors for both admin and student tokens)
- `src/server/middleware/studentAuth.ts` (student JWT verification)
- `src/server/routes/student.ts`
- `src/server/cache.ts`
- `client/src/hooks/useMonacoJavaCompletions.ts` (IntelliSense snippet sizes — relevant for suspicious_paste threshold calibration)
- `public/index.html` (if testing static runtime)
- `public/assets/*.js` (to confirm the runtime bundle really contains the expected change)

## Notable current behavior

- Clipboard attempts are counted as violations. Clipboard interception is handled inside the Monaco CodeEditor component (not via DOM events on the wrapper), because Monaco stops DOM event propagation internally.
- Leaving fullscreen for more than 5 seconds records `fullscreen_exit`. A second fullscreen exit after the first violation triggers force-submit from the client.
- Chrome side-panel extensions (e.g. Monica AI) opened during a fullscreen exam are detected as `extension_panel` via a `document.documentElement` width-shrink heuristic — see "Extension side-panel detection" above. Do not use `window.innerWidth`/`window.screen.width` for this; they don't change when a side panel is open.
- Violation locking threshold: `violation_count >= 2` for any single type OR `total_violations >= 2`, applied uniformly to **every** type. The former `suspicious_paste`/`focus_lost` log-only exemption (`isLogOnly`/`LOG_ONLY_TYPES`) was **removed on 2026-07-29** — both are now lockable and count toward the total.
- `suspicious_paste` is detected via Monaco `onDidChangeModelContent` with threshold ≥ **300 chars** per change event (lowered from 1200 on 2026-07-29 to catch Notes-copied answers; see Anti-Cheat v2 section). **Do not raise it back or re-enable large IntelliSense snippets** without pairing the length check with a snippet exclusion — the larger snippets in `useMonacoJavaCompletions.ts` (up to `GlobalExceptionHandler` at 1093 chars) now exceed 300 and would false-positive if typed; they are only safe because they are currently unused.
- `focus_lost` is detected via `window` `blur`/`focus` events with a **3-second grace timer** (rewritten 2026-07-29, replacing the old 5s×3 polling heartbeat). A `blur` starts the timer; a `focus` before it fires cancels it; if it fires with focus still lost, the violation is reported. Event-based rather than polling to avoid aliasing short focus-losses.
- Each violation report also appends a row to `violation_events` (timestamp, type, `text_length`, `content_preview` ≤ 500 chars for `suspicious_paste`, `question_id`). Admins review these via the "🔍 Xem chi tiết" popup on the Results page.
- Server auto-submits the exam when the deadline passes (detected on `GET /exam/questions` → returns `410 Gone`, `reason: 'timeout'`).
- Server auto-submits the exam when the student has been disconnected for more than 120 seconds (`reason: 'absent_too_long'`).
- Runtime anti-cheat behavior depends heavily on `client/src/pages/StudentExam.tsx`; many server-side changes alone will not alter what candidates experience in the browser.
- Student API authentication uses JWT (`studentToken`), not the `x-student-id` header. Any code that still reads `x-student-id` from request headers on student endpoints is stale and should be replaced.
- Internal diagnostic endpoints (`/api/test-db`, `/api/queue/*`, `/api/cache/flush`, `/api/stats`) require admin JWT. `/api/init-tables` has been removed — DB init runs automatically on server startup.
