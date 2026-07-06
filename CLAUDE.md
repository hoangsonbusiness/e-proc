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

## Important project-specific notes

- There is drift between current TypeScript source and legacy/generated JS checked into the repo. Prefer `src/**` and `client/src/**` when reasoning about behavior.
- The frontend build uses hashed filenames, so any manual static sync to `public/` must update `public/index.html` to the new hash.
- There is no dedicated lint or test script in the current package files. Validation is primarily via build commands and manual runtime verification.
- For frontend changes that affect actual exam behavior, verify against the runtime path being served, not just against source edits or `client/dist` output.
- `src/server/routes/student.ts` contains a non-obvious exam-state hazard: `POST /exam/answer` currently changes student status from `in_progress` to `submitted` on the first buffered save. Any work on resume logic, anti-cheat, or submission flow should re-check this behavior before assuming the status model is correct.
- The DB layer and route layer mix SQLite-style `?` placeholders and PostgreSQL-style `$1` placeholders depending on code path. Before changing queries, verify which runtime path (`DATABASE_URL` present vs absent) is intended. `db.query()` in `src/server/db/postgres.ts` auto-translates `?` → `$N` for the Postgres branch, so **`?` is always the safe/portable choice** for any query that can run under both DB modes (i.e. anything not already inside a `USE_SQLITE` / `else` Postgres-only branch); a stray `$1` in a shared code path (not inside an explicit non-SQLite branch) will crash under SQLite with "Too many parameter values were provided." One such bug (the duplicate-ID check in `POST /questions/import`) was found and fixed this way — if you add new shared queries, default to `?`.
- `FileCache` in `src/server/cache.ts` initializes `dataDir`/`queueFile` as class field defaults (`path.join(process.cwd(), 'data')` / `.../data/queue.json`) so the constructor's `ensureDataDir()` has a valid path outside Vercel/production. If these fields are ever refactored, keep them initialized before `ensureDataDir()` runs — leaving them unassigned crashes `npm run dev` immediately on startup (`ERR_INVALID_ARG_TYPE` in `fs.mkdirSync`).
- **Fixed:** `query()` in `src/server/db/postgres.ts` used to decide how to run a SQLite statement purely by checking `text.trim().toUpperCase().startsWith('SELECT')` — anything else (including `INSERT ... RETURNING id`) went through `stmt.run(...)`, which always returns `rows: []`. This silently broke any `INSERT ... RETURNING` under local SQLite dev: `POST /batches/:id/students/import` in `admin.ts` reads `studentResult.rows[0]?.id` after such an insert, got `undefined`, and `if (!studentId) continue;` skipped exam_questions assignment for every invited student (student row created, but with zero questions assigned). Fix: the SQLite branch now also routes through `.all()` when the SQL text contains `RETURNING` (case-insensitive), not just when it starts with `SELECT`. Postgres was never affected (its branch always returns real rows regardless of statement type). If similar "insert succeeded but the returned row is empty" symptoms show up again in local SQLite dev, check this function first.
- If a frontend fix appears correct in source but has no effect in manual testing on the real deployment, check whether `deploy/scripts/deploy.sh` has actually been re-run on the EC2 instance since the fix landed on `main` (see "Actual production deployment" above) before assuming the React code itself is wrong.

## Verification expectations

- Frontend exam changes should be verified against the actual served runtime, not just via source inspection. For local manual testing, run both `npm run dev` (backend) and `cd client && npm run dev` (Vite) and exercise the real flow in a browser — this matches production's `client/dist` + Node backend split more closely than editing source and assuming it works.
- Syncing to `public/assets` + `public/index.html` is only relevant if you've confirmed the environment you're testing against actually serves from `public/` (uncommon — see "Static runtime path" above). Don't do it by default for this project's real deployment; instead rely on `deploy/scripts/deploy.sh` rebuilding `client/dist/` on the server.
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
