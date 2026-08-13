# Deploy Guide — E-Audit Platform

Production target: một project Vercel phục vụ frontend tĩnh + Express function, Supabase PostgreSQL qua Transaction Pooler, và S3 nếu bật screen recording.

### Vì sao diff có nhiều file?

Đợt này thay đổi một luồng xuyên suốt từ browser đến database, nên một thay đổi logic tạo ra nhiều file liên quan:

| Nhóm | File chính | Ý nghĩa |
|---|---|---|
| Frontend source | `client/src/**` | retry violation, browser/display guard, recorder, answer debounce |
| Frontend artifact | `client/dist/**` | bundle hash mới mà Vercel thực sự phục vụ; được sinh bởi build, không sửa tay |
| Backend source | `src/server/**` | transaction violation, schema readiness, queue worker, session enforcement |
| Backend artifact | `dist/server/**` | JavaScript Vercel thực sự chạy; được sinh bởi TypeScript build |
| Database | `migrations/**` | column/table/index bắt buộc trên Supabase |
| Regression test | `test/**`, `scripts/run-postgres-tests.mjs` | SQLite test và race test PostgreSQL thật |
| Dependency/config | hai `package*.json`, `vercel.json` | dependency đã vá, cron và lệnh test/build |

Không phải mọi file trong diff đều là logic độc lập: phần lớn `dist/**`, asset hash và lockfile là artifact/dependency được sinh lại. Source of truth vẫn là `src/**`, `client/src/**`, migration và config.

## 1. Thứ tự triển khai bắt buộc

Không deploy code trước rồi mới sửa database. Thứ tự an toàn cho đợt cập nhật này:

1. Cài dependency và chạy SQLite regression test.
2. Chạy PostgreSQL integration test trên **database test riêng**.
3. Dừng tạo kỳ thi mới/chọn thời gian không có học viên đang thi.
4. Chạy bốn migration trên Supabase production theo đúng thứ tự.
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

Kết quả `npm test` hiện mong đợi: 9 SQLite test pass và 5 PostgreSQL test skip. Việc skip là có chủ ý khi chưa cấu hình database test; nó không chứng minh race PostgreSQL đã đúng.

### 2.1. `TEST_DATABASE_URL` dùng để làm gì?

Năm integration test cần PostgreSQL thật để kiểm tra những hành vi SQLite không mô phỏng được:

- hai transaction violation khác type chạy đồng thời vẫn nhìn thấy tổng count đúng;
- partial unique index của `event_id` hoạt động đúng cú pháp PostgreSQL;
- rollback xóa đồng thời event và counter;
- hai Vercel worker đồng thời chỉ một worker claim được AI queue job.

Test tạo schema tạm tên `test_violation`, tạo các bảng tối thiểu trong schema đó, rồi `DROP SCHEMA test_violation CASCADE` khi kết thúc. Nó không chạy bốn migration và không chạm schema `public`, nhưng **không được trỏ vào production**.

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

Script `test:postgres` tự build backend, đọc `.env.test.local`, từ chối placeholder/URL sai, sau đó chỉ chạy năm PostgreSQL integration test. Kết quả mong đợi:

```text
tests 5
pass 5
fail 0
skipped 0
```

Nếu tiến trình bị tắt giữa chừng, schema `test_violation` có thể còn lại trong project test; lần chạy kế tiếp sẽ chủ động xóa và tạo lại schema này.

Không ghi `TEST_DATABASE_URL` vào Vercel. Đây chỉ là secret dùng trên máy developer/CI.

### 2.3. Vì sao không hard-code URL vào script?

Connection string chứa database password. Hard-code nó trong `package.json`, source hoặc commit sẽ làm lộ quyền truy cập database. Vì vậy repository chỉ cung cấp lệnh `npm run test:postgres` và file mẫu `.env.test.example`; secret thật nằm trong `.env.test.local`, đã được `.gitignore` loại trừ.

## 3. Migration Supabase production

### 3.1. Chuẩn bị

- Chọn thời gian không có học viên đang thi; migration tạo unique index và có thể cần lock bảng ngắn hạn.
- Xác nhận đang mở đúng **project production**, không phải project test.
- Nếu dữ liệu quan trọng, tạo backup/export phù hợp với plan trước khi thay đổi. Free Plan không có automatic database backup.
- Không deploy source mới trước khi cả bốn migration thành công; source mới fail readiness nếu schema bắt buộc chưa đủ.

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

