# LLM Cluster

Local Ollama cluster for running AI models across multiple machines on a LAN.

## Architecture

```
[Client app] --HTTP--> [Backend Manager] --HTTP--> [Worker machines with Ollama]
```

- **backend/** — Node.js + Express manager. Receives chat requests, routes round-robin to registered workers.
- **worker/** — Standalone Node.js agent. Run on any machine with Ollama to register it as a worker.
- **client/** — Electron desktop chat app. Distributed as `.dmg` (macOS) and `.exe` (Windows).

---

## 1. Manager (one machine)

Install and start the backend:

```bash
cd backend
npm install
npm start
```

Runs on port `3000`. Open firewall port `3000` for LAN access.

---

## 2. Workers (any machine with Ollama)

### Requirements
1. [Ollama](https://ollama.com) installed and running
2. Model pulled: `ollama pull llama3`
3. Firewall port `11434` open for LAN

### On macOS/Linux — allow LAN access
Ollama binds to `localhost` by default. To accept connections from the manager:

```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

### On Windows — allow LAN access
Set the environment variable before starting Ollama:

```
OLLAMA_HOST=0.0.0.0:11434
```

Then add a Windows Firewall inbound rule for TCP port `11434`.

### Register as a worker

```bash
cd worker
node index.js http://<manager-ip>:3000
```

The worker auto-registers, sends heartbeats every 15s, and deregisters on exit (Ctrl+C).
If the manager doesn't hear a heartbeat for 30s, it evicts the worker automatically.

---

## 3. Client (user machines)

Download the latest installer from [GitHub Releases](https://github.com/skarazan/LLM-Cluster-NYAI/releases/latest).

- macOS: `.dmg`
- Windows: `.exe`

Enter the manager's LAN IP in the app (e.g. `http://192.168.1.x:3000`), click **Test** to verify connection, then start chatting.

The app maintains full conversation history per session. Click **New Chat** to start fresh.

### Update notifications

On launch, the client checks GitHub Releases. If a newer version exists, a banner appears with a link to download the update.

---

## 4. Chat API

```
POST /chat
Content-Type: application/json

{
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "model": "llama3"
}
```

Response:
```json
{ "worker": "worker-name", "model": "llama3", "response": "..." }
```

Workers endpoint:
```
GET /workers          — list registered workers
POST /workers/register
POST /workers/heartbeat
DELETE /workers/deregister
```

---

## 5. Building & releasing

```bash
cd client
npm install
npm run build:mac    # produces .dmg in client/dist/
npm run build:win    # produces .exe in client/dist/
```

Tagging a release triggers GitHub Actions to build for macOS + Windows and publish to GitHub Releases automatically:

```bash
git tag v1.x.x
git push origin v1.x.x
```
