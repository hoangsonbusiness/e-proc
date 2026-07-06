# 🚀 Hướng dẫn Deploy E-Audit từ VSCode → AWS bằng Terraform

> Hướng dẫn từng bước cho Windows, chạy tất cả lệnh từ **VSCode Terminal (PowerShell)**.

---

## Trạng thái hiện tại

| Item | Status |
|------|--------|
| Terraform | ❌ Chưa cài |
| AWS CLI | ❌ Chưa cài |
| SSH Key | ❌ Chưa có |
| Git Remote | ✅ `https://github.com/minhmaihuy/e-proc.git` |
| Terraform files | ✅ 11 files sẵn sàng |

---

## PHASE 1: Cài Terraform (2 phút)

Mở **VSCode Terminal** (`` Ctrl+` ``), chạy:

```powershell
# Cài Terraform qua winget
winget install HashiCorp.Terraform

# Đóng và mở lại terminal, rồi kiểm tra
terraform --version
```

**Kết quả mong đợi:**
```
Terraform v1.x.x
```

> [!TIP]
> Nếu `winget` không có, tải trực tiếp từ https://developer.hashicorp.com/terraform/install
> → Tải file `.zip` cho Windows AMD64 → Giải nén → Copy `terraform.exe` vào `C:\Windows\` hoặc thêm vào PATH.

---

## PHASE 2: Cài AWS CLI (2 phút)

```powershell
# Cài AWS CLI qua winget
winget install Amazon.AWSCLI

# Đóng và mở lại terminal, rồi kiểm tra
aws --version
```

**Kết quả mong đợi:**
```
aws-cli/2.x.x Python/3.x.x Windows/10 ...
```

---

## PHASE 3: Tạo AWS Access Key (5 phút)

### 3.1 — Tạo IAM User trên AWS Console

1. Vào **AWS Console**: https://console.aws.amazon.com
2. Tìm **IAM** → **Users** → **Create user**
3. Điền:
   - User name: `terraform-deploy`
   - ✅ Check **"Provide user access to the AWS Management Console"** (optional)
4. **Set permissions**:
   - Chọn **"Attach policies directly"**
   - Tìm và check: **`AdministratorAccess`**
   
   > ⚠️ Cho mục đích deploy ban đầu. Sau khi deploy xong, nên giảm quyền xuống.
   
5. Click **Create user**

### 3.2 — Tạo Access Key

1. Click vào user `terraform-deploy` vừa tạo
2. Tab **Security credentials** → **Create access key**
3. Use case: **"Command Line Interface (CLI)"**
4. ✅ Check xác nhận → **Create access key**
5. **⚠️ GHI LẠI** 2 giá trị:
   - `Access key ID`: (ví dụ: `AKIAIOSFODNN7EXAMPLE`)
   - `Secret access key`: (ví dụ: `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`)

### 3.3 — Cấu hình AWS CLI

Quay lại **VSCode Terminal**:

```powershell
aws configure
```

Nhập lần lượt:
```
AWS Access Key ID [None]: <PASTE_ACCESS_KEY_ID>
AWS Secret Access Key [None]: <PASTE_SECRET_ACCESS_KEY>
Default region name [None]: ap-southeast-1
Default output format [None]: json
```

**Kiểm tra:**
```powershell
aws sts get-caller-identity
```

**Kết quả mong đợi:**
```json
{
    "UserId": "AIDAXXXXXXXXXX",
    "Account": "123456789012",
    "Arn": "arn:aws:iam::123456789012:user/terraform-deploy"
}
```

---

## PHASE 4: Tự động hóa SSH Key Pair (0 phút)

> [!NOTE]
> **Không cần cài đặt `ssh-keygen` hoặc tạo SSH Key thủ công!**
> Terraform đã được cấu hình để tự động sinh khóa bảo mật RSA 4096-bit trong bộ nhớ, tự upload khóa công khai lên AWS, và tải xuống khóa riêng tư của bạn dưới dạng file **`eaudit-key.pem`** nằm ngay trong thư mục `terraform/`.
> 
> Bạn hoàn toàn có thể bỏ qua bước này và chuyển sang Phase 5.

---

## PHASE 5: Cấu hình Terraform (3 phút)

```powershell
# Di chuyển vào thư mục terraform
cd d:\Workspaces\e-proc\terraform

# Copy file example → file thật
Copy-Item terraform.tfvars.example terraform.tfvars
```

### Mở file `terraform.tfvars` trong VSCode và SỬA các giá trị:

```hcl
# ✅ Giữ nguyên
aws_region    = "ap-southeast-1"
domain_name   = "devfatstrack.cloud"
app_subdomain = "epoc"
instance_type = "t3.micro"

# ⚠️ Nên đổi thành IP của bạn (tìm IP tại https://whatismyip.com)
allowed_ssh_cidr = "0.0.0.0/0"

# ✅ Giữ nguyên
db_instance_class = "db.t3.micro"
db_name           = "eaudit"
db_username       = "eaudit_admin"

# ⚠️ ĐỔI PASSWORD NÀY! (ít nhất 8 ký tự, có chữ hoa + số + ký tự đặc biệt)
db_password = "MyStr0ng!Pass2026"

# ⚠️ Điền Gemini API key (lấy từ https://aistudio.google.com/app/apikey)
gemini_api_key = "AIzaSy..."

# ⚠️ ĐỔI THÀNH CHUỖI NGẪU NHIÊN (ít nhất 32 ký tự)
session_secret = "my-super-secret-random-string-2026-eaudit-platform"

# ✅ Giữ nguyên
node_env = "production"
app_port = 3001
```

> [!CAUTION]
> **KHÔNG commit `terraform.tfvars` lên Git!** File này chứa mật khẩu. Nó đã được thêm vào `.gitignore`.

---

## PHASE 6: Deploy Infrastructure bằng Terraform (10-15 phút)

### 6.1 — Khởi tạo Terraform

```powershell
cd d:\Workspaces\e-proc\terraform

terraform init
```

**Kết quả mong đợi:**
```
Initializing the backend...
Initializing provider plugins...
- Installing hashicorp/aws v5.x.x...
- Installing hashicorp/random v3.x.x...

Terraform has been successfully initialized!
```

### 6.2 — Xem preview (không tạo gì)

```powershell
terraform plan
```

**Kết quả mong đợi:**
```
Plan: 16 to add, 0 to change, 0 to destroy.
```

Kiểm tra danh sách resources sẽ tạo:
- ✅ `aws_instance.eaudit` (EC2)
- ✅ `aws_db_instance.eaudit` (RDS)
- ✅ `aws_s3_bucket.backup` (S3)
- ✅ `aws_route53_zone.main` (DNS)
- ✅ `aws_eip.eaudit_eip` (Elastic IP)
- ✅ `aws_security_group.eaudit_sg` (SG cho EC2)
- ✅ `aws_security_group.rds_sg` (SG cho RDS)
- ... và các resources khác

### 6.3 — DEPLOY! 🚀

```powershell
terraform apply
```

Terraform sẽ hiển thị plan và hỏi:
```
Do you want to perform these actions?
  Enter a value: yes
```

**Gõ `yes` → Enter**

⏱️ **Đợi 10-15 phút** (RDS mất ~5-10 phút để tạo)

**Kết quả mong đợi:**
```
Apply complete! Resources: 16 added, 0 changed, 0 destroyed.

Outputs:

app_url = "https://epoc.devfatstrack.cloud"
ec2_public_ip = "13.xxx.xxx.xxx"
rds_endpoint = "eaudit-db.xxxxxxxxx.ap-southeast-1.rds.amazonaws.com:5432"
route53_nameservers = [
  "ns-xxx.awsdns-xx.com",
  "ns-xxx.awsdns-xx.net",
  "ns-xxx.awsdns-xx.co.uk",
  "ns-xxx.awsdns-xx.org",
]
s3_backup_bucket = "eaudit-db-backup-xxxxxxxx"
ssh_command = "ssh -i ~/.ssh/id_rsa ubuntu@13.xxx.xxx.xxx"
```

### 6.4 — ⚠️ QUAN TRỌNG: Cập nhật Nameservers

> [!IMPORTANT]
> **Bước này BẮT BUỘC** để domain `devfatstrack.cloud` hoạt động!

1. Copy 4 nameservers từ output `route53_nameservers`
2. Vào **nơi bạn mua domain** (VD: Namecheap, GoDaddy, Tenten, etc.)
3. Tìm **DNS Settings** hoặc **Nameservers**
4. Đổi nameservers thành 4 giá trị từ Route 53:
   ```
   ns-xxx.awsdns-xx.com
   ns-xxx.awsdns-xx.net
   ns-xxx.awsdns-xx.co.uk
   ns-xxx.awsdns-xx.org
   ```
5. Lưu lại. DNS propagate mất **10 phút → 48 giờ** (thường 10-30 phút)

---

## PHASE 7: Setup App trên EC2 (10 phút)

### 7.1 — SSH vào EC2

```powershell
# Lấy SSH command từ terraform output
terraform output -raw ssh_command

# Chạy SSH (khóa eaudit-key.pem tự động tải về thư mục terraform)
ssh -i eaudit-key.pem ubuntu@<EC2_PUBLIC_IP>
```

Lần đầu SSH sẽ hỏi:
```
Are you sure you want to continue connecting? yes
```

> [!TIP]
> Nếu lỗi `Permission denied`, kiểm tra:
> ```powershell
> # Trên Windows, đôi khi cần sửa quyền SSH key
> icacls "$env:USERPROFILE\.ssh\id_rsa" /inheritance:r /grant:r "$($env:USERNAME):R"
> ```

### 7.2 — Kiểm tra UserData đã chạy xong chưa

```bash
# Trên EC2 (sau khi SSH vào)
tail -5 /var/log/userdata.log
```

**Kết quả mong đợi:** Dòng cuối chứa `UserData Complete`

Nếu chưa xong, đợi và check lại:
```bash
tail -f /var/log/userdata.log
# Ctrl+C để thoát khi thấy "Complete"
```

### 7.3 — Clone repo & Build

```bash
# Clone project
cd /opt/eaudit
git clone https://github.com/minhmaihuy/e-proc.git app

# Copy .env (đã được tạo sẵn bởi userdata)
cd app
cp /opt/eaudit/.env .env

# Kiểm tra .env
cat .env
# → Phải thấy DATABASE_URL trỏ tới RDS endpoint
```

### 7.4 — Build Server

```bash
cd /opt/eaudit/app

# Cài dependencies
npm ci --production=false
npm install

# Build TypeScript → JavaScript
npm run build:server
```

### 7.5 — Build Client

```bash
cd /opt/eaudit/app/client

# Cài dependencies
npm ci --production=false
npm install

# Build React app
npm run build

cd ..
```

### 7.6 — Start App

```bash
# Start với PM2
pm2 start dist/server/server.js \
  --name eaudit \
  --max-memory-restart 512M \
  --log-date-format "YYYY-MM-DD HH:mm:ss"

# Lưu PM2 config (auto-start khi reboot)
pm2 save

# Kiểm tra status
pm2 status
```

**Kết quả mong đợi:**
```
┌─────┬─────────┬──────┬───────┬──────────┬──────┐
│ id  │ name    │ mode │ ↺     │ status   │ cpu  │
├─────┼─────────┼──────┼───────┼──────────┼──────┤
│ 0   │ eaudit  │ fork │ 0     │ online   │ 0%   │
└─────┴─────────┴──────┴───────┴──────────┴──────┘
```

### 7.7 — Init Database Tables

```bash
# Tạo tables trên RDS
curl -s -X POST http://localhost:3001/api/init-tables
# → {"success":true,"message":"Tables initialized"}

# Kiểm tra kết nối DB
curl -s http://localhost:3001/api/test-db
# → {"success":true,"time":"...","pg_version":"PostgreSQL 16.4..."}

# Health check
curl -s http://localhost:3001/api/health
# → {"status":"ok",...}
```

> [!IMPORTANT]
> Nếu `init-tables` lỗi, kiểm tra logs:
> ```bash
> pm2 logs eaudit --lines 50
> ```

---

## PHASE 8: Setup SSL Certificate (2 phút)

> ⚠️ DNS phải đã propagate trước khi chạy bước này. Kiểm tra:
> ```bash
> nslookup epoc.devfatstrack.cloud
> # Phải trả về IP = EC2 Elastic IP
> ```

```bash
sudo certbot --nginx \
  -d epoc.devfatstrack.cloud \
  --agree-tos \
  --no-eff-email \
  --redirect \
  -m your-email@gmail.com
```

**Kết quả mong đợi:**
```
Congratulations! You have successfully enabled HTTPS...
```

---

## ✅ HOÀN TẤT! Kiểm tra lần cuối

### Trên EC2:
```bash
curl -s http://localhost:3001/api/health
curl -s http://localhost:3001/api/test-db
pm2 status
```

### Trên trình duyệt (máy local):
```
🌐 https://epoc.devfatstrack.cloud           → Trang student login
🌐 https://epoc.devfatstrack.cloud/admin     → Trang admin login
🌐 https://epoc.devfatstrack.cloud/api/health → Health check JSON
```

### Login Admin:
```
Username: admin
Password: admin123
```

---

## 📋 Lệnh hữu ích hàng ngày

### Trên máy local (VSCode Terminal):
```powershell
# Xem tất cả outputs
cd d:\Workspaces\e-proc\terraform
terraform output

# SSH vào EC2 nhanh
ssh -i ~/.ssh/id_rsa ubuntu@$(terraform output -raw ec2_public_ip)

# Xem chi phí ước tính
terraform output monthly_cost_estimate

# Xóa TOÀN BỘ infrastructure (cẩn thận!)
terraform destroy
```

### Trên EC2 (sau khi SSH):
```bash
# Xem app logs
pm2 logs eaudit --lines 50

# Restart app
pm2 restart eaudit

# Deploy code mới
bash /opt/eaudit/deploy.sh

# Manual backup DB → S3
bash /opt/eaudit/backup-db.sh

# Xem cron jobs
crontab -l
```

---

## 🔥 Troubleshooting

### Lỗi `terraform init` — Provider not found
```powershell
# Xóa cache và thử lại
Remove-Item -Recurse -Force .terraform
Remove-Item .terraform.lock.hcl
terraform init
```

### Lỗi `terraform apply` — Credentials
```powershell
# Kiểm tra AWS credentials
aws sts get-caller-identity
# Nếu lỗi → chạy lại: aws configure
```

### Lỗi SSH — Permission denied
```powershell
# Windows: sửa quyền file SSH key
icacls "$env:USERPROFILE\.ssh\id_rsa" /inheritance:r /grant:r "$($env:USERNAME):R"
```

### Lỗi SSH — Connection timeout
```powershell
# Kiểm tra Security Group cho phép SSH port 22
# Hoặc EC2 chưa boot xong, đợi 2-3 phút
```

### Lỗi RDS — Connection refused (trên EC2)
```bash
# Kiểm tra RDS endpoint đúng chưa
cat /opt/eaudit/.env | grep DATABASE_URL

# Test kết nối trực tiếp
psql "$(grep DATABASE_URL /opt/eaudit/.env | cut -d= -f2-)"
```

### Lỗi Certbot — DNS chưa propagate
```bash
# Kiểm tra DNS
nslookup devfatstrack.cloud
dig devfatstrack.cloud

# Nếu chưa có IP → đợi thêm 10-30 phút
# Hoặc kiểm tra nameservers đã update ở domain registrar chưa
```

### App crash / restart liên tục
```bash
pm2 logs eaudit --lines 100
# Xem lỗi cụ thể → sửa → pm2 restart eaudit
```
