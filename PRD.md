# PRODUCT REQUIREMENTS DOCUMENT (PRD)

## E-Audit Platform — AI-Powered Technical Assessment

**Version:** 2.0

**Last Updated:** 2026-08-16
**Reviewed source of truth:** `src/**`, `client/src/**`, `migrations/**`, package/build/deploy configuration

---

## 1. Product overview

E-Audit Platform tổ chức bài đánh giá kỹ thuật trực tuyến dạng tự luận/coding hoặc trắc nghiệm, có chấm điểm tự động, phúc khảo, screen recording, forensic log và các cơ chế chống gian lận ở browser lẫn server.

| Actor | Mục tiêu và quyền chính |
|---|---|
| Admin | Quản lý user quản trị, toàn bộ question/batch, recording, AI và kết quả |
| Moderator (`mod`) | Tạo question/batch; chỉ sửa/xóa nội dung mình sở hữu; không được bật recording |
| Candidate | Xác thực bằng access code, làm bài trong môi trường kiểm soát và nộp bài |

Không còn ràng buộc “cố định 10 câu/50 thí sinh”. Blueprint hiện nhận 1–100 câu. Năng lực tải production phải được đo, không suy ra từ các số liệu cũ trong tài liệu.

## 2. Product principles

- Backend quyết định cuối cùng về identity, deadline, trạng thái, violation lock và concurrent-session lock.
- Browser telemetry là risk signal/evidence, không phải bảo đảm tuyệt đối.
- Answer durability không phụ thuộc process-local memory.
- Submit, violation retry và queue enqueue phải idempotent.
- Answer submit không chờ recording finalize; lỗi evidence phải hiển thị rõ để điều tra.
- TypeScript/React source và migration là nguồn sự thật; generated artifacts không phải nguồn thiết kế.

## 3. Functional requirements

### 3.1 Admin authentication and roles

- Tạo admin đầu tiên qua `/admin/setup` chỉ khi `admin_users` trống.
- Login trả JWT 24 giờ, `role`, `userId`; client lưu token/expiry/role/user id.
- `admin` quản lý user role `admin`/`mod` và không được tự xóa chính mình.
- `mod` chỉ sửa/xóa question có `uploaded_by` và batch có `created_by` bằng JWT user id.
- Chỉ `admin` được đặt `record_mode` khác `none`. Mod clone batch vẫn bị server ép recording về `none`.
- Mọi route admin sau setup/login/logout xác thực JWT; việc ẩn nút trên frontend chỉ là UX.

### 3.2 Question bank

Loại câu hỏi: `Coding`, `Conceptual`, `Fill-in`, `Debug`, `SingleChoice`, `MultipleChoice`; level: `Easy`, `Medium`, `Hard`.

Admin/mod có thể:

- import/update essay và quiz từ hai Excel format;
- tạo thủ công tại `/admin/questions/new`;
- kiểm tra ID trước khi lưu; sửa tại `/admin/questions/:id/edit` nhưng không đổi ID;
- xem live sanitized-HTML preview giống candidate renderer;
- lọc module + nhóm essay/quiz, phân trang 10/25/50;
- xóa đơn/bulk theo ownership.

Validation:

- ID bắt buộc, tối đa 50 ký tự, phân biệt hoa/thường; duplicate exact ID trả 409.
- Module/question bắt buộc; module được normalize Unicode.
- Quiz có 2–6 option không rỗng, key A–F duy nhất, correct answer phải tồn tại.
- `SingleChoice` có đúng một đáp án; `MultipleChoice` có ít nhất một; score > 0.
- Non-quiz xóa quiz fields và dùng score 1.
- Question/rubric được lưu verbatim, sanitize tại render boundary.
- Excel parsing trong memory, giới hạn 5 MiB và một file/request.

### 3.3 Batch management

Mỗi batch có tên, UTC start/end, duration, `exam_type`, blueprint, `ai_grading_enabled`, `record_mode` và `created_by`.

Current blueprint:

