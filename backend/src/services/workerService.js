'use strict';

const { randomUUID } = require('crypto');
const { exec }       = require('child_process');
const util           = require('util');
const execP          = util.promisify(exec);

const HEARTBEAT_TTL_MS  = 30000;
const SWEEP_INTERVAL_MS = 10000;
const JOB_TIMEOUT_MS    = 300000; // 5 min

// In-memory registry
const workers = new Map();

// Job queue: jobId -> { resolve, reject, timer, model, messages, workerId }
const pendingJobs = new Map();

// ---------- Dev-only setup ----------

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

// ---------- Registry ----------

const DEFAULT_CAPACITY = { cores: 4, maxThreads: 2, maxConcurrent: 1 };

function registerWorker({ name, ip, port = 11434, models = [], capacity, version }) {
  const id = randomUUID();
  const worker = {
    id,
    name,
    models,
    lastSeen: Date.now(),
    status: 'online',
    capacity: capacity || DEFAULT_CAPACITY,
    metrics: { cpuPct: 0, loadAvg1: 0 },
    inflight: 0,
    version: version || '1.0',
    // Long-poll queue: pending response objects waiting for a job
    waiters: [],
  };
  workers.set(id, worker);
  console.log(`[registry] registered: ${name} id=${id} threads=${worker.capacity.maxThreads}`);
  return id;
}

function deregisterWorker(id) {
  const worker = workers.get(id);
  if (!worker) return false;
  // Wake any waiting pollers so they exit cleanly
  for (const waiter of worker.waiters) {
    waiter.res.json({ job: null });
  }
  worker.waiters = [];
  workers.delete(id);
  console.log(`[registry] deregistered id=${id}`);
  return true;
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

// Evict stale workers
setInterval(() => {
  const now = Date.now();
  for (const [id, worker] of workers) {
    if (now - worker.lastSeen > HEARTBEAT_TTL_MS) {
      console.log(`[registry] evicting stale worker: ${worker.name} id=${id}`);
      // Fail any jobs assigned to this worker
      for (const [jobId, job] of pendingJobs) {
        if (job.workerId === id) {
          clearTimeout(job.timer);
          job.reject(new Error(`Worker ${worker.name} went offline`));
          pendingJobs.delete(jobId);
        }
      }
      workers.delete(id);
    }
  }
}, SWEEP_INTERVAL_MS);

// ---------- Worker selection ----------

function pickWorker(model, exclude = new Set()) {
  if (workers.size === 0) return null;
  let candidates = Array.from(workers.values()).filter(w => !exclude.has(w.id));
  if (candidates.length === 0) return null;

  const modelFiltered = candidates.filter(w =>
    w.models.length === 0 || w.models.some(m => m.startsWith(model))
  );
  if (modelFiltered.length > 0) candidates = modelFiltered;

  const available = candidates.filter(w => w.inflight < w.capacity.maxConcurrent);
  const pool = available.length > 0 ? available : candidates;

  pool.sort((a, b) => {
    const ratioA = a.inflight / a.capacity.maxConcurrent;
    const ratioB = b.inflight / b.capacity.maxConcurrent;
    if (ratioA !== ratioB) return ratioA - ratioB;
    if (a.metrics.cpuPct !== b.metrics.cpuPct) return a.metrics.cpuPct - b.metrics.cpuPct;
    return a.metrics.loadAvg1 - b.metrics.loadAvg1;
  });

  return pool[0];
}

function getNextWorker() { return pickWorker(''); }
function getAllWorkers()  { return Array.from(workers.values()); }

// ---------- Pull-based job dispatch ----------

// Called by chatRoutes: push a job and wait for the worker to run it
function sendPromptToWorker(worker, messages, model) {
  return new Promise((resolve, reject) => {
    const jobId = randomUUID();

    const timer = setTimeout(() => {
      pendingJobs.delete(jobId);
      decInflight(worker.id);
      const err = new Error(`Worker ${worker.name} timed out`);
      err.name = 'AbortError';
      reject(err);
    }, JOB_TIMEOUT_MS);

    pendingJobs.set(jobId, { resolve, reject, timer, model, messages, workerId: worker.id });

    // Dispatch immediately to a waiting poller, or it will be picked up on next poll
    dispatchToWorker(worker, jobId);
  });
}

// Try to hand the job directly to a waiting long-poll response
function dispatchToWorker(worker, jobId) {
  const job = pendingJobs.get(jobId);
  if (!job) return;

  while (worker.waiters.length > 0) {
    const waiter = worker.waiters.shift();
    // Check waiter hasn't timed out
    if (!waiter.timedOut) {
      waiter.res.json({
        job: {
          id: jobId,
          model: job.model,
          messages: job.messages,
          maxThreads: worker.capacity.maxThreads,
        }
      });
      return;
    }
  }
  // No waiter available — job stays in pendingJobs, worker will pick it up on next poll
}

// Called by workerRoutes: worker is asking for a job (long-poll)
function pollForJob(workerId, res) {
  const worker = workers.get(workerId);
  if (!worker) {
    return res.status(404).json({ error: 'Worker not found' });
  }

  refreshHeartbeat(workerId);

  // Check if there's already a pending job for this worker
  for (const [jobId, job] of pendingJobs) {
    if (job.workerId === workerId) {
      res.json({
        job: {
          id: jobId,
          model: job.model,
          messages: job.messages,
          maxThreads: worker.capacity.maxThreads,
        }
      });
      return;
    }
  }

  // No job yet — long-poll: hold the connection for up to 25s
  const POLL_TIMEOUT = 25000;
  const waiter = { res, timedOut: false };
  worker.waiters.push(waiter);

  const t = setTimeout(() => {
    waiter.timedOut = true;
    const idx = worker.waiters.indexOf(waiter);
    if (idx !== -1) worker.waiters.splice(idx, 1);
    res.json({ job: null }); // no job, worker should poll again
  }, POLL_TIMEOUT);

  // Clean up timer if connection drops
  res.on('close', () => {
    clearTimeout(t);
    waiter.timedOut = true;
    const idx = worker.waiters.indexOf(waiter);
    if (idx !== -1) worker.waiters.splice(idx, 1);
  });
}

// Called by workerRoutes: worker posts the result back
function submitJobResult(jobId, result, error) {
  const job = pendingJobs.get(jobId);
  if (!job) return false; // already timed out or duplicate

  clearTimeout(job.timer);
  pendingJobs.delete(jobId);

  if (error) {
    job.reject(new Error(error));
  } else {
    job.resolve(result);
  }
  return true;
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
  pollForJob,
  submitJobResult,
};
