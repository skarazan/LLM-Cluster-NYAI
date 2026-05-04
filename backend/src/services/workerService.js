'use strict';

const { randomUUID } = require('crypto');
const { exec } = require('child_process');
const util = require('util');
const execP = util.promisify(exec);

const OLLAMA_TIMEOUT_MS = 300000; // 5 min — slow CPU inference
const HEARTBEAT_TTL_MS  = 30000;  // 30s — worker expires if silent
const SWEEP_INTERVAL_MS = 10000;  // 10s — how often to evict stale workers

// In-memory registry: workerID -> worker object
const workers = new Map();
let currentIndex = 0;

// for auto insert of local worker to auto register + install of ollama automatically on local dev machines
const os = require('os');

// Ensure ollama + llama3 model on local dev machines (non-production)
async function ensureOllamaAndLlama3() {
  if (process.env.NODE_ENV === 'production') return;

  try {
    await execP('ollama --version');
    console.log('[setup] ollama CLI detected');
  } catch (err) {
    console.warn('[setup] ollama CLI not found on PATH; skipping model pull. Please install ollama manually: https://ollama.com/docs');
    return;
  }

  // Try a few commands that list available local models and check for 'llama3'
  const listCommands = ['ollama list', 'ollama ls', 'ollama models'];
  let modelsOutput = '';
  for (const cmd of listCommands) {
    try {
      const { stdout } = await execP(cmd);
      modelsOutput = stdout || '';
      break;
    } catch (e) {
      // try the next listing command
    }
  }

  if (modelsOutput.toLowerCase().includes('llama3')) {
    console.log('[setup] llama3 model already present');
    return;
  }

  console.log('[setup] pulling llama3 model via ollama (this may take a while)...');
  try {
    // This will run `ollama pull llama3` to download the model locally
    await execP('ollama pull llama3', { timeout: 0 });
    console.log('[setup] successfully pulled llama3');
  } catch (e) {
    console.error('[setup] failed to pull llama3 via ollama:', e && e.message ? e.message : e);
  }
}

// Run setup in background (don't block module import)
ensureOllamaAndLlama3().catch(err => console.error('[setup] error during ollama setup', err));

// ---------- Registry lifecycle ----------

function registerWorker({ name, ip, port = 11434, models = [] }) {
  const id     = randomUUID();
  const url    = `http://${ip}:${port}`;
  const worker = { id, name, url, models, lastSeen: Date.now(), status: 'online' };
  workers.set(id, worker);
  console.log(`[registry] registered: ${name} (${url}) id=${id}`);
  return id;
}
//auto rehister local worker on startup for dev machines (non-production)
registerWorker({
  name: os.hostname(),
  ip: 'localhost',
  port: 11434,
  models: ['llama3'],
});

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

async function sendPromptToWorker(worker, prompt, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const res = await fetch(`${worker.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Worker ${worker.name} returned HTTP ${res.status}`);
    }

    const data = await res.json();
    return data.response;
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
