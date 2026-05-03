# LLM Cluster — Full Documentation

This document explains everything that was built, how it works, and the reasoning behind each decision.

---

## 1. Project Overview

### What we're building

A small private AI service for a 3-person team. Multiple laptops on the same WiFi/LAN each run Ollama with the same local model (e.g. `llama3`). One designated **manager** machine runs a backend server that:

1. Accepts chat requests from any user on the network
2. Picks an available worker laptop (round-robin load balancing)
3. Forwards the prompt to that worker's Ollama instance
4. Returns the response to the user

End users get a desktop chat app (`.exe`) that they install on their laptops, point at the manager, and chat with.

### High-level architecture

```
┌─────────────────┐
│ User laptops    │  Electron .exe ("LLM Cluster Chat")
│ (chat client)   │
└────────┬────────┘
         │ HTTP POST /chat
         ▼
┌─────────────────┐
│ Manager machine │  Node.js + Express ("backend")
│ (load balancer) │  Round-robin selector
└────────┬────────┘
         │ HTTP POST /api/generate
         ▼
┌─────────────────┐
│ Worker laptops  │  Ollama (port 11434)
│ (run the model) │  Each runs the same model locally
└─────────────────┘
```

### Why this architecture

- **Separation of concerns** — Backend manages routing; workers do inference; client is just a UI. Each layer is independent.
- **No cloud, no cost** — Everything runs on local hardware on a LAN. No API keys, no per-token billing.
- **Horizontal scalability** — Adding a new worker is one config edit. Removing one is a status flag flip.
- **Beginner-friendly stack** — Node.js + Express + Electron. Same language (JavaScript) end to end.

---

## 2. Repository Structure

```
LLM-Cluster-NYAI/
├── README.md                  Quick-start summary
├── DOCUMENTATION.md           This file
├── .gitignore                 Excludes node_modules, dist, etc.
├── backend/                   Manager server (runs on host machine)
│   ├── package.json
│   └── src/
│       ├── server.js          Express app entry point
│       ├── routes/
│       │   ├── chatRoutes.js  POST /chat handler
│       │   └── workerRoutes.js GET /workers handler
│       └── services/
│           └── workerService.js  Worker registry + round-robin + Ollama call
└── client/                    Desktop chat app (built to .exe, installed on user laptops)
    ├── package.json
    ├── main.js                Electron main process (window + IPC + auto-update)
    └── renderer/
        ├── index.html         Chat UI markup
        ├── renderer.js        UI logic (talks to main process via IPC)
        └── style.css          Dark theme styling
```

---

## 3. Backend (Manager Server)

### 3.1 Why Node.js + Express

- **Lightweight** — Single small server, no need for heavyweight frameworks.
- **JavaScript continuity** — Same language as Electron client.
- **Async I/O native** — Critical for forwarding requests to workers without blocking.
- **CommonJS** — User requested `require/module.exports` style, no TypeScript, beginner-friendly.

### 3.2 `backend/package.json`

```json
{
  "scripts": {
    "start": "node src/server.js",
    "dev":   "nodemon src/server.js"
  }
}
```

- `npm run dev` uses `nodemon` so the server restarts on file save (faster development).
- `npm start` is the production command (plain `node`, no auto-reload).
- Only one runtime dependency (`express`). Keeps install fast and the surface area small.

### 3.3 `backend/src/server.js`

The Express app. Three jobs:

1. Parse JSON bodies (`app.use(express.json())`) so the `/chat` endpoint receives parsed objects instead of raw streams.
2. Mount route modules at their respective base paths (`/chat` → `chatRoutes`, `/workers` → `workerRoutes`).
3. Provide `GET /` as a basic health check so the client app can verify the manager is reachable before sending real requests.

Listens on port `3000`.

### 3.4 `backend/src/services/workerService.js` — the heart of the system

Stores all the cluster state in one place. Three exports:

