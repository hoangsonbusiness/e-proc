# Deploy Guide - E-Audit Platform

## Bước 1: Chuẩn bị

### 1.1. Tạo Supabase Project
1. Go to https://supabase.com → "New Project"
2. Điền tên project: `eaudit`
3. Password database: `postgres123` (hoặc tùy chọn)
4. Region: Chọn gần nhất (Singapore)
5. Click "Create new project"

### 1.2. Lấy Database URL
- Sau khi tạo xong → Settings → Database
- Copy "Connection string" (kìm theo password đã đặt)
- Format: `postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres`

### 1.3. Lấy Gemini API Key
1. Go to https://aistudio.google.com/app/apikey
2. Click "Create API Key" → Copy key

---

## Bước 2: Deploy Backend lên Vercel

```bash
cd /home/ast/Workspace_OpenCode
```

Tạo file `vercel.json`:
```json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "framework": "none",
  "installCommand": "npm install"
}
```

Deploy:
```bash
npm i -g vercel
vercel login
vercel --prod
```

- Connect to GitHub khi được hỏi
- Project name: `eaudit-backend`
- Directory: `.` (current)
- Environment variables cần thêm:
  - `DATABASE_URL`: (từ bước 1.2)
  - `GEMINI_API_KEY`: (từ bước 1.3)
  - `SESSION_SECRET`: (chuỗi bảo mật)

---

## Bước 3: Deploy Frontend lên Vercel

```bash
cd /home/ast/Workspace_OpenCode/client
vercel --prod
```

- Project name: `eaudit-frontend`
- Directory: `.`
- Sau khi deploy xong, copy URL (ví dụ: `https://eaudit-frontend.vercel.app`)

---

## Bước 4: Cấu hình API

Trong frontend, cập nhật `client/src/services/api.ts`:
```typescript
const API_BASE = 'https://eaudit-backend.vercel.app/api';
```

---

## Bước 5: Setup Cron Job (Queue)

Vercel Dashboard → Project → Settings → Cron Jobs

Create cron:
- Path: `/api/queue/process`
- Schedule: `*/1 * * * *` (mỗi phút)

---

## Hoàn tất!

Sau khi deploy:
- **Admin:** https://eaudit-frontend.vercel.app/admin
- **Student:** https://eaudit-frontend.vercel.app/

Login admin: `admin` / `admin123`

---

## Troubleshooting

**Lỗi CORS:**
- Đảm bảo CORS_ORIGIN = true trong code

**Lỗi Database:**
- Kiểm tra DATABASE_URL đúng format
- Supabase cần enable "IP Allowlist" → để "Allow all IPs"

**Lỗi Queue:**
- Kiểm tra Cron Job đã tạo chưa
- Vercel free tier: timeout 10s, nên xử lý batch nhỏ

---

## Chi phí:
- **Supabase:** Free (giới hạn 500MB, 100 concurrent)
- **Vercel:** Free (100GB bandwidth, 1000 build phút/tháng)
- **Gemini:** Free (15 requests/phút, 1500 requests/ngày)

→ **Tổng: $0/month**