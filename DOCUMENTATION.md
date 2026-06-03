# LLM Cluster — Documentation

Hey, welcome to the project. This doc covers everything you need to know to understand, run, and work on LLM Cluster. It's written for the team — not for a conference paper, not for investors. If something's confusing, that's our fault, ask and we'll fix the doc.

---

## What Is This?

LLM Cluster is a system that lets you run AI models on your own hardware and use them from a desktop app. Think of it as a private, self-hosted ChatGPT — except instead of paying per token, you run open-source models on GPUs you already have. No API keys, no cloud bills, no data leaving your network.

But it's more than just a chatbot. The desktop client has a **code agent** built in — you can point it at a folder on your computer, say "build me a calculator app," and watch it plan the work, write all the files, run commands, and keep going until it's done. It's not perfect (we'll get to that), but it's genuinely useful and getting better every release.

### The Big Picture

```
You (desktop app)  ──HTTP──►  Manager (routes jobs)  ──HTTP──►  Worker (runs the model)
     Electron                    Node.js/Express                  llama.cpp / Ollama / etc.
     macOS/Windows               any machine                      GPU machine
```

Three pieces:
1. **Client** — Electron desktop app you install on your laptop. Has a chat UI and a code agent.
2. **Manager** (backend) — Node.js server that sits in the middle. Receives requests from clients, picks the best available worker, and forwards the job.
3. **Worker** — Runs on whichever machine has the GPU. Talks to the local inference engine (llama.cpp, Ollama, LM Studio, or vLLM) and streams results back.

They can all run on the same machine for dev, or spread across a LAN, or connected over the internet via a Cloudflare tunnel. The architecture doesn't care.

---

## Repo Structure

```
LLM-Cluster-NYAI/
├── backend/                    Manager server
│   ├── src/
│   │   ├── server.js           Express app entry point
│   │   ├── routes/
│   │   │   ├── chatRoutes.js   POST /chat — main endpoint clients talk to
│   │   │   └── workerRoutes.js Worker registration, polling, results
│   │   └── services/
│   │       └── workerService.js Worker registry, job queue, dispatch logic
│   └── package.json
│
├── worker/                     Worker agent (runs on GPU machine)
│   ├── index.js                Main file — registration, polling, job execution
│   ├── lib/
│   │   ├── cpuSampler.js       CPU usage metrics for load balancing
│   │   └── toolPromptWrap.js   Converts tool messages for llama-server compatibility
│   └── package.json
│
├── client/                     Electron desktop app
│   ├── main.js                 Electron main process — window, IPC, tool execution
│   ├── lib/
│   │   ├── agentLoop.js        The code agent brain (~3400 lines)
│   │   ├── tools.js            Tool definitions (read_file, write_file, etc.)
│   │   └── sandbox.js          Path sandboxing and shell command filtering
│   ├── renderer/
│   │   ├── index.html          Chat UI
│   │   ├── renderer.js         UI logic
│   │   ├── style.css           Dark theme
│   │   └── components/
│   │       └── approvalCard.js Plan approval UI component
│   └── package.json
│
├── start-manager.sh            One-command script to start backend + Cloudflare tunnel
├── README.md                   Quick-start
└── DOCUMENTATION.md            This file
```

---

## How It All Works

### 1. Manager (backend/)

The manager is a plain Express server on port 3000. It doesn't run any AI models itself — it's just a traffic cop.

