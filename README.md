# LLM Cluster

Local Ollama cluster for running AI models across multiple laptops on a LAN.

## Architecture

```
[Users with Client app] --HTTP--> [Backend Manager] --HTTP--> [Worker Laptops with Ollama]
```

- **backend/** — Node.js + Express manager. Receives prompts, round-robin to online workers.
- **client/** — Electron desktop app. Chat UI, distributed as `.exe`.

## Backend (manager machine)

```bash
cd backend
npm install
npm run dev
```

Runs on `http://localhost:3000`. Configure workers in [backend/src/services/workerService.js](backend/src/services/workerService.js).

## Client (user machines)

```bash
cd client
npm install
npm start          # dev
npm run build      # produce .exe installer in client/dist/
```

## Setup workers

Each worker laptop needs:
1. Ollama installed: <https://ollama.com>
2. Model pulled: `ollama pull llama3`
3. Firewall port `11434` open
4. Its IP added to `workerService.js` with `status: 'online'`

## Setup manager

1. Node.js installed
2. Backend running (port `3000`)
3. Firewall port `3000` open

## Auto-updates

Client checks GitHub Releases on launch and self-updates.
