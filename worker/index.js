'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { getCpuPct }    = require('./lib/cpuSampler');
const { wrapMessages } = require('./lib/toolPromptWrap');

const HEARTBEAT_EVERY = 15_000; // 15s

// Engine types and their default endpoints
const ENGINE_DEFAULTS = {
  ollama:    { url: 'http://localhost:11434', port: 11434 },
  llamacpp:  { url: 'http://localhost:8080',  port: 8080  },
  lmstudio:  { url: 'http://localhost:1234',  port: 1234  },
  vllm:      { url: 'http://localhost:8000',  port: 8000  },
};
const OPENAI_SHAPE = new Set(['llamacpp', 'lmstudio', 'vllm']);

function resolveEngine(config) {
  const type = (config.engineType || process.env.LLM_ENGINE_TYPE || 'ollama').toLowerCase();
  const defaults = ENGINE_DEFAULTS[type] || ENGINE_DEFAULTS.ollama;
  const url     = (config.engineUrl    || process.env.LLM_ENGINE_URL    || defaults.url).replace(/\/$/, '');
  const port    = config.enginePort   || process.env.LLM_ENGINE_PORT    || defaults.port;
  const apiKey  = config.engineApiKey || process.env.LLM_ENGINE_API_KEY || '';
  return { type, url, port: Number(port), apiKey, openai: OPENAI_SHAPE.has(type) };
}

function authHeaders(engine) {
  return engine.apiKey ? { Authorization: `Bearer ${engine.apiKey}` } : {};
}

// ---------- Config loader ----------

function loadConfig() {
  const configPath = path.join(os.homedir(), '.llm-cluster-worker.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn(`[config] Could not read ${configPath}: ${err.message}`);
  }
  return {};
}

// ---------- Manager URL ----------

async function getManagerUrl(config) {
  if (process.argv[2]) return process.argv[2].replace(/\/$/, '');
  if (process.env.LLM_MANAGER_URL) return process.env.LLM_MANAGER_URL.replace(/\/$/, '');
  if (config.preferredManager) return config.preferredManager.replace(/\/$/, '');

  // mDNS discovery
  try {
    const { Bonjour } = require('bonjour-service');
    const b = new Bonjour();
    const found = await new Promise((resolve) => {
      const list = [];
      const browser = b.find({ type: 'llmcluster' }, (svc) => {
        const addr = (svc.addresses || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
        if (addr) list.push(`http://${addr}:${svc.port}`);
      });
      setTimeout(() => { browser.stop(); b.destroy(); resolve(list); }, 3000);
    });
    if (found.length >= 1) {
      console.log(`[discovery] Found manager via mDNS: ${found[0]}`);
      return found[0];
    }
  } catch { /* bonjour not available */ }

  // Default public URL
  const defaultUrl = 'https://llm.tutorrev.live';
  console.log(`[discovery] Using default manager URL: ${defaultUrl}`);
  return defaultUrl;
}

// ---------- Engine helpers ----------

async function getLocalModels(engine) {
  const url = engine.openai ? `${engine.url}/v1/models` : `${engine.url}/api/tags`;
  let res;
  try {
    res = await fetch(url, { headers: authHeaders(engine) });
  } catch (err) {
    console.error(`Cannot reach ${engine.type} at ${engine.url}. Is it running?`);
    console.error(err.message);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`${engine.type} responded with HTTP ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  if (engine.openai) {
    return (data.data || []).map((m) => m.id);
  }
  return (data.models || []).map((m) => m.name);
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

// ---------- Manager communication ----------

async function register(managerUrl, name, ip, port, models, capacity) {
  let res;
  try {
    res = await fetch(`${managerUrl}/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ip, port, models, capacity, version: '3.0' }),
    });
  } catch (err) {
    console.error(`Cannot reach manager at ${managerUrl}.`);
    console.error(err.message);
    process.exit(1);
  }
  if (!res.ok) {
    const body = await res.text();
    console.error(`Registration failed (HTTP ${res.status}): ${body}`);
    process.exit(1);
  }
  const data = await res.json();
  return data.id;
}

