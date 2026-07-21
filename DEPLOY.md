# Deploy Guide - E-Audit Platform

Kiến trúc: **1 project Vercel duy nhất** (backend + frontend cùng deploy, route qua `vercel.json`) + Supabase (PostgreSQL). Không cần Redis, không cần VPS.

## Bước 1: Chuẩn bị

### 1.1. Tạo Supabase Project
1. Go to https://supabase.com → "New Project"
2. Điền tên project: `eaudit`
3. Password database: tự đặt mật khẩu mạnh (không dùng mật khẩu mẫu trong tài liệu)
4. Region: Chọn gần nhất (Singapore)
5. Click "Create new project"

### 1.2. Lấy Database URL
- Sau khi tạo xong → Settings → Database
- Copy **"Connection pooling"** connection string (chế độ Transaction), không phải connection string trực tiếp — pooler phù hợp hơn cho serverless (Vercel), vì mỗi function invocation có thể mở connection riêng và connection trực tiếp dễ cạn khi nhiều người thi cùng lúc
- Format: `postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:6543/postgres?pgbouncer=true`

### 1.3. Lấy Gemini API Key (nếu dùng Gemini)
1. Go to https://aistudio.google.com/app/apikey
2. Click "Create API Key" → Copy key
3. Có thể bỏ qua bước này nếu cấu hình AI provider khác trực tiếp trong admin UI (bảng `ai_settings`)

---

## Bước 2: Deploy lên Vercel

Project hiện tại chỉ deploy **1 lần duy nhất** ở thư mục gốc — `vercel.json` đã tự route `/api/*` sang backend và phần còn lại sang frontend đã build sẵn trong `client/dist`. Không cần deploy `client/` riêng.

```bash
npm i -g vercel
vercel login
vercel --prod
```

- Connect to GitHub khi được hỏi
- Project name: `eaudit` (hoặc tên bạn muốn)
- Directory: `.` (current — thư mục gốc, không phải `client/`)
- Trước khi deploy, đảm bảo đã build sẵn và commit: `npm run build` (chạy cả `build:client` + `build:server`), rồi commit `client/dist/` và `dist/`. Nếu chỉ sửa source mà không rebuild + commit, Vercel sẽ deploy bản build cũ.
- Environment variables cần thêm (Vercel Dashboard → Project → Settings → Environment Variables):
  - `JWT_SECRET`: chuỗi ngẫu nhiên ≥32 ký tự (bắt buộc, server sẽ không chạy nếu thiếu)
  - `DATABASE_URL`: connection string từ bước 1.2
  - `GEMINI_API_KEY`: (nếu dùng, từ bước 1.3)
  - `ALLOWED_ORIGINS`: URL deployment Vercel thật của bạn (ví dụ `https://eaudit.vercel.app`)
  - `SESSION_SECRET`: chuỗi bảo mật (không để mặc định `'secret'`)

---

## Bước 3: Setup Cron Job (Queue chấm bài AI)

⚠️ **Lưu ý quan trọng — route cron hiện tại yêu cầu đăng nhập admin:**

`GET /api/queue/process` (dùng để xử lý queue chấm bài AI) đang được bảo vệ bởi `authMiddleware` — nghĩa là nó cần JWT admin (`Authorization: Bearer <admin_token>`), không phải cơ chế `CRON_SECRET` mà Vercel Cron Jobs dùng mặc định. Nếu bạn tạo Cron Job theo cách dưới đây mà không xử lý thêm, **request sẽ bị trả về 401 và queue sẽ không được xử lý qua cron**.

Cách tạo Cron Job (Vercel Dashboard → Project → Settings → Cron Jobs):
- Path: `/api/queue/process`
- Schedule: `*/1 * * * *` (mỗi phút)

Trước khi tin tưởng cron này hoạt động, hãy tự kiểm tra: gọi thử endpoint và xác nhận trả về 200, không phải 401. Nếu bị 401, có 2 lựa chọn:
1. Sửa route để chấp nhận `CRON_SECRET` riêng cho request từ Vercel Cron (cần code thêm, chưa có sẵn)
2. Bỏ qua cron, dựa vào cơ chế xử lý queue tự động đang chạy sẵn trong tiến trình (`QUEUE_PROCESS_INTERVAL`, mặc định 10 giây/lần) — với quy mô ~40 lượt thi/tháng, có học viên đang hoạt động liên tục trong lúc thi, cách này thường đã đủ mà không cần cron ngoài.

