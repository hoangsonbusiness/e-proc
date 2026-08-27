# Deploy Guide — E-Audit Platform

Hai topology production đang được repository hỗ trợ:

- **Vercel (mặc định):** frontend tĩnh + Express Function, Supabase PostgreSQL qua Transaction Pooler, và S3 nếu bật screen recording.
- **Ubuntu VPS:** `deploy-vps.sh` dựng Docker Compose + Caddy/HTTPS và kết nối Supabase bằng Session Pooler. AI grading hiện vẫn được kích hoạt thủ công từ Batches List; queue worker cũ chỉ chạy khi chủ động bật compatibility flag.

### Vì sao diff có nhiều file?

Đợt này thay đổi một luồng xuyên suốt từ browser đến database, nên một thay đổi logic tạo ra nhiều file liên quan:

| Nhóm | File chính | Ý nghĩa |
|---|---|---|
| Frontend source | `client/src/**` | retry violation, browser/display guard, recorder, answer debounce |
| Frontend artifact | `client/dist/**` | bundle hash mới mà Vercel thực sự phục vụ; được sinh bởi build, không sửa tay |
| Backend source | `src/server/**` | transaction violation, schema readiness, manual AI grading/provider layer, session enforcement |
| Backend artifact | `dist/server/**` | JavaScript Vercel thực sự chạy; được sinh bởi TypeScript build |
| Database | `migrations/**` | column/table/index bắt buộc trên Supabase |
| Regression test | `test/**`, `scripts/run-postgres-tests.mjs`, `scripts/run-local-compose-tests.mjs`, `scripts/verify-ai-grade-*.mjs` | SQLite, PostgreSQL race, local Docker và AI Grade E2E |
| Dependency/config | hai `package*.json`, `vercel.json`, `Dockerfile.local`, `docker-compose.local.yml` | dependency, lệnh test/build và local stack; `vercel.json` hiện không có cron |

Không phải mọi file trong diff đều là logic độc lập: phần lớn `dist/**`, asset hash và lockfile là artifact/dependency được sinh lại. Source of truth vẫn là `src/**`, `client/src/**`, migration và config.

## 1. Thứ tự triển khai bắt buộc

Không deploy code trước rồi mới sửa database. Thứ tự an toàn cho đợt cập nhật này:

1. Cài dependency và chạy full local gate `npm run test:local`.
2. Nếu cần xác minh provider production, giữ local stack đang chạy và chạy thêm `npm run test:ai-grade:real` với secret local; bước này có thể phát sinh traffic/chi phí thật.
3. Dừng tạo kỳ thi mới/chọn thời gian không có học viên đang thi.
4. Chạy các migration trên Supabase production theo đúng thứ tự.
5. Cấu hình/kiểm tra environment variables trên Vercel.
6. Build lại cả backend và frontend artifact.
7. Deploy Vercel, kiểm tra health và chạy một bài smoke test hoàn chỉnh.

Nếu deploy Vercel lỗi sau khi migration đã chạy, rollback deployment về commit trước trên Vercel. Các migration của đợt này chủ yếu là additive/widening; không tự `DROP` column/index để rollback database.

## 2. Kiểm tra local

- Node.js: `20.x`, `22.x` hoặc `24.x`.
- Không đặt `npm_config_ignore_scripts=true`; `better-sqlite3` cần chạy install script để test SQLite hoạt động.
- Dùng source trong `src/**` và `client/src/**`; Vercel hiện phục vụ artifact đã build trong `dist/**` và `client/dist/**` theo `vercel.json`.

Từ thư mục root của repository:

```bash
npm install
npm test
npm run build
npm audit --omit=dev
cd client && npm audit --omit=dev
```

Kết quả đã xác minh ngày 2026-08-16: `npm test` có **73 test, 69 pass, 4 PostgreSQL test skip** khi chưa cấu hình database test. Việc skip là có chủ ý; nó không chứng minh race PostgreSQL đã đúng.

### 2.1. `TEST_DATABASE_URL` dùng để làm gì?

Sáu integration test cần PostgreSQL thật để kiểm tra những hành vi SQLite không mô phỏng được:

