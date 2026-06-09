# LLM Cluster — Project Context

## What This Is

Distributed AI system for universities. Repurposes idle campus GPU machines to run open source LLMs. Three components:

```
[Client App]  ──HTTP/SSE──►  [Manager]  ──HTTP long-poll──►  [Worker + GPU]
  Electron                   Express.js                     llama.cpp (C++)
```

- **Manager** (`backend/`) — Express.js job router. One instance on a server. Routes chat requests to free workers.
- **Worker App** (`worker-app/`) — Electron app. One-click GPU worker setup: detect GPU, pick model, download llama-server + GGUF, connect to manager.
- **Worker** (`worker/`) — Raw Node.js worker script. Embedded in worker-app via `extraResources`, or run standalone from CLI.
- **Client** (`client/`) — Electron chat app with an agentic code mode that can plan/write/execute multi-file projects.

## Current Version: v1.0.9

GitHub: `skarazan/LLM-Cluster-NYAI`. Releases built for macOS (x64 + arm64) and Windows (x64) via electron-builder + GitHub CI/CD.

## File Map

### backend/
- `src/server.js` — Express server. Endpoints: `/chat`, `/workers`, `/workers/register`, `/workers/poll/:id`, `/workers/result`, `/workers/chunk`, `/workers/heartbeat`.

### client/
- `main.js` — Electron main process. IPC handlers for agent state, file ops, shell exec.
- `renderer/index.html` — SPA. Model dropdown with 14 models in 4 groups (Small/Medium/Large/Code).
- `renderer/renderer.js` — Chat UI, mode toggle (Chat/Code), connection management.
- `renderer/style.css` — Tokyo Night dark theme.
- `lib/agentLoop.js` — **Largest file (~3400 lines)**. The agentic code mode engine. Handles: plan phase, todo management, LLM inference calls, tool execution (read/write/edit/shell), text `<write_file>`/`<append_file>` block extraction, loop control, stuck detection, follow-up handling.
- `lib/tools.js` — Tool definitions (read_file, write_file, edit_file, run_shell, etc.).
- `lib/sandbox.js` — File operation sandboxing within workspace.

### worker-app/
- `main.js` — Electron main. Manages llama-server + worker child processes.
- `lib/gpuDetect.js` — GPU detection. `nvidia-smi` (Win/Linux), `system_profiler` (Mac). All async.
- `lib/gpuBandwidthTable.js` — GPU name → bandwidth GB/s lookup for tok/s estimation.
- `lib/modelCatalog.js` — 14 models with VRAM requirements, HuggingFace URLs, use cases.
- `lib/modelRecommender.js` — Filter models by detected VRAM, estimate tok/s.
- `lib/downloadManager.js` — Downloads llama-server binary + GGUF model. Resume support via HTTP Range.
- `lib/llamaServerManager.js` — Spawns/stops llama-server, parses stdout for metrics (tok/s, VRAM, ready signal).
- `lib/workerProcessManager.js` — Spawns worker/index.js as child process.
- `lib/configStore.js` — Read/write `~/.llm-cluster-worker.json`.
- `lib/autoUpdater.js` — electron-updater for fleet auto-updates via GitHub Releases.
- `lib/mdnsDiscovery.js` — Bonjour mDNS manager discovery on LAN.
- `renderer/` — Setup wizard (5 steps), dashboard (stats/logs), settings.

### worker/
- `index.js` — Job polling loop. Long-polls manager for jobs, forwards to llama-server (or Ollama/LM Studio/vLLM), streams SSE responses back via chunk endpoint.
- `lib/toolPromptWrap.js` — Converts tool-call messages for different engine formats.
- `lib/cpuSampler.js` — CPU metrics sent in heartbeats.

## Critical Patterns & Gotchas

### Electron Renderer — Shared Global Scope
`nodeIntegration: true`, `contextIsolation: false`. All renderer scripts share ONE global scope. `const` declarations with the same name across files cause `SyntaxError: Identifier already declared`. Each file must use unique variable names (e.g., `ipcCtrl`, `ipcWiz` instead of `ipcRenderer` everywhere).

### llama.cpp Release Asset Naming
Changes frequently. Current patterns (as of v1.0.9):
- Windows + NVIDIA: `win-cuda-12` (exclude `cudart`)
- Windows CPU: `win-cpu-x64`
- macOS ARM: `macos-arm64` (exclude `kleidiai`)
- macOS x64: `macos-x64`
- Linux: `ubuntu-x64` (exclude `vulkan|openvino|sycl|rocm`)

### llama-server Flags
- `-fa` requires a value: `-fa on` (not just `-fa`)
- Ready signal: `"server is listening on"` (not just `"server listening"`)
- TurboQuant: `--cache-type-k turbo4 --cache-type-v turbo3` for ~40% KV cache reduction

### Worker Model Routing
`pickWorker()` in manager uses soft match: `w.models.some(m => m.toLowerCase().startsWith(modelLower))`. Client model dropdown values must prefix-match what workers report.

### tok/s Calculation (v1.0.9)
Measures generation speed only: first content token → last content token. Excludes prompt-processing time. Falls back to total elapsed if span can't be measured.

### Agent Loop Follow-Up Handling (v1.0.9)
Three follow-up types after a finished project:
- **Edit/fix** ("notes don't show"): `isEditRequestPrompt()` → re-opens existing file todos as pending.
- **Run/build** ("run it"): `isRunRequestPrompt()` → nudges model to emit `run_shell` tool call (up to 2x).
- **Question** ("why is it slow?"): exits cleanly — no todos needed.

### NSIS Installer (Windows)
`build/installer.nsh` has `customUnInstall` macro that kills processes. Only applies to NEW installs — old versions need manual PowerShell cleanup (documented in README).

## Build & Release

```bash
# Client
cd client && GH_TOKEN=$(gh auth token) npm run release          # mac
cd client && GH_TOKEN=$(gh auth token) npx electron-builder --win --x64 --publish always  # windows

# Worker App
cd worker-app && GH_TOKEN=$(gh auth token) npm run release      # mac
cd worker-app && GH_TOKEN=$(gh auth token) npx electron-builder --win --x64 --publish always  # windows
```

Both apps publish to the same GitHub Release tag (e.g., `v1.0.9`). `latest.yml` (Windows) and `latest-mac.yml` trigger auto-updates.

## Cloudflare Tunnel
`start-manager.sh` (bash only, macOS/Linux). Windows users: run `node src/server.js` + `cloudflared tunnel run llm-cluster` in separate terminals. Tunnel domain: `llm.tutorrev.live`.

## Known Issues / Next Steps
- Windows builds require wine on macOS (electron-builder NSIS)
- No Linux release builds yet (AppImage target configured but not published)
- VS Code extension integration in progress (not yet pushed)
- Chat history screen in worker-app: password-gated (set via config store, `chatHistoryPassword`)
- Friend on Windows had WSL issues running start-manager.sh — needs a PowerShell equivalent
