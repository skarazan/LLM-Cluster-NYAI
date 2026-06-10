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
const {
  executeSearchTool,
  searchPolicyPrompt,
  wrapToolResult,
  SEARCH_TOOL_SCHEMAS,
  SEARCH_TOOL_NAMES,
} = require('../services/searchService');

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

  // SSE headers may only be written once; after the first byte streams out we
  // can no longer retry on another worker — we must terminate the stream.
  let sseStarted = false;
  const startSse = () => {
    if (sseStarted) return;
    sseStarted = true;
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
  };
  const endSseWithError = (message, type) => {
    try {
      res.write(`data: ${JSON.stringify({ error: { message, type } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch {}
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const worker = pickWorker(model, tried);
    if (!worker) break;

    incInflight(worker.id);
    const jobId = randomUUID();

    if (stream) {
      // --- SSE streaming ---
      addChunkListener(jobId, (content) => {
        startSse();
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

        startSse();
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
          if (sseStarted) {
            endSseWithError(err.message, 'timeout_error');
          } else {
            res.status(504).json({ error: { message: err.message, type: 'timeout_error' } });
          }
          return;
        }
        // Partial content already streamed from this worker — cannot retry
        // on another worker without duplicating output. Terminate cleanly.
        if (sseStarted) {
          endSseWithError('Worker failed mid-stream', 'server_error');
          return;
        }
        continue;
      }
    } else {
      // --- Non-streaming ---
      try {
        // Extension param web_search: true → manager-side search tool loop.
        const useSearch = req.body.web_search === true;
        let convo = useSearch
          ? (messages[0]?.role === 'system'
            ? [{ ...messages[0], content: `${messages[0].content}\n\n${searchPolicyPrompt()}` }, ...messages.slice(1)]
            : [{ role: 'system', content: searchPolicyPrompt() }, ...messages])
          : messages;
        let result = await sendPromptToWorker(worker, convo, model, useSearch ? SEARCH_TOOL_SCHEMAS : null, jobId, {});
        let hops = 0;
        while (
          useSearch && hops < 2
          && Array.isArray(result.tool_calls)
          && result.tool_calls.length > 0
          && result.tool_calls.every(tc => SEARCH_TOOL_NAMES.has(tc.function?.name))
        ) {
          hops++;
          convo = [...convo, { role: 'assistant', content: result.content || '', tool_calls: result.tool_calls }];
          for (const tc of result.tool_calls) {
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
            const toolOut = await executeSearchTool(tc.function?.name, args);
            convo.push({ role: 'tool', tool_call_id: tc.id || '', content: wrapToolResult(JSON.stringify(toolOut)) });
          }
          result = await sendPromptToWorker(worker, convo, model, hops >= 2 ? null : SEARCH_TOOL_SCHEMAS, randomUUID(), {});
        }
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
