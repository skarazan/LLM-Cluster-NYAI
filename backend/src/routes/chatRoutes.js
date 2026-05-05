'use strict';

const express = require('express');
const router  = express.Router();
const { pickWorker, incInflight, decInflight, sendPromptToWorker } = require('../services/workerService');

// POST /chat — smart worker selection with retry/failover (max 3 attempts)
router.post('/', async (req, res) => {
  const { messages, model = 'llama3' } = req.body;

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

    try {
      result = await sendPromptToWorker(worker, messages, model);
    } catch (err) {
      decInflight(worker.id);
      if (err.name === 'AbortError') {
        return res.status(504).json({ error: `Worker ${worker.name} timed out` });
      }
      tried.add(worker.id);
      continue; // retry with next worker
    }

    decInflight(worker.id);
    return res.json({
      worker: worker.name,
      model,
      response: result.content,
      tokens: result.tokens,
      ms: Date.now() - t0,
      attempt,
    });
  }

  if (tried.size === 0) {
    return res.status(503).json({ error: 'No workers online' });
  }
  return res.status(502).json({ error: 'All workers failed', tried: [...tried] });
});

module.exports = router;
