# Hướng dẫn cấu hình AWS S3 để lưu video ghi màn hình bài thi

> Mục tiêu: tạo nơi lưu video (S3 bucket), một tài khoản quyền tối thiểu (IAM user) để backend upload, cấu hình CORS + tự động xóa, rồi khai báo 4 biến môi trường trên Vercel.
>
> Ước tính thời gian: ~15–20 phút. Chỉ làm **một lần**.

---

## Tổng quan các bước

1. Tạo **S3 bucket** (nơi chứa video)
2. Cấu hình **CORS** cho bucket (cho phép trình duyệt thí sinh upload thẳng)
3. Cấu hình **Lifecycle rule** (tự xóa video sau N ngày)
4. Tạo **IAM policy + user** (quyền tối thiểu, lấy access key)
5. Khai báo **4 biến môi trường** trên Vercel
6. Kiểm tra

> ⚠️ Ghi lại 3 giá trị sau khi làm, sẽ dùng ở bước 5:
> - Tên bucket (ví dụ `eproc-exam-recordings`)
> - Region của bucket (ví dụ `us-east-1`)
> - Access Key ID + Secret Access Key (bước 4)

---

## Bước 1 — Tạo S3 bucket

1. Đăng nhập [AWS Console](https://console.aws.amazon.com/) → tìm dịch vụ **S3**.
2. Bấm **Create bucket**.
3. **Bucket name**: đặt tên duy nhất toàn cầu, ví dụ `eproc-exam-recordings` (không trùng với bucket của người khác trên AWS).
4. **AWS Region**: chọn region gần bạn/thí sinh (ví dụ `Asia Pacific (Singapore) ap-southeast-1` hoặc `US East (N. Virginia) us-east-1`). **Ghi nhớ region này.**
5. **Block Public Access**: **GIỮ NGUYÊN bật tất cả** (Block all public access = ON). Video không cần public — backend upload bằng quyền riêng, admin tải về bằng credential. Không mở public.
6. Các mục khác để mặc định → **Create bucket**.

---

## Bước 2 — Cấu hình CORS cho bucket

Cho phép trình duyệt thí sinh gửi lệnh `PUT` thẳng lên S3 (nếu không có, trình duyệt sẽ chặn vì khác origin).

1. Vào bucket vừa tạo → tab **Permissions**.
2. Kéo xuống mục **Cross-origin resource sharing (CORS)** → **Edit**.
3. Dán JSON sau, **thay `https://TEN-APP.vercel.app`** bằng domain thật của hệ thống thi (domain thí sinh truy cập):

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT"],
    "AllowedOrigins": ["https://TEN-APP.vercel.app"],
    "ExposeHeaders": [],
    "MaxAgeSeconds": 3000
  }
]
```

> - Nếu có nhiều domain (ví dụ cả domain tùy chỉnh lẫn `*.vercel.app`), thêm nhiều dòng trong `AllowedOrigins`:
>   `"AllowedOrigins": ["https://thi.congty.com", "https://ten-app.vercel.app"]`
> - **Không** dùng `"*"` cho `AllowedOrigins` ở production (kém an toàn). Chỉ liệt kê domain thật.

4. **Save changes**.

---

## Bước 3 — Cấu hình Lifecycle rule (tự động xóa video)

Video tự xóa sau N ngày để không phình dung lượng và giảm rủi ro lộ dữ liệu.

1. Trong bucket → tab **Management** → mục **Lifecycle rules** → **Create lifecycle rule**.
2. **Lifecycle rule name**: `auto-delete-recordings`.
3. **Rule scope**: chọn **Limit the scope... using filters** → ở **Prefix** nhập: `recordings/`
4. **Lifecycle rule actions**: tích **Expire current versions of objects**.
5. **Days after object creation**: nhập số ngày muốn giữ, ví dụ `7` (giữ 7 ngày rồi tự xóa). Chọn số ngày **đủ để bạn đối chiếu xong** trước khi video bị xóa.
6. **Create rule**.

> Tương đương JSON (nếu cấu hình bằng CLI/API):
> ```json
> {
>   "Rules": [
>     {
>       "ID": "auto-delete-recordings",
>       "Filter": { "Prefix": "recordings/" },
>       "Status": "Enabled",
>       "Expiration": { "Days": 7 }
>     }
>   ]
> }
> ```

---

## Bước 4 — Tạo IAM user với quyền tối thiểu

Tạo một tài khoản riêng chỉ có quyền **ghi** vào thư mục `recordings/` — nếu access key này lộ, kẻ tấn công cũng không xóa/đọc được dữ liệu khác.

### 4.1 — Tạo Policy

1. AWS Console → dịch vụ **IAM** → **Policies** → **Create policy**.
2. Chọn tab **JSON**, dán nội dung sau. **Thay `TEN-BUCKET`** bằng tên bucket ở Bước 1:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::TEN-BUCKET/recordings/*"
    }
  ]
}
```