- partial unique index của `event_id` hoạt động đúng và retry không tăng counter;
- hai `event_id` khác nhau cùng type tăng counter thành 2;
- hai transaction violation khác type chạy đồng thời vẫn nhìn thấy tổng count đúng và khóa bài;
- rollback xóa đồng thời event và counter;
- hai worker đồng thời chỉ một worker claim được AI queue job;
- batch vừa tắt AI grading làm pending job bị hủy thay vì được claim.

Test tạo schema tạm tên `test_violation`, tạo các bảng tối thiểu trong schema đó, rồi `DROP SCHEMA test_violation CASCADE` khi kết thúc. Nó không chạy bộ migration production và không chạm schema `public`, nhưng **không được trỏ vào production**.

`postgresql://.../dedicated_test_db` trước đây chỉ là placeholder minh họa, không phải chuỗi có thể chạy. `...` phải được thay bằng toàn bộ connection string thật của một PostgreSQL test riêng.

### 2.2. Tạo database test trên Supabase Free

Cách đơn giản nhất là dùng project Supabase thứ hai. Free Plan hiện cho tối đa hai project active; project thứ nhất là production, project thứ hai chỉ dùng cho test.

1. Supabase Dashboard → **New project** → tạo project, ví dụ `e-proc-test`.
2. Chờ database khởi tạo xong.
3. Trong project test, bấm **Connect**.
4. Chọn **Transaction Pooler** và copy URI đầy đủ, thường có dạng:

```text
postgresql://postgres.<PROJECT_REF>:<DB_PASSWORD>@aws-0-<REGION>.pooler.supabase.com:6543/postgres
```

Không tự đoán host/region; copy chính xác URI Dashboard hiển thị. Nếu URI chứa `[YOUR-PASSWORD]`, thay bằng database password của **project test**. Nếu password có ký tự như `@`, `:`, `/`, `#`, `%`, phải URL-encode password trước. PowerShell có thể encode bằng:

```powershell
[uri]::EscapeDataString('mat-khau-database-test')
```

5. Từ root repository, tạo file local không được commit:

```powershell
Copy-Item .env.test.example .env.test.local
notepad .env.test.local
```

6. Thay toàn bộ giá trị `TEST_DATABASE_URL=` bằng URI project test, lưu file, rồi chạy:

```powershell
npm run test:postgres
```

Script `test:postgres` tự build backend, đọc `.env.test.local`, từ chối placeholder/URL sai, sau đó chỉ chạy bốn PostgreSQL integration test. Kết quả mong đợi:

```text
tests 6
pass 6
fail 0
skipped 0
```

Nếu tiến trình bị tắt giữa chừng, schema `test_violation` có thể còn lại trong project test; lần chạy kế tiếp sẽ chủ động xóa và tạo lại schema này.

Không ghi `TEST_DATABASE_URL` vào Vercel. Đây chỉ là secret dùng trên máy developer/CI.

### 2.3. Vì sao không hard-code URL vào script?

Connection string chứa database password. Hard-code nó trong `package.json`, source hoặc commit sẽ làm lộ quyền truy cập database. Vì vậy repository chỉ cung cấp lệnh `npm run test:postgres` và file mẫu `.env.test.example`; secret thật nằm trong `.env.test.local`, đã được `.gitignore` loại trừ.

### 2.4. Full local Docker gate

Lệnh bắt buộc sau mọi thay đổi source/test/build/dependency/Docker/runtime config:

```powershell
npm run test:local
```

`docker-compose.local.yml` chạy đúng hai service:

- `database`: image `supabase/postgres:17.6.1.136`, publish `127.0.0.1:${EPROC_LOCAL_DB_PORT:-54323}`, dùng named volume và healthcheck.
- `app`: build từ `Dockerfile.local`, publish `127.0.0.1:3001`, dùng `SERVE_STATIC=true` để phục vụ `client/dist`, kết nối database service với `DATABASE_SSL=false`, và tắt legacy queue.

Gate chạy tuần tự bảy bước: build/start stack; chạy lần lượt migration recording reservation và manifest recovery hai lần; restart/xác minh schema v4; kiểm tra built React app; chạy default suite; chạy PostgreSQL integration tests; rồi chạy manual AI Grade E2E qua mock LLM.

Stack được giữ lại sau test để điều tra. Dùng:

```powershell
npm run local:logs
npm run local:down
```

