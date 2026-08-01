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
  - `/admin`, `/admin/dashboard`, `/admin/questions`, `/admin/batches`, `/admin/batches/:id/students`, `/admin/batches/:id/results`, `/admin/settings`, `/admin/users` (superadmin-only, see **Admin authentication** below)
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
  - `batches` (has nullable `practice_exam_id` — set = the batch is a Practice batch, see **Practice exams** below)
  - `students`
  - `exam_questions`
  - `violations`
  - `violation_events` (append-only forensic log — one row per violation occurrence; see Anti-Cheat v2 section)
  - `ai_queue` (has `kind` column: `'exam'` grades an `exam_questions` row, `'practice'` grades a `practice_submissions` row — for practice jobs, `exam_question_id` actually holds the `practice_submissions.id`)
  - `ai_settings`
  - `practice_exams` / `practice_submissions` (see **Practice exams** below)
- `question_bank` columns relevant to import/grading/export (see "Question bank: groups and HTML-safe plain text" below):
  - `module` — topic/category (e.g. "Pointers", "OOP")
  - `question_group` — nullable, names the question set a question belongs to (e.g. `CPP_PRINT_IOT`, `CPP_EMB_AUTOSAR`), used to disambiguate question sets that otherwise share the same `module`/`level`/`type` framework
  - `question_sample` — original content as imported, may contain HTML markup (rendered to students via sanitized `dangerouslySetInnerHTML`)
  - `question_plain` — nullable, HTML-stripped plain-text version of `question_sample`, auto-generated at import time; used anywhere the question text is consumed by something other than the student-facing renderer (AI grading prompts, Excel export)
  - `admin_users`

### Security model

#### Admin authentication & roles
- `POST /api/admin/login` → returns JWT (`expiresIn: 24h`) **and** the account's `role` (`'admin'` | `'superadmin'`), both in the response body and inside the JWT payload (read from `admin_users.role`, no longer hard-coded)
- Stored in `localStorage.adminToken` (+ `localStorage.adminRole`); sent as `Authorization: Bearer <token>` header
- All `/api/admin/*` routes after `/login` require `authMiddleware`
- **Roles:** `admin_users.role` ∈ `{'admin', 'superadmin'}`. `requireSuperAdmin` (`src/server/middleware/auth.ts`) gates privileged routes with 403.
  - **Recording mode per batch** (`batches.record_mode` ∈ `{'none','local','s3'}`, default `'none'`; replaced the old boolean `batches.record_enabled` toggle): only `role === 'superadmin'` may set it to anything other than `'none'`. Enforced server-side in `POST/PUT /api/admin/batches` — on create a plain admin's requested mode is **forced to `'none'`**; on update it **keeps the existing DB `record_mode` unchanged** (a plain admin can neither enable nor change it, for `local` OR `s3`). The batch form dropdown is `disabled` for non-superadmins (UX only). `record_enabled` is kept in sync (`= record_mode === 's3'`) for backward compat but `record_mode` is the source of truth.
- Internal diagnostic endpoints (`/api/test-db`, `/api/queue/*`, `/api/cache/flush`, `/api/stats`) also require admin JWT
- **Self-service admin registration has been removed** (2026-07 security hardening): `GET /is-initialized` and `POST /setup` no longer exist. Instead:
  - The first `admin_users` row is seeded automatically at DB startup by `seedSuperAdmin()` in `src/server/db/postgres.ts`, **only when the table is empty** — username/password default to `supperadmin` / `superadmin123#2nf` (role `superadmin`), overridable via the `SUPERADMIN_USERNAME` / `SUPERADMIN_PASSWORD` env vars. **Change this password immediately after first login** (`PUT /api/admin/change-password`) — the default lives in git history.
  - All other admin accounts can only be created/edited/deleted by an existing `superadmin`, via `GET/POST/PUT/DELETE /api/admin/users` (`src/server/routes/admin.ts`), gated by the `requireSuperAdmin` middleware (`src/server/middleware/auth.ts`) which checks `req.adminUser.role === 'superadmin'`. Guards in place: an account cannot demote or delete itself, and the last remaining `superadmin` cannot be deleted.
  - Frontend: `client/src/pages/UserManagement.tsx` (route `/admin/users`) is the only UI for this — gated both by `PrivateRoute`'s `requireSuperAdmin` prop (`client/src/components/PrivateRoute.tsx`) and by conditionally rendering the "User Management" nav link (`isSuperAdmin` from `AuthContext`) across all admin pages. Non-superadmin accounts never see the link and are bounced to `/admin/dashboard` if they navigate to the URL directly — though the real enforcement is server-side (`requireSuperAdmin`), since client-side gating alone is not a security boundary.

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