**What it does:**
- Maintains an in-memory registry of workers (who's online, what models they have, how busy they are)
- Receives chat requests from clients via `POST /chat`
- Picks the best worker for each job (least busy, matching model)
- Uses a **pull-based job dispatch** system — workers long-poll the manager asking "got anything for me?"
- Streams token chunks back to the client in real-time as they arrive from the worker
- Handles retries — if a worker fails, it tries the next one (up to 3 attempts)
- Evicts workers that stop sending heartbeats (30 second TTL)
- Optionally advertises itself on the LAN via mDNS so workers and clients can auto-discover it

**Key design decisions:**

The job dispatch is **pull-based**, not push-based. Workers poll the manager with long-polling (`GET /workers/poll/:id`). When a job comes in, the manager either hands it directly to a waiting poller or queues it until the worker polls again. This works better over tunnels and firewalls than having the manager push to workers.

Worker selection is smarter than simple round-robin now. It considers:
- Which workers have the requested model
- Current in-flight job count vs. worker capacity
- CPU utilization metrics (reported via heartbeats)
- Least-loaded worker wins

**Running it:**
```bash
cd backend
npm install
npm start          # port 3000
```

Or use the convenience script that also starts the Cloudflare tunnel:
```bash
./start-manager.sh
```

### 2. Worker (worker/)

The worker runs on whatever machine has inference hardware. It supports four engines:

| Engine | Default Port | Setup |
|--------|-------------|-------|
| **Ollama** | 11434 | `ollama serve` — easiest to start with |
| **llama.cpp** (llama-server) | 8080 | Best performance, most control over quantization |
| **LM Studio** | 1234 | GUI wrapper, good for beginners |
| **vLLM** | 8000 | Production-grade, Linux only |

The worker auto-detects which engine you're running and adapts its API calls. Ollama uses its native `/api/chat` endpoint; everything else uses the OpenAI-compatible `/v1/chat/completions`.

**Lifecycle:**
1. Starts up, queries the local engine for available models
2. Registers with the manager (sends name, IP, models, capacity)
3. Enters a poll loop — asks the manager for jobs every ~15 seconds
4. When a job arrives, forwards it to the local engine and streams chunks back to the manager
5. Submits the final result when inference completes
6. Sends heartbeats every 15 seconds so the manager knows it's alive
7. Graceful shutdown on Ctrl+C (deregisters from manager)

If the manager evicts the worker (missed heartbeats), it automatically re-registers after 5 seconds.

**Configuration:**

Workers can be configured via environment variables, command-line args, or a JSON config file at `~/.llm-cluster-worker.json`:

```json
{
  "name": "shadow-gpu",
  "preferredManager": "https://llm.tutorrev.live",
  "engineType": "llamacpp",
  "engineUrl": "http://localhost:8080",
  "engineApiKey": "llm-cluster",
  "maxThreads": 8,
  "maxConcurrent": 1,
  "numCtx": 32768
}
```

Or via env vars:
```bash
LLM_ENGINE_TYPE=llamacpp
LLM_ENGINE_URL=http://localhost:8080
LLM_ENGINE_API_KEY=llm-cluster
LLM_MANAGER_URL=https://llm.tutorrev.live
```

If you are using `llamacpp` (a local llama.cpp-based HTTP server) the worker can attempt
to auto-start the engine when it is not reachable. Configure one of the following in
`~/.llm-cluster-worker.json` or via environment variables:

- `engineAutoStartCmd` / `LLM_ENGINE_AUTO_START_CMD`: command to run to start the engine (runs in background)
- `engineBin` / `LLM_ENGINE_BIN`: path to the server binary to launch after install

Two helper scripts are provided at `scripts/install-llamacpp.sh` and `scripts/install-llamacpp.ps1` as templates
to build or fetch a compatible server; they are best-effort and may require manual edits per OS.


**Starting a worker:**
```bash
cd worker
npm install
node index.js                              # auto-discovers manager via mDNS
node index.js http://192.168.1.50:3000     # explicit manager URL
node index.js https://llm.tutorrev.live    # over the internet via tunnel
```

**Sampling parameters:**

The worker sets different sampling for code agent vs. regular chat:

| Parameter | Code Agent | Chat |
|-----------|-----------|------|
| Temperature | 0.6 | 0.7 |
| Top P | 0.95 | 0.9 |
| Top K | 40 | 40 |
| Presence Penalty | 0 | 0 |
| Repeat Penalty | 1.0 | 1.1 |
| Max Tokens | 8192 | unlimited |

These are overridable via env vars like `LLM_CODE_TEMPERATURE=0.5`.

**Thinking mode:**

For models that support it (like Qwen3), `enable_thinking` is left at the default (on). The model reasons internally before generating code. The worker handles the case where the model produces only thinking tokens with no visible output — it returns empty content instead of crashing.

### 3. Client (client/)

The client is an Electron app with two modes:

**Chat mode** — A simple chat interface. Type a message, get a response. Shows which worker answered, token count, and speed.

**Code agent mode** — The powerful one. You select a workspace folder, describe what you want built, and the agent takes over. It can:
- Plan the work and show you a file manifest before starting
- Create, read, edit, and delete files
- Run shell commands (npm install, tests, builds, opening files)
- Search files with glob and grep
- Iterate on bugs when things don't work
- Track progress with a todo list

The agent's brain lives in `client/lib/agentLoop.js` (~3400 lines). Here's how a typical run works:

1. You type a prompt like "Build me a calculator app"
2. The agent creates a plan with a todo list (one item per file to create)
3. For each file, it either:
   - Writes it using XML tags in its text response (`<write_file>...</write_file>`)
   - Or calls tool functions (read_file, edit_file, run_shell, etc.)
4. After each cycle, the agent checks: are all todos done? Did we make progress?
5. When all files are created and verified, it auto-completes with a summary

**Why XML tags for file writing?**

We learned this one the hard way. Putting HTML content inside JSON tool call arguments straight up breaks llama.cpp's JSON parser — double quotes in HTML attributes like `charset="UTF-8"` crash it every time. After a lot of debugging, we switched to having the model write files as plain text in its response, wrapped in XML tags:

```
<write_file path="/Users/you/Desktop/project/index.html">
<!DOCTYPE html>
<html>
  <head><meta charset="UTF-8"></head>
  ...
</write_file>
```

The client parses these tags out of the response and executes the writes. Large files get split: `<write_file>` for the first ~80 lines, then `<append_file>` for the rest.

**Agent safety features:**
- **Sandboxing** — All file operations are confined to the selected workspace folder. Path traversal is blocked. Symlinks that escape the workspace are rejected.
- **Shell filtering** — Dangerous commands (`rm -rf`, `sudo`, `curl`, `wget`, file-writing shell commands) are blocked. The agent can only run safe commands like `npm install`, `node`, `open`, etc.
- **Stale read detection** — Before overwriting a file, the agent must have a recent read of it. If the file changed since the last read, the write is rejected.
- **Stuck detection** — If the agent repeats the same action too many times without making progress, it gets nudged or killed.
- **Read loop detection** — If the agent keeps reading the same file without doing anything with it, it gets interrupted.
- **Auto-completion** — When all planned files are created and verified, the agent stops automatically instead of looping forever.

**Frontend verification:**

When the agent builds web projects (HTML/CSS/JS), it runs basic checks:
- Do linked CSS files exist?
- Do linked JS files exist?
- Do important CSS classes referenced in HTML have matching CSS rules?
- Do element IDs referenced in JavaScript exist in the HTML?

These checks happen automatically before the agent declares "done."

---

## APIs

### Client → Manager

**`POST /chat`** — Send a message, get a response.
```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ],
  "model": "qwen3.6-27b",
  "tools": [],
  "requestId": "abc-123",
  "agentMode": "code"
}
```

Response is chunked — you'll get streaming token chunks as they arrive:
```
{"chunk": "Hello"}
{"chunk": "! How"}
{"chunk": " can I help?"}
{"worker":"shadow-gpu","model":"qwen3.6-27b","response":"Hello! How can I help?","tokens":{"prompt":150,"response":12,"total":162,"tokensPerSec":8.5},"finish_reason":"stop","ms":1420,"attempt":0}
```

**`POST /chat/cancel`** — Cancel an in-flight request.
```json
{ "requestId": "abc-123" }
```

**`GET /workers`** — List all registered workers and their status.

### Worker → Manager

**`POST /workers/register`** — Worker announces itself on startup.

**`POST /workers/heartbeat`** — Worker sends CPU/load metrics every 15s.

**`GET /workers/poll/:id`** — Worker long-polls for a job (15s timeout).

**`POST /workers/chunk`** — Worker forwards streaming token chunks.

**`POST /workers/result`** — Worker submits completed job result.

**`POST /workers/job-heartbeat`** — Worker signals it's still working on a job.

---

## Setting Things Up

### For development (everything on one machine)

```bash
# Terminal 1: Manager
cd backend && npm install && npm start

# Terminal 2: Start your inference engine
# Option A: Ollama
ollama serve

# Option B: llama-server
./llama-server -m model.gguf -ngl 999 --host 0.0.0.0 --port 8080

# Terminal 3: Worker
cd worker && npm install
LLM_ENGINE_TYPE=llamacpp node index.js http://localhost:3000

# Terminal 4: Client
cd client && npm install && npm start
```

### For the current production setup

We run the manager on a Mac with a Cloudflare tunnel (`llm.tutorrev.live`), and the worker on a Windows ShadowPC with an RTX 2000 Ada running llama-server.

**Manager machine (Mac):**
```bash
./start-manager.sh
# Starts backend on port 3000 + Cloudflare tunnel
```

**Worker machine (Windows ShadowPC):**
```batch
:: Start llama-server with the model
set GGML_CUDA_GRAPH_OPT=1
llama-server.exe ^
  -m D:\models\Qwen3.6-27B-UD-Q3_K_XL.gguf ^
  -ngl 999 ^
  -fa on ^
  --cache-type-k turbo4 ^
  --cache-type-v turbo3 ^
  -c 65536 ^
  --jinja ^
  --host 0.0.0.0 ^
  --port 8080 ^
  --api-key llm-cluster
```

```bash
# In another terminal, start the worker
cd worker
node index.js https://llm.tutorrev.live
```

**Your laptop:**

Download the client from [GitHub Releases](https://github.com/skarazan/LLM-Cluster-NYAI/releases/latest), install it, and set the manager URL to `https://llm.tutorrev.live`. Or run it from source with `cd client && npm start`.

### Adding a new worker

1. Set up your inference engine (Ollama, llama-server, whatever)
2. Clone the repo, `cd worker && npm install`
3. Create `~/.llm-cluster-worker.json` or set env vars
4. Run `node index.js <manager-url>`
5. That's it — the manager will start routing jobs to it automatically

The worker auto-registers and the manager picks it up within seconds. No config changes needed on the manager side.

---

## The Code Agent (the interesting part)

The agent loop in `agentLoop.js` is the most complex piece of the system. Here's what it handles and why.

### Planning

When you give the agent a task, it first creates a plan — a list of files to create with descriptions. You see this as a "Proposed Plan" card in the UI. You can approve, edit, or reject it. Once approved, the plan becomes a todo list that drives execution.

### File Writing Strategy

The agent writes files using XML tags in its text response, not JSON tool calls. This was a deliberate choice:

- **JSON tool calls break on HTML** — llama.cpp's JSON parser chokes on double quotes inside HTML attributes
- **XML tags handle any content** — Raw text between tags, no escaping needed
- **Chunking** — Files over ~80 lines get split: `<write_file>` for the beginning, `<append_file>` for the rest. The chunking threshold (`WRITE_CHUNK_CHARS = 8000`) was tuned to avoid splitting small files unnecessarily.

### Stuck Detection

The agent can get into all kinds of weird failure loops. We've seen it read the same file 15 times in a row, repeat the same paragraph forever, or just... stop doing anything useful. So there's a whole detection system:

| Failure Mode | Detection | Response |
|---|---|---|
| Repeating the same text without acting | `plainContinuationCount >= 5` | Force nudge toward next todo |
| Empty responses (thinking-only output) | `emptyContinuationCount >= 3` | Re-prompt with explicit instruction |
| Reading the same file repeatedly | `readRepeatFingerprints` count >= 3-6 | "Stop re-reading, edit or move on" |
| Writing fails, then reading the same file | `stuckOnFailedFile` after 2 reads | Force file write with explicit instruction |
| No progress for several cycles | `consecutiveNoProgressCycles >= 3` | Escalating interventions |

All counters reset when the agent makes actual progress (file written, tool succeeded, etc.).

### Auto-completion

When all todo items are done and the agent made progress in the current cycle, it automatically:
1. Runs file verification (existence, size, frontend checks)
2. If verification passes, injects a "Done. Verified N file todos" message and stops
3. If verification fails, marks failed items and tells the agent to fix them

There's a guard (`todosAlreadyDoneAtStart`) that prevents auto-completion from firing on follow-up turns. Without this, if you said "hey fix this bug" after a completed task, the agent would make one edit and immediately say "Done!" because the original todos were already checked off. That was annoying, so now it knows the difference between a fresh task and a follow-up.

### file:// Protocol Rules

Since the agent creates files that get opened directly in the browser (no dev server), there are strict rules in the system prompt:

- No `import`/`export` or `<script type="module">` (CORS blocks on file://)
- No Babel standalone loading external files (same CORS issue)
- CDN libraries are global — accessed directly, never imported
- JSX must be inline in the HTML file
- External JS files use `React.createElement()` instead of JSX

These rules exist because the model was trained on a mountain of modern bundled code with ES modules, and its instinct is to `import` everything. But none of that works when you just double-click an HTML file to open it. We've added these rules to the system prompt multiple times in increasingly stern language and the model *still* sometimes does it. It's a work in progress.

### Read File Behavior

`DEFAULT_READ_LINES = 5000` — When the agent reads a file, it gets up to 5000 lines by default. This used to be 300, and the agent was constantly making wrong decisions because it could only see the top of each file. Imagine trying to fix a bug in a file you can only see 30% of — that's what was happening. Bumping it to 5000 fixed a lot of mysterious failures.

---

## Building & Releasing

### Build the client

```bash
cd client
npm install
npm run build:mac    # .dmg
npm run build:win    # .exe (NSIS installer)
npm run build:linux  # .AppImage
```

### Release a new version

```bash
# 1. Bump version in client/package.json
# 2. Commit and push

# 3. Set GitHub token
export GH_TOKEN=ghp_...          # macOS/Linux
$env:GH_TOKEN = "ghp_..."        # Windows PowerShell

# 4. Build and publish
cd client
npm run release
```

This builds the installer, creates a GitHub Release, and uploads the binary. Installed clients will detect the update on their next launch.

### Version tagging

```bash
git tag v1.0.7
git push origin v1.0.7
```

---

## Environment Variables Reference

### Worker

| Variable | Default | What it does |
|----------|---------|-------------|
| `LLM_ENGINE_TYPE` | `ollama` | Engine: `ollama`, `llamacpp`, `lmstudio`, `vllm` |
| `LLM_ENGINE_URL` | per engine | Engine HTTP URL |
| `LLM_ENGINE_PORT` | per engine | Engine port |
| `LLM_ENGINE_API_KEY` | (none) | Bearer token for engine auth |
| `LLM_MANAGER_URL` | auto-discover | Manager URL |
| `LLM_CODE_TEMPERATURE` | `0.6` | Sampling temp for code agent |
| `LLM_CHAT_TEMPERATURE` | `0.7` | Sampling temp for chat |
| `LLM_CODE_MAX_TOKENS` | `8192` | Max output tokens for code agent |
| `LLM_CHAT_MAX_TOKENS` | `-1` (unlimited) | Max output tokens for chat |
| `LLM_CODE_TOP_P` | `0.95` | Top-p for code agent |
| `LLM_CODE_TOP_K` | `40` | Top-k for code agent |
| `LLM_CODE_PRESENCE_PENALTY` | `0` | Presence penalty for code agent |
| `LLM_CODE_REPEAT_PENALTY` | `1.0` | Repeat penalty for code agent |
| `LLM_CACHE_PROMPT` | `0` | Set to `1` to add `cache_prompt: true` to requests |

### Manager

| Variable | Default | What it does |
|----------|---------|-------------|
| `MDNS` | (on) | Set to `0` to disable mDNS advertisement |
| `LLM_DEV_OLLAMA` | (off) | Set to `1` to enable local Ollama setup check (dev only) |

---

## Troubleshooting

### "No workers online"
The manager has no registered workers. Either the worker isn't running, it can't reach the manager, or heartbeats timed out. Check the worker terminal for errors.

### Worker keeps re-registering
The manager evicted it (missed heartbeats). This usually means network issues between worker and manager. If using a tunnel, check that Cloudflare isn't throttling long-poll connections.

### Agent gets stuck reading the same file
The stuck detection should catch this after 3-6 reads. If it doesn't, the agent loop may need the thresholds adjusted. Check `agentLoop.js` for `readRepeatFingerprints`.

### Agent uses `import`/`export` in generated code
The system prompt tells it not to, but sometimes the model's training overpowers the instruction. The system prompt rules are in `agentLoop.js` around line 505. You can make them more aggressive if needed.

### "Failed to parse tool call arguments"
llama.cpp's JSON parser crashed on the tool call (usually because of HTML double quotes). The worker's salvage logic kicks in and tells the agent to switch to XML file blocks. This is normal and self-correcting.

### Files get split into chunks unexpectedly
The `WRITE_CHUNK_CHARS` threshold in `agentLoop.js` controls this. Currently set to 8000. If files are getting split when they shouldn't be, raise it.

### Model produces empty responses
The model generated only thinking tokens (`<think>...</think>`) with no visible output. The worker handles this gracefully — it returns empty content and the agent loop retries. If it happens repeatedly, the `emptyContinuationCount` detector will escalate.

---

## Architecture Decisions (the "why" behind things)

**Why pull-based job dispatch?** Workers long-poll the manager instead of the manager pushing to workers. This works through firewalls, NAT, and tunnels without needing workers to expose ports. The manager just needs to be reachable.

**Why XML tags for file writing?** JSON tool calls can't safely carry HTML content through llama.cpp's parser. XML tags in plain text bypass this entirely — the content is just text, no escaping needed.

**Why not stream directly from worker to client?** The manager sits in the middle and relays chunks. This lets us do retry/failover transparently — if a worker dies mid-response, the manager can retry with another worker without the client knowing.

**Why Electron?** Same JavaScript stack everywhere (backend, worker, client). Easy to package as .exe/.dmg. The code agent needs Node.js APIs (filesystem, child_process) that browsers can't do.

**Why not just use the Ollama API directly?** We could, but the manager gives us: load balancing across multiple GPUs, failover, centralized job tracking, and the ability to swap inference engines without changing the client. Workers are interchangeable.

---

## Current Setup & Performance

We're currently running **Qwen3.6-27B** (UD-Q3_K_XL GGUF quantization) on an **RTX 2000 Ada** (16GB VRAM) via llama-server. The model fits entirely in VRAM at ~14GB.

**Performance numbers:**
- Decode: ~4-8 tok/s (memory bandwidth limited — 224 GB/s)
- Context window: up to 65K tokens
- KV cache: asymmetric turbo4 (keys) / turbo3 (values) for memory efficiency

This is a 27 billion parameter model running on a single consumer GPU. It's not blazing fast — you'll wait a bit between responses — but it's genuinely capable. It can build multi-file web apps, handle tool calling chains, and reason through complex problems. For a model running on hardware that costs less than a nice dinner, it's impressive.

See `AGENT_PLAN.md` for the performance optimization roadmap if you want to squeeze more speed out of it.

---

## Known Limitations (being honest)

- **Speed** — ~4-8 tok/s means the agent takes minutes for big tasks, not seconds. You can start a task and go get coffee.
- **ES modules** — The model really wants to use `import`/`export`. We keep telling it not to. It keeps doing it sometimes.
- **Complex React projects** — Multi-file React with JSX is tricky because Babel standalone + file:// protocol don't play nice. The agent sometimes needs a couple attempts.
- **Verification is basic** — We check that files exist and aren't empty, and do some CSS/JS cross-referencing, but we're not running the actual app to see if it works.
- **The model hallucinates prop names** — When writing multi-file code, the model sometimes writes component A expecting props that component B never sends. We tell it to cross-check interfaces, but it doesn't always listen.

These are all actively being worked on. If you run into something new, let us know so we can add detection/handling for it.

---

*Last updated after v1.0.6 release*