Để probe provider thật, tạo `.env.ai-grade.local` đã được ignore với `AI_GRADE_REAL_PROVIDER`, `AI_GRADE_REAL_PROTOCOL`, `AI_GRADE_REAL_BASE_URL`, `AI_GRADE_REAL_API_KEY`, `AI_GRADE_REAL_MODEL`, giữ local stack đang chạy rồi thực hiện:

```powershell
npm run test:ai-grade:real
```

Không commit file secret này. Diagnostic gửi request thật tới provider và không thay thế mock E2E bắt buộc trong `test:local`.

## 3. Migration Supabase production

### 3.1. Chuẩn bị

- Chọn thời gian không có học viên đang thi; migration tạo unique index và có thể cần lock bảng ngắn hạn.
- Xác nhận đang mở đúng **project production**, không phải project test.
- Nếu dữ liệu quan trọng, tạo backup/export phù hợp với plan trước khi thay đổi. Free Plan không có automatic database backup.
- Với migration additive, chạy migration trước source như thông thường. Riêng destructive cleanup `20260819`, deploy release chuyển tiếp hỗ trợ schema 1/2 trước, đợi invocation cũ kết thúc, rồi mới chạy migration để tránh old deployment yêu cầu bảng vừa bị drop.

### 3.2. Chạy thủ công bằng SQL Editor

Repository hiện chưa được cấu hình theo workflow Supabase CLI migration history, nên quy trình hiện tại là chạy từng file SQL idempotent bằng Dashboard:

1. Supabase Dashboard → chọn project production.
2. Mở **SQL Editor** → **New query**.
3. Mở file migration trong repository, copy **toàn bộ nội dung**, kể cả `BEGIN`, `COMMIT` và các câu `SELECT` verification ở cuối.
4. Paste vào SQL Editor → bấm **Run** hoặc `Ctrl+Enter`.
5. Chỉ chuyển sang file kế tiếp khi không có error và verification trả đúng kết quả.

Chạy đúng thứ tự:

1. `migrations/20260808_mac_exam_hardening.sql`
   - Mong đợi verification: 2 row — `recording_parts.student_id` và `violation_events.metadata_json`.
2. `migrations/20260809_concurrent_session_detection.sql`
   - Mong đợi: 1 row — `exam_sessions.student_id`.
3. `migrations/20260810_free_tier_exam_integrity.sql`
   - Mong đợi result set đầu: 6 column của `students`.
   - Mong đợi result set sau: 2 index — `uq_exam_questions_student_order`, `uq_students_access_code`.
4. `migrations/20260810_violation_event_idempotency.sql`
   - Mong đợi result set đầu: 1 row — `violation_events.event_id`.
   - Mong đợi result set sau: 2 index — `ux_violation_events_student_event`, `ux_violations_student_type`.
5. `migrations/20260813_ai_grading_controls.sql`
   - Bổ sung trạng thái điều khiển AI grading/queue và index session cần thiết.
6. `migrations/20260813_admin_query_performance.sql`
   - Mong đợi verification trả 2 index — `idx_students_batch_id`, `idx_violation_events_student_created_at`.
   - Chạy lúc ít tải vì `CREATE INDEX` thông thường có thể phải chờ hoặc chặn write xung đột trong thời gian ngắn.
7. `migrations/20260816_user_ai_manual_grading.sql`
   - Tạo `user_ai_settings` với API key mã hóa theo owner.
   - Thêm trạng thái manual AI grading cho `batches` và điểm/summary/status/error cho `students`.
   - Mong đợi verification trả các column mới của `user_ai_settings`, `batches` và `students`.
8. `migrations/20260817_ai_grading_student_recovery.sql`
   - Thêm timestamp/token lease cho mỗi student grading attempt và index recovery.
   - Mong đợi verification trả 2 column và index `idx_students_ai_grading_lease`.
   - Chỉ chạy khi không có AI Grade request đang hoạt động.
9. `migrations/20260818_admin_startup_fast_path.sql`
   - Tạo `app_schema_state` và đánh dấu schema version `1` để Vercel cold start bỏ qua runtime DDL.
   - Phải chạy sau toàn bộ migration phía trên và trước khi deploy source sử dụng startup fast path.
   - Mong đợi verification trả đúng một row với `id = 1`, `version = 1`.
