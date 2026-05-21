#!/bin/bash
# =============================================================================
# First-Time Setup Script
# Run this ONCE after SSH-ing into the EC2 instance
# Usage: bash setup.sh <GIT_REPO_URL>
# =============================================================================
set -euo pipefail

REPO_URL="${1:-}"
APP_DIR="/opt/eaudit/app"

# Automatically detect domain from Nginx configuration
if [ -f /etc/nginx/sites-available/eaudit ]; then
    DOMAIN=$(grep -oP 'server_name\s+\K[^\s;]+' /etc/nginx/sites-available/eaudit | head -n 1)
    ALT_DOMAIN=$(grep -oP 'server_name\s+[^\s;]+\s+\K[^\s;]+' /etc/nginx/sites-available/eaudit | head -n 1)
else
    DOMAIN="devfatstrack.cloud"
    ALT_DOMAIN="www.devfatstrack.cloud"
fi

DOMAIN_ARGS="-d $DOMAIN"
if [ -n "$ALT_DOMAIN" ]; then
    DOMAIN_ARGS="$DOMAIN_ARGS -d $ALT_DOMAIN"
fi

echo "============================================"
echo "  E-Audit Platform — First-Time Setup"
echo "============================================"
echo ""

# --- Validate ---
if [ -z "$REPO_URL" ]; then
    echo "Usage: bash setup.sh <GIT_REPO_URL>"
    echo "Example: bash setup.sh https://github.com/youruser/e-proc.git"
    exit 1
fi

# --- Wait for userdata to complete ---
echo ">>> Checking if userdata has completed..."
while [ ! -f /var/log/userdata.log ] || ! grep -q "UserData Complete" /var/log/userdata.log 2>/dev/null; do
    echo "    Waiting for userdata script to finish..."
    sleep 10
done
echo ">>> UserData completed!"

# --- Clone Repository ---
echo ""
echo ">>> Cloning repository..."
if [ -d "$APP_DIR" ]; then
    echo "    App directory exists, pulling latest..."
    cd "$APP_DIR"
    git pull origin main
else
    git clone "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR"
fi

# --- Copy .env ---
echo ""
echo ">>> Setting up environment..."
if [ -f /opt/eaudit/.env ]; then
    cp /opt/eaudit/.env "$APP_DIR/.env"
    echo "    .env copied from /opt/eaudit/.env"
else
    echo "    WARNING: No .env found at /opt/eaudit/.env"
    echo "    Create one manually: nano $APP_DIR/.env"
fi

# --- Install & Build Server ---
echo ""
echo ">>> Installing server dependencies..."
cd "$APP_DIR"
npm ci --production=false

echo ""
echo ">>> Building server..."
npm run build:server

# --- Install & Build Client ---
echo ""
echo ">>> Installing client dependencies..."
cd "$APP_DIR/client"
npm ci --production=false

echo ""
echo ">>> Building client..."
npm run build

# --- Start with PM2 ---
echo ""
echo ">>> Starting application with PM2..."
cd "$APP_DIR"
pm2 delete eaudit 2>/dev/null || true
pm2 start dist/server/server.js \
    --name eaudit \
    --env production \
    --max-memory-restart 512M \
    --log-date-format "YYYY-MM-DD HH:mm:ss" \
    --merge-logs
pm2 save

# --- Initialize Database Tables ---
echo ""
echo ">>> Initializing database tables..."
sleep 3
curl -s -X POST http://localhost:3001/api/init-tables | head -c 200
echo ""

# --- Health Check ---
echo ""
echo ">>> Running health check..."
sleep 2
HEALTH=$(curl -s http://localhost:3001/api/health)
echo "    Health: $HEALTH"

# --- Setup SSL ---
echo ""
echo ">>> Setting up SSL certificate..."
echo "    Running: sudo certbot --nginx $DOMAIN_ARGS"
echo ""
read -p "    Enter your email for Let's Encrypt notifications: " LE_EMAIL

if [ -n "$LE_EMAIL" ]; then
    sudo certbot --nginx \
        $DOMAIN_ARGS \
        --email "$LE_EMAIL" \
        --agree-tos \
        --no-eff-email \
        --redirect
    echo "    SSL certificate installed!"
else
    echo "    Skipping SSL. Run manually later:"
    echo "    sudo certbot --nginx $DOMAIN_ARGS"
fi

# --- Setup Certbot Auto-Renew ---
echo ""
echo ">>> Setting up SSL auto-renewal..."
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl reload nginx'") | crontab -
echo "    Cron job added: SSL renews daily at 3 AM"

# --- Setup Queue Processor Cron ---
echo ""
echo ">>> Setting up AI queue processor..."
(crontab -l 2>/dev/null; echo "* * * * * curl -s http://localhost:3001/api/queue/process > /dev/null 2>&1") | crontab -
echo "    Cron job added: Queue processes every minute"

echo ""
echo "============================================"
echo "  ✅ Setup Complete!"
echo "============================================"
echo ""
echo "  App URL:    http://$DOMAIN"
echo "  Admin:      http://$DOMAIN/admin"
echo "  Health:     http://$DOMAIN/api/health"
echo ""
echo "  PM2 Status: pm2 status"
echo "  PM2 Logs:   pm2 logs eaudit"
echo "  Redeploy:   /opt/eaudit/deploy.sh"
echo ""
