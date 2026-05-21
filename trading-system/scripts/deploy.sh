#!/bin/bash
# Usage: ./scripts/deploy.sh <ssh-host>
#
# Deploys the trading system to a VPS via Docker Compose.
# Prerequisites (on VPS): docker, docker compose, git
#
# Example:
#   ./scripts/deploy.sh ubuntu@your-vps-ip
#
# Optional: copy .env before deploying
#   scp .env.production ubuntu@your-vps-ip:~/trading-system/.env

set -euo pipefail

HOST="${1:?Usage: $0 <ssh-host>}"
REMOTE_DIR="~/trading-system"

echo "==> Syncing files to $HOST:$REMOTE_DIR"
rsync -avz --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude '*.db' \
  --exclude .env \
  --exclude .git \
  ./ "$HOST:$REMOTE_DIR/"

echo "==> Building and restarting on remote"
ssh "$HOST" << 'SSH'
  set -e
  cd ~/trading-system
  docker compose build ts-engine
  docker compose up -d
  echo "==> Waiting for health check..."
  sleep 5
  docker compose ps
  echo "==> Testing gRPC port..."
  curl -sf http://localhost:50051 || echo "(gRPC health check not available via HTTP)"
  echo "==> Testing dashboard..."
  curl -sf http://localhost:3000/api/status | head -c 200
  echo ""
  echo "==> Done!"
SSH

echo "==> Deploy complete: https://your-domain.com"