10. `migrations/20260819_remove_legacy_ai.sql`
   - Xóa `ai_queue`, global plaintext `ai_settings`, `batches.ai_grading_enabled` và `batches.ai_setting_id`.
   - Giữ nguyên `user_ai_settings` và toàn bộ manual grading state.
   - Nâng `app_schema_state.version` lên `2`; chỉ chạy sau khi release chuyển tiếp hỗ trợ cả schema 1 và 2 đã được deploy và invocation cũ đã kết thúc.

11. `migrations/20260827_recording_upload_reservations.sql`
   - Tạo reservation bền vững theo `(student_id, upload_id)` và chặn hai logical blob dùng chung `(student_id, part_index)`.
   - Backfill mọi `recording_parts` cũ thành reservation đã hoàn tất, sửa marker `completed_at` bị thiếu khi key khớp, và rollback nếu gặp xung đột part/key.
   - Nâng `app_schema_state.version` lên `3`; chạy migration này trước migration manifest recovery.
   - Verification phải trả đủ 7 column, 2 unique index được đặt tên và row `app_schema_state.version >= 3`.

12. `migrations/20260827_recording_manifest_recovery.sql`
   - Thêm `students.recording_manifest_sealed_at`, `students.recording_expected_part_count` và `students.attempt_record_mode`; mode được đóng băng theo lượt thi để admin đổi batch không làm đổi nghĩa evidence đang ghi.
   - Nâng `app_schema_state.version` lên `4`; chạy migration này **trước** khi deploy source hiện tại vì runtime mới yêu cầu schema v4.
   - Verification phải trả đủ 3 column recovery và row `app_schema_state.version >= 4`.

> **Điều kiện rollout bắt buộc cho release recording schema-v4:** dừng tạo lượt thi mới và chờ đến khi không còn thí sinh S3 nào đang `in_progress`/không còn tab thi dùng bundle cũ. Client cũ không gửi `/recording-seal`, nên deploy backend mới giữa một lượt thi đang chạy sẽ làm lượt đó không thể finalize. Chỉ chạy hai migration và deploy frontend/backend sau khi đã drain các lượt S3 đang hoạt động.

Các file đều có transaction/idempotent guard và có thể chạy lại khi cần. Riêng `20260810_violation_event_idempotency.sql` có bước gộp duplicate `violations`; vẫn phải đọc kết quả và không chạy đồng thời từ hai cửa sổ.

### 3.3. Nếu migration thứ ba báo duplicate

Migration sẽ rollback và chưa tạo hai unique index. Chạy hai query chẩn đoán sau:

```sql
SELECT access_code, COUNT(*) AS duplicate_count,
       ARRAY_AGG(id ORDER BY id) AS student_ids
FROM public.students
GROUP BY access_code
HAVING COUNT(*) > 1;

SELECT student_id, question_order, COUNT(*) AS duplicate_count,
       ARRAY_AGG(id ORDER BY id) AS exam_question_ids
FROM public.exam_questions
GROUP BY student_id, question_order
HAVING COUNT(*) > 1;
```

Không xóa row tự động. Đối chiếu email/batch/answer của các ID được trả về, quyết định row đúng cần giữ, sửa dữ liệu rồi chạy lại migration thứ ba. Nếu không chắc row nào đúng, dừng deploy và backup dữ liệu trước khi xử lý.

### 3.4. Vì sao vẫn phải chạy migration production trước deploy?

Production dùng `app_schema_state` để đi theo startup fast path: tạo connection, đọc schema version rồi chạy verification gộp, không chạy lại chuỗi `CREATE/ALTER/INDEX`. Runtime hiện tại yêu cầu version `>=4`, và fresh bootstrap ghi version `4`. Vì vậy phải chạy cả hai migration recording 20260827 theo đúng thứ tự trước source mới. Runtime bootstrap đầy đủ chỉ dành cho local/fresh database khi `ALLOW_RUNTIME_SCHEMA_BOOTSTRAP=true`.

Vì cold start Vercel có thể xuất hiện đồng thời ở nhiều instance, không được dựa vào runtime DDL như cơ chế deploy schema. Phải chạy migration có chủ đích trước deploy; readiness là hàng rào cuối trả `503` nếu schema version hoặc required schema/index chưa đúng. Baseline migration đầy đủ cho database mới vẫn là technical debt; local Docker tạm thời dùng bootstrap rõ ràng qua biến môi trường riêng.

