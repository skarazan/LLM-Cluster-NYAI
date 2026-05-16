# LLM Cluster

Run AI models on your own hardware. Chat with them from a desktop app. Or let the built-in code agent build entire projects for you — no cloud, no API keys, no per-token bills.

```
[Desktop Client]  ──HTTP──►  [Manager]  ──HTTP──►  [Worker + GPU]
   Electron app              Express.js            llama.cpp / Ollama / LM Studio / vLLM
```

- **backend/** — Manager server. Routes jobs to workers, handles load balancing and failover.
- **worker/** — Runs on your GPU machine. Talks to the local inference engine and streams results back.
- **client/** — Electron desktop app with chat UI and an autonomous code agent.

📖 Full docs: [DOCUMENTATION.md](DOCUMENTATION.md)

---

## Quick Start

### 1. Manager (one machine)

```bash
cd backend
npm install
npm start            # runs on port 3000
```

### 2. Worker (GPU machine)

Start your inference engine, then register with the manager:

```bash
# Start llama-server (or ollama serve, or lm studio, etc.)
./llama-server -m model.gguf -ngl 999 --host 0.0.0.0 --port 8080

# In another terminal
cd worker
npm install
LLM_ENGINE_TYPE=llamacpp node index.js http://<manager-ip>:3000
```

The worker auto-registers, sends heartbeats, and deregisters on Ctrl+C.

Supported engines: `ollama` (default), `llamacpp`, `lmstudio`, `vllm`

### 3. Client (your laptop)

Download from [GitHub Releases](https://github.com/skarazan/LLM-Cluster-NYAI/releases/latest) or run from source:

```bash
cd client
npm install
npm start
```

Enter the manager URL (ask the team if you don't have it), click Test, start chatting.

---

## Code Agent

The client has a built-in code agent. Select a workspace folder, describe what you want, and the agent will:

1. Create a plan with a file manifest
2. Write all the files (HTML, CSS, JS, etc.)
3. Run shell commands as needed (npm install, tests, etc.)
4. Verify the output and iterate on issues

It handles multi-file projects, framework code (React, Vue, etc.), and can fix bugs when you point them out. It's not perfect — think of it as a very fast intern that sometimes needs guidance.

---

## Worker Configuration

Set via env vars, CLI args, or `~/.llm-cluster-worker.json`:

```json
{
  "name": "my-gpu",
  "engineType": "llamacpp",
  "engineUrl": "http://localhost:8080",
  "engineApiKey": "my-key",
  "preferredManager": "https://llm.tutorrev.live"
}
```

---

## Building & Releasing

```bash
cd client
npm run build:mac    # .dmg
npm run build:win    # .exe
npm run build:linux  # .AppImage

# Publish to GitHub Releases
export GH_TOKEN=ghp_...
npm run release
```

---

## API

```
POST /chat              — Send messages, get streaming response
POST /chat/cancel       — Cancel an in-flight request
GET  /workers           — List registered workers
POST /workers/register  — Worker self-registers
POST /workers/heartbeat — Worker keepalive + metrics
GET  /workers/poll/:id  — Worker long-polls for jobs
POST /workers/result    — Worker submits job result
POST /workers/chunk     — Worker forwards streaming chunks
```
