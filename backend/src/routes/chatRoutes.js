'use strict';

const express = require('express');
const router  = express.Router();
const { randomUUID } = require('crypto');
const { pickWorker, incInflight, decInflight, sendPromptToWorker, addChunkListener, removeChunkListener, cancelJob } = require('../services/workerService');

// POST /chat — smart worker selection with retry/failover (max 3 attempts)
router.post('/', async (req, res) => {
  const { messages, model = 'llama3', tools, requestId, agentMode } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Missing required field: messages (must be a non-empty array)' });
  }

  const tried = new Set();
  console.log(`[chat] request model=${model} workers=${require('../services/workerService').getAllWorkers().length}`);

  // Set up chunked response once, before the retry loop
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  const keepalive = setInterval(() => { try { res.write('\n'); } catch { /* closed */ } }, 30000);

  for (let attempt = 0; attempt < 3; attempt++) {
    const worker = pickWorker(model, tried);
    console.log(`[chat] attempt=${attempt} worker=${worker ? worker.name : 'none'} tried=${[...tried].length}`);
    if (!worker) break;

    incInflight(worker.id);
    const t0 = Date.now();
    let result = null;

    const jobId = requestId || randomUUID();
    addChunkListener(jobId, (content) => {
      try { res.write(JSON.stringify({ chunk: content }) + '\n'); } catch {}
    });

    try {
      result = await sendPromptToWorker(worker, messages, model, tools, jobId, { agentMode });
    } catch (err) {
      removeChunkListener(jobId);
      decInflight(worker.id);
      console.log(`[chat] worker=${worker.name} error=${err.name}: ${err.message}`);
      if (err.name === 'AbortError') {
        clearInterval(keepalive);
        res.status(504).end(JSON.stringify({ error: err.message || `Worker ${worker.name} timed out` }));
        return;
      }
      tried.add(worker.id);
      continue; // retry with next worker
    }

    clearInterval(keepalive);
    removeChunkListener(jobId);
    decInflight(worker.id);
    const resp = {
      worker: worker.name,
      model,
      response: result.content,
      tokens: result.tokens,
      finish_reason: result.finish_reason || null,
      ms: Date.now() - t0,
      attempt,
    };
    if (result.tool_calls) resp.tool_calls = result.tool_calls;
    res.end(JSON.stringify(resp));
    return;
  }

  clearInterval(keepalive);
  if (tried.size === 0) {
    return res.status(503).end(JSON.stringify({ error: 'No workers online' }));
  }
  return res.status(502).end(JSON.stringify({ error: 'All workers failed', tried: [...tried] }));
});

router.post('/cancel', (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId) return res.status(400).json({ error: 'Missing requestId' });
  const ok = cancelJob(requestId);
  res.json({ ok });
});

module.exports = router;
