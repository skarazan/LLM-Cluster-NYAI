'use strict';

const express = require('express');
const router  = express.Router();
const { randomUUID } = require('crypto');
const { pickWorker, incInflight, decInflight, sendPromptToWorker, addChunkListener, removeChunkListener, cancelJob } = require('../services/workerService');
const {
  executeSearchTool,
  searchPolicyPrompt,
  wrapToolResult,
  SEARCH_TOOL_SCHEMAS,
  SEARCH_TOOL_NAMES,
} = require('../services/searchService');

const MAX_SEARCH_HOPS = 2;

// Append the search policy to the conversation's system message (or add one).
function injectSearchPolicy(messages) {
  if (messages.length > 0 && messages[0].role === 'system') {
    return [
      { ...messages[0], content: `${messages[0].content}\n\n${searchPolicyPrompt()}` },
      ...messages.slice(1),
    ];
  }
  return [{ role: 'system', content: searchPolicyPrompt() }, ...messages];
}

// POST /chat — smart worker selection with retry/failover (max 3 attempts)
router.post('/', async (req, res) => {
  const { messages, model = 'llama3', tools, requestId, agentMode, preferredWorkerId, enableThinking, webSearch } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Missing required field: messages (must be a non-empty array)' });
  }

  const useSearch = webSearch === true;
  const convoBase = useSearch ? injectSearchPolicy(messages) : messages;
  const mergedTools = useSearch ? [...(tools || []), ...SEARCH_TOOL_SCHEMAS] : tools;

  const tried = new Set();
  let lastErrorMessage = '';
  let lastErrorDetails = null;
  console.log(`[chat] request model=${model} workers=${require('../services/workerService').getAllWorkers().length}`);

  // Set up chunked response once, before the retry loop
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Transfer-Encoding', 'chunked');
  const keepalive = setInterval(() => { try { res.write('\n'); } catch { /* closed */ } }, 30000);

  for (let attempt = 0; attempt < 3; attempt++) {
    const worker = pickWorker(model, tried, preferredWorkerId);
    console.log(`[chat] attempt=${attempt} worker=${worker ? worker.name : 'none'} tried=${[...tried].length}`);
    if (!worker) break;

    incInflight(worker.id);
    const t0 = Date.now();
    let result = null;

    const jobId = requestId || randomUUID();
    const chunkWriter = (content) => {
      try { res.write(JSON.stringify({ chunk: content }) + '\n'); } catch {}
    };
    addChunkListener(jobId, chunkWriter);

    try {
      result = await sendPromptToWorker(worker, convoBase, model, mergedTools, jobId, { agentMode, enableThinking });

      // Manager-side search loop: execute web_search/fetch_url/package_version
      // here (keys + SearXNG live on the manager) and re-prompt the worker.
      // Mixed or client-side tool calls fall through to the client untouched.
      if (useSearch) {
        let convo = convoBase;
        let hops = 0;
        while (
          hops < MAX_SEARCH_HOPS
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
            convo.push({
              role: 'tool',
              tool_call_id: tc.id || '',
              content: wrapToolResult(JSON.stringify(toolOut)),
            });
          }
          const hopJobId = randomUUID();
          addChunkListener(hopJobId, chunkWriter);
          try {
            // Last allowed hop drops the search tools to force a final answer.
            const hopTools = hops >= MAX_SEARCH_HOPS ? tools : mergedTools;
            result = await sendPromptToWorker(worker, convo, model, hopTools, hopJobId, { agentMode, enableThinking });
          } finally {
            removeChunkListener(hopJobId);
          }
        }
      }
    } catch (err) {
      removeChunkListener(jobId);
      decInflight(worker.id);
      console.log(`[chat] worker=${worker.name} error=${err.name}: ${err.message}`);
      lastErrorMessage = err.message;
      lastErrorDetails = err.payload || null;
      if (err.name === 'AbortError') {
        clearInterval(keepalive);
        res.status(504).end(JSON.stringify({
          error: err.message || `Worker ${worker.name} timed out`,
          jobId,
          error_details: err.payload || { retryable: true, stage: 'manager_wait', jobId, status: 'timed_out' },
        }));
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
  return res.status(502).end(JSON.stringify({
    error: lastErrorMessage ? `All workers failed: ${lastErrorMessage}` : 'All workers failed',
    tried: [...tried],
    error_details: lastErrorDetails,
  }));
});

router.post('/cancel', (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId) return res.status(400).json({ error: 'Missing requestId' });
  const ok = cancelJob(requestId);
  res.json({ ok });
});

module.exports = router;
