#!/bin/bash
# Start the LLM Cluster manager (backend + Cloudflare tunnel)

set -e

# Kill anything already on port 3000
lsof -ti :3000 | xargs kill -9 2>/dev/null || true

echo "[manager] Starting backend..."
cd "$(dirname "$0")/backend"
node src/server.js &
BACKEND_PID=$!

echo "[manager] Waiting for backend to be ready..."
sleep 2

echo "[manager] Starting Cloudflare tunnel (https://llm.tutorrev.live)..."
cloudflared tunnel run llm-cluster &
TUNNEL_PID=$!

echo "[manager] Ready. Backend PID=$BACKEND_PID  Tunnel PID=$TUNNEL_PID"
echo "[manager] Press Ctrl+C to stop both."

# Graceful shutdown on Ctrl+C
trap "echo '[manager] Shutting down...'; kill $BACKEND_PID $TUNNEL_PID 2>/dev/null; exit 0" INT TERM

wait
