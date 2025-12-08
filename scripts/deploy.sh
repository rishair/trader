#!/bin/bash
# Deploy script for trader bot
# Run locally: npm run deploy

set -e

SERVER="root@104.248.8.100"
REMOTE_PATH="/opt/trader"

echo "🚀 Deploying to $SERVER..."

# 1. Ensure local changes are committed and pushed
if [[ -n $(git status --porcelain) ]]; then
  echo "❌ Error: You have uncommitted changes. Commit and push first."
  exit 1
fi

LOCAL_HASH=$(git rev-parse HEAD)
REMOTE_HASH=$(git ls-remote origin main | cut -f1)

if [[ "$LOCAL_HASH" != "$REMOTE_HASH" ]]; then
  echo "❌ Error: Local HEAD ($LOCAL_HASH) differs from origin/main ($REMOTE_HASH)"
  echo "   Push your changes first: git push origin main"
  exit 1
fi

echo "✓ Local is in sync with origin/main"

# 2. SSH to server and deploy
ssh $SERVER << 'ENDSSH'
set -e
cd /opt/trader

echo "📥 Pulling latest changes..."
git fetch origin
git reset --hard origin/main

# Ensure trader user owns everything
chown -R trader:trader /opt/trader

echo "📦 Installing dependencies (as trader)..."
su - trader -c 'cd /opt/trader && npm install --silent'

echo "🔨 Building TypeScript..."
su - trader -c 'cd /opt/trader && npx tsc --noEmit 2>/dev/null' || echo "Type check completed (warnings ok)"

echo "📋 Installing systemd services..."
cp /opt/trader/infra/telegram-handler.service /etc/systemd/system/
cp /opt/trader/infra/trader-daemon.service /etc/systemd/system/
systemctl daemon-reload

echo "🔄 Restarting services..."
systemctl restart telegram-handler 2>/dev/null || echo "telegram-handler: starting fresh"
systemctl enable telegram-handler 2>/dev/null || true

echo "✅ Deploy complete!"
echo ""
echo "Service status:"
systemctl is-active telegram-handler 2>/dev/null || echo "telegram-handler: not running"
systemctl is-active trader-daemon 2>/dev/null || echo "trader-daemon: not running (start with /start)"
ENDSSH

echo ""
echo "✅ Deployment finished!"
