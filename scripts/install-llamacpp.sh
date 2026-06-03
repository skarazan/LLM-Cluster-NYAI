#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TP="$ROOT/third_party/llama.cpp"

echo "This script attempts to clone and build llama.cpp as a baseline for a local 'llama-server'."
echo "It's provided as a convenience; you may need to adapt it to the server project you prefer."

if [ -d "$TP" ]; then
  echo "third_party/llama.cpp already exists"
else
  git clone https://github.com/ggerganov/llama.cpp "$TP"
fi

cd "$TP"
echo "Building llama.cpp (this may take a while)..."
if command -v cmake >/dev/null 2>&1; then
  mkdir -p build && cd build
  cmake ..
  cmake --build . -j$(nproc)
else
  if command -v make >/dev/null 2>&1; then
    make
  else
    echo "No build tool found (cmake or make). Install one and re-run this script." && exit 1
  fi
fi

echo "Build finished. This script does NOT install a llama-server binary by default."
echo "If you have a separate server implementation that wraps llama.cpp into an HTTP API, place it in ./bin/llama-server or set LLM_ENGINE_BIN to its path."
echo "You can configure automatic startup by adding an 'engineAutoStartCmd' entry to ~/.llm-cluster-worker.json or set the env var LLM_ENGINE_AUTO_START_CMD."
