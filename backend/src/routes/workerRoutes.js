'use strict';

const express = require('express');
const router  = express.Router();
const {
  getAllWorkers,
  registerWorker,
  deregisterWorker,
  refreshHeartbeat,
  pollForJob,
  submitJobResult,
  emitChunk,
} = require('../services/workerService');

// GET /workers — lists all registered workers (strip non-serializable internals)
router.get('/', (req, res) => {
  const workers = getAllWorkers().map(({ id, name, ip, models, status, capacity, metrics, inflight, version, lastSeen }) => ({
    id, name, ip, models, status, capacity, metrics, inflight, version, lastSeen,
  }));
  res.json({ workers });
});

// POST /workers/register — worker self-registers on startup
router.post('/register', (req, res) => {
  const { name, ip, port, models, capacity, version } = req.body;
  if (!name || !ip) {
    return res.status(400).json({ error: 'Missing required fields: name, ip' });
  }
  const id = registerWorker({ name, ip, port, models, capacity, version });
  res.status(201).json({ id });
});

// POST /workers/heartbeat — worker keeps its registration alive
router.post('/heartbeat', (req, res) => {
  const { id, metrics } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing required field: id' });
  const ok = refreshHeartbeat(id, metrics);
  if (!ok) return res.status(404).json({ error: 'Worker not found' });
  res.json({ ok: true });
});

// DELETE /workers/deregister — worker removes itself cleanly on shutdown
router.delete('/deregister', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing required field: id' });
  const ok = deregisterWorker(id);
  if (!ok) return res.status(404).json({ error: 'Worker not found' });
  res.json({ ok: true });
});

// GET /workers/poll/:id — worker long-polls for a job (pull-based dispatch)
router.get('/poll/:id', (req, res) => {
  pollForJob(req.params.id, res);
});

// POST /workers/chunk — worker forwards a streaming token chunk
router.post('/chunk', (req, res) => {
  const { jobId, content } = req.body;
  if (jobId && content) emitChunk(jobId, content);
  res.json({ ok: true });
});

// POST /workers/result — worker submits completed job result
router.post('/result', (req, res) => {
  const { jobId, result, error } = req.body;
  if (!jobId) return res.status(400).json({ error: 'Missing jobId' });
  const ok = submitJobResult(jobId, result, error);
  if (!ok) return res.status(404).json({ error: 'Job not found or already timed out' });
  res.json({ ok: true });
});

module.exports = router;
