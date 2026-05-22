# LLM Cluster

Run AI models on your own hardware. Chat with them from a desktop app. Or let the built-in code agent build entire projects for you — no cloud, no API keys, no per-token bills.

```
[Desktop Client]  ──HTTP──►  [Manager]  ──HTTP──►  [Worker + GPU]
   Electron app              Express.js            llama.cpp / Ollama / LM Studio / vLLM
```

- **backend/** — Manager server. Routes jobs to workers, handles load balancing and failover.
- **worker-app/** — One-click Electron app for setting up a GPU worker. Download, detect GPU, pick a model, click Run. That's it.
- **worker/** — The raw worker script (used by worker-app internally, or run manually if you prefer CLI).
- **client/** — Electron desktop app with chat UI and an autonomous code agent.

📖 Full technical docs: [DOCUMENTATION.md](DOCUMENTATION.md)

---

## Downloads

| App | What it does | Link |
|-----|-------------|------|
| **LLM Cluster Chat** | Chat client + code agent | [v1.0.9 →](https://github.com/skarazan/LLM-Cluster-NYAI/releases/tag/v1.0.9) |
| **LLM Cluster Worker** | One-click GPU worker setup | [v1.0.9 →](https://github.com/skarazan/LLM-Cluster-NYAI/releases/tag/v1.0.9) |

**macOS note:** Apps aren't signed (no $99/yr Apple account). After installing, run once in Terminal:
```bash
xattr -cr "/Applications/LLM Cluster Chat.app"
xattr -cr "/Applications/LLM Cluster Worker.app"
```
Or right-click the app → Open → Open anyway.

---

## Available Models

The Worker App includes these models in its catalog. Pick one during setup — it downloads automatically.

| Model | Params | VRAM | Good for |
|-------|--------|------|----------|
| Qwen3 1.7B | 1.7B | 2 GB | Fast assistant, lightweight tasks |
| Qwen3 4B | 4B | 4 GB | Good balance for 4-6 GB GPUs |
| Llama 3.2 3B | 3B | 3 GB | General chat |
| **Qwen3 8B** | 8B | 7 GB | Excellent all-rounder, strong reasoning |
| Llama 3.1 8B | 8B | 7 GB | Great at instruction following |
| Mistral 7B | 7B | 6 GB | Fast, efficient chat and code |
| Gemma 2 9B | 9B | 8 GB | Strong at analysis |
| DeepSeek R1 8B | 8B | 7 GB | Chain-of-thought reasoning, math |
| Qwen3 14B | 14B | 11 GB | Top quality for 12 GB GPUs |
| Qwen3 30B-A3B | 30B (MoE) | 22 GB | 30B params, 3B active — fast like 3B, smart like 30B |
| Qwen3 32B | 32B | 24 GB | Excellent quality (4090, A5000) |
| Llama 3.3 70B | 70B | 48 GB | Flagship (A6000, Mac Ultra) |
| Qwen 2.5 Coder 7B | 7B | 7 GB | Code generation specialist |
| Qwen 2.5 Coder 32B | 32B | 24 GB | Best open-source code model |

All models are Q4_K_M quantized GGUF files from HuggingFace.

---

## How it all fits together

There are three moving parts. You only need to set up the ones that apply to you.

```
You (laptop)         Team server          GPU machine(s)
─────────────        ────────────         ───────────────
  Client app    →      Manager      ←       Worker app
  (chat UI)          (job router)         (runs the model)
```

- **Manager** — one instance, runs on a server somewhere. Routes chat requests to whichever GPU worker is free.
- **Worker** — one per GPU machine. Downloads a model, runs llama-server, connects to the manager, waits for jobs.
- **Client** — one per person. Connects to the manager URL, sends messages, gets responses.

The manager URL is the only thing you need to share with your team. Workers and clients both connect to it.

---

## 1. Manager Setup

The manager is a plain Node.js server. Run it on any machine your team can reach — a VPS, a Mac mini, whatever.

```bash
cd backend
npm install
npm start        # listens on port 3000
```

To expose it publicly, use a reverse proxy or Cloudflare tunnel. There's a script for the tunnel approach:

```bash
./start-manager.sh   # starts backend + cloudflare tunnel
```

Check it's alive:
```bash
curl http://your-server:3000/workers
# → {"workers":[]}
```

---

## 2. Worker Setup

### Option A — Worker App (recommended)

Download **LLM Cluster Worker** from the [releases page](https://github.com/skarazan/LLM-Cluster-NYAI/releases/tag/v1.0.9). Install it, unlock it (macOS command above), open it.

The setup wizard walks you through everything:

**Step 1 — GPU Detection**
Automatically finds your GPU via `nvidia-smi` (Windows/Linux) or `system_profiler` (Mac). Shows VRAM, driver version, and memory bandwidth.

**Step 2 — Pick a Model**
Shows all available models filtered to what actually fits in your VRAM. Each row shows:
- Estimated tok/s (calculated from GPU bandwidth ÷ model file size)
- How much context fits in remaining VRAM after the model loads
- Green / Yellow / Red fit indicator

**Step 3 — Download**
Downloads two things in parallel:
- `llama-server` binary from the llama.cpp GitHub releases (right build for your platform + CUDA version)
- The GGUF model file from HuggingFace

Both downloads show speed, ETA, and resume automatically if interrupted.

**Step 4 — Manager URL**
Either paste your manager URL or click Discover to find one on the local network via mDNS.

**Step 5 — Run**
Click **Start Worker**. The app starts llama-server, waits for it to be ready, then connects the worker to the manager. The dashboard shows live tok/s, VRAM usage, jobs completed, and full logs.

The worker re-registers automatically on next app launch — no re-setup needed.

---

### Option B — Manual CLI Setup

If you're comfortable with the command line or want more control:

**1. Start your inference engine**

```bash
# llama.cpp
./llama-server -m model.gguf -ngl 999 --host 0.0.0.0 --port 8080

# Ollama
ollama serve

# LM Studio
# Start it from the GUI, enable local server

# vLLM
vllm serve model-name --port 8000
```

**2. Install and run the worker script**

```bash
cd worker
npm install
LLM_ENGINE_TYPE=llamacpp node index.js http://your-manager:3000
```

Supported engine types: `ollama` (default), `llamacpp`, `lmstudio`, `vllm`

The worker auto-registers on start, sends heartbeats every 15 seconds, and deregisters cleanly on Ctrl+C.

**3. Worker config file (optional)**

Instead of env vars, create `~/.llm-cluster-worker.json`:

```json
{
  "name": "my-gpu",
  "engineType": "llamacpp",
  "engineUrl": "http://localhost:8080",
  "engineApiKey": "optional-key",
  "preferredManager": "https://your-manager:3000"
}
```

---

## 3. Client Setup

Download **LLM Cluster Chat** from the [latest release](https://github.com/skarazan/LLM-Cluster-NYAI/releases/latest). Or run from source:

```bash
cd client
npm install

## VS Code Extension

A development VS Code extension lives in [vscode-extension/](vscode-extension/). It adds inline completions plus basic ask/generate commands backed by the same manager API.
npm start

Enter the manager URL in the top bar and click **Test**. Green dot = connected, pick a model from the dropdown, start chatting.

---

## Code Agent

Switch to **Code** mode in the client. Select a workspace folder, describe what you want built, and the agent will:

1. Create a plan with a file manifest
2. Write all the files
3. Run shell commands as needed (`npm install`, tests, etc.)
4. Verify output and iterate on issues

It handles multi-file projects, React/Vue apps, APIs, scripts — pretty much anything. Not perfect. Think of it as a fast intern that occasionally needs course correction. Point out bugs and it'll fix them.

**Tips:**
- Give it a clear first message — what to build, what stack, any constraints
- For frontend projects, it uses CDN scripts so everything opens directly in a browser (no build step)
- You can stop it mid-run and redirect it with a follow-up message

---

## TurboQuant (Experimental)

The Worker App has a **⚡ TurboQuant** toggle in Settings. When on, it adds `--cache-type-k turbo4 --cache-type-v turbo3` to the llama-server startup flags.

This reduces the VRAM used by the KV cache (the "memory" for the current conversation) by roughly 40%, which means you can fit significantly more context in the same GPU. A 12 GB GPU might go from fitting 8K context to 14K+ context on the same model.

The tradeoff: it's experimental, uses aggressive quantization on the attention cache, and may subtly affect quality on long conversations. Try it if you're running out of context or want to run a bigger model than your VRAM normally allows.

---

## Worker Dashboard

Once the worker is running, the dashboard shows:

| Metric | What it means |
|--------|--------------|
| **tok/s** | Tokens generated per second, parsed live from llama-server output |
| **VRAM Used** | How much GPU memory the model is occupying |
| **Jobs Done** | Total requests handled since the worker started |
| **Uptime** | How long the worker has been running |
| **Context** | Current context window size in tokens |

The log viewer has three tabs: **llama-server** (inference engine output), **Worker** (job polling and registration), and **Errors** (anything that went wrong). You can filter any tab by keyword.

---

## API Reference

The manager exposes these endpoints:

```
POST /chat              — Send messages, get streaming response
POST /chat/cancel       — Cancel an in-flight request
GET  /workers           — List registered workers and their status
POST /workers/register  — Worker self-registers on startup
POST /workers/heartbeat — Worker keepalive (every 15s) + CPU/memory metrics
GET  /workers/poll/:id  — Worker long-polls for a new job
POST /workers/result    — Worker submits completed job result
POST /workers/chunk     — Worker forwards a streaming chunk to the client
POST /workers/job-heartbeat — Worker signals it's still alive mid-job
```

---

## Building from Source

```bash
# Chat client
cd client
npm run build:mac    # → dist/*.dmg
npm run build:win    # → dist/*.exe
npm run build:linux  # → dist/*.AppImage
npm run release      # build + publish to GitHub Releases (needs GH_TOKEN)

# Worker app
cd worker-app
npm run build:mac
npm run build:win
npm run release
```

---

## Troubleshooting

**Worker connects but no jobs come in**
- Check the manager URL is correct and reachable from the worker machine
- Make sure at least one model is loaded in your inference engine (`GET /workers` shows registered workers and their models)
- The client needs to have a model selected that matches one the worker has available

**llama-server crashes immediately**
- VRAM full: pick a smaller model or enable TurboQuant to reduce KV cache size
- Wrong binary: the worker app downloads the right build for your platform, but if you're running manually make sure you have the right CUDA version

**macOS: "App is damaged and can't be opened"**
```bash
xattr -cr "/Applications/LLM Cluster Chat.app"
xattr -cr "/Applications/LLM Cluster Worker.app"
```

**Windows: Can't uninstall old Worker App ("app is still running")**
The old uninstaller doesn't kill processes. Run these in PowerShell as Admin:
```powershell
taskkill /F /IM "LLM Cluster Worker.exe" /T
taskkill /F /IM llama-server.exe /T
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\llm-cluster-worker"
Remove-Item -Recurse -Force "$env:APPDATA\llm-cluster-worker-app"
```
Then install the latest version fresh. Versions 1.0.5+ handle this automatically.

**Windows: SmartScreen blocks the installer**
Click "More info" → "Run anyway". This happens because the app isn't code-signed. It's safe.

**Agent gets stuck or loops**
The agent has built-in loop detection and will stop itself if it can't make progress. If it does get stuck, stop it manually and give it a more specific follow-up instruction.

**Model download keeps failing**
HuggingFace throttles unauthenticated downloads. The worker app resumes interrupted downloads automatically — just leave it running and it'll finish.