Supabase khuyến nghị dùng migration files/CLI cho workflow lâu dài; thao tác SQL Editor trên remote không tạo migration history. Đợt này vẫn hướng dẫn SQL Editor vì repository hiện lưu migration ngoài cấu trúc Supabase CLI. Nếu chuyển sang CLI sau này, cần import/repair migration history trước, không chạy lẫn hai workflow.

## 4. Supabase connection cho Vercel

Trong Supabase Dashboard → Connect, copy đúng **Transaction Pooler** URL (port `6543`). Đây là mode phù hợp cho serverless. Node `pg` trong project không đặt `name` cho query nên không dùng named prepared statements, tương thích với Transaction Pooler.

Tài liệu chính thức: https://supabase.com/docs/guides/database/connecting-to-postgres

Backend có startup readiness kiểm tra các column/index bắt buộc. Timeout/network tạm thời được retry single-flight với backoff và không còn khóa vĩnh viễn một Vercel instance; thiếu/sai schema hoặc lỗi auth/config vẫn trả `503` và không retry liên tục.

## 5. Environment variables trên Vercel

Vercel Dashboard → project → **Settings** → **Environment Variables**. Thêm từng biến cho environment **Production**; nếu dùng Preview để smoke test thì chọn thêm Preview. Sau khi đổi env phải redeploy vì deployment cũ không tự nhận giá trị mới.

Các biến bắt buộc:

- `JWT_SECRET`: chuỗi ngẫu nhiên tối thiểu 32 bytes.
- `SESSION_SECRET`: chuỗi ngẫu nhiên riêng, không dùng giá trị mặc định.
- `DATABASE_URL`: Transaction Pooler URL từ Supabase.
- `ALLOWED_ORIGINS`: domain production chính xác, ví dụ `https://eaudit.vercel.app`.
- `AI_SETTINGS_ENCRYPTION_KEY`: đúng 32 byte dạng base64 hoặc 64 ký tự hex. Key này mã hóa API key LLM của user và phải giữ ổn định giữa các deployment; mất/đổi key sẽ làm các cấu hình đã lưu không giải mã được.

`DATABASE_URL` ở đây phải lấy từ **project Supabase production**, không phải `.env.test.local` hay project `e-proc-test`. Không đặt `TEST_DATABASE_URL` trên Vercel.

Có thể tạo secret trong PowerShell, chạy riêng từng lần và lưu ngay vào password manager/Vercel:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