3. **Next** → đặt tên policy: `eproc-recording-put-only` → **Create policy**.

> Chỉ có `s3:PutObject` (ghi). Không có quyền đọc, xóa, liệt kê — đủ để backend cấp URL upload, không hơn.

### 4.2 — Tạo User và gắn Policy

1. IAM → **Users** → **Create user**.
2. **User name**: `eproc-recording-uploader`.
3. **KHÔNG** tích "Provide user access to the AWS Management Console" (user này chỉ dùng API, không cần đăng nhập console).
4. **Next** → **Permissions options**: chọn **Attach policies directly** → tìm và tích `eproc-recording-put-only` (policy vừa tạo).
5. **Next** → **Create user**.

### 4.3 — Lấy Access Key

1. Bấm vào user `eproc-recording-uploader` vừa tạo → tab **Security credentials**.
2. Mục **Access keys** → **Create access key**.
3. **Use case**: chọn **Application running outside AWS** → **Next** → **Create access key**.
4. **Ghi lại ngay** (màn hình này chỉ hiện Secret **một lần duy nhất**):
   - **Access key ID** (dạng `AKIA...`)
   - **Secret access key**
5. Bấm **Download .csv file** để lưu an toàn, rồi **Done**.

> ⚠️ **Bảo mật:** không commit access key vào code/git, không gửi qua chat công khai. Nếu lỡ lộ, vào IAM xóa key đó và tạo key mới.

---

## Bước 5 — Khai báo biến môi trường trên Vercel

1. Vào [Vercel Dashboard](https://vercel.com/) → chọn project của hệ thống thi.
2. **Settings** → **Environment Variables**.
3. Thêm **4 biến** sau (bấm **Add** cho từng biến). Chọn phạm vi **Production** (và **Preview** nếu bạn test trên preview deploy):

| Key | Value | Ghi chú |
|-----|-------|---------|
| `AWS_ACCESS_KEY_ID` | `AKIA...` | Access key ID ở bước 4.3 |
| `AWS_SECRET_ACCESS_KEY` | (chuỗi secret) | Secret access key ở bước 4.3 |
| `AWS_REGION` | ví dụ `ap-southeast-1` | Region bucket ở bước 1 |
| `S3_RECORDINGS_BUCKET` | ví dụ `eproc-exam-recordings` | Tên bucket ở bước 1 |

4. **Save**.
5. **Redeploy** để biến môi trường có hiệu lực: vào tab **Deployments** → deployment mới nhất → **Redeploy**.
   - ⚠️ Nếu từng gặp lỗi Vercel serve code cũ, khi redeploy hãy **tắt "Use existing Build Cache"**.

> Tên biến phải **chính xác** như bảng trên — backend đọc đúng các tên này (`process.env.AWS_ACCESS_KEY_ID`, …). Sai tên → endpoint upload trả lỗi 503 "S3 not configured".

---

## Bước 6 — Kiểm tra

1. Vào một bài thi (hoặc đề thi thử), chia sẻ **toàn bộ màn hình**, làm bài **hơn 5 phút**.
2. Mở **AWS Console → S3 → bucket** → kiểm tra có thư mục:
   `recordings/{batchId}/{studentId}/part000.webm`
   xuất hiện sau ~5 phút.
3. Nộp bài → kiểm tra có thêm **part cuối** được tải lên.
4. (Kiểm tra chống gian lận) Trong lúc thi bấm **"Stop sharing"** của trình duyệt → bài phải **bị khóa ngay**.

### Nếu không thấy file lên S3

Mở **DevTools (F12) → Console / Network** lúc thi và kiểm tra:

| Triệu chứng | Nguyên nhân thường gặp |
|---|---|
| Lỗi **CORS** khi PUT lên S3 | `AllowedOrigins` trong CORS (Bước 2) chưa khớp domain thật. Sửa lại đúng domain. |
| Request `/exam/recording-url` trả **503** | 4 biến env chưa đặt đúng hoặc chưa redeploy (Bước 5). |
| Request `/exam/recording-url` trả **500** | Access key sai, hoặc region/bucket sai. Kiểm tra lại Bước 4–5. |
| PUT lên S3 trả **403 AccessDenied** | IAM policy chưa đúng `Resource` (Bước 4.1) — kiểm tra tên bucket trong ARN. |

---

## Chi phí tham khảo

Với 30 thí sinh × 60 phút (~8 GB/đợt): chi phí S3 khoảng **dưới $1/đợt** (upload gần như miễn phí, lưu trữ vài cent, tải về miễn phí trong 100GB/tháng đầu). Lifecycle tự xóa giúp chi phí lưu trữ gần như bằng 0.
