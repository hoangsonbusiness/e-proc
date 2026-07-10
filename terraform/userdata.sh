#!/bin/bash
# =============================================================================
# EC2 User Data — Bootstrap E-Audit Platform (IPv4)
# With RDS PostgreSQL + S3 Backup + Auto-Deploy
# =============================================================================
set -euo pipefail

exec > /var/log/userdata.log 2>&1
echo "=== E-Audit UserData Start: $(date) ==="

# =============================================================================
# STEP 1: System Update & Core Packages
# =============================================================================
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y

# --- Install Node.js 18 LTS ---
echo ">>> Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
echo "Node.js version: $(node --version)"
echo "NPM version: $(npm --version)"

# --- Install Nginx ---
echo ">>> Installing Nginx..."
apt-get install -y nginx
systemctl enable nginx

# --- Install Certbot (Let's Encrypt SSL) ---
echo ">>> Installing Certbot..."
apt-get install -y certbot python3-certbot-nginx

# --- Install PM2 (Node.js Process Manager) ---
echo ">>> Installing PM2..."
npm install -g pm2

# --- Install Git & Build Tools ---
echo ">>> Installing build tools..."
apt-get install -y git build-essential

# --- Install PostgreSQL Client (for pg_dump backups) ---
echo ">>> Installing PostgreSQL client..."
apt-get install -y postgresql-client-16 || apt-get install -y postgresql-client

# --- Install AWS CLI with Fallbacks ---
echo ">>> Installing AWS CLI..."
if apt-get install -y awscli 2>/dev/null; then
    echo "AWS CLI installed via apt"
else
    echo ">>> apt failed, trying snap install for AWS CLI..."
    if snap install aws-cli --classic 2>/dev/null; then
        echo "AWS CLI installed via snap"
        ln -sf /snap/bin/aws /usr/bin/aws || true
    else
        echo ">>> snap failed, downloading official AWS CLI zip..."
        apt-get install -y unzip
        ARCH=$(uname -m)
        if [ "$ARCH" = "x86_64" ]; then
            curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
        else
            curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"
        fi
        unzip -q awscliv2.zip
        ./aws/install
        rm -rf awscliv2.zip aws
        ln -sf /usr/local/bin/aws /usr/bin/aws || true
    fi
fi

# =============================================================================
# STEP 2: System Configuration
# =============================================================================

# --- Add Swap (1GB) ---
echo ">>> Setting up 1GB swap..."
if [ ! -f /swapfile ]; then
    fallocate -l 1G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "    Swap enabled: 1GB"
fi

# --- Create app directory ---
echo ">>> Setting up app directory..."
mkdir -p /opt/eaudit
chown ubuntu:ubuntu /opt/eaudit

# --- Create environment file ---
echo ">>> Creating .env file..."
cat > /opt/eaudit/.env << 'ENVEOF'
NODE_ENV=${node_env}
PORT=${app_port}
DATABASE_URL=${database_url}
GEMINI_API_KEY=${gemini_api_key}
SESSION_SECRET=${session_secret}
USE_SQLITE=false
ENVEOF
chown ubuntu:ubuntu /opt/eaudit/.env
chmod 600 /opt/eaudit/.env

