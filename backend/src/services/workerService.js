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
let currentIndex = 0;

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

function registerWorker({ name, ip, port = 11434, models = [] }) {
  const id     = randomUUID();
  const url    = `http://${ip}:${port}`;
  const worker = { id, name, url, models, lastSeen: Date.now(), status: 'online' };
  workers.set(id, worker);
  console.log(`[registry] registered: ${name} (${url}) id=${id}`);
  return id;
}

function deregisterWorker(id) {
  const had = workers.has(id);
  workers.delete(id);
  if (had) console.log(`[registry] deregistered id=${id}`);
  return had;
}

function refreshHeartbeat(id) {
  const worker = workers.get(id);
  if (!worker) return false;
  worker.lastSeen = Date.now();
  return true;
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

// ---------- Existing public interface (unchanged contract) ----------

function getNextWorker() {
  if (workers.size === 0) return null;
  const online = Array.from(workers.values());
  const worker = online[currentIndex % online.length];
  currentIndex = (currentIndex + 1) % online.length;
  return worker;
}

function getAllWorkers() {
  return Array.from(workers.values());
}

async function sendPromptToWorker(worker, messages, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const res = await fetch(`${worker.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Worker ${worker.name} returned HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!data.message || typeof data.message.content !== 'string') {
      throw new Error(`Worker ${worker.name} returned unexpected response shape (missing message.content)`);
    }
    return data.message.content;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  registerWorker,
  deregisterWorker,
  refreshHeartbeat,
  getNextWorker,
  getAllWorkers,
  sendPromptToWorker,
};
