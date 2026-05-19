# Connecting VS Code to LLM Cluster

Use any VS Code AI extension (Continue, Cline, etc.) with LLM Cluster instead of paying for API keys. This guide assumes you're testing locally — no Cloudflare tunnel needed.

---

## Quick Start (5 minutes)

### 1. Start the Manager

```powershell
cd backend
npm install
node src/server.js
```

You should see:
```
Backend running at http://localhost:3000
```

### 2. Start Your Worker

If you're already running llama-server directly:

```powershell
cd worker
npm install
set LLM_ENGINE_TYPE=llamacpp
node index.js http://localhost:3000
```

Or if using Ollama:
```powershell
ollama serve
cd worker
npm install
node index.js http://localhost:3000
```

Or just use the Worker App — it handles everything.

### 3. Verify It Works

Open a browser or PowerShell:

```powershell
# Check workers are connected
curl http://localhost:3000/workers

# Check available models
curl http://localhost:3000/v1/models

# Test a chat completion
curl http://localhost:3000/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "qwen3-8b",
  "messages": [{"role": "user", "content": "Hello"}],
  "stream": false
}'
```

If you get a response, you're good.

---

## VS Code Setup with Continue Extension

[Continue](https://marketplace.visualstudio.com/items?itemName=Continue.continue) is the easiest — it supports custom OpenAI-compatible endpoints out of the box.

### Install

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search "Continue" → Install

### Configure

1. Click the Continue icon in the sidebar
2. Click the gear icon → Open config file
3. This opens `~/.continue/config.json`. Replace the models section:

```json
{
  "models": [
    {
      "title": "LLM Cluster",
      "provider": "openai",
      "model": "qwen3-8b",
      "apiBase": "http://localhost:3000/v1",
      "apiKey": "not-needed"
    }
  ]
}
```

Change `"model"` to whatever model your worker is running (check `http://localhost:3000/v1/models`).

4. Save the file. Continue will reload automatically.
5. Open a file, select some code, press Ctrl+L to chat about it.

### Tab Autocomplete (Optional)

Add this to the same config.json:

```json
{
  "models": [...],
  "tabAutocompleteModel": {
    "title": "LLM Cluster Autocomplete",
    "provider": "openai",
    "model": "qwen2.5-coder-7b",
    "apiBase": "http://localhost:3000/v1",
    "apiKey": "not-needed"
  }
}
```

This works best with a code-specific model like Qwen 2.5 Coder.

---

## VS Code Setup with Cline

[Cline](https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev) also supports custom OpenAI endpoints.

1. Install Cline from the Extensions marketplace
2. Open Cline settings
3. Set API Provider to "OpenAI Compatible"
4. Base URL: `http://localhost:3000/v1`
5. API Key: `not-needed` (anything works, the manager doesn't check)
6. Model: your model name (e.g. `qwen3-8b`)

---

## Available API Endpoints

The manager now exposes a standard OpenAI-compatible API:

| Endpoint | Method | What it does |
|----------|--------|-------------|
| `/v1/models` | GET | List all models available across workers |
| `/v1/chat/completions` | POST | Chat completion (streaming and non-streaming) |

### Request format (same as OpenAI)

```json
{
  "model": "qwen3-8b",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Write a function to sort an array"}
  ],
  "stream": true,
  "temperature": 0.7,
  "max_tokens": 2048
}
```

### Streaming response (SSE)

```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"delta":{"content":"Here"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"delta":{"content":" is"},"finish_reason":null}]}

data: [DONE]
```

---

## Troubleshooting

**"No workers online"**
→ Worker isn't connected to the manager. Run `curl http://localhost:3000/workers` — if empty, start the worker script.

**Model not found / wrong model**
→ The model name in VS Code config must prefix-match what the worker reports. Check `http://localhost:3000/v1/models` for exact names.

**Continue shows "connection refused"**
→ Manager not running, or wrong port. Default is `http://localhost:3000/v1`.

**Slow responses**
→ Normal for large models on small GPUs. Try a smaller model (Qwen3 4B or 1.7B) for autocomplete, keep the bigger model for chat.

**Testing from another machine on the same network**
→ Replace `localhost` with the manager machine's local IP (e.g. `http://192.168.1.50:3000/v1`).