async function sendHeartbeat(managerUrl, id) {
  getCpuPct();
  await new Promise(r => setTimeout(r, 1000));
  const cpuPct   = getCpuPct();
  const loadAvg1 = os.loadavg()[0];
  try {
    const res = await fetch(`${managerUrl}/workers/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, metrics: { cpuPct, loadAvg1 } }),
    });
    if (!res.ok) console.warn(`[heartbeat] manager responded ${res.status}`);
  } catch (err) {
    console.warn(`[heartbeat] failed: ${err.message}`);
  }
}

async function deregister(managerUrl, id) {
  try {
    await fetch(`${managerUrl}/workers/deregister`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    console.log('Deregistered from manager. Goodbye.');
  } catch (err) {
    console.warn(`Could not reach manager to deregister: ${err.message}`);
  }
}

// ---------- Job execution ----------

async function runJob(job, engine, maxThreads, numCtx, onChunk) {
  const messages = wrapMessages(job.messages, job.tools);
  const startMs = Date.now();

  let url, body;
  if (engine.openai) {
    url = `${engine.url}/v1/chat/completions`;
    body = {
      model: job.model,
      messages,
      stream: true,   // stream so we can see tokens in real-time + detect crash point
      max_tokens: 8192,
      temperature: 0.7,
    };
    if (job.tools && job.tools.length > 0) {
      body.tools = job.tools;
      body.tool_choice = 'auto';
    }
  } else {
    url = `${engine.url}/api/chat`;
    body = {
      model: job.model,
      messages,
      stream: false,
      options: { num_thread: maxThreads, num_ctx: numCtx },
    };
    if (job.tools && job.tools.length > 0) body.tools = job.tools;
  }

  const inferenceAbort = new AbortController();
  const inferenceTimer = setTimeout(() => inferenceAbort.abort(), 600_000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(engine) },
      body: JSON.stringify(body),
      signal: inferenceAbort.signal,
    });
  } finally {
    clearTimeout(inferenceTimer);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`${engine.type} HTTP ${res.status}: ${errBody.slice(0, 500)}`);
  }

  let content, toolCalls, tokens;

  if (engine.openai) {
    // --- SSE stream reader ---
    let accumulated = '';
    const toolCallsMap = {};  // index → partial tool call
    let promptTokens = 0, completionTokens = 0;

    process.stdout.write('\n[stream] ');
    const reader = res.body;
    const decoder = new TextDecoder();
    let buf = '';

    for await (const chunk of reader) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }

        // usage (some servers send it in last chunk)
        if (evt.usage) {
          promptTokens     = evt.usage.prompt_tokens     || 0;
          completionTokens = evt.usage.completion_tokens || 0;
        }

        const delta = evt.choices?.[0]?.delta;
        if (!delta) continue;

        // content delta (thinking + response text)
        if (delta.content) {
          accumulated += delta.content;
          process.stdout.write(delta.content);
          if (onChunk) onChunk(delta.content);
        }

        // tool_calls delta
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsMap[idx]) {
              toolCallsMap[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
            }
            const t = toolCallsMap[idx];
            if (tc.id)                    t.id                    = tc.id;
            if (tc.function?.name)        t.function.name        += tc.function.name;
            if (tc.function?.arguments)   t.function.arguments   += tc.function.arguments;
          }
        }
      }
    }
    process.stdout.write('\n[stream end]\n');

    content   = accumulated;
    const built = Object.values(toolCallsMap);
    toolCalls = built.length ? built : null;

    const elapsedSec = (Date.now() - startMs) / 1000;
    tokens = {
      prompt:       promptTokens,
      response:     completionTokens,
      total:        promptTokens + completionTokens,
      tokensPerSec: (completionTokens && elapsedSec > 0)
        ? Math.round((completionTokens / elapsedSec) * 10) / 10
        : null,
    };
  } else {
    const data = await res.json();
    toolCalls = data.message?.tool_calls || null;
    content   = data.message?.content    || '';
    tokens = {
      prompt:       data.prompt_eval_count || 0,
      response:     data.eval_count        || 0,
      total:        (data.prompt_eval_count || 0) + (data.eval_count || 0),
      tokensPerSec: data.eval_duration
        ? Math.round((data.eval_count / (data.eval_duration / 1e9)) * 10) / 10
        : null,
    };
  }

  if (!toolCalls && !content) {
    throw new Error(`Unexpected ${engine.type} response shape`);
  }

  const result = { content, tokens };
  if (toolCalls) result.tool_calls = toolCalls;
  return result;
}

// ---------- Poll loop ----------

async function pollLoop(managerUrl, id, engine, maxThreads, numCtx) {
  while (true) {
    let data;
    try {
      const controller = new AbortController();
      const pollTimer = setTimeout(() => controller.abort(), 20000);
      let res;
      try {
        res = await fetch(`${managerUrl}/workers/poll/${id}`, {
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(pollTimer);
      }
      if (res.status === 404) {
        console.error('[poll] Manager says worker not found — re-registering...');
        return; // exits poll loop, main() will re-register
      }
      if (!res.ok) {
        console.warn(`[poll] manager responded ${res.status} — retrying in 5s`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      // Body may have leading newlines from chunked-encoding keepalives.
      const text = await res.text();
      const trimmed = text.trimStart();
      data = trimmed ? JSON.parse(trimmed) : { job: null };
    } catch (err) {
      console.warn(`[poll] fetch failed: ${err.message} — retrying in 5s`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    if (!data.job) continue; // no job, poll again immediately

    const job = data.job;
    console.log(`[job] received jobId=${job.id} model=${job.model}`);

    // Real-time chunk forwarder — fire-and-forget, no batching delay
    const onChunk = (content) => {
      fetch(`${managerUrl}/workers/chunk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, content }),
      }).catch(() => {});
    };

    let result = null;
    let error  = null;
    try {
      result = await runJob(job, engine, maxThreads, numCtx, onChunk);
      console.log(`[job] completed jobId=${job.id} tokens=${result.tokens.total}`);
    } catch (err) {
      error = err.message;
      console.error(`[job] failed jobId=${job.id}: ${err.message}`);
    }

    // Post result back
    try {
      await fetch(`${managerUrl}/workers/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, result, error }),
      });
    } catch (err) {
      console.error(`[job] failed to submit result: ${err.message}`);
    }
  }
}

// ---------- Main ----------

async function main() {
  const config = loadConfig();
  const engine = resolveEngine(config);

  const cores         = os.cpus().length;
  const maxThreads    = config.maxThreads    || Math.max(2, Math.round(cores * 0.85));
  const maxConcurrent = config.maxConcurrent || 1;
  const numCtx        = config.numCtx        || 32768;
  const capacity      = { cores, maxThreads, maxConcurrent };

  const managerUrl = await getManagerUrl(config);
  const models     = await getLocalModels(engine);
  const ip         = getLocalIp();
  const name       = config.name || os.hostname();

  console.log(`[worker] v3.0 — engine=${engine.type} url=${engine.url} (api-key=${engine.apiKey ? 'set' : 'none'})`);
  console.log(`Detected ${models.length} model(s): ${models.join(', ') || '(none)'}`);
  const ctxNote = engine.openai ? '(server-side context)' : `numCtx=${numCtx} (Ollama auto-GPU)`;
  console.log(`Capacity: ${cores} cores → maxThreads=${maxThreads}, maxConcurrent=${maxConcurrent}, ${ctxNote}`);
  console.log(`Registering as "${name}" (${ip}) with manager at ${managerUrl} ...`);

  let currentId = await register(managerUrl, name, ip, engine.port, models, capacity);
  console.log(`Registered (id=${currentId}). Polling for jobs... (Ctrl+C to stop)`);

  const heartbeatTimer = setInterval(() => sendHeartbeat(managerUrl, currentId), HEARTBEAT_EVERY);

  async function shutdown() {
    console.log('\nShutting down...');
    clearInterval(heartbeatTimer);
    await deregister(managerUrl, currentId);
    process.exit(0);
  }

  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  // Auto re-register if manager evicts this worker (poll returns 404)
  while (true) {
    await pollLoop(managerUrl, currentId, engine, maxThreads, numCtx);
    console.log('[worker] Evicted by manager — re-registering in 5s...');
    await new Promise(r => setTimeout(r, 5000));
    currentId = await register(managerUrl, name, ip, engine.port, models, capacity);
    console.log(`[worker] Re-registered (id=${currentId}). Resuming poll...`);
  }
}

main();