# =============================================================================
# STEP 3: Configure Nginx
# =============================================================================
echo ">>> Configuring Nginx..."
cat > /etc/nginx/sites-available/eaudit << 'NGINXEOF'
server {
    listen 80;
    server_name ${domain_name}${www_domain_name != "" ? " " : ""}${www_domain_name};

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml text/javascript image/svg+xml;

    # API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:${app_port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
        client_max_body_size 10M;
    }

    # Static files (React build)
    location / {
        root /opt/eaudit/app/client/dist;
        index index.html;
        try_files $uri $uri/ /index.html;

        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            expires 30d;
            add_header Cache-Control "public, immutable";
        }
    }

    # Health check (no logging)
    location = /api/health {
        proxy_pass http://127.0.0.1:${app_port};
        access_log off;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/eaudit /etc/nginx/sites-enabled/eaudit
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# =============================================================================
# STEP 4: Create Helper Scripts
# =============================================================================

# --- DB Backup Script ---
echo ">>> Creating backup script..."
cat > /opt/eaudit/backup-db.sh << 'BACKUPEOF'
#!/bin/bash
set -euo pipefail

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="/tmp/eaudit_backup_$TIMESTAMP.sql.gz"
S3_BUCKET="${s3_bucket}"
DB_HOST="${db_host}"
DB_PORT="${db_port}"
DB_NAME="${db_name}"
DB_USER="${db_username}"

echo "[Backup] Starting: $TIMESTAMP"

export PGPASSWORD=$(grep DATABASE_URL /opt/eaudit/.env | sed 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/')
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges | gzip > "$BACKUP_FILE"

aws s3 cp "$BACKUP_FILE" "s3://$S3_BUCKET/backups/$TIMESTAMP.sql.gz" --region ${aws_region}
rm -f "$BACKUP_FILE"

echo "[Backup] Complete: s3://$S3_BUCKET/backups/$TIMESTAMP.sql.gz"
BACKUPEOF
chmod +x /opt/eaudit/backup-db.sh
chown ubuntu:ubuntu /opt/eaudit/backup-db.sh

# --- Deploy Script ---
echo ">>> Creating deploy script..."
cat > /opt/eaudit/deploy.sh << 'DEPLOYEOF'
#!/bin/bash
set -euo pipefail
echo "=== Deploying E-Audit: $(date) ==="
cd /opt/eaudit/app

# Clean conflicting local files to ensure clean git pull
git checkout -- . || true
rm -rf dist client/dist package-lock.json client/package-lock.json

echo ">>> Pulling latest code..."
git pull origin main

echo ">>> Executing repository deploy script..."
bash deploy/scripts/deploy.sh
DEPLOYEOF
chmod +x /opt/eaudit/deploy.sh
chown ubuntu:ubuntu /opt/eaudit/deploy.sh

# =============================================================================
# STEP 5: Auto-Deploy Application
# =============================================================================
echo ">>> AUTO-DEPLOYING APPLICATION..."

# Clone the repository
echo ">>> Cloning repository..."
cd /opt/eaudit
su - ubuntu -c "cd /opt/eaudit && git clone https://github.com/minhmaihuy/e-proc.git app" || {
    echo "ERROR: Failed to clone repository. Will retry once after 10 seconds..."
    sleep 10
    su - ubuntu -c "cd /opt/eaudit && git clone https://github.com/minhmaihuy/e-proc.git app"
}

# Copy .env to app directory
cp /opt/eaudit/.env /opt/eaudit/app/.env
chown ubuntu:ubuntu /opt/eaudit/app/.env

# Install server dependencies & build
echo ">>> Installing server dependencies..."
cd /opt/eaudit/app
su - ubuntu -c "cd /opt/eaudit/app && npm install"

echo ">>> Building server..."
su - ubuntu -c "cd /opt/eaudit/app && npm run build:server"

# Install client dependencies & build
echo ">>> Installing client dependencies..."
su - ubuntu -c "cd /opt/eaudit/app/client && npm install"

echo ">>> Building client..."
su - ubuntu -c "cd /opt/eaudit/app/client && npm run build"

# Start application with PM2
echo ">>> Starting application with PM2..."
su - ubuntu -c "cd /opt/eaudit/app && pm2 start dist/server/server.js --name eaudit --max-memory-restart 512M"
su - ubuntu -c "pm2 save"

# Wait for app to start
echo ">>> Waiting for app to start..."
sleep 5

# Initialize database tables
echo ">>> Initializing database tables..."
curl -s -X POST http://localhost:${app_port}/api/init-tables || echo "WARNING: init-tables call failed (may need manual init)"

# =============================================================================
# STEP 6: PM2 Startup & Cron Jobs
# =============================================================================

# --- PM2 startup ---
echo ">>> Configuring PM2 startup..."
env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
su - ubuntu -c "pm2 save" || true

# --- Cron Jobs ---
echo ">>> Setting up cron jobs..."
cat > /tmp/eaudit-cron << 'CRONEOF'
# SSL auto-renew (daily 3 AM)
0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'

# DB backup to S3 (daily 2 AM)
0 2 * * * /opt/eaudit/backup-db.sh >> /var/log/eaudit-backup.log 2>&1

# AI queue processor (every minute)
* * * * * curl -s http://localhost:3001/api/queue/process > /dev/null 2>&1
CRONEOF
crontab -u ubuntu /tmp/eaudit-cron
rm /tmp/eaudit-cron
echo "    Cron jobs configured"

# =============================================================================
# STEP 7: Firewall
# =============================================================================
echo ">>> Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# =============================================================================
# DONE!
# =============================================================================
echo ""
echo "=========================================="
echo "=== E-Audit Deployment COMPLETE! ==="
echo "=========================================="
echo "=== Finished at: $(date) ==="
echo ""
echo ">>> App Status:"
su - ubuntu -c "pm2 status" || true
echo ""
echo ">>> Health Check:"
curl -s http://localhost:${app_port}/api/health || echo "(App may still be starting...)"
echo ""
echo ">>> Domain: ${domain_name}"
echo ">>> SSL: Run 'sudo certbot --nginx -d ${domain_name}${www_domain_name != "" ? " -d " : ""}${www_domain_name}' to enable HTTPS"
