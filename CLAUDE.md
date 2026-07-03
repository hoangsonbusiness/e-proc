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
  - `/` → login
  - `/confirm` → confirm email / start exam
  - `/exam` → active exam page
  - `/submit` → submission complete page
- Admin flow routes:
  - `/admin`, `/admin/dashboard`, `/admin/questions`, `/admin/batches`, `/admin/batches/:id/students`, `/admin/batches/:id/results`, `/admin/settings`
- API wrapper: `client/src/services/api.ts`
  - `adminApi` contains admin CRUD/reporting endpoints
  - `studentApi` contains exam lifecycle endpoints and violation reporting

### Backend
- HTTP server entry: `src/server/server.ts`
- Express app setup: `src/server/index.ts`
  - mounts `/api/admin` and `/api/student`
  - exposes health, queue, cache flush, and stats endpoints
- Admin routes: `src/server/routes/admin.ts`
- Student routes: `src/server/routes/student.ts`

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
- `question_bank` columns relevant to import/grading/export (see "Question bank: groups and HTML-safe plain text" below):
  - `module` — topic/category (e.g. "Pointers", "OOP")
  - `question_group` — nullable, names the question set a question belongs to (e.g. `CPP_PRINT_IOT`, `CPP_EMB_AUTOSAR`), used to disambiguate question sets that otherwise share the same `module`/`level`/`type` framework
  - `question_sample` — original content as imported, may contain HTML markup (rendered to students via sanitized `dangerouslySetInnerHTML`)
  - `question_plain` — nullable, HTML-stripped plain-text version of `question_sample`, auto-generated at import time; used anywhere the question text is consumed by something other than the student-facing renderer (AI grading prompts, Excel export)

### Exam lifecycle
- Student verification and exam start live in `src/server/routes/student.ts`
- Frontend exam behavior lives mainly in `client/src/pages/StudentExam.tsx`
- Answers are not written directly on every keystroke:
  - frontend debounces saves
  - backend buffers answers through `src/server/cache.ts`
  - buffered answers are flushed periodically or on submit
- Violations are reported from the frontend through `studentApi.reportViolation(...)` and stored in the `violations` table
- Anti-cheat behavior is concentrated in `client/src/pages/StudentExam.tsx`:
  - clipboard attempts are blocked on the answer textarea and reported as violations
  - fullscreen exit is handled with a 5-second grace period; if the student stays out of fullscreen beyond that, the client records `fullscreen_exit` and force-submits the exam
  - tab switching still uses the generic violation pipeline
- The student runtime relies on `localStorage` for `studentId` and `duration`, and passes `x-student-id` to student APIs. When debugging exam state, inspect both localStorage and network requests.

### Static runtime path
- There are two frontend runtime modes in practice:
  - Vite dev mode from `client/src/**`
  - static/public mode from `public/index.html` + `public/assets/**`
- For behavior changes in `StudentExam.tsx`, always confirm which runtime is actually being served before concluding a fix works. A successful `client/dist` build does not affect static runtime unless `public/` is updated too.

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

### Export filenames
- `GET /api/admin/batches/:id/students/export` and `GET /api/admin/batches/:id/results/export` (in `src/server/routes/admin.ts`) derive the downloaded filename from the batch's `name` (looked up via `SELECT name FROM batches WHERE id = ?`), not from the batch id. Filenames are `<sanitized-batch-name>-students.xlsx` / `<sanitized-batch-name>-results.xlsx`; if the batch has no name, it falls back to `batch-<id>`.
- Filename sanitization/encoding helpers live in `src/utils/string.ts`:
  - `sanitizeFilename()` strips filesystem-unsafe characters and collapses whitespace to `_`.
  - `buildContentDisposition()` emits both an ASCII-diacritics-stripped `filename=` fallback and a full UTF-8 `filename*=` (RFC 5987) value, so Vietnamese batch names with diacritics survive the download with the correct display name in modern browsers while still degrading gracefully elsewhere.
- When testing these endpoints manually from a shell, be aware that passing non-ASCII batch names as inline `curl -d '...'` command-line arguments can get mangled by the shell/terminal encoding (observed on Windows Git Bash) before the request ever reaches the server — this is a testing-tool artifact, not an application bug. Write the JSON payload to a UTF-8 file and use `curl --data-binary @file.json` instead when verifying Unicode behavior.

## Important project-specific notes

- There is drift between current TypeScript source and legacy/generated JS checked into the repo. Prefer `src/**` and `client/src/**` when reasoning about behavior.
- The frontend build uses hashed filenames, so any manual static sync to `public/` must update `public/index.html` to the new hash.
- There is no dedicated lint or test script in the current package files. Validation is primarily via build commands and manual runtime verification.
- For frontend changes that affect actual exam behavior, verify against the runtime path being served, not just against source edits or `client/dist` output.
- `src/server/routes/student.ts` contains a non-obvious exam-state hazard: `POST /exam/answer` currently changes student status from `in_progress` to `submitted` on the first buffered save. Any work on resume logic, anti-cheat, or submission flow should re-check this behavior before assuming the status model is correct.
- The DB layer and route layer mix SQLite-style `?` placeholders and PostgreSQL-style `$1` placeholders depending on code path. Before changing queries, verify which runtime path (`DATABASE_URL` present vs absent) is intended. `db.query()` in `src/server/db/postgres.ts` auto-translates `?` → `$N` for the Postgres branch, so **`?` is always the safe/portable choice** for any query that can run under both DB modes (i.e. anything not already inside a `USE_SQLITE` / `else` Postgres-only branch); a stray `$1` in a shared code path (not inside an explicit non-SQLite branch) will crash under SQLite with "Too many parameter values were provided." One such bug (the duplicate-ID check in `POST /questions/import`) was found and fixed this way — if you add new shared queries, default to `?`.
- `FileCache` in `src/server/cache.ts` initializes `dataDir`/`queueFile` as class field defaults (`path.join(process.cwd(), 'data')` / `.../data/queue.json`) so the constructor's `ensureDataDir()` has a valid path outside Vercel/production. If these fields are ever refactored, keep them initialized before `ensureDataDir()` runs — leaving them unassigned crashes `npm run dev` immediately on startup (`ERR_INVALID_ARG_TYPE` in `fs.mkdirSync`).
- If a frontend fix appears correct in source but has no effect in manual testing, check `public/index.html`, the hashed asset filename under `public/assets`, and the built bundle contents before debugging the React code further.

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
- Build failures in `StudentExam.tsx` are easy to trigger if old duplicated code blocks are left behind during refactors; if Vite reports a stray `}` or duplicate definitions, inspect the bottom half of the file for leftover blocks from earlier edits.

## Files worth checking together for exam/anti-cheat work

- `client/src/pages/StudentExam.tsx`
- `client/src/services/api.ts`
- `src/server/routes/student.ts`
- `src/server/cache.ts`
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

- Clipboard attempts are counted as violations.
- Leaving fullscreen for more than 5 seconds records `fullscreen_exit` and force-submits the exam from the client.
- Generic violation locking still uses the backend count in `/student/violation`.
- Runtime anti-cheat behavior depends heavily on `client/src/pages/StudentExam.tsx`; many server-side changes alone will not alter what candidates experience in the browser.