### Practice exams (long-form .docx exams, separate from question_bank)
A second exam mode, fully independent of the question-bank/blueprint pipeline:

- **Data model**: `practice_exams` (id, name, `content_html` from mammoth docx→HTML conversion, `content_plain` via `stripHtml()` for the AI grading prompt) and `practice_submissions` (one row per student: answer + ai/trainer score/feedback). A batch becomes a Practice batch by having `batches.practice_exam_id` set (blueprint is stored NULL for those); one batch is either blueprint-based or practice-based, never both.
- **Admin import**: `POST /api/admin/practice/import` (`src/server/routes/admin.ts`) accepts a `.docx` upload (multer memory storage) + optional name, converts with `mammoth.convertToHtml`, stores both HTML and stripped plain text. Managed in `client/src/pages/PracticeManagement.tsx` at `/admin/practice` (list/preview/delete; delete is blocked while any batch references the exam). Batch creation (`BatchManagement.tsx`) has a "Question Bank | Practice" tab — Practice mode swaps the blueprint UI for a practice-exam `<select>` and sends `practice_exam_id` instead of `blueprint`.
- **Student flow**: same access-code login. `POST /student/verify` returns `exam_kind: 'practice' | 'exam'` (derived from `batches.practice_exam_id`); `StudentConfirm.tsx` routes to `/practice` instead of `/exam` accordingly. `client/src/pages/StudentPractice.tsx` renders the docx HTML (DOMPurify-sanitized) in a left panel and a single Monaco CodeEditor (one answer for the whole exam) on the right. It intentionally duplicates the anti-cheat/timer/violation logic of `StudentExam.tsx` — changes to anti-cheat behavior must be applied to BOTH files.
- **Student API** (`src/server/routes/student.ts`): `GET /student/practice` (auto-starts on first call: sets deadline + creates the `practice_submissions` row; enforces the same 410 timeout/absent guards as `/exam/questions`), `POST /student/practice/answer` (direct DB update — no buffer, since it's a single answer, client debounces 2s), `POST /student/practice/submit`. Violations and the disconnect beacon reuse the shared `/student/violation` and `/exam/disconnect` endpoints.
- **AI grading**: `cache.addToQueue(id, studentId, 'practice')` — queue jobs carry `kind`; practice jobs JOIN `practice_submissions`+`practice_exams` and grade the whole answer against `content_plain` holistically (no rubric columns). Results written back to `practice_submissions`.
- **Trainer review**: `GET /api/admin/batches/:id/practice-results` + `PUT /api/admin/practice-results/:studentId`; `Results.tsx` detects `batch.practice_exam_id` and renders the practice results table/review panel instead of the per-question view. Excel export (`GET /api/admin/batches/:id/practice-results/export`, wired to the same "Export Excel" button) is a single sheet, one row per student (Email, Status, Violation Count, Answer, AI Score, AI Feedback, Trainer Score, Trainer Feedback) — different shape from the regular exam export (`.../results/export`, one sheet per student, one row per question), since a practice batch has one holistic answer per student rather than several graded questions.
- **Students import**: `POST /batches/:id/students/import` skips blueprint validation and question assignment entirely for practice batches (students are created with access codes only). Student reset/delete and batch delete also clean up `practice_submissions`.
- **Run code (self-check)** — "▶ Run Code" button on `/practice`, **local-first** to keep load off the t3.micro:
  - `python`/`c`/`cpp` run **in the student's browser** (`client/src/services/localRunner.ts`): Pyodide (real CPython→WASM) for Python, JSCPP (JS interpreter, C++ *subset* — fine for junior exercises, not full g++) for C/C++. Each runtime runs in a reused Web Worker loaded from CDN (first run downloads ~5-10s, warm runs are instant); infinite loops are handled by `worker.terminate()` on timeout (60s cold / 8s warm). Zero server requests for these languages.
  - `cobol`/`java` have no viable browser runtime → they still go through `POST /api/student/run` (`src/server/coderunner.ts`): gcc/g++/python3/cobc (tries `-free`, falls back to fixed-format)/javac. Resource guards: **strictly sequential FIFO queue** — 1 submission compiles/runs at a time; each job's temp dir (source + binary) is deleted **synchronously before the next job starts** (disk/RAM freed between jobs), queue holds up to 20 waiting submissions (a full class), 429 beyond that; stale `coderun-*` temp dirs from a previous crash are swept at server startup. Also: 1 run per student at a time, compile timeout 10s / run 5s with process-group SIGKILL, Linux ulimits (256MB vmem / 64 procs / 10MB files), output capped 64KB, **clean env** (`PATH` only — never `DATABASE_URL`/`JWT_SECRET`), only `in_progress` students. Set `ENABLE_SERVER_CODE_RUN=false` to hard-disable server-side execution (returns 503). NOT a hard sandbox (runs as app user) — internal training only; Docker/nsjail/Judge0 is the upgrade path. One-time EC2 install: `sudo apt install -y gnucobol default-jdk` (gcc/g++/python3 only needed if server-side C/C++/Python runs are ever re-enabled for fallback).

### Code editor language support (student answer editor)
- The Monaco-based answer editor is `client/src/components/CodeEditor.tsx`. `LANGUAGE_OPTIONS`/`SupportedLanguage` there is the single source of truth for which languages appear in the student-facing "Language:" dropdown; add new languages there.
- Monaco ships `c`, `cpp`, `python`, and `csharp` as built-in languages already (`c`/`cpp` registered by its own `basic-languages/cpp/cpp.contribution.js` under two separate ids sharing one tokenizer) — no extra registration needed for any of those four.
- Monaco has **no built-in COBOL support**. `client/src/hooks/useMonacoCobolLanguage.ts` registers a minimal custom Monarch tokenizer for it (`registerCobolLanguage()`, called once from `CodeEditor`'s `beforeMount`) — keyword list only, no IntelliSense/completions (unlike the Java completions in `useMonacoJavaCompletions.ts`). If COBOL support needs to get richer (snippets, division-aware completions), extend that file following the Java completions file as a pattern.
- `detectLanguage(questionType, questionModule)` in `CodeEditor.tsx` picks the editor's *default* language from the question's `type`/`module` text (student can still override via the dropdown) — it matches `cobol`, `python` (`python|py|django|flask|pandas`), `csharp` (`c#|csharp|.net|dotnet|asp.net`), and C/C++ via `c\+\+|cpp|embedded|mcu|isr|autosar` (falls to `cpp`) or a standalone `c` word (falls to `c`). It still defaults to `java` when nothing matches, which is a holdover from this platform's original Java-exam use case — reconsider that default if this platform is now primarily used for C/C++ embedded question banks (see `D:\Workspaces\C_CPP\...` import files referenced elsewhere in this doc).

### Two independent deployment methods — keep both, don't mix them
This repo intentionally supports **two separate, independent deployment paths**. Neither depends on the other, and a change to one should not assume it applies to the other:

1. **Vercel** (`vercel.json`) — builds `dist/server/index.js` (`@vercel/node`) and serves static assets from `client/dist/**`, with `public/` referenced as the html/asset fallback path in some historical setups. This path is defined and kept in the repo for whoever/whenever Vercel is the target, but is **not what currently serves `epoc.devfasttrack.cloud`**.
2. **Self-hosted EC2 + nginx + pm2, via `deploy/scripts/deploy.sh`** — this is the method actually used for `epoc.devfasttrack.cloud` today, and it **does not use Vercel in any way**: no `vercel.json` step runs, no Vercel CLI/API is involved, nothing is deployed to Vercel's infrastructure. Building "via deploy.sh" means: SSH/EC2-console into the instance, `git pull`, rebuild `dist/` and `client/dist/` locally on that same box with plain `npm run build:*`, and restart via `pm2`. See below for the full flow.

When troubleshooting "why doesn't my change show up," first confirm **which of the two** environments you're actually looking at (their URLs differ) — don't assume Vercel-style behavior (auto-deploy on push, `public/` as the served path) applies to the EC2/deploy.sh target, and vice versa.

### Static runtime path
- There are three frontend runtime modes that have existed in this repo's history:
  - Vite dev mode from `client/src/**` (`npm run dev` in `client/`)
  - `public/index.html` + `public/assets/**` — the path referenced by the Vercel deployment method (see above). Not used by the EC2/deploy.sh deployment.
  - `client/dist/**` — built by both deployment methods, but only the EC2/deploy.sh method serves it directly (via nginx); Vercel's `vercel.json` also serves `client/dist/**` for static assets, so this path is actually shared by both.
- For behavior changes in `StudentExam.tsx`, always confirm which runtime is actually being served before concluding a fix works. If you're testing against the EC2 deployment specifically, that means `client/dist/` (rebuilt by `deploy/scripts/deploy.sh` on the server itself, not by syncing artifacts from a dev machine) — `public/` syncing is irrelevant there. If you're testing against a Vercel deployment, `public/` may matter; check `vercel.json`'s routes.

### EC2 + nginx + pm2 deployment (`deploy/scripts/deploy.sh`)
- Production at `epoc.devfasttrack.cloud` (at the time of writing) runs on a self-hosted EC2 instance — accessed via the AWS EC2 console (EC2 Instance Connect / Session Manager), not a persistent SSH key setup.
- Deploy flow: `deploy/scripts/deploy.sh`, run from `/opt/eaudit/app` on the instance. It does `git pull origin main`, `rm -rf dist client/dist`, rebuilds both (`npm run build:server`, `cd client && npm run build`), then `pm2 delete/start eaudit` running `dist/server/server.js`. It does **not** touch `public/`, and does **not** invoke Vercel in any way.
- nginx config: `deploy/nginx/eaudit.conf`. `/api/*` reverse-proxies to `http://127.0.0.1:3001` (the pm2-managed Node process); everything else is served as static files from `/opt/eaudit/app/client/dist` with SPA fallback (`try_files $uri $uri/ /index.html`).
- DB is Postgres via RDS (`DATABASE_URL` set in the EC2 instance's `.env`, not committed to the repo) — so `USE_SQLITE` is `false` on this deployment; the SQLite code paths only run in local dev.
- **Pushing to `origin/main` does not deploy anything by itself on this path.** There is no CI/CD webhook wired up as of this writing — someone must manually re-run `deploy/scripts/deploy.sh` on the EC2 instance after a push for the change to go live. If a fix "isn't showing up," the first thing to check is whether `deploy.sh` was actually re-run after the relevant commit landed on `main` — e.g. `cd /opt/eaudit/app && git log -1 --oneline` on the instance, compared against the latest commit that should be live.
- Practical corollary seen in this repo's history: a question-bank import can appear to "not save a field" when the real cause is that the import ran against still-deployed old code (before a deploy), writing an empty value for a newer column, and simply needs to be **re-imported** after the deploy actually lands — re-importing the same file goes through the `ON CONFLICT DO UPDATE` / `INSERT OR REPLACE` path and overwrites the stale empty value correctly (verified: this is not a query bug, `db.query()`'s handling of `question_group` is correct in both DB modes).

#### Screen recording — three modes: `none` / `local` / `s3` (per-batch `record_mode`)

The exam can record the candidate's full screen. Since 2026-07-30 the per-batch setting is a **3-value `record_mode`** (`batches.record_mode`, replacing the old boolean `record_enabled` — superadmin-only, see Admin roles):

- **`none`** — no recording. `StudentConfirm` skips screen-share entirely; `StudentExam` skips the `recording_stopped` handler and resume-after-reload guard.
- **`s3`** — records and uploads **directly to AWS S3** via presigned PUT URLs during the exam (details below). The video never resides on the candidate's machine.
- **`local`** — records to a folder the candidate picks (File System Access `showDirectoryPicker`); each part is **compressed + AES-256 encrypted into a `.zip` client-side** with a password the **server generates and stores, never shown to the candidate**. Candidate commits the zip folder to GitLab after the exam; an admin retrieves the password to decrypt. See the "`local` mode" subsection below. **Security caveat:** this revives (in a hardened form) the very "save-local + candidate-commits" model that S3 replaced — the candidate still controls the evidence file (can fail to commit / commit a corrupt file), and because the client must receive the password to encrypt, a technical candidate can in principle read it from the `/verify` response. `local` only limits leak damage per-batch; it does not close the hole the way `s3` does. Prefer `s3` when leak-resistance matters.

**Flow of the setting:** `/verify` returns `record_mode` (and, for `local`, `recording_password`); it flows login → `/confirm` (router state) → `localStorage.recordMode` (+ `localStorage.recordingPassword` for local) → `/exam`. `StudentExam` derives `recordEnabled = recordMode !== 'none'` so all existing recording guards keep working for both `local` and `s3`. The `POST /exam/recording-url` endpoint **rechecks `batches.record_mode === 's3'` server-side** (returns 403 otherwise), so S3 URLs cannot be obtained for `local`/`none` batches. `record_enabled` is still written (`= record_mode === 's3'`) for backward compat but `record_mode` is authoritative.

**S3 mode** (`record_mode === 's3'`): the video uploads **directly to AWS S3** during the exam (via presigned PUT URLs). The video never resides on the candidate's machine.

Architecture (presigned URL — sidesteps Vercel serverless payload/timeout limits, since the video goes client→S3, not through the backend):
```
Client records → every 5 min cuts a part → asks backend for a presigned PUT URL
  → PUTs the blob straight to S3 → retry-queue on failure (does not block the exam)
S3 key: recordings/{batchId}/{studentId}/part{NNN}.webm  (batchId/studentId from JWT, not client)
Deletion: S3 Lifecycle rule auto-expires objects after N days (no backend script)
```

- **Backend:** `POST /api/student/exam/recording-url` (`studentAuthMiddleware`) returns a presigned PUT URL from `src/server/services/s3.ts` (`createRecordingUploadUrl`). AWS credentials live only in backend env; the URL expires in 15 min. The S3 key is built from `batchId`/`studentId` in the JWT so a candidate cannot overwrite another's video. Returns `503` if S3 env is not configured (`isS3Configured()`).
- **Frontend module** `client/src/services/examRecorder.ts` (singleton **outside React** — survives the `/confirm` → `/exam` navigation; handles **both** `s3` and `local` modes):
  - **Full-screen only:** `getDisplayMedia({ video: { displaySurface: 'monitor' } })`; a shared tab/window (`displaySurface !== 'monitor'`) is refused. Requires **Chrome/Edge + HTTPS**; Safari/Firefox blocked at confirm.
  - **Config:** VP9 (fallback VP8), 5 fps, ~600 kbps → ~22 MB per **5-minute part**. In `s3` mode each part asks for a presigned URL then `fetch(url, { method: 'PUT', body: blob })` straight to S3, with a **retry queue** (exponential backoff, max 5 attempts) in the background. In `local` mode each part is zipped+encrypted and written to the chosen folder.
  - **Mode-aware API:** `isSupported(mode)` (local also needs `showDirectoryPicker`), `requestSetup(mode)` (local also prompts the folder picker **before** `getDisplayMedia`, both inside the click gesture), `start({ mode, password })`. `flushPart()` routes to S3 upload or local zip by mode.
- **Lifecycle:** `requestSetup(recordMode)` is called in `StudentConfirm.tsx#handleStartExam` **in the click gesture, BEFORE `requestFullscreen()`** (fullscreen consumes the user-activation that `getDisplayMedia`/`showDirectoryPicker` need — order matters). `start({ mode, password })` begins recording. `stopAndSave()` at the top of `handleSubmit` in `StudentExam.tsx` covers all three submit paths (manual / cheating auto-submit / timeout); wrapped in try/catch so a recording error never blocks submission. For `local`, `stopAndSave()` **awaits** the final zip write.
- **`recording_stopped` violation:** `track.onended` (candidate clicks "Stop sharing") → `handleViolation('recording_stopped')`. Backend locks on the **first** occurrence (`type === 'recording_stopped'` short-circuits the `>= 2` rule in `student.ts`). Registered via `examRecorder.setOnRecordingStopped()` after `/exam` mounts; if the track already ended before registration, the callback fires immediately. Applies to both `local` and `s3`.
- **Resume-after-reload:** F5 resets the singleton, so if the candidate re-enters `/exam` while running but `examRecorder.isActive()` is false, a blocking modal (`handleResumeRecording`) forces them to re-share the screen. For `local`, the `dirHandle` does **not** survive F5, so the candidate must re-pick the folder; the password is re-read from `localStorage.recordingPassword` (same value the server issued, so pre- and post-reload zip parts share one password).
- **Env required for `s3` (set on Vercel):** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_RECORDINGS_BUCKET`. The bucket needs a **CORS policy** allowing `PUT` from the deployment origin and a **Lifecycle rule** to auto-delete. IAM user should be scoped to `PutObject` on `recordings/*` only. `local` mode needs none of these.
- **macOS caveat:** the first `getDisplayMedia` requires granting Screen Recording permission to Chrome in System Settings **and restarting Chrome**. Because exams are time-gated, candidates should do this during a **practice exam** beforehand, not on exam day.

##### `local` mode specifics (added 2026-07-30)
- **Client-side zip encryption:** `client/src/services/examRecorder.ts` uses **`@zip.js/zip.js`** (`ZipWriter` with `password`, `encryptionStrength: 3` = AES-256, `level: 0` — no recompression since webm is already compressed). Each 5-min part becomes `exam_{stamp}_part{NNN}.zip` written to the folder via File System Access API.
- **Password provenance:** `POST /api/student/verify` generates `crypto.randomBytes(24).toString('base64url')` **once per `students` row** and stores it in `students.recording_password` (reused on subsequent `/verify` calls for that row, so resume uses the same password). It is returned to the client **only for `local` mode** (needed to encrypt) and **never displayed to the candidate**.
- **Password scope:** keyed by `students.id`, and since a `students` row is one **(person × batch)**, the same person in different batches gets **different** passwords; all zip parts of one exam attempt share **one** password.
- **Admin retrieval:** the password is surfaced on the **Results page** (`Results.tsx`) next to each student (`r.student.recording_password`, admin view) so an admin can decrypt the GitLab-committed zip. It rides along in the `/batches/:id/results` payload via `SELECT s.*`.
- **DB columns:** `batches.record_mode` (VARCHAR(16)/TEXT default `'none'`) and `students.recording_password` (TEXT), created + migrated in `src/server/db/postgres.ts` for both Postgres and SQLite. Migration backfills `record_mode='s3'` where the old `record_enabled` was true. **Deploy note (Vercel + Supabase):** these `ALTER TABLE`s run automatically at DB init on cold-start (idempotent, `IF NOT EXISTS` + try/catch), but to avoid a race on the first few requests after deploy, prefer running them manually in the Supabase SQL Editor **before** deploying.

### Queue / AI grading
- Queue and answer-buffer orchestration live in `src/server/cache.ts`
- AI evaluation provider settings are also read there (`ai_settings` plus env fallback)
- The server initializes DB, cache, and queue processing on startup in `src/server/index.ts`
- The AI grading prompt (built in `src/server/cache.ts`, inside the queue-processing job) uses `eq.question_plain` (falling back to `stripHtml(eq.question_sample)` for rows imported before this column existed) — never the raw HTML `question_sample`. Rubric fields (`rubric_must_have`/`rubric_nice_to_have`/`rubric_optional`) are still passed as-is (not HTML-stripped); they are expected to be entered as plain text via the Excel rubric columns.

### Question bank: groups and HTML-safe plain text
- Import happens via `POST /api/admin/questions/import` in `src/server/routes/admin.ts`, parsing an uploaded `.xlsx`/`.xls` with `xlsx`.
- Excel header column for question group: `QuestionGroup` (aliases also accepted: `Question Set`, `Bộ đề`). If absent/blank, `question_group` is stored as an empty string.
- `question_plain` is always (re)computed at import time from `question_sample` via `stripHtml()` in `src/utils/string.ts` — it is not user-supplied. `stripHtml()` converts block-level tags (`<br>`, `</p>`, `</li>`, `</tr>`, headings) to newlines, list items to `- ` prefixes, strips all remaining tags, and decodes a small set of HTML entities (`&nbsp;`, `&amp;`, etc.).
- Frontend: `client/src/pages/QuestionBank.tsx` shows a "Question Group" column and an independent filter dropdown (combinable with the Module filter). Distinct values come from `GET /api/admin/questions/question-groups`.
- Student-facing rendering of `question_sample` (in `client/src/pages/StudentExam.tsx`) uses `DOMPurify.sanitize(...)` before `dangerouslySetInnerHTML` — this is a separate, independent safeguard from `question_plain` and must be kept even though `question_plain` now exists.
- `client/src/pages/Results.tsx` (trainer manual-review view) still renders `q.question_sample` as plain JSX text (React-escaped, so HTML tags show up literally to the trainer) — this was not changed and is a known display quirk, not a security issue, since it isn't `dangerouslySetInnerHTML`.

### Module + question group disambiguation in exam blueprints
- The same `module` name can exist under multiple `question_group`s (e.g. "Chapter 10: Unit Testing" imported once under `CPP_EMB_PRINT_IOT` and once under `CPP_EMB_AUTOSAR`). `module` alone is therefore not a unique selector for blueprint/exam purposes — every blueprint item now carries both `module` and `question_group`.
- Backend endpoints for this (`src/server/routes/admin.ts`):
  - `GET /questions/module-groups` — distinct `{ module, question_group }` combos, used to populate Module dropdowns.
  - `GET /questions/module-group-stats` / `GET /questions/module-group-type-stats` — per-(module, question_group[, type]) counts by level, used to compute per-row "Có sẵn" availability and to validate blueprint rows.
  - `POST /batches/:id/check-feasibility` and the question-picking logic inside `POST /batches/:id/students/import` both filter by `question_group` when a blueprint item specifies one (case-insensitive, via `LOWER(question_group) = ?`); omitting `question_group` on an item (legacy blueprints) falls back to matching on `module` alone.
  - Question-picking for `students/import` is centralized in the `pickQuestionIds()` helper in `admin.ts` (replaces what used to be 6 near-duplicated inline query blocks for module/type/level combinations) — extend that helper rather than re-duplicating query blocks if new selection dimensions are added.
- Frontend (`client/src/pages/BatchManagement.tsx`): Module `<select>` dropdowns (both "By Module" and "By Module + Type" blueprint modes, in both the Create and Edit batch forms) render **combo options** built from `moduleGroups`, labeled `"<module> (<question_group>)"` (or just `<module>` when there is no group). The combo is encoded as a single option value via `comboKey()`/`decodeComboKey()` (`` `${module}|||${question_group}` ``) since a native `<select>` can only carry one string value per option. Stats/availability lookups (`getStatsForModuleGroup`, `getStatsForModuleGroupType`) and blueprint validation are keyed on the `(module, question_group)` pair, not `module` alone — this matters because two combos can share a module name with different available question counts.
- Legacy batches saved before `question_group` existed are handled in `handleEditBatch()`: blueprint items loaded from the DB are defaulted to `question_group: ''` so the combo dropdowns always have a matching option to select.
- `client/src/services/api.ts` exposes `getModuleGroups`, `getModuleGroupStats`, `getModuleGroupTypeStats` for this. The older `getModules`/`getModuleStats`/`getModuleTypeStats` (module-only, no group) are still used by `QuestionBank.tsx`'s simpler Module filter dropdown, which is a plain list/filter UI, not a blueprint-authoring UI, so it does not need combo disambiguation.

### Export filenames
- `GET /api/admin/batches/:id/students/export` and `GET /api/admin/batches/:id/results/export` (in `src/server/routes/admin.ts`) derive the downloaded filename from the batch's `name` (looked up via `SELECT name FROM batches WHERE id = ?`), not from the batch id. Filenames are `<sanitized-batch-name>-students.xlsx` / `<sanitized-batch-name>-results.xlsx`; if the batch has no name, it falls back to `batch-<id>`.
- Filename sanitization/encoding helpers live in `src/utils/string.ts`:
  - `sanitizeFilename()` strips filesystem-unsafe characters and collapses whitespace to `_`.
  - `buildContentDisposition()` emits both an ASCII-diacritics-stripped `filename=` fallback and a full UTF-8 `filename*=` (RFC 5987) value, so Vietnamese batch names with diacritics survive the download with the correct display name in modern browsers while still degrading gracefully elsewhere.
- When testing these endpoints manually from a shell, be aware that passing non-ASCII batch names as inline `curl -d '...'` command-line arguments can get mangled by the shell/terminal encoding (observed on Windows Git Bash) before the request ever reaches the server — this is a testing-tool artifact, not an application bug. Write the JSON payload to a UTF-8 file and use `curl --data-binary @file.json` instead when verifying Unicode behavior.
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
| `ENABLE_SERVER_CODE_RUN` | No | enabled | Set to `'false'` to disable server-side code execution (`POST /api/student/run` returns 503). Browser-local runs (python/c/cpp) are unaffected. |
| `SUPERADMIN_USERNAME` | No | `supperadmin` | Username seeded as the first `admin_users` row (role `superadmin`) when the table is empty. See **Admin authentication**. |
| `SUPERADMIN_PASSWORD` | No | `superadmin123#2nf` | Password for the seeded superadmin account above. Set this explicitly in production instead of relying on the hardcoded default. |
| `AWS_ACCESS_KEY_ID` | Rec | — | IAM key for S3 recording uploads. Absent → recording endpoint returns 503. |
| `AWS_SECRET_ACCESS_KEY` | Rec | — | IAM secret for S3. |
| `AWS_REGION` | No | `us-east-1` | S3 bucket region. |
| `S3_RECORDINGS_BUCKET` | Rec | — | S3 bucket that stores exam screen recordings. |

## Important project-specific notes

- There is drift between current TypeScript source and legacy/generated JS checked into the repo. Prefer `src/**` and `client/src/**` when reasoning about behavior.
- The frontend build uses hashed filenames, so any manual static sync to `public/` must update `public/index.html` to the new hash.
- There is no dedicated lint or test script in the current package files. Validation is primarily via `npx tsc --noEmit` (both backend and frontend) and manual runtime verification.
- For frontend changes that affect actual exam behavior, verify against the runtime path being served, not just against source edits or `client/dist` output.
- `src/server/routes/student.ts` contains a non-obvious exam-state hazard: `POST /exam/answer` currently changes student status from `in_progress` to `submitted` on the first buffered save. Any work on resume logic, anti-cheat, or submission flow should re-check this behavior before assuming the status model is correct.
- The DB layer and route layer mix SQLite-style `?` placeholders and PostgreSQL-style `$1` placeholders depending on code path. Before changing queries, verify which runtime path (`DATABASE_URL` present vs absent) is intended. `db.query()` in `src/server/db/postgres.ts` auto-translates `?` → `$N` for the Postgres branch, so **`?` is always the safe/portable choice** for any query that can run under both DB modes (i.e. anything not already inside a `USE_SQLITE` / `else` Postgres-only branch); a stray `$1` in a shared code path (not inside an explicit non-SQLite branch) will crash under SQLite with "Too many parameter values were provided." One such bug (the duplicate-ID check in `POST /questions/import`) was found and fixed this way — if you add new shared queries, default to `?`.
- `FileCache` in `src/server/cache.ts` initializes `dataDir`/`queueFile` as class field defaults (`path.join(process.cwd(), 'data')` / `.../data/queue.json`) so the constructor's `ensureDataDir()` has a valid path outside Vercel/production. If these fields are ever refactored, keep them initialized before `ensureDataDir()` runs — leaving them unassigned crashes `npm run dev` immediately on startup (`ERR_INVALID_ARG_TYPE` in `fs.mkdirSync`).
- **Fixed:** `query()` in `src/server/db/postgres.ts` used to decide how to run a SQLite statement purely by checking `text.trim().toUpperCase().startsWith('SELECT')` — anything else (including `INSERT ... RETURNING id`) went through `stmt.run(...)`, which always returns `rows: []`. This silently broke any `INSERT ... RETURNING` under local SQLite dev: `POST /batches/:id/students/import` in `admin.ts` reads `studentResult.rows[0]?.id` after such an insert, got `undefined`, and `if (!studentId) continue;` skipped exam_questions assignment for every invited student (student row created, but with zero questions assigned). Fix: the SQLite branch now also routes through `.all()` when the SQL text contains `RETURNING` (case-insensitive), not just when it starts with `SELECT`. Postgres was never affected (its branch always returns real rows regardless of statement type). If similar "insert succeeded but the returned row is empty" symptoms show up again in local SQLite dev, check this function first.
- If a frontend fix appears correct in source but has no effect in manual testing on the real deployment, check whether `deploy/scripts/deploy.sh` has actually been re-run on the EC2 instance since the fix landed on `main` (see "Actual production deployment" above) before assuming the React code itself is wrong.
- **`USE_SQLITE` logic is inconsistent across files** — `postgres.ts` and `admin.ts` use `!process.env.DATABASE_URL`; `student.ts` uses `process.env.USE_SQLITE === 'true' || process.env.NODE_ENV !== 'production'`. Before changing DB queries, verify which runtime path is intended.
- The DB layer auto-converts `?` placeholders to `$1/$2/...` style when running in PostgreSQL mode (see `query()` in `postgres.ts`). Do not mix placeholder styles in a single query string.
- If a frontend fix appears correct in source but has no effect in manual testing, check `public/index.html`, the hashed asset filename under `public/assets`, and the built bundle contents before debugging the React code further.
- The `admin_users` table is not listed in the DB-layer table descriptions of older doc, but it is created at startup alongside the others.
- `multer` is configured with `memoryStorage()` only (no disk writes). File size limit is not currently set — consider adding a `limits: { fileSize }` option for production.
- The `xlsx` package (`v0.18.5`) is end-of-life with known vulnerabilities. Treat uploaded Excel files as untrusted input.

## Verification expectations

- Frontend exam changes should be verified against the actual served runtime, not just via source inspection. For local manual testing, run both `npm run dev` (backend) and `cd client && npm run dev` (Vite) and exercise the real flow in a browser — this matches production's `client/dist` + Node backend split more closely than editing source and assuming it works.
- Syncing to `public/assets` + `public/index.html` is only relevant if you've confirmed the environment you're testing against actually serves from `public/` (uncommon — see "Static runtime path" above). Don't do it by default for this project's real deployment; instead rely on `deploy/scripts/deploy.sh` rebuilding `client/dist/` on the server.
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

## Files worth checking together for question bank / import / export / AI grading work

- `src/server/routes/admin.ts` (import parsing, `question_group`/`question_plain` population, export endpoints)
- `src/server/db/postgres.ts` (`question_bank` schema + migrations for both SQLite and Postgres)
- `src/server/cache.ts` (AI grading prompt construction — must use `question_plain`, not raw `question_sample`)
- `src/utils/string.ts` (`stripHtml`, `sanitizeFilename`, `buildContentDisposition`, `normalizeUnicode`)
- `client/src/pages/QuestionBank.tsx` (Module + Question Group filters, import UI)
- `client/src/services/api.ts` (`adminApi.getQuestionGroups`, other question-bank endpoints)

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