---

## Hoàn tất!

Sau khi deploy:
- **Admin:** https://<your-project>.vercel.app/admin
- **Student:** https://<your-project>.vercel.app/

(Tạo admin user qua `/api/admin/setup` hoặc theo cơ chế setup ban đầu — không dùng tài khoản/mật khẩu mẫu có sẵn trong bất kỳ tài liệu nào.)

---

## Troubleshooting

**Lỗi CORS:**
- Kiểm tra `ALLOWED_ORIGINS` đã set đúng domain Vercel thật chưa

**Lỗi Database:**
- Kiểm tra `DATABASE_URL` đúng format, đang dùng pooler connection (bước 1.2) chứ không phải direct connection
- Supabase: kiểm tra Network Restrictions cho phép Vercel kết nối (mặc định thường đã cho phép mọi IP với connection pooler)

**Lỗi Queue / chấm bài AI không chạy:**
- Nếu dùng Cron Job: kiểm tra có bị 401 không (xem Bước 3 ở trên)
- Nếu không dùng Cron: kiểm tra biến `QUEUE_PROCESS_INTERVAL` và log server xem interval xử lý queue có chạy không
- Vercel free tier: function timeout 10s, nên xử lý batch nhỏ (`limit` param trên `/api/queue/process`)

**Sửa code frontend nhưng không thấy hiệu lực:**
- Đã build lại `client/dist` và commit chưa? Vercel deploy từ artifact có sẵn, không tự rebuild lại nếu bạn không cấu hình build command tương ứng
- Nếu vẫn không thấy hiệu lực dù đã build/commit/deploy đúng commit: thử Vercel Dashboard → Redeploy → tắt "Use existing Build Cache" (gặp phải trường hợp này thực tế — code đã đúng nhưng bundle cũ vẫn được serve do build cache)

---

## Giới hạn cần lưu ý ở quy mô hiện tại (~40 lượt thi/tháng, ~20-25 học viên/lượt)

- **Buffer đáp án đang lưu tạm trong bộ nhớ (in-memory), không phải ghi thẳng DB mỗi lần gõ** (`src/server/cache.ts`, debounce 2s ở frontend + flush định kỳ ở backend). Đừng bỏ cơ chế này để "ghi thẳng Supabase" — làm vậy sẽ tăng đáng kể lưu lượng (bandwidth) tới Supabase và có nguy cơ chạm giới hạn free tier nhanh hơn, trong khi lợi ích (tránh mất buffer khi Vercel scale nhiều instance) không đáng so với chi phí này ở quy mô hiện tại.
- **Bug đã biết**: `FileCache` (`src/server/cache.ts`) có 2 biến `dataDir`/`queueFile` khai báo nhưng chưa được gán giá trị ở constructor — gây lỗi `npm run dev` chạy local (không ảnh hưởng production vì có nhánh riêng bỏ qua bước này khi `NODE_ENV=production`). Cần fix riêng nếu muốn chạy dev server local.

## Chi phí ước tính ở quy mô hiện tại:
- **Supabase:** Free (500MB database, connection pooler) — đủ dùng thoải mái ở quy mô ~40 lượt thi/tháng × 20-25 học viên, miễn giữ nguyên cơ chế buffer/debounce ở trên. Lưu ý: project free tier tự pause sau 7 ngày không hoạt động — nếu giữa các đợt thi cách nhau lâu, cân nhắc ping định kỳ để tránh bị pause.
- **Vercel:** Free (100GB bandwidth/tháng) — dư dả ở quy mô này.
- **Gemini:** Free tier có giới hạn request/phút và request/ngày — kiểm tra lại giới hạn hiện tại của provider so với số câu hỏi × học viên × lượt thi/tháng thực tế trước khi giả định luôn đủ dùng.

→ **Tổng: $0/month** ở quy mô hiện tại, với điều kiện xử lý vấn đề cron 401 ở Bước 3 (hoặc chấp nhận dùng interval xử lý queue trong tiến trình thay vì cron).
