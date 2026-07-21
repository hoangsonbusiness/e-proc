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
  - `ai_queue`
  - `ai_settings`
  - `admin_users`

### Security model

#### Admin authentication
- `POST /api/admin/login` → returns JWT (`expiresIn: 24h`)
- Stored in `localStorage.adminToken`; sent as `Authorization: Bearer <token>` header
- All `/api/admin/*` routes after `/login` and `/setup` require `authMiddleware`
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
  - Accepted violation types (server-enforced whitelist in `src/server/routes/student.ts`, `validTypes`): `tab_switch`, `fullscreen_exit`, `copy_attempt`, `cut_attempt`, `paste_attempt`, `devtools_open`, `extension_panel`, `screenshot_attempt`, `print_attempt`
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
- The student runtime relies on `localStorage` for `studentId` (display) and `duration`, and `studentToken` for authentication. When debugging exam state, inspect both localStorage and network `Authorization` headers.
- Server-side timer guard in `GET /exam/questions`: if `exam_deadline` has passed, the server auto-submits and returns `410 Gone` with `reason: 'timeout'`
- Disconnect guard: if `disconnected_at` is set for > 120 seconds, the server auto-submits on next `GET /exam/questions` and returns `410 Gone` with `reason: 'absent_too_long'`

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
- `public/index.html` (if testing static runtime)
- `public/assets/*.js` (to confirm the runtime bundle really contains the expected change)

## Notable current behavior

- Clipboard attempts are counted as violations. Clipboard interception is handled inside the Monaco CodeEditor component (not via DOM events on the wrapper), because Monaco stops DOM event propagation internally.
- Leaving fullscreen for more than 5 seconds records `fullscreen_exit`. A second fullscreen exit after the first violation triggers force-submit from the client.
- Chrome side-panel extensions (e.g. Monica AI) opened during a fullscreen exam are detected as `extension_panel` via a `document.documentElement` width-shrink heuristic — see "Extension side-panel detection" above. Do not use `window.innerWidth`/`window.screen.width` for this; they don't change when a side panel is open.
- Violation locking threshold: `violation_count >= 2` for any single type OR `total_violations >= 2`.
- Server auto-submits the exam when the deadline passes (detected on `GET /exam/questions` → returns `410 Gone`, `reason: 'timeout'`).
- Server auto-submits the exam when the student has been disconnected for more than 120 seconds (`reason: 'absent_too_long'`).
- Runtime anti-cheat behavior depends heavily on `client/src/pages/StudentExam.tsx`; many server-side changes alone will not alter what candidates experience in the browser.
- Student API authentication uses JWT (`studentToken`), not the `x-student-id` header. Any code that still reads `x-student-id` from request headers on student endpoints is stale and should be replaced.
- Internal diagnostic endpoints (`/api/test-db`, `/api/queue/*`, `/api/cache/flush`, `/api/stats`) require admin JWT. `/api/init-tables` has been removed — DB init runs automatically on server startup.