Các file đều có transaction/idempotent guard và có thể chạy lại khi cần. Tuy nhiên file cuối có bước gộp duplicate `violations`; vẫn phải đọc kết quả và không chạy đồng thời từ hai cửa sổ.

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

### 3.4. Vì sao migration production không tự chạy khi Vercel start?

Cold start Vercel có thể chạy đồng thời ở nhiều instance. Tự chạy DDL/dedupe lúc startup vừa tăng lock trên Supabase Free vừa làm khó kiểm soát lỗi dữ liệu. Runtime chỉ kiểm tra readiness và trả `503` nếu schema chưa đúng; thay đổi schema production phải là bước deploy có chủ đích.

Supabase khuyến nghị dùng migration files/CLI cho workflow lâu dài; thao tác SQL Editor trên remote không tạo migration history. Đợt này vẫn hướng dẫn SQL Editor vì repository hiện lưu migration ngoài cấu trúc Supabase CLI. Nếu chuyển sang CLI sau này, cần import/repair migration history trước, không chạy lẫn hai workflow.

## 4. Supabase connection cho Vercel

Trong Supabase Dashboard → Connect, copy đúng **Transaction Pooler** URL (port `6543`). Đây là mode phù hợp cho serverless. Node `pg` trong project không đặt `name` cho query nên không dùng named prepared statements, tương thích với Transaction Pooler.

Tài liệu chính thức: https://supabase.com/docs/guides/database/connecting-to-postgres

Backend có startup readiness kiểm tra các column/index bắt buộc. Thiếu hoặc sai unique index làm `/api/health` trả `503`, không cho route thi chạy trên schema nửa-migrate.

## 5. Environment variables trên Vercel

Vercel Dashboard → project → **Settings** → **Environment Variables**. Thêm từng biến cho environment **Production**; nếu dùng Preview để smoke test thì chọn thêm Preview. Sau khi đổi env phải redeploy vì deployment cũ không tự nhận giá trị mới.

Các biến bắt buộc:

- `JWT_SECRET`: chuỗi ngẫu nhiên tối thiểu 32 bytes.
- `SESSION_SECRET`: chuỗi ngẫu nhiên riêng, không dùng giá trị mặc định.
- `DATABASE_URL`: Transaction Pooler URL từ Supabase.
- `ALLOWED_ORIGINS`: domain production chính xác, ví dụ `https://eaudit.vercel.app`.
- `CRON_SECRET`: chuỗi ngẫu nhiên tối thiểu 16 ký tự; Vercel tự gửi `Authorization: Bearer <CRON_SECRET>` tới cron endpoint.

`DATABASE_URL` ở đây phải lấy từ **project Supabase production**, không phải `.env.test.local` hay project `e-proc-test`. Không đặt `TEST_DATABASE_URL` trên Vercel.

Có thể tạo secret trong PowerShell, chạy riêng từng lần và lưu ngay vào password manager/Vercel:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

Biến khuyến nghị:

- `DB_POOL_MAX=2`
- `DB_POOL_MIN=0`
- `DB_CONNECT_TIMEOUT_MS=15000` — thời gian chờ mỗi lần kết nối PostgreSQL; hữu ích khi Supabase vừa cold-start.
- `DB_CONNECT_ATTEMPTS=2` — retry giới hạn khi lỗi kết nối tạm thời; không khắc phục URL/credential sai.
- `AI_QUEUE_STALE_MS=900000` — recover job bị kẹt `processing` sau 15 phút; không đặt thấp hơn thời gian tối đa một lần gọi AI.
- `GEMINI_API_KEY` hoặc cấu hình provider trong admin UI.

Nếu dùng S3 recording:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `S3_RECORDINGS_BUCKET`

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

Sau health check, dùng một batch/student test riêng để chạy đủ: verify access code → start → trả lời ít nhất hai câu → tạo một violation thử nghiệm → submit → mở Admin Results kiểm tra answer, violation event, `submitted_at`, `submit_reason` và AI queue. Không dùng học viên thật cho smoke test.

## 7. AI queue trên Vercel Hobby

