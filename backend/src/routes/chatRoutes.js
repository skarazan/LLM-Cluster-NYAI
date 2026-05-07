'use strict';

const express = require('express');
const router  = express.Router();
const { pickWorker, incInflight, decInflight, sendPromptToWorker } = require('../services/workerService');

// POST /chat — smart worker selection with retry/failover (max 3 attempts)
router.post('/', async (req, res) => {
  const { messages, model = 'llama3', tools } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Missing required field: messages (must be a non-empty array)' });
  }

  const tried = new Set();

  for (let attempt = 0; attempt < 3; attempt++) {
    const worker = pickWorker(model, tried);
    if (!worker) break;

    incInflight(worker.id);
    const t0 = Date.now();
    let result = null;

    // Send periodic newline keepalives so Cloudflare doesn't close the connection
    // on long-running model inference (>100s). The client reads the full body as
    // text, trims it, then JSON.parses — leading/trailing newlines are harmless.
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');
    const keepalive = setInterval(() => { try { res.write('\n'); } catch { /* closed */ } }, 30000);

    try {
      result = await sendPromptToWorker(worker, messages, model, tools);
    } catch (err) {
      clearInterval(keepalive);
      decInflight(worker.id);
      if (err.name === 'AbortError') {
        res.end(JSON.stringify({ error: `Worker ${worker.name} timed out` }));
        return;
      }
      tried.add(worker.id);
      continue; // retry with next worker
    }

    clearInterval(keepalive);
    decInflight(worker.id);
    const resp = {
      worker: worker.name,
      model,
      response: result.content,
      tokens: result.tokens,
      ms: Date.now() - t0,
      attempt,
    };
    if (result.tool_calls) resp.tool_calls = result.tool_calls;
    res.end(JSON.stringify(resp));
    return;
  }

  if (tried.size === 0) {
    if (!res.headersSent) res.status(503);
    return res.end(JSON.stringify({ error: 'No workers online' }));
  }
  if (!res.headersSent) res.status(502);
  return res.end(JSON.stringify({ error: 'All workers failed', tried: [...tried] }));
});

module.exports = router;
