'use strict';

const crypto = require('crypto');

// token -> workerId, issued at registration, valid for the worker's lifetime
const workerTokens = new Map();

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Client auth: Bearer CLUSTER_API_KEY on /chat and /v1.
// When the env var is unset the cluster runs open (dev mode) — server.js warns.
function requireApiKey(req, res, next) {
  const key = process.env.CLUSTER_API_KEY;
  if (!key) return next();
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token && safeEqual(token, key)) return next();
  return res.status(401).json({
    error: { message: 'Invalid or missing API key', type: 'authentication_error' },
  });
}

// Registration gate: workers must present WORKER_SHARED_SECRET to join the fleet.
function checkWorkerSecret(req) {
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!secret) return true;
  return safeEqual(String(req.headers['x-worker-secret'] || ''), secret);
}

function issueWorkerToken(workerId) {
  const token = crypto.randomBytes(24).toString('hex');
  workerTokens.set(token, workerId);
  return token;
}

function revokeWorkerTokens(workerId) {
  for (const [token, id] of workerTokens) {
    if (id === workerId) workerTokens.delete(token);
  }
}

// Per-worker token auth on poll/chunk/result/heartbeat/deregister.
// Only enforced when WORKER_SHARED_SECRET is set, so dev setups keep working.
function requireWorkerToken(req, res, next) {
  if (!process.env.WORKER_SHARED_SECRET) return next();
  const token = String(req.headers['x-worker-token'] || '');
  if (token && workerTokens.has(token)) {
    req.workerId = workerTokens.get(token);
    return next();
  }
  return res.status(401).json({ error: 'Invalid or missing worker token' });
}

module.exports = {
  requireApiKey,
  checkWorkerSecret,
  issueWorkerToken,
  revokeWorkerTokens,
  requireWorkerToken,
};
