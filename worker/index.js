'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { getCpuPct }    = require('./lib/cpuSampler');
const { wrapMessages } = require('./lib/toolPromptWrap');

const OLLAMA_URL      = 'http://localhost:11434';
const HEARTBEAT_EVERY = 15_000; // 15s

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

// ---------- Ollama helpers ----------

async function getLocalModels() {
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/tags`);
  } catch (err) {
    console.error(`Cannot reach Ollama at ${OLLAMA_URL}. Is it running?`);
    console.error(err.message);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Ollama responded with HTTP ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
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

async function register(managerUrl, name, ip, models, capacity) {
  let res;
  try {
    res = await fetch(`${managerUrl}/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ip, port: 11434, models, capacity, version: '2.0' }),
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

async function runJob(job, maxThreads) {
  const messages = wrapMessages(job.messages, job.tools);

  // Let Ollama auto-decide GPU offload based on available VRAM.
  // Setting num_gpu manually risks OOM (too high) or slow inference (too low).
  const body = {
    model: job.model,
    messages,
    stream: false,
    options: { num_thread: maxThreads },
  };
  if (job.tools && job.tools.length > 0) body.tools = job.tools;

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${errBody.slice(0, 500)}`);
  }
  const data = await res.json();

  // Ollama may return tool_calls instead of (or alongside) message.content
  const toolCalls = data.message?.tool_calls || null;
  const content   = data.message?.content || '';

  if (!toolCalls && !content) throw new Error('Unexpected Ollama response shape');

  const result = {
    content,
    tokens: {
      prompt:       data.prompt_eval_count || 0,
      response:     data.eval_count        || 0,
      total:        (data.prompt_eval_count || 0) + (data.eval_count || 0),
      tokensPerSec: data.eval_duration
        ? Math.round((data.eval_count / (data.eval_duration / 1e9)) * 10) / 10
        : null,
    },
  };
  if (toolCalls) result.tool_calls = toolCalls;
  return result;
}

// ---------- Poll loop ----------

async function pollLoop(managerUrl, id, maxThreads) {
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

    let result = null;
    let error  = null;
    try {
      result = await runJob(job, maxThreads);
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

  const cores         = os.cpus().length;
  const maxThreads    = config.maxThreads    || Math.max(2, Math.floor(cores / 2));
  const maxConcurrent = config.maxConcurrent || 1;
  const capacity      = { cores, maxThreads, maxConcurrent };

  const managerUrl = await getManagerUrl(config);
  const models     = await getLocalModels();
  const ip         = getLocalIp();
  const name       = config.name || os.hostname();

  console.log(`Detected ${models.length} model(s): ${models.join(', ') || '(none)'}`);
  console.log(`Capacity: ${cores} cores → maxThreads=${maxThreads}, maxConcurrent=${maxConcurrent} (Ollama auto-GPU)`);
  console.log(`Registering as "${name}" (${ip}) with manager at ${managerUrl} ...`);

  const id = await register(managerUrl, name, ip, models, capacity);
  console.log(`[worker] v2.2 — chunked-keepalive poll`);
  console.log(`Registered (id=${id}). Polling for jobs... (Ctrl+C to stop)`);

  const heartbeatTimer = setInterval(() => sendHeartbeat(managerUrl, id), HEARTBEAT_EVERY);

  async function shutdown() {
    console.log('\nShutting down...');
    clearInterval(heartbeatTimer);
    await deregister(managerUrl, id);
    process.exit(0);
  }

  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  await pollLoop(managerUrl, id, maxThreads);
}

main();