```json
{
  "blueprintMode": "module",
  "items": [{ "module": "Java Core", "easy": 2, "medium": 1, "hard": 0 }]
}
```

Mode `type` thêm `type` trong từng item; backend vẫn đọc legacy array.

- Tổng blueprint: 1–100 câu; feasibility đối chiếu module/level hoặc module/type/level.
- Batch quiz chỉ lấy `SingleChoice`/`MultipleChoice`; essay loại hai type này.
- Clone là frontend prefill form tạo mới với hậu tố `CLONE`, không có clone API riêng.
- Tắt AI grading cancel queue jobs `pending/processing` của batch.

### 3.4 Candidate management

- Import email; duplicate trong batch/request được skip và trả danh sách.
- Access code mới dài 8 ký tự, dùng `crypto.randomInt`, tránh ký tự dễ nhầm và retry collision.
- Production unique toàn cục `students.access_code`; login vẫn nhận code legacy 6 ký tự.
- Admin list/export email+code, xóa candidate hoặc reopen attempt.
- Reopen giữ questions/answers; yêu cầu còn questions và batch chưa kết thúc; duration 1–480 phút, deadline không vượt batch end; xóa score/AI job/session/recording metadata, revoke token cũ và buộc verify lại.

### 3.5 Candidate authentication and preflight

1. `/student/verify` kiểm tra access code, status, time window.
2. Server tạo JWT 4 giờ `{studentId,batchId,jti}`, ghi `active_jti`; verify mới revoke token cũ.
3. UI dùng email đầu tiên và chuyển tới `/confirm`; `/select-email` chỉ còn legacy, không thuộc flow hiện tại.
4. Preflight fail closed nếu `screen.isExtended=true` hoặc API không trả boolean.
5. Recording yêu cầu recent Chrome/Edge desktop và đúng `displaySurface='monitor'`.
6. Fullscreen phải thành công; sau hai animation frames, lưu immutable document-width baseline vào `sessionStorage`.
7. Lưu token/context vào `localStorage`, điều hướng `/exam`.

### 3.6 Exam lifecycle and answers

- Start dùng transaction + PostgreSQL row lock, randomize theo blueprint, xáo câu và quiz options; option order được persist.
- Deadline = `min(started_at + duration, batch.end_time)`; resume không gia hạn.
- Essay/code debounce 5 giây/câu; quiz 500ms/câu.
- Dirty answers gửi batch qua `/exam/answers`; `/exam/answer` vẫn tương thích.
- Backend kiểm tra assignment, answer ≤100.000 ký tự, quiz options, status và deadline.
- Manual submit gửi full answer map trong transaction; submit idempotent, ghi `submitted_at`/`submit_reason`.
- Auto-submit reasons: `timeout`, `absent_too_long`, `violation`, `recording_stopped`, `concurrent_session`; manual dùng `manual`.
- Disconnect beacon ghi timestamp; lần load questions sau >120 giây auto-submit.

### 3.7 Grading

- Quiz chấm ngay bằng exact-set match, không partial credit; đúng nhận configured score, sai 0.
- Essay chỉ enqueue khi batch bật AI grading.
- Queue id deterministic theo `exam_question.id`, claim atomic, tối đa 3 attempts, recover stale processing jobs.
- `ai_settings.worker_enabled=false` dừng claim nhưng giữ pending jobs.
- Provider: Gemini, OpenAI, Azure, Groq, DeepSeek, OpenRouter, Ollama.
- Trainer override hiện áp cùng score/feedback cho toàn bộ questions của một student.

### 3.8 Results and reporting

- Results summary phân trang 10/25/50; question bank và results dùng aggregate query count không tăng theo số row trong page.
- Summary hiển thị status, average score, counted violations, forensic count, recording count/bytes và local password.
- Answers/feedback/violation events/recording parts load lazy theo student.
- Detail hiển thị type, timestamp, length, question id, preview và metadata.
- Export Excel một sheet/student; trainer score ưu tiên hơn AI/quiz score.
- Legacy full-results API còn cho compatibility; current UI dùng summary/detail.

