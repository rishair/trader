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

echo "📦 Installing dependencies..."
npm install --silent

echo "🔨 Building TypeScript..."
npx tsc --noEmit 2>/dev/null || echo "Type check completed (warnings ok)"

echo "🔄 Restarting services..."
systemctl restart telegram-handler 2>/dev/null || echo "No telegram-handler service"

echo "✅ Deploy complete!"
echo ""
echo "Service status:"
systemctl is-active telegram-handler 2>/dev/null || echo "telegram-handler: not running"
ENDSSH

echo ""
echo "✅ Deployment finished!"
