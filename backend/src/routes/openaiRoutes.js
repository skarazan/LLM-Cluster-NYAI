'use strict';

const express = require('express');
const router  = express.Router();
const { randomUUID } = require('crypto');
const {
  pickWorker,
  incInflight,
  decInflight,
  sendPromptToWorker,
  addChunkListener,
  removeChunkListener,
  getAllWorkers,
} = require('../services/workerService');

// GET /v1/models — list models available across all workers
router.get('/models', (req, res) => {
  const modelSet = new Set();
  for (const worker of getAllWorkers()) {
    for (const m of worker.models) modelSet.add(m);
  }
  const models = [...modelSet].map(id => ({
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'llm-cluster',
  }));
  res.json({ object: 'list', data: models });
});

// POST /v1/chat/completions — OpenAI-compatible chat endpoint
router.post('/chat/completions', async (req, res) => {
  const {
    model = 'llama3',
    messages,
    stream = false,
    temperature,
    max_tokens,
    top_p,
    stop,
  } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: { message: 'messages must be a non-empty array', type: 'invalid_request_error' },
    });
  }

  const tried = new Set();
  const completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);

  for (let attempt = 0; attempt < 3; attempt++) {
    const worker = pickWorker(model, tried);
    if (!worker) break;

    incInflight(worker.id);
    const jobId = randomUUID();

    if (stream) {
      // --- SSE streaming ---
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      // Send role chunk first (like OpenAI does)
      res.write(`data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`);

      addChunkListener(jobId, (content) => {
        const chunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content }, finish_reason: null }],
        };
        try { res.write(`data: ${JSON.stringify(chunk)}\n\n`); } catch {}
      });

      try {
        const result = await sendPromptToWorker(worker, messages, model, null, jobId, {});
        removeChunkListener(jobId);
        decInflight(worker.id);

        // Send final chunk with finish_reason
        res.write(`data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: result.finish_reason || 'stop' }],
          ...(result.tokens ? {
            usage: {
              prompt_tokens: result.tokens.prompt || 0,
              completion_tokens: result.tokens.response || 0,
              total_tokens: result.tokens.total || 0,
            },
          } : {}),
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      } catch (err) {
        removeChunkListener(jobId);
        decInflight(worker.id);
        tried.add(worker.id);
        if (err.name === 'AbortError') {
          res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'timeout_error' } })}\n\n`);
          res.end();
          return;
        }
        continue;
      }
    } else {
      // --- Non-streaming ---
      try {
        const result = await sendPromptToWorker(worker, messages, model, null, jobId, {});
        decInflight(worker.id);

        res.json({
          id: completionId,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: result.content || '' },
            finish_reason: result.finish_reason || 'stop',
          }],
          usage: {
            prompt_tokens: result.tokens?.prompt || 0,
            completion_tokens: result.tokens?.response || 0,
            total_tokens: result.tokens?.total || 0,
          },
        });
        return;
      } catch (err) {
        decInflight(worker.id);
        tried.add(worker.id);
        if (err.name === 'AbortError') {
          return res.status(504).json({
            error: { message: err.message, type: 'timeout_error' },
          });
        }
        continue;
      }
    }
  }

  // All workers failed or none available
  if (tried.size === 0) {
    return res.status(503).json({
      error: { message: 'No workers online', type: 'server_error' },
    });
  }
  return res.status(502).json({
    error: { message: 'All workers failed', type: 'server_error' },
  });
});

module.exports = router;
