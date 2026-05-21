#!/bin/bash
# =============================================================================
# Redeploy Script — Pull latest code, rebuild, and restart
# Usage: bash deploy.sh
# =============================================================================
set -euo pipefail

APP_DIR="/opt/eaudit/app"

echo "============================================"
echo "  E-Audit Platform — Redeploy"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"

cd "$APP_DIR"

# --- Pull Latest ---
echo ""
echo ">>> Pulling latest code..."
git pull origin main

# --- Rebuild Server ---
echo ""
echo ">>> Rebuilding server..."
npm ci --production=false
npm run build:server

# --- Rebuild Client ---
echo ""
echo ">>> Rebuilding client..."
cd client
npm ci --production=false
npm run build
cd ..

# --- Restart App ---
echo ""
echo ">>> Restarting application..."
pm2 restart eaudit
pm2 save

# --- Health Check ---
echo ""
echo ">>> Waiting for app to start..."
sleep 3

HEALTH=$(curl -s http://localhost:3001/api/health)
echo "    Health: $HEALTH"

echo ""
echo "============================================"
echo "  ✅ Redeploy Complete!"
echo "============================================"
echo "  PM2 Logs: pm2 logs eaudit --lines 20"
echo ""