### 3.9 Screen recording

| Mode | Hành vi |
|---|---|
| `none` | Không screen share, không recording-stop guard |
| `local` | Part 5 phút, ZIP AES-256 vào folder candidate chọn; password server sinh/lưu/trả ngầm |
| `s3` | Part 5 phút, PUT trực tiếp S3 bằng presigned URL; backend `HeadObject` trước khi persist metadata |

- VP9, fallback VP8, 5 fps, khoảng 600 kbps.
- Candidate dừng share → `recording_stopped`, lock ngay lần đầu.
- F5 mất recorder singleton → blocking modal bắt share/chọn folder lại.
- Answer submit xong trước; `/submit` chờ shared `stopAndSave()` promise.
- S3 finalize yêu cầu contiguous manifest `0..finalPartIndex`.
- Manifest chưa xong khi submit đặt `recording_incomplete=true`; recording endpoints có grace 15 phút.
- S3 cần CORS `PUT`, lifecycle retention và IAM `PutObject` + `GetObject` cho `HeadObject`.

### 3.10 Anti-cheat and forensic policy

Client-reportable:

`tab_switch`, `fullscreen_exit`, `copy_attempt`, `cut_attempt`, `paste_attempt`, `devtools_open`, `view_source`, `extension_panel`, `screenshot_attempt`, `print_attempt`, `suspicious_paste`, `focus_lost`, `recording_stopped`, `rapid_text_insertion`, `multiple_display_detected`.

`concurrent_session` là server-owned; client POST bị 400.

- Lock khi một lockable type ≥2 hoặc tổng lockable violations ≥2.
- `recording_stopped` lock lần đầu.
- Forensic-only: `suspicious_paste`, `rapid_text_insertion`, `multiple_display_detected`, `concurrent_session`. Concurrent IP overlap vẫn lock trực tiếp.
- Fullscreen exit report sau 5 giây và lần hai sau thêm 5 giây.
- Focus lost report sau blur 3 giây; tab hidden dùng `visibilitychange`.
- Clipboard bị chặn trong Monaco; cooldown 3 giây/type.
- Single insertion ≥300 chars: bỏ qua exact registered suggestion; unmatched content bị undo và log preview ≤500.
- Rapid insertion: tổng ≥300 chars/2,5 giây, mỗi change <300, telemetry cooldown 10 giây.
- Side panel: immutable document width giảm >80px trong 2 poll ×1,5 giây, tối đa hai report.
- Multiple display poll 3 giây forensic-only; watermark email/SID/time cập nhật, dịch vị trí mỗi 15 giây.
- Client sinh `event_id`; unique `(student_id,event_id)` làm violation retry idempotent.

Concurrent session:

- Track `(student_id,jti,ip)` trên questions/answer(s)/violation.
- Active window 60 giây; hai IP khác nhau có `last_seen` cách <10 giây là overlap lockable.
- Nhiều IP/UA/jti không overlap chỉ log; overlap auto-submit trực tiếp.

## 4. Data model

| Table | Vai trò |
|---|---|
| `question_bank` | Question/rubric/quiz config/owner |
| `batches` | Schedule/blueprint/exam-record-AI mode/owner |
| `students` | Candidate attempt/code/deadline/session/submit/recording state |
| `exam_questions` | Assignment/option order/answer/scores |
| `violations` | Unique counted row theo student/type |
| `violation_events` | Append-only forensic event + idempotency id |
| `recording_parts` | S3 part đã verify |
| `exam_sessions` | Recent jti/IP/UA activity |
| `ai_queue` | Durable grading jobs |
| `ai_settings` | Provider + worker switch |
| `admin_users` | Credentials + role |

Production PostgreSQL cần migrations; startup readiness kiểm tra required columns và unique-index definitions trước khi phục vụ traffic.

## 5. API surface