Queue không còn dựa vào `setInterval` trên Vercel và không gọi AI trong cold-start readiness.

- Enqueue được `await` tới khi row `ai_queue` đã persist.
- Worker claim atomically bằng `UPDATE ... WHERE status='pending'`; nhiều instance không cùng chấm một job.
- Job `processing` bị crash được trả về `pending` sau `AI_QUEUE_STALE_MS`.
- `vercel.json` đăng ký cron `/api/queue/process` lúc `02:00 UTC` mỗi ngày; endpoint mặc định xử lý tối đa 5 job.
- Endpoint chấp nhận `CRON_SECRET` của Vercel hoặc JWT admin.

Vercel Hobby hiện chỉ cho cron tối đa **một lần/ngày** và thời điểm có thể lệch trong giờ đã chọn. Muốn có kết quả ngay, admin gọi thủ công:

```text
GET /api/queue/process?limit=5
Authorization: Bearer <admin JWT>
```

Lặp lại tới khi `processed: 0`. Vercel không tự retry cron lỗi, nên phải theo dõi logs.

Tài liệu chính thức:

- https://vercel.com/docs/cron-jobs/usage-and-pricing
- https://vercel.com/docs/cron-jobs/manage-cron-jobs

## 8. Answer persistence và free tier

Answer hiện được ghi trực tiếp vào Supabase sau debounce phía frontend:

- Essay: 5 giây theo từng `question_order`.
- Quiz: 500 ms theo từng `question_order`.
- Trước manual submit, frontend gửi lại toàn bộ answer hiện có.

Không còn dựa vào process-local answer buffer cho dữ liệu bài thi. Cách này tạo nhiều request/write hơn nhưng tránh mất dữ liệu khi Vercel scale hoặc freeze instance. Cần theo dõi Vercel invocations và Supabase database load trong kỳ thi thật; không khẳng định `$0/month` nếu chưa đo usage thực tế.

Supabase Free có 500 MB database và có thể pause project ít hoạt động sau khoảng một tuần. Trước ngày thi, mở dashboard và gọi `/api/health` đủ sớm để xác nhận project đã hoạt động lại.

Tài liệu chính thức:

- https://supabase.com/pricing
- https://supabase.com/docs/guides/platform/free-project-pausing

## 9. Checklist production trước mỗi kỳ thi

- [ ] Bốn migration đã chạy và verification query đúng.
- [ ] `/api/health` trả HTTP 200.
- [ ] `DATABASE_URL` là Transaction Pooler; `DB_POOL_MAX=2`, `DB_POOL_MIN=0`.
- [ ] `ALLOWED_ORIGINS` đúng domain production.
- [ ] Import Excel lớn hơn 5 MiB bị từ chối; SheetJS vẫn được pin ở official tarball `0.20.3`, không hạ về npm `0.18.5`.
- [ ] `CRON_SECRET` đã cấu hình và queue endpoint không trả 401.
- [ ] `req.ip` trên Vercel phản ánh IP client thật; nếu mọi session cùng một IP thì concurrent-session detection bị vô hiệu.
- [ ] `npm test` có 9 pass/5 skip; `npm run test:postgres` có 5 pass/0 skip trên project test riêng.
- [ ] Chrome và Edge vật lý đã test fullscreen, recorder và `displaySurface='monitor'`.
- [ ] Nếu dùng S3: test PUT → recording-complete → HeadObject → finalize và Lifecycle rule.
- [ ] Test một bài submit thật, xác nhận answer, violation event, recording metadata và AI queue row trong Supabase.

## 10. Giới hạn còn chấp nhận

- Web browser không thể ngăn chắc thiết bị thứ hai, VM, OS accessibility hoặc custom API client.
- Concurrent-session cùng IP/NAT vẫn là vùng quan sát yếu.
- Violation retry chỉ cứu lỗi tạm thời; proxy/extension chặn liên tục vẫn làm mất telemetry.
- Recording hiện mới xác minh object tồn tại/kích thước và manifest liên tục, chưa phân tích duration/frame/black screen server-side.
- PostgreSQL concurrency integration test cần database thật; SQLite test không chứng minh được race behavior trên Supabase.

Các giới hạn trên cần bù bằng recording review, similarity analysis và oral defense cho bài thi high-stakes.