Tạo riêng key AES 64 ký tự hex cho `AI_SETTINGS_ENCRYPTION_KEY`:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
```

Biến khuyến nghị:

- `DB_POOL_MAX=4`
- `DB_POOL_MIN=0`
- `DB_CONNECT_TIMEOUT_MS=15000` — thời gian chờ mỗi lần kết nối PostgreSQL; hữu ích khi Supabase vừa cold-start.
- `DB_CONNECT_ATTEMPTS=2` — retry giới hạn khi lỗi kết nối tạm thời; không khắc phục URL/credential sai.
- `DB_READY_RETRY_BASE_MS=1000` — cooldown ban đầu sau khi toàn bộ connect attempts thất bại.
- `DB_READY_RETRY_MAX_MS=30000` — cooldown tối đa giữa các vòng startup retry; request đồng thời dùng chung một attempt.
- `AI_GRADING_CONCURRENCY=3` — số học viên chấm đồng thời trong một batch invocation, code clamp 1–5; đặt `1` để fallback tuần tự.
- `AI_GRADING_CORRELATION_RETRIES=2` — số lần retry riêng cho lỗi response correlation, code clamp 0–3; mỗi attempt dùng request token mới.
- `AI_GRADING_LLM_TIMEOUT_MS=60000` — timeout mỗi LLM request, code clamp 1–120 giây.
- `AI_GRADING_MAX_PROMPT_CHARS=80000` — ngưỡng chủ động chia câu hỏi của một học viên thành chunk.
- `AI_GRADE_SAFE_BUDGET_MS=270000` — ngừng bắt đầu student mới trước giới hạn 300 giây của function; code clamp tối đa 290 giây.
- `AI_GRADING_STALE_MS=360000` — recovery lease student/batch; luôn được nâng tối thiểu bằng safe budget + 60 giây.
- `ADMIN_PERF_LOGS=true` — tùy chọn, log timing cho mọi API admin trong giai đoạn lấy baseline; tắt sau khi đo xong.
- `ADMIN_SLOW_REQUEST_MS=1000` — khi không bật full perf logs, chỉ log API admin chậm hơn ngưỡng này.

Legacy queue/global-setting variables đã bị xóa. Manual AI Grade chỉ cần encrypted user-owned setting và các biến `AI_GRADING_*` ở trên.

Nếu dùng S3 recording:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `S3_RECORDINGS_BUCKET`

IAM principal dùng bởi backend tối thiểu cần `s3:PutObject` cho presigned upload và `s3:GetObject` để `HeadObject` xác minh part đã upload. Bucket phải có CORS cho phép domain thi gọi `PUT` với `Content-Type`, và nên có Lifecycle rule tự xóa `recordings/**` theo chính sách lưu trữ của tổ chức. Không cấp public-read cho bucket.

## 6. Build và deploy

Project dùng artifact đã build. Trước khi commit/deploy:

```bash
npm run build
```

Phải có cả:

- `dist/server/index.js` và các module mới dưới `dist/server/services/`
- `client/dist/index.html` cùng asset hash tương ứng

Deploy từ thư mục root:

```bash
vercel --prod
```

Nếu deploy bằng Git integration thay vì CLI: commit cả source, migration, lockfile, `dist/server/**` và `client/dist/**`; push branch; mở deployment tương ứng trong Vercel. Kiểm tra commit SHA của deployment để tránh smoke test nhầm bản cũ.

Sau deploy, kiểm tra:

```text
GET https://<domain>/api/health
```

Chỉ HTTP `200` + `status: "ok"` + `db: "ready"` mới được coi là ready. `503 initializing/degraded` nghĩa là startup/schema/cache chưa sẵn sàng; xem function logs trước khi mở kỳ thi.

PowerShell smoke check:

```powershell
$health = Invoke-RestMethod 'https://<domain>/api/health'
$health | ConvertTo-Json -Depth 5
```

Sau health check, dùng một batch/student test riêng để chạy đủ: tạo batch essay (không cần LLM setting) → cấu hình LLM trong AI Settings → Test Connection → Save → verify access code → start → trả lời ít nhất hai câu → tạo một violation thử nghiệm → submit → tại Batches List bấm **AI Grade** → mở Results kiểm tra answer, feedback từng câu, summary feedback, điểm tổng kết, `submitted_at` và `submit_reason`. Không dùng học viên thật cho smoke test.

## 7. Manual AI Grade trên Vercel Hobby

AI grading không chạy khi học viên submit và không dùng Vercel Cron. Một lần creator bấm **AI Grade** tạo đúng một backend invocation tới `POST /api/admin/batches/:id/ai-grade`.

Trong invocation đó:

- Chỉ `batches.created_by` được chạy; role `admin` không bypass ownership.
- Chỉ creator được chấm batch essay của mình. Backend lấy verified LLM setting hiện tại của creator từ `user_ai_settings`.
- Mỗi học viên `submitted` có một LLM request độc lập chứa toàn bộ câu hỏi, answer và rubric; payload lớn hoặc response không hợp lệ có thể tách thành nhiều chunk cho riêng học viên đó.
- Học viên được xử lý qua bounded worker pool mặc định 3, clamp 1–5. Mỗi worker claim student riêng, đọc theo `student_id`, gọi LLM không giữ DB connection, rồi publish trong transaction có điều kiện theo chính student đó.
- Mỗi attempt gửi `request_token` và grading key riêng; correlation sai được retry tối đa theo `AI_GRADING_CORRELATION_RETRIES`, luôn với token mới, và không được publish nếu vẫn không xác định được ownership của response.
- Mỗi student claim có UUID lease token và start timestamp. Request mới chỉ recover lease stale; mọi publish/failure phải khớp token nên worker cũ trả muộn không thể ghi đè kết quả mới.
- Mỗi student thành công được commit riêng vào Supabase: score/feedback từng câu, summary feedback và điểm tổng kết thang 10.
- Khi gần hết safe budget, backend dừng nhận student mới, trả batch status `partial`; creator bấm lại để tiếp tục. Student đã `completed` được bỏ qua.
- Results có route targeted grade/retry/regrade. Regrade thất bại giữ nguyên score/feedback/status completed trước đó; chỉ kết quả mới đầy đủ, đúng correlation và qua validation mới thay thế dữ liệu đã publish.

Điểm từng câu nằm trong `0.00..1.00`. Điểm tổng kết là `ROUND(SUM(score)/total_questions*10, 2)`; câu không trả lời tính 0. Một invocation có thể phát sinh 25 outbound LLM requests cho batch 25 học viên, nhưng vẫn chỉ là một inbound Vercel Function invocation.

`AI_GRADE_SAFE_BUDGET_MS=270000` chừa khoảng đệm trước ceiling 300 giây. Cần xác nhận deployment thực tế đang có Fluid Compute/max duration phù hợp và benchmark provider/model thật; provider throttling, chunk fallback và correlation retry vẫn có thể làm tăng tổng thời gian dù worker chạy song song. Nếu function bị hard-kill, student đã commit vẫn còn; sau stale threshold, request tiếp theo phục hồi attempt chưa publish thành retryable, giữ nguyên kết quả regrade cũ, và token cũ bị vô hiệu hóa.

Manual AI Grade không có queue table/cron endpoint. Batch invocation checkpoint trực tiếp trên trạng thái grading của từng student.

## 8. Answer persistence và free tier

Answer hiện được ghi trực tiếp vào Supabase sau debounce phía frontend:

- Essay: 5 giây theo từng `question_order`.
- Quiz: 500 ms theo từng `question_order`.
- Trước manual submit, frontend gửi lại toàn bộ answer hiện có.

Không còn dựa vào process-local answer buffer cho dữ liệu bài thi. Cách này tạo nhiều request/write hơn nhưng tránh mất dữ liệu khi Vercel scale hoặc freeze instance. Cần theo dõi Vercel invocations và Supabase database load trong kỳ thi thật; không khẳng định `$0/month` nếu chưa đo usage thực tế.

Supabase Free có thể pause project có ít hoạt động trong khoảng 7 ngày. Trước ngày thi, mở dashboard và gọi `/api/health` đủ sớm để xác nhận project đã hoạt động lại; kiểm tra pricing/quotas hiện hành thay vì xem giới hạn free tier trong tài liệu này là cam kết cố định.

Tài liệu chính thức:

- https://supabase.com/pricing
- https://supabase.com/docs/guides/platform/free-project-pausing

## 9. Triển khai Ubuntu VPS bằng `deploy-vps.sh`

Topology này phù hợp khi cần backend chạy lâu dài thay vì serverless. Manual AI Grade vẫn được kích hoạt bằng button giống Vercel. Script hiện chỉ hỗ trợ **Ubuntu**, phải chạy bằng `root`, và sẽ:

1. cài Docker Engine/Compose, Git, Caddy dependencies và UFW;
2. chỉ mở SSH, HTTP, HTTPS/HTTP3;
3. clone repository vào `/opt/e-proc/app`, checkout detached `GIT_REF` (mặc định `main`), rồi `reset --hard`/`clean` deployment checkout đó;
4. sinh Dockerfile, Compose, Caddyfile và secret env dưới `/opt/e-proc/runtime`;
5. tùy chọn cập nhật Cloudflare DNS khi có `CF_API_TOKEN` + `CF_ZONE_ID`;
6. build image, khởi tạo schema, chạy toàn bộ `migrations/*.sql` theo tên tăng dần, kiểm tra/import question bank, rồi chờ `/api/health` ready.

Không lưu file thủ công trong `/opt/e-proc/app`: lần deploy kế tiếp sẽ xóa mọi file không thuộc commit. Với repository private, VPS phải có credential Git đọc được repository.

Chuẩn bị DNS trỏ `APP_DOMAIN` về IPv4 của VPS, sau đó chạy từ bản script đã review:

```bash
sudo GIT_REF=<commit-or-tag> bash deploy-vps.sh
```

Script hỏi `REPO_URL`, `APP_DOMAIN`, `DATABASE_URL`. Với VPS IPv4 chạy lâu, dùng Supabase **Session Pooler port 5432**; Transaction Pooler `6543` dành cho Vercel/serverless. Runtime VPS đặt `DB_POOL_MIN=1`, `DB_POOL_MAX=5` và ghi nhận từng migration đã chạy trong `schema_migrations`.

Nếu `question_bank` đang rỗng, phải cung cấp `QUESTION_BANK_CSV_URL`; importer hiện yêu cầu chính xác 599 row/ID. Nếu database đã có câu hỏi, có thể bỏ qua URL này. Các biến AI/S3 và Cloudflare có thể export trước khi chạy script.

> **Cảnh báo bắt buộc:** phiên bản script hiện tại tạo hoặc **reset lại sau mỗi lần chạy** tài khoản `admin / admin321` qua upsert. Phải đổi mật khẩu ngay sau deploy và không chạy script này trên production nếu chưa chấp nhận hành vi reset credential đó. Nên sửa script nhận bootstrap secret từ biến môi trường trước khi dùng cho hệ thống thật.

Sau deploy:

```bash
cd /opt/e-proc/runtime
docker compose ps
docker compose logs --tail=200 webapp proxy
curl -fsS https://<domain>/api/health
```

Stop/start VPS giữ nguyên Supabase data và Docker tự restart service. Nếu VPS bị terminate, tạo VPS mới và chạy lại script; backup/retention của PostgreSQL và S3 vẫn phải được quản lý độc lập.

## 10. Checklist production trước mỗi kỳ thi

- [ ] Đã dừng tạo lượt thi mới và xác nhận không còn lượt S3 `in_progress`/tab thi bundle cũ trước khi rollout recording schema-v4.
- [ ] Mười hai migration đã chạy theo đúng thứ tự và verification query đúng; migration recovery/cleanup chỉ chạy khi không có AI Grade request hoạt động; hai migration recording 20260827 phải hoàn tất trước source schema-v4.
- [ ] `/api/health` trả HTTP 200.
- [ ] Vercel dùng Transaction Pooler + `DB_POOL_MAX=4`, `DB_POOL_MIN=0`; VPS IPv4 dùng Session Pooler + `DB_POOL_MAX=5`, `DB_POOL_MIN=1`.
- [ ] `ALLOWED_ORIGINS` đúng domain production.
- [ ] Import Excel lớn hơn 5 MiB bị từ chối; SheetJS vẫn được pin ở official tarball `0.20.3`, không hạ về npm `0.18.5`.
- [ ] `AI_SETTINGS_ENCRYPTION_KEY` đã cấu hình, lưu an toàn và không thay đổi giữa deployment.
- [ ] Creator đã Test Connection + Save LLM setting; user khác, kể cả admin, không thấy/chạy AI Grade trên batch không thuộc sở hữu.
- [ ] Create/Edit Batch không còn AI flag; mọi batch essay cũ/mới của creator hiện AI Grade sau khi setting được verified; quiz không hiện button.
- [ ] `req.ip` trên Vercel phản ánh IP client thật; nếu mọi session cùng một IP thì concurrent-session detection bị vô hiệu.
- [ ] `npm run test:local` pass toàn bộ bảy bước; default suite hiện có 133 pass/15 skip, PostgreSQL có 15 pass/0 skip, schema v2→v4/backfill idempotent và AI Grade E2E pass các scenario isolation/correlation/regrade/recovery.
- [ ] Chrome và Edge bản hiện hành trên máy vật lý đã test fail-closed display preflight, fullscreen, recorder và `displaySurface='monitor'`.
- [ ] Nếu dùng S3: test PUT → recording-complete → HeadObject → finalize và Lifecycle rule.
- [ ] Test một bài submit thật, bấm AI Grade và xác nhận per-question score/feedback, student summary/final score cùng recording/violation metadata trong Supabase.
- [ ] Nếu dùng VPS: đã thay `admin321`, kiểm tra certificate Caddy, UFW và Docker restart policy.

## 11. Giới hạn còn chấp nhận

- Web browser không thể ngăn chắc thiết bị thứ hai, VM, OS accessibility hoặc custom API client.
- Concurrent-session cùng IP/NAT vẫn là vùng quan sát yếu.
- Violation retry chỉ cứu lỗi tạm thời; proxy/extension chặn liên tục vẫn làm mất telemetry.
- Recording hiện mới xác minh object tồn tại/kích thước và manifest liên tục, chưa phân tích duration/frame/black screen server-side.
- PostgreSQL concurrency integration test cần database thật; SQLite test không chứng minh được race behavior trên Supabase.

Các giới hạn trên cần bù bằng recording review, similarity analysis và oral defense cho bài thi high-stakes.
