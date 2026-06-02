#!/bin/bash
# =============================================================================
# EC2 User Data — Bootstrap E-Audit Platform (IPv6 Optimized)
# =============================================================================
set -euo pipefail

exec > /var/log/userdata.log 2>&1
echo "=== E-Audit IPv6 UserData Start: $(date) ==="

# --- Configure Public DNS64 / NAT64 for Free IPv4 Internet Access ---
# Since GitHub, NodeSource, and standard Linux package mirrors do not support native IPv6,
# we temporarily inject public DNS64 resolvers. This automatically maps IPv4-only domains
# to IPv6 and routes traffic through free public NAT64 gateways.
echo ">>> Injecting public DNS64/NAT64 resolvers..."
mkdir -p /etc/systemd/resolved.conf.d/
cat > /etc/systemd/resolved.conf.d/dns64.conf << 'DNS64EOF'
[Resolve]
DNS=2001:67c:2b0::4 2001:67c:2b0::6 2001:67c:27e4:15::64
FallbackDNS=2001:4860:4860::6464 2001:4860:4860::64
DNSEOF
systemctl restart systemd-resolved
sleep 2

# Verify internet connectivity
echo ">>> Verifying internet connectivity..."
ping6 -c 3 -W 5 2001:4860:4860::8888 || echo "Warning: ping6 failed"
curl -I -m 10 https://github.com || echo "Warning: Github is unreachable yet"

# --- System Update ---
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y

# --- Install Node.js 18 LTS ---
echo ">>> Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
node --version
npm --version

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
if apt-get install -y awscli; then
    echo "AWS CLI installed via apt"
else
    echo ">>> apt failed, trying snap install for AWS CLI..."
    if snap install aws-cli --classic; then
        echo "AWS CLI installed via snap"
        ln -sf /snap/bin/aws /usr/bin/aws || true
    else
        echo ">>> snap failed, downloading official AWS CLI zip..."
        apt-get install -y unzip
        curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
        unzip -q awscliv2.zip
        ./aws/install
        rm -rf awscliv2.zip aws
        ln -sf /usr/local/bin/aws /usr/bin/aws || true
    fi
fi

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

# --- Create app user & directory ---
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

# --- Configure Nginx ---
echo ">>> Configuring Nginx..."
cat > /etc/nginx/sites-available/eaudit << 'NGINXEOF'
server {
    listen 80;
    listen [::]:80; # Listen on IPv6 as well
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

# Enable site
ln -sf /etc/nginx/sites-available/eaudit /etc/nginx/sites-enabled/eaudit
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# --- Create DB backup script ---
echo ">>> Creating backup script..."
cat > /opt/eaudit/backup-db.sh << 'BACKUPEOF'
#!/bin/bash
# Daily PostgreSQL backup to S3
set -euo pipefail

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="/tmp/eaudit_backup_$TIMESTAMP.sql.gz"
S3_BUCKET="${s3_bucket}"
DB_HOST="${db_host}"
DB_PORT="${db_port}"
DB_NAME="${db_name}"
DB_USER="${db_username}"

echo "[Backup] Starting: $TIMESTAMP"

# Dump database (password from .env)
export PGPASSWORD=$(grep DATABASE_URL /opt/eaudit/.env | sed 's/.*:\/\/[^:]*:\([^@]*\)@.*/\1/')
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" --no-owner --no-privileges | gzip > "$BACKUP_FILE"

# Upload to S3
aws s3 cp "$BACKUP_FILE" "s3://$S3_BUCKET/backups/$TIMESTAMP.sql.gz" --region ${aws_region}

# Cleanup local file
rm -f "$BACKUP_FILE"

echo "[Backup] Complete: s3://$S3_BUCKET/backups/$TIMESTAMP.sql.gz"
BACKUPEOF
chmod +x /opt/eaudit/backup-db.sh
chown ubuntu:ubuntu /opt/eaudit/backup-db.sh

# --- Create deploy script ---
echo ">>> Creating deploy script..."
cat > /opt/eaudit/deploy.sh << 'DEPLOYEOF'
#!/bin/bash
set -euo pipefail
echo "=== Deploying E-Audit: $(date) ==="
cd /opt/eaudit/app

git pull origin main

echo ">>> Building client..."
cd client && npm install && npm run build && cd ..

echo ">>> Building server..."
npm install && npm run build:server

echo ">>> Restarting app..."
pm2 restart eaudit || pm2 start dist/server/server.js --name eaudit --max-memory-restart 512M
pm2 save

sleep 3
echo ">>> Health: $(curl -s http://localhost:3001/api/health)"
echo "=== Deploy complete: $(date) ==="
DEPLOYEOF
chmod +x /opt/eaudit/deploy.sh
chown ubuntu:ubuntu /opt/eaudit/deploy.sh

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

# --- Configure UFW Firewall ---
echo ">>> Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

echo "=== E-Audit UserData Complete: $(date) ==="
echo ""
echo ">>> Next steps:"
echo ">>>   1. SSM Connect: Click 'Connect' -> 'Session Manager' in AWS EC2 Console"
echo ">>>   2. Clone: cd /opt/eaudit && git clone https://github.com/minhmaihuy/e-proc.git app"
echo ">>>   3. Setup: cp /opt/eaudit/.env app/.env"
echo ">>>   4. Build: cd app && npm install && npm run build:server"
echo ">>>   5. Client: cd client && npm install && npm run build && cd .."
echo ">>>   6. Start: pm2 start dist/server/server.js --name eaudit && pm2 save"
echo ">>>   7. Init DB: curl -X POST http://localhost:3001/api/init-tables"
echo ">>>   8. SSL: sudo certbot --nginx -d ${domain_name}"
