'use strict';

const { randomUUID } = require('crypto');
const { exec }       = require('child_process');
const util           = require('util');
const os             = require('os');
const execP          = util.promisify(exec);

const OLLAMA_TIMEOUT_MS = 300000; // 5 min — slow CPU inference
const HEARTBEAT_TTL_MS  = 30000;  // 30s — worker expires if silent
const SWEEP_INTERVAL_MS = 10000;  // 10s — how often to evict stale workers

// In-memory registry: workerID -> worker object
const workers = new Map();

// ---------- Dev-only: ensure Ollama + llama3 present on local machine ----------

async function ensureOllamaAndLlama3() {
  if (process.env.NODE_ENV === 'production') return;

  try {
    await execP('ollama --version');
    console.log('[setup] ollama CLI detected');
  } catch {
    console.warn('[setup] ollama not found on PATH — install from https://ollama.com');
    return;
  }

  let modelsOutput = '';
  for (const cmd of ['ollama list', 'ollama ls']) {
    try { ({ stdout: modelsOutput } = await execP(cmd)); break; } catch { /* try next */ }
  }

  if (modelsOutput.toLowerCase().includes('llama3')) {
    console.log('[setup] llama3 already present');
    return;
  }

  console.log('[setup] pulling llama3 (this may take a while)...');
  try {
    await execP('ollama pull llama3', { timeout: 0 });
    console.log('[setup] llama3 pulled');
  } catch (e) {
    console.error('[setup] pull failed:', e.message);
  }
}

ensureOllamaAndLlama3().catch(err => console.error('[setup] error:', err));

// ---------- Registry lifecycle ----------

const DEFAULT_CAPACITY = { cores: 4, maxThreads: 2, maxConcurrent: 1 };

function registerWorker({ name, ip, port = 11434, models = [], capacity, version }) {
  const id     = randomUUID();
  const url    = `http://${ip}:${port}`;
  const worker = {
    id,
    name,
    url,
    models,
    lastSeen: Date.now(),
    status: 'online',
    capacity: capacity || DEFAULT_CAPACITY,
    metrics: { cpuPct: 0, loadAvg1: 0 },
    inflight: 0,
    version: version || '1.0',
  };
  workers.set(id, worker);
  console.log(`[registry] registered: ${name} (${url}) id=${id} threads=${worker.capacity.maxThreads}`);
  return id;
}

function deregisterWorker(id) {
  const had = workers.has(id);
  workers.delete(id);
  if (had) console.log(`[registry] deregistered id=${id}`);
  return had;
}

function refreshHeartbeat(id, metrics) {
  const worker = workers.get(id);
  if (!worker) return false;
  worker.lastSeen = Date.now();
  if (metrics) {
    worker.metrics.cpuPct   = metrics.cpuPct   ?? worker.metrics.cpuPct;
    worker.metrics.loadAvg1 = metrics.loadAvg1 ?? worker.metrics.loadAvg1;
  }
  return true;
}

function incInflight(id) {
  const w = workers.get(id);
  if (w) w.inflight++;
}

function decInflight(id) {
  const w = workers.get(id);
  if (w && w.inflight > 0) w.inflight--;
}

// Background sweep — evict workers that have gone silent
setInterval(() => {
  const now = Date.now();
  for (const [id, worker] of workers) {
    if (now - worker.lastSeen > HEARTBEAT_TTL_MS) {
      console.log(`[registry] evicting stale worker: ${worker.name} id=${id}`);
      workers.delete(id);
    }
  }
}, SWEEP_INTERVAL_MS);

// ---------- Worker selection ----------

function pickWorker(model, exclude = new Set()) {
  if (workers.size === 0) return null;

  let candidates = Array.from(workers.values()).filter(w => !exclude.has(w.id));
  if (candidates.length === 0) return null;

  // Filter by model if the worker has a model list; skip filter if list is empty (old worker)
  const modelFiltered = candidates.filter(w =>
    w.models.length === 0 || w.models.some(m => m.startsWith(model))
  );
  if (modelFiltered.length > 0) candidates = modelFiltered;

  // Prefer non-saturated workers; if all saturated fall through to least-loaded
  const available = candidates.filter(w => w.inflight < w.capacity.maxConcurrent);
  const pool = available.length > 0 ? available : candidates;

  // Sort: lowest load ratio → lowest cpu% → lowest loadAvg1
  pool.sort((a, b) => {
    const ratioA = a.inflight / a.capacity.maxConcurrent;
    const ratioB = b.inflight / b.capacity.maxConcurrent;
    if (ratioA !== ratioB) return ratioA - ratioB;
    if (a.metrics.cpuPct !== b.metrics.cpuPct) return a.metrics.cpuPct - b.metrics.cpuPct;
    return a.metrics.loadAvg1 - b.metrics.loadAvg1;
  });

  return pool[0];
}

// Backward-compat alias
function getNextWorker() {
  return pickWorker('');
}

function getAllWorkers() {
  return Array.from(workers.values());
}

// ---------- Ollama call ----------

async function sendPromptToWorker(worker, messages, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const res = await fetch(`${worker.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: { num_thread: worker.capacity.maxThreads },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Worker ${worker.name} returned HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.message || typeof data.message.content !== 'string') {
      throw new Error(`Worker ${worker.name} returned unexpected response shape (missing message.content)`);
    }

    return {
      content: data.message.content,
      tokens: {
        prompt:       data.prompt_eval_count || 0,
        response:     data.eval_count        || 0,
        total:        (data.prompt_eval_count || 0) + (data.eval_count || 0),
        tokensPerSec: data.eval_duration
          ? Math.round((data.eval_count / (data.eval_duration / 1e9)) * 10) / 10
          : null,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  registerWorker,
  deregisterWorker,
  refreshHeartbeat,
  incInflight,
  decInflight,
  pickWorker,
  getNextWorker,
  getAllWorkers,
  sendPromptToWorker,
};
