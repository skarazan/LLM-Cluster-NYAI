const express = require('express');
const router = express.Router();
const { getNextWorker, sendPromptToWorker } = require('../services/workerService');

// POST /chat — each request gets its own worker, own response, own error handling
router.post('/', async (req, res) => {
  const { prompt, model = 'llama3' } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Missing required field: prompt' });
  }

  const worker = getNextWorker();
  if (!worker) {
    return res.status(503).json({ error: 'No workers online' });
  }

  try {
    const response = await sendPromptToWorker(worker, prompt, model);
    res.json({ worker: worker.name, model, response });
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: `Worker ${worker.name} timed out` });
    }
    return res.status(502).json({ error: `Worker ${worker.name} failed: ${err.message}` });
  }
});

module.exports = router;