#### `workers` array
Each worker is `{ id, name, url, status }`. The `status` field (`online`/`offline`) lets us add laptops to the list before they're actually running. Setting `status: 'online'` activates them.

The Ollama HTTP API listens on port `11434` by default, so each worker URL ends with `:11434`.

#### `getNextWorker()`
Round-robin among `online` workers only. Why round-robin?
- Simplest fair distribution algorithm. No external state, no metrics required.
- For a small, homogeneous cluster (3 similar laptops), every worker handles roughly equal load.
- Easy to upgrade later (e.g. least-connections, weighted by GPU strength) — only this function changes.

The implementation filters `workers` for online entries every call so toggling a worker offline is immediately respected.

#### `sendPromptToWorker(worker, prompt, model)`
Calls the Ollama generate API:

```js
POST http://<worker.url>/api/generate
{ "model": "llama3", "prompt": "...", "stream": false }
```

`stream: false` returns one complete response instead of streaming token-by-token. Streaming is more complex (server-sent events / chunked transfer); we'd add it later if real-time typing is desired.

**Timeout & cancellation:**
- An `AbortController` with a 60-second timeout wraps the fetch.
- Long Ollama inference (especially CPU-only) can take a while; 60s is a sensible upper bound.
- If the timeout fires, `controller.abort()` is called and the fetch rejects with `AbortError`.

**Error propagation:**
- Non-2xx status from Ollama throws — caller handles it.
- Timeout throws `AbortError` — the route translates this to HTTP 504.

### 3.5 `backend/src/routes/chatRoutes.js`

`POST /chat` — the main user-facing endpoint.

Steps:
1. Validate `prompt` exists. Missing → `400`.
2. Get next online worker. None online → `503`.
3. Try to call the worker:
   - Success → return `{ worker, model, response }`.
   - `AbortError` → `504` (gateway timeout).
   - Other errors → `502` (bad gateway).

#### Why per-request try/catch
Without it, an unhandled rejection from `sendPromptToWorker` would crash the Node process. With many concurrent users, one slow or broken worker would take down the whole service. Catching per-request isolates failures.

#### Why the response format includes `worker` and `model`
Visibility. The client UI shows which laptop answered ("Laptop 1 · llama3"), which is useful for diagnosing imbalanced load, slow workers, or wrong models being served.

### 3.6 `backend/src/routes/workerRoutes.js`

`GET /workers` — read-only snapshot of the worker registry. Useful for:
- Debugging from the client (or `curl`)
- Future admin UIs
- Monitoring scripts

### 3.7 Concurrency model

Node.js is single-threaded for JS execution but uses async I/O. While one request is awaiting Ollama, the event loop happily processes others. With async/await each request has its own closure (its own `req`/`res`/local variables), so responses cannot get crossed between users.

The shared `currentIndex` in `workerService.js` is mutated in synchronous code (`getNextWorker` is not async), so JavaScript's single-threaded execution model guarantees no race conditions there.

---

## 4. Ollama Setup

### 4.1 Why Ollama

- Free, open source, runs locally.
- Zero-config HTTP server (`ollama serve`) on port 11434.
- Supports many open-weight models with a single `ollama pull` command.
- Model files cached locally — no internet needed after first pull.

### 4.2 Installation steps performed

1. Downloaded the Windows installer from <https://ollama.com/download>.
2. Ran `ollama pull llama3` to download the 4.7 GB model weights.
3. Ollama auto-starts a background server on `localhost:11434`.

### 4.3 What the backend talks to

```
POST http://<worker-ip>:11434/api/generate
Content-Type: application/json

{ "model": "llama3", "prompt": "...", "stream": false }
```

Response:
```json
{
  "model": "llama3",
  "response": "the model's text reply",
  "done": true,
  ...metadata
}
```

We extract `data.response` and forward it.

### 4.4 Network exposure (worker laptops)

By default Ollama binds only to `localhost`. For LAN access we need the worker laptops to either:

- Set `OLLAMA_HOST=0.0.0.0:11434` env var before starting Ollama, **or**
- Rely on the default if the firewall lets port 11434 through (Ollama on Windows binds all interfaces by default in recent versions).

Either way, port `11434` must be opened in Windows Defender Firewall on the worker.

---

## 5. Client (Electron Desktop App)

### 5.1 Why Electron

The user wanted a `.exe` installer for end users. Options considered:

| Option | Pros | Cons |
|--------|------|------|
| **Electron** | Same Node/JS stack as backend; mature; easy `.exe` packaging | ~70 MB binary (bundles Chromium) |
| Tauri | Smaller binary (~10 MB) | Requires Rust toolchain; steeper learning curve |
| Native (C# WPF, .NET) | Smallest, native | Different language, different tooling |
| Web app (no install) | Zero install for users | User asked specifically for `.exe` |

Electron won on **stack continuity** and **packaging simplicity**.

### 5.2 `client/package.json`

Three scripts:
- `start` — `electron .` for local development.
- `build` — produces `.exe` installer locally (no upload).
- `release` — builds **and** publishes to GitHub Releases (used for shipping updates).

The `build` config block tells `electron-builder`:
- App identity (`appId`, `productName`)
- Target format (NSIS Windows installer)
- Update server (GitHub Releases on this repo)
- Which files to bundle (only `main.js` and `renderer/` — never `node_modules` or source maps)

### 5.3 `client/main.js` — the Electron main process

#### Window creation
A 900×700 `BrowserWindow` with `nodeIntegration: true` and `contextIsolation: false`. This lets the renderer use Node `require()` directly. For an internal app on a trusted LAN this is fine; for a public app we'd switch to `contextIsolation: true` + a preload script (more secure but more boilerplate).

The default menu bar is hidden (`setMenuBarVisibility(false)`) for a cleaner look.

#### IPC handlers
`ipcMain.handle()` exposes two functions to the renderer:

- `ping-backend` — quick GET to `/`, used by the "Test" button to verify connectivity. 4-second timeout because we don't want users staring at a spinner if the server is unreachable.
- `send-prompt` — POSTs to `/chat`. Wraps everything in try/catch and returns `{ ok, data }` or `{ ok: false, error }`. The renderer doesn't have to know about HTTP details — it just gets a clean result.

**Why use main-process IPC instead of letting the renderer call `fetch` directly?**
- Avoids browser CORS errors if the backend ever sets restrictive headers.
- Centralizes networking in one place (easier to add auth headers, retries, logging later).
- Main-process `fetch` runs in Node, not Chrome — fewer surprises with mixed content / cookies / etc.

#### Auto-update wiring
`autoUpdater` from `electron-updater`:
- `autoDownload = true` — downloads in background as soon as a new release is detected.
- `autoInstallOnAppQuit = true` — installs the new version when the app closes naturally.
- `update-available` event sends a notification to the renderer (currently used only by `mainWindow.webContents.send`; renderer can display a UI hint if desired).
- `update-downloaded` event triggers a native dialog: "Restart now / Later".

Update checking only runs when `app.isPackaged` is true — i.e. only inside an installed `.exe`, never in `npm start` development. Avoids confusing dev errors and accidental update prompts during testing.

### 5.4 `client/renderer/index.html`

Three regions:
1. **Header** — Manager URL input, model dropdown, Test button, status dot.
2. **Chat area** — scrollable message list.
3. **Footer** — textarea + Send button.

The status dot has four states (`unknown`, `pending`, `online`, `offline`), each a different color, set by `renderer.js` based on ping results.

### 5.5 `client/renderer/renderer.js`

#### Persistence
The manager URL is saved to `localStorage` under `llm-cluster-backend-url` so users don't have to re-enter it every launch.

#### Chat flow
1. User clicks Send (or hits Enter).
2. User's message becomes a blue "user" bubble on the right.
3. A grey "thinking…" placeholder appears (with animated dots from CSS).
4. `ipcRenderer.invoke('send-prompt', ...)` waits for the main process to round-trip to the backend.
5. Placeholder is replaced with the assistant's response (or a red error bubble).

#### Why the "thinking…" placeholder
Llama responses can take 5–30 seconds. Without immediate feedback, users assume the app is broken and click Send again, creating duplicate requests.

### 5.6 `client/renderer/style.css`

Dark theme inspired by the Tokyo Night palette (`#1a1b26` background, `#7aa2f7` accent). User bubbles right-aligned in accent color; assistant bubbles left-aligned in dark grey; error bubbles centered in red. Animated `…` dots use a CSS keyframe.

`white-space: pre-wrap` on bubbles preserves Ollama's line breaks (it often returns markdown lists).

---

## 6. Git & GitHub

### 6.1 What was set up

- `git init` in the project root.
- `.gitignore` excluding `node_modules/`, `dist/`, logs, OS junk.
- Initial commit with backend + client source.
- Remote added: `https://github.com/skarazan/LLM-Cluster-NYAI.git`.
- Branch renamed to `main`, pushed.

### 6.2 Why a single repo (not separate backend/client repos)

For a project this small, splitting hurts more than helps:
- One issue tracker.
- One README.
- Coordinated versioning (backend changes sometimes need matching client changes).
- Both folders are independent npm projects, so they can still be built and shipped separately.

### 6.3 Why private repo

User chose private. Trade-off:
- Pros: Code stays internal.
- Cons: Auto-update via GitHub Releases requires an embedded token in the client (a public token visible in any decompiled `.exe`). For trusted LAN distribution this is acceptable; for wide distribution we'd switch to public or use a custom update server.

---

## 7. Auto-Updates (electron-updater + GitHub Releases)

### 7.1 How it works

```
You bump version → npm run release → uploads to GitHub Releases
                                            ↓
Installed .exe checks GitHub Releases on launch
                                            ↓
              If new version found → downloads in background
                                            ↓
              Shows dialog: "Restart now / Later"
                                            ↓
                              quitAndInstall() → restart
```

`electron-updater` reads a manifest file (`latest.yml`) that `electron-builder` uploads alongside the `.exe`. The manifest contains version, file size, SHA-512 checksum. The updater downloads the new `.exe`, verifies the checksum, then runs the NSIS installer in silent mode on quit.

### 7.2 Why GitHub Releases as the update server

- **Free** for open repos and private repos under a small team.
- **Zero infra** — no S3 bucket, no CDN, no hosting.
- **Built-in `electron-builder` support** — one config block, no glue code.
- **CI-friendly** — easy to automate from GitHub Actions later.

### 7.3 Configuration

In `client/package.json`:
```json
"publish": {
  "provider": "github",
  "owner": "skarazan",
  "repo": "LLM-Cluster-NYAI"
}
```

In `client/main.js`:
```js
const { autoUpdater } = require('electron-updater');
autoUpdater.checkForUpdates();
```

That's all the wiring `electron-updater` needs.

### 7.4 Release workflow

1. Edit `client/package.json` — bump `version` (semver: `1.0.0` → `1.0.1` for patches, `1.1.0` for features, `2.0.0` for breaking changes).
2. Commit & push: `git commit -am "v1.0.1"` and `git push`.
3. Set token: `$env:GH_TOKEN = "ghp_..."` (Personal Access Token with `repo` scope).
4. Run: `npm run release`.

`electron-builder` will:
- Build the `.exe`.
- Generate `latest.yml` (the update manifest).
- Create a GitHub Release tagged `v1.0.1`.
- Upload both files as release assets.

Within a few minutes, every installed client checks GitHub on next launch, downloads the update, and prompts the user to restart.

### 7.5 Why `app.isPackaged` guard

In development (`npm start`) the app's version is whatever's in `package.json` and there's no installer to update. Without the guard, `electron-updater` would log errors trying to check for updates against a non-existent local environment.

---

## 8. Concurrency & Multi-User Behavior

The user explicitly asked: with 10+ simultaneous users, do responses get crossed?

**No.** Each user's request is its own:
- HTTP connection (separate `req`/`res` objects in Express).
- Closure (local `prompt`, `model`, `worker` variables in the route handler).
- Fetch call to a worker (separate `AbortController`, separate response stream).

Responses cannot mix. Each `await` resumes only the request that started it.

The only shared mutable state is `currentIndex` for round-robin. Because Node.js runs JavaScript single-threaded, the read-modify-write of `currentIndex` happens atomically per call — no race conditions.

The real concurrency limit is **per worker**: Ollama processes one inference at a time, so requests pile up if a worker is busy. With 3 workers running, throughput is ~3 inferences in parallel. More workers = more throughput.

---

## 9. Deployment

### 9.1 Manager machine

```bash
git clone https://github.com/skarazan/LLM-Cluster-NYAI.git
cd LLM-Cluster-NYAI/backend
npm install
npm start
```

Open firewall:
```powershell
New-NetFirewallRule -DisplayName "LLM Cluster Backend" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

Find IP: `ipconfig` → IPv4 → e.g. `192.168.1.50`.

### 9.2 Worker laptops

```bash
# Install Ollama from https://ollama.com
ollama pull llama3
```

Open firewall:
```powershell
New-NetFirewallRule -DisplayName "Ollama" -Direction Inbound -Protocol TCP -LocalPort 11434 -Action Allow
```

### 9.3 Configure manager

Edit `backend/src/services/workerService.js`:
```js
const workers = [
  { id: 1, name: 'Laptop 1', url: 'http://192.168.1.51:11434', status: 'online' },
  { id: 2, name: 'Laptop 2', url: 'http://192.168.1.52:11434', status: 'online' },
  { id: 3, name: 'Laptop 3', url: 'http://192.168.1.53:11434', status: 'online' },
];
```

Restart backend.

### 9.4 User machines

1. Run `LLM Cluster Chat Setup 1.0.0.exe` (from `client/dist/` or GitHub Releases).
2. Open the app.
3. Manager URL: `http://192.168.1.50:3000`.
4. Click Test → green dot.
5. Chat.

Subsequent updates are automatic.

---

## 10. Limitations & Future Work

### Currently out of scope
- **Streaming responses** — Right now the user waits for the full response. Streaming via Server-Sent Events would feel more like ChatGPT.
- **Conversation memory** — Each prompt is independent; the model has no memory of prior turns. Adding a conversation history (last N messages sent with each request) is a small frontend change.
- **Worker health checks** — A worker that goes down stays marked `online`. Periodic pings would auto-flip status.
- **Authentication** — Anyone on the LAN can chat. Fine for a 3-person team; would need API keys / SSO for wider use.
- **Model selector** — Only `llama3` exposed in the dropdown. The backend already accepts any model name, so adding more is purely a UI change.
- **Per-worker load tracking** — Round-robin assumes equal speed. For mixed hardware, a "least busy" strategy would be smarter.
- **Logging / metrics** — No persistent logs of who asked what. Could add a `requests.log` or wire up Prometheus.

### Easy upgrades
- Move worker list to a `config.json` so non-developers can edit.
- Add an admin UI on `/admin` showing real-time worker status.
- Add a "stop generation" button (cancels via `AbortController` mid-stream, once streaming is implemented).

---

## 11. Quick Reference Cheatsheet

```bash
# Run backend (manager machine)
cd backend && npm start

# Run client locally for development
cd client && npm start

# Build .exe (no upload)
cd client && npm run build

# Release new version (builds + publishes to GitHub)
$env:GH_TOKEN = "ghp_..."
cd client && npm run release

# Test endpoints
curl http://localhost:3000/
curl http://localhost:3000/workers
curl -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d "{\"prompt\":\"hi\",\"model\":\"llama3\"}"
```

---

*Last updated: initial build, v1.0.0*
