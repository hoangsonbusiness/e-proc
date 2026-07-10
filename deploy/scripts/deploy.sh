#!/bin/bash
# =============================================================================
# Redeploy Script — Pull latest code, rebuild, and restart
# Usage: bash deploy.sh  OR  sudo /opt/eaudit/deploy.sh
#
# PM2 keeps a separate daemon per OS user. The app's pm2 process is normally
# started under a non-root deploy user, not root. If this script runs as root
# (e.g. via sudo) without dropping privileges, `pm2 stop/delete eaudit` below
# silently no-ops against root's own (empty) pm2 daemon instead of the real
# running process, and `pm2 start` then creates a second, root-owned "eaudit"
# — so the live app never actually gets the new code. To make `sudo
# /opt/eaudit/deploy.sh` behave the same as running it directly, we re-exec
# ourselves as the real app-owning user before doing anything else whenever
# we detect we're running as root.
# =============================================================================
set -euo pipefail

APP_DIR="/opt/eaudit/app"

if [ "$(id -u)" -eq 0 ]; then
  APP_USER="${SUDO_USER:-$(stat -c '%U' "$APP_DIR")}"
  if [ "$APP_USER" = "root" ]; then
    echo "!!! Refusing to deploy as root: $APP_DIR is root-owned and no non-root" >&2
    echo "!!! SUDO_USER is set. Fix ownership first: chown -R <user>:<user> $APP_DIR" >&2
    exit 1
  fi
  echo ">>> Running as root; re-executing as '$APP_USER' so PM2/git/npm stay consistent..."
  exec sudo -u "$APP_USER" -H bash "$0" "$@"
fi

echo "============================================"
echo "  E-Audit Platform — Redeploy"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"

cd "$APP_DIR"

# --- Pull Latest ---
echo ""
echo ">>> Cleaning conflicting local files..."
git checkout -- . || true
rm -rf dist client/dist package-lock.json client/package-lock.json

echo ">>> Pulling latest code..."
git pull origin main

# --- Stop App (To Avoid Conflicts and Free Up RAM) ---
echo ""
echo ">>> Stopping application..."
pm2 stop eaudit || true

# --- Rebuild Server ---
echo ""
echo ">>> Rebuilding server..."
npm install --production=false
npm run build:server

# --- Rebuild Client ---
echo ""
echo ">>> Rebuilding client..."
cd client
npm install --production=false
npm run build
cd ..

# --- Restart App ---
echo ""
echo ">>> Restarting application..."
pm2 delete eaudit || true
pm2 start dist/server/server.js --name eaudit --max-memory-restart 512M
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