- Public admin auth: initialization, setup, login, logout.
- Protected admin: users; question import/stats/paging/CRUD; batch CRUD/feasibility; candidate import/list/export/delete/reset; result summary/detail/legacy/export/override; AI settings/test.
- Student: verify, start, questions, answer(s), submit, disconnect, violation, recording URL/complete/finalize.
- Operations: readiness health; authenticated DB/queue/cache stats; queue process bằng admin JWT hoặc exact `CRON_SECRET` bearer.

Chi tiết method/path nằm trong `SPEC.md`.

## 6. Non-functional requirements

### Security

- `JWT_SECRET` bắt buộc; production đặt `SESSION_SECRET` riêng.
- CORS allowlist; CSP/HSTS production/frame deny/no-sniff/no-referrer/Permissions-Policy.
- CSP giữ `'unsafe-eval'` và `blob:` vì Monaco; client minification không phải security boundary.
- Rate limit: global 1200/phút/IP; verify 60/phút/IP; admin login 10/phút/IP; setup 5/giờ/IP.
- JSON/urlencoded 10 MiB; Excel 5 MiB.

### Reliability and performance

- SQLite WAL local; PostgreSQL pool mặc định min 0/max 4.
- Readiness 503 khi DB/schema/cache chưa sẵn sàng.
- Direct DB answer writes, transactional/idempotent submit.
- Paginated/lazy admin read paths và request/DB query metrics.
- Vercel queue chạy qua cron/admin endpoint; self-host có interval 10 giây.

### Browser compatibility

- Exam yêu cầu recent desktop Chrome/Edge có `screen.isExtended`.
- Recording cần HTTPS, Screen Recording permission, Fullscreen, MediaRecorder, whole-monitor share; local thêm File System Access API.
- OS screenshot/shortcut detection vẫn best effort.

## 7. Acceptance criteria

1. Duplicate exact question ID trả 409; edit giữ ID; quiz invalid trả 400.
2. Question paging/filter/ownership UI khớp backend 403.
3. Blueprint ngoài 1–100 hoặc vượt inventory bị từ chối; mod không bật recording qua clone/API.
4. Verify mới revoke token cũ; missing/invalid/revoked token trả 401.
5. Start tạo unique assignment, deadline không vượt batch end, resume không gia hạn.
6. Answer sau deadline/submitted không ghi; submit không mất answer đang debounce.
7. Quiz exact answer nhận configured score; essay AI-off không enqueue; worker-off không claim.
8. Retry cùng violation event id không tăng counter; đủ threshold auto-submit server-side.
9. Client không report được `concurrent_session`; different-IP overlap auto-submit.
10. Unsupported display API, extended display, non-monitor share hoặc fullscreen denial đều chặn Start.
11. Side-panel persistent shrink tạo tối đa hai report; transient shrink không report.
12. S3 metadata chỉ persist sau HeadObject; finalize thiếu part trả 409; submit page phản ánh finalize failure.
13. Health trả 503 pending/error và 200 chỉ khi ready.
14. Results dùng paged summary/lazy detail; export giữ trainer-score precedence.

## 8. Known limitations

- Không ngăn tuyệt đối thiết bị thứ hai, VM, OS accessibility, spoofed UA/IP hoặc custom client.
- Concurrent use cùng NAT/IP có thể không bị detector phát hiện.
- Local recording do candidate kiểm soát; password phải hiện diện trong client để mã hóa.
- S3 chỉ verify object/key/size/manifest, chưa verify duration/frame/black screen.
- AI response JSON chưa có schema validation sâu.
- Repo chưa chứng minh SLA/load target; không dùng claim cũ “20–30 users/99.7% reduction”.

## 9. Deployment targets

- Vercel: `dist/server/index.js` cho API, `client/dist/**` cho SPA, Supabase Transaction Pooler, optional S3, daily cron.
- Ubuntu VPS: `deploy-vps.sh` sinh Docker/Caddy/Compose runtime ngoài checkout, dùng Supabase PostgreSQL.
- `public/**`, root `server/**`, `index.js` và generated bundles không phải production source of truth theo Vercel config.

Xem migration, environment và smoke checklist tại `DEPLOY.md`.
