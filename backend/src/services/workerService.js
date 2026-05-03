'use strict';

const { randomUUID } = require('crypto');

const OLLAMA_TIMEOUT_MS = 300000; // 5 min — slow CPU inference
const HEARTBEAT_TTL_MS  = 30000;  // 30s — worker expires if silent
const SWEEP_INTERVAL_MS = 10000;  // 10s — how often to evict stale workers

// In-memory registry: workerID -> worker object
const workers = new Map();
let currentIndex = 0;

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
