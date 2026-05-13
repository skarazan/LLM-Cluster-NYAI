'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const { getCpuPct }    = require('./lib/cpuSampler');
const { wrapMessages } = require('./lib/toolPromptWrap');

const HEARTBEAT_EVERY = 15_000; // 15s

// Engine types and their default endpoints
const ENGINE_DEFAULTS = {
  ollama:    { url: 'http://localhost:11434', port: 11434 },
  llamacpp:  { url: 'http://localhost:8080',  port: 8080  },
  lmstudio:  { url: 'http://localhost:1234',  port: 1234  },
  vllm:      { url: 'http://localhost:8000',  port: 8000  },
};
const OPENAI_SHAPE = new Set(['llamacpp', 'lmstudio', 'vllm']);

function resolveEngine(config) {
  const type = (config.engineType || process.env.LLM_ENGINE_TYPE || 'ollama').toLowerCase();
  const defaults = ENGINE_DEFAULTS[type] || ENGINE_DEFAULTS.ollama;
  const url     = (config.engineUrl    || process.env.LLM_ENGINE_URL    || defaults.url).replace(/\/$/, '');
  const port    = config.enginePort   || process.env.LLM_ENGINE_PORT    || defaults.port;
  const apiKey  = config.engineApiKey || process.env.LLM_ENGINE_API_KEY || '';
  return { type, url, port: Number(port), apiKey, openai: OPENAI_SHAPE.has(type) };
}

function authHeaders(engine) {
  return engine.apiKey ? { Authorization: `Bearer ${engine.apiKey}` } : {};
}

// ---------- Config loader ----------

function loadConfig() {
  const configPath = path.join(os.homedir(), '.llm-cluster-worker.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn(`[config] Could not read ${configPath}: ${err.message}`);
  }
  return {};
}

// ---------- Manager URL ----------

async function getManagerUrl(config) {
  if (process.argv[2]) return process.argv[2].replace(/\/$/, '');
  if (process.env.LLM_MANAGER_URL) return process.env.LLM_MANAGER_URL.replace(/\/$/, '');
  if (config.preferredManager) return config.preferredManager.replace(/\/$/, '');

  // mDNS discovery
  try {
    const { Bonjour } = require('bonjour-service');
    const b = new Bonjour();
    const found = await new Promise((resolve) => {
      const list = [];
      const browser = b.find({ type: 'llmcluster' }, (svc) => {
        const addr = (svc.addresses || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
        if (addr) list.push(`http://${addr}:${svc.port}`);
      });
      setTimeout(() => { browser.stop(); b.destroy(); resolve(list); }, 3000);
    });
    if (found.length >= 1) {
      console.log(`[discovery] Found manager via mDNS: ${found[0]}`);
      return found[0];
    }
  } catch { /* bonjour not available */ }

  // Default public URL
  const defaultUrl = 'https://llm.tutorrev.live';
  console.log(`[discovery] Using default manager URL: ${defaultUrl}`);
  return defaultUrl;
}

// ---------- Engine helpers ----------

async function getLocalModels(engine) {
  const url = engine.openai ? `${engine.url}/v1/models` : `${engine.url}/api/tags`;
  let res;
  try {
    res = await fetch(url, { headers: authHeaders(engine) });
  } catch (err) {
    console.error(`Cannot reach ${engine.type} at ${engine.url}. Is it running?`);
    console.error(err.message);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`${engine.type} responded with HTTP ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  if (engine.openai) {
    return (data.data || []).map((m) => m.id);
  }
  return (data.models || []).map((m) => m.name);
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

// ---------- Manager communication ----------

async function register(managerUrl, name, ip, port, models, capacity) {
  const stableId = `${name}@${ip}:${port}`;
  let res;
  try {
    res = await fetch(`${managerUrl}/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ip, port, models, capacity, version: '3.0', stableId }),
    });
  } catch (err) {
    console.error(`Cannot reach manager at ${managerUrl}.`);
    console.error(err.message);
    process.exit(1);
  }
  if (!res.ok) {
    const body = await res.text();
    console.error(`Registration failed (HTTP ${res.status}): ${body}`);
    process.exit(1);
  }
  const data = await res.json();
  return data.id;
}

async function sendHeartbeat(managerUrl, id) {
  getCpuPct();
  await new Promise(r => setTimeout(r, 1000));
  const cpuPct   = getCpuPct();
  const loadAvg1 = os.loadavg()[0];
  try {
    const res = await fetch(`${managerUrl}/workers/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, metrics: { cpuPct, loadAvg1 } }),
    });
    if (!res.ok) console.warn(`[heartbeat] manager responded ${res.status}`);
  } catch (err) {
    console.warn(`[heartbeat] failed: ${err.message}`);
  }
}

async function sendJobHeartbeat(managerUrl, workerId, jobId, stage = 'running') {
  try {
    const res = await fetch(`${managerUrl}/workers/job-heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId, jobId, stage }),
    });
    if (!res.ok && res.status !== 404) console.warn(`[job-heartbeat] manager responded ${res.status}`);
  } catch (err) {
    console.warn(`[job-heartbeat] failed: ${err.message}`);
  }
}

async function deregister(managerUrl, id) {
  try {
    await fetch(`${managerUrl}/workers/deregister`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    console.log('Deregistered from manager. Goodbye.');
  } catch (err) {
    console.warn(`Could not reach manager to deregister: ${err.message}`);
  }
}

// ---------- Job execution ----------

async function runJob(job, engine, maxThreads, numCtx, onChunk) {
  const messages = wrapMessages(job.messages, job.tools);
  const startMs = Date.now();
  const isCodeAgent = job.agentMode === 'code';
  const sampling = {
    temperature: isCodeAgent
      ? Number(process.env.LLM_CODE_TEMPERATURE || 0.35)
      : Number(process.env.LLM_CHAT_TEMPERATURE || 0.65),
    topP: isCodeAgent
      ? Number(process.env.LLM_CODE_TOP_P || 0.9)
      : Number(process.env.LLM_CHAT_TOP_P || 0.9),
    topK: isCodeAgent
      ? Number(process.env.LLM_CODE_TOP_K || 30)
      : Number(process.env.LLM_CHAT_TOP_K || 40),
    presencePenalty: isCodeAgent
      ? Number(process.env.LLM_CODE_PRESENCE_PENALTY || 0.4)
      : Number(process.env.LLM_CHAT_PRESENCE_PENALTY || 0.2),
    repeatPenalty: isCodeAgent
      ? Number(process.env.LLM_CODE_REPEAT_PENALTY || 1.15)
      : Number(process.env.LLM_CHAT_REPEAT_PENALTY || 1.1),
  };

  // ── Debug: audit the message array being sent ──────────────────────
  const msgSummary = messages.map((m, i) => {
    const toolCallIds = m.tool_calls ? m.tool_calls.map(tc => tc.function?.name || tc.id).join(',') : null;
    const toolId = m.tool_call_id || null;
    return `  [${i}] role=${m.role}` +
      (m.content ? ` content=${String(m.content).slice(0, 60).replace(/\n/g, '↵')}` : '') +
      (toolCallIds ? ` tool_calls=[${toolCallIds}]` : '') +
      (toolId ? ` tool_call_id=${toolId}` : '');
  }).join('\n');
  console.log(`[job] sending ${messages.length} messages to ${engine.type}:\n${msgSummary}`);
  console.log(`[job] tools=${job.tools?.length || 0} model=${job.model}`);

  let url, body;
  let requestedMaxTokens = null;
  if (engine.openai) {
    url = `${engine.url}/v1/chat/completions`;
    const hasTools = job.tools && job.tools.length > 0;
    const maxTokens = isCodeAgent
      ? Number(process.env.LLM_CODE_MAX_TOKENS || 8192)
      : Number(process.env.LLM_CHAT_MAX_TOKENS || -1);
    requestedMaxTokens = maxTokens;
    body = {
      model: job.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: maxTokens,
      temperature: sampling.temperature,
      top_p: sampling.topP,
      top_k: sampling.topK,
      presence_penalty: sampling.presencePenalty,
      frequency_penalty: 0,
      repeat_penalty: sampling.repeatPenalty,
      cache_prompt: process.env.LLM_CACHE_PROMPT === '1',
    };
    if (hasTools) {
      body.tools = job.tools;
      body.tool_choice = 'auto';
    }
    if (isCodeAgent || hasTools) {
      // Qwen3 respects this via chat_template_kwargs. Keep it off for all
      // agent steps, including text-only file blocks, so output tokens go to
      // actions instead of hidden reasoning.
      body.chat_template_kwargs = { enable_thinking: false };
    }
  } else {
    url = `${engine.url}/api/chat`;
    body = {
      model: job.model,
      messages,
      stream: false,
      options: {
        num_thread: maxThreads,
        num_ctx: numCtx,
        temperature: sampling.temperature,
        top_p: sampling.topP,
        top_k: sampling.topK,
        repeat_penalty: sampling.repeatPenalty,
        presence_penalty: sampling.presencePenalty,
        num_predict: isCodeAgent ? Number(process.env.LLM_CODE_MAX_TOKENS || 8192) : -1,
      },
    };
    if (job.tools && job.tools.length > 0) body.tools = job.tools;
  }

  console.log(`[job] POST ${url}`);

  const inferenceAbort = new AbortController();
  const inferenceTimer = setTimeout(() => {
    console.error('[job] inference timeout (10 min) — aborting');
    inferenceAbort.abort();
  }, 600_000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(engine) },
      body: JSON.stringify(body),
      signal: inferenceAbort.signal,
    });
  } catch (fetchErr) {
    clearTimeout(inferenceTimer);
    const reason = fetchErr.name === 'AbortError' ? 'timeout after 10 min' : fetchErr.message;
    const err = new Error(`[job] fetch to ${engine.type} failed: ${reason}`);
    err.payload = {
      retryable: true,
      stage: fetchErr.name === 'AbortError' ? 'inference_timeout' : 'inference_fetch',
      jobId: job.id,
      status: 'timed_out',
      engine: engine.type,
    };
    throw err;
  } finally {
    clearTimeout(inferenceTimer);
  }

  console.log(`[job] ${engine.type} responded HTTP ${res.status}`);

  if (!res.ok) {
    const errBody = await res.text().catch(() => '(unreadable)');
    console.error(`[job] ${engine.type} error body: ${errBody.slice(0, 1000)}`);

    // llama.cpp returns 500 when tool call args JSON is too long / truncated.
    // Try to salvage partial content from the error so the client can write what exists.
    if (res.status === 500 && errBody.includes('Failed to parse tool call arguments')) {
      console.warn('[job] tool call args too large for llama.cpp JSON parser — attempting to salvage');

      // Try to extract path and partial content from the truncated JSON in error
      let salvaged = null;
      try {
        const lastReadMatch = errBody.match(/last read:\s*'([^]*)'/);
        const rawPartial = lastReadMatch ? lastReadMatch[1] : '';
        // The error contains the raw JSON string the model was generating
        // Try to find path and content fields
        const pathMatch = errBody.match(/"path"\s*:\s*"([^"]+)"/);
        const fnMatch = errBody.match(/"name"\s*:\s*"(write_file|append_file)"/);
        if (pathMatch && fnMatch) {
          salvaged = { tool: fnMatch[1], path: pathMatch[1] };
          console.log(`[job] salvaged tool=${salvaged.tool} path=${salvaged.path}`);
        }
      } catch (e) {
        console.warn('[job] salvage parse failed:', e.message);
      }

      const hint = salvaged
        ? `\nThe model was trying to ${salvaged.tool}("${salvaged.path}") but the JSON parser crashed on escaped quotes.`
        : '';

      const isHtml = errBody.includes('DOCTYPE') || errBody.includes('<html') || (salvaged && salvaged.path && /\.html?$/i.test(salvaged.path));

      const htmlFix = isHtml
        ? `\nCRITICAL: HTML attributes with double quotes (charset="UTF-8") CRASH the JSON parser. Use SINGLE QUOTES for ALL HTML attributes: charset='UTF-8', name='viewport', etc.`
        : '';

      const startTag = salvaged?.path ? `\nStart with: <${salvaged.tool} path="${salvaged.path}">` : '';
      const endTag = salvaged?.tool ? `\nEnd with: </${salvaged.tool}>` : '';

      return {
        content: `ERROR: Native tool-call JSON was truncated.${hint}${htmlFix}\nYou MUST stop using JSON tool calls for file contents. Continue by outputting exactly one plain text file block with the real absolute target path from the workspace/task.${startTag}\nThen write the complete real source code for that file.${endTag}\nIf no path is shown above, use the exact pending file path from the current workspace/task state. For appends, use the same pattern with append_file opening and closing tags.\nNever write placeholder paths or placeholder body text. Do not call write_file or append_file as tools.`,
        tool_calls: null,
        tokens: { prompt: 0, response: 0, total: 0, tokensPerSec: null },
      };
    }

    const err = new Error(`${engine.type} HTTP ${res.status}: ${errBody.slice(0, 500)}`);
    err.payload = { retryable: res.status >= 500, stage: 'inference_http', jobId: job.id, status: 'failed', httpStatus: res.status };
    throw err;
  }

  let content, toolCalls, tokens, finishReason = null;
  let streamMeta = null;

  if (engine.openai) {
    // --- SSE stream reader ---
    let accumulated = '';
    const toolCallsMap = {};
    let promptTokens = 0, completionTokens = 0;
    let sseEventCount = 0;
    let sseErrors = [];

    process.stdout.write('\n[stream] ');
    const reader = res.body;
    const decoder = new TextDecoder();
    let buf = '';

    for await (const chunk of reader) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(raw); } catch (e) {
          console.warn(`[stream] failed to parse SSE line: ${line.slice(0, 200)}`);
          continue;
        }
        sseEventCount++;

        // llama-server sends error events as { error: "..." }
        if (evt.error) {
          const errStr = typeof evt.error === 'string' ? evt.error : JSON.stringify(evt.error);
          sseErrors.push(errStr);
          console.error(`[stream] SSE error event: ${errStr}`);
          continue;
        }

        // usage chunk (sent with stream_options.include_usage: true)
        if (evt.usage) {
          promptTokens     = evt.usage.prompt_tokens     || 0;
          completionTokens = evt.usage.completion_tokens || 0;
        }

        const choice = evt.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (!delta) continue;

        if (delta.content) {
          accumulated += delta.content;
          process.stdout.write(delta.content);
          if (onChunk) onChunk(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsMap[idx]) {
              toolCallsMap[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
            }
            const t = toolCallsMap[idx];
            if (tc.id)                  t.id                  = tc.id;
            if (tc.function?.name)      t.function.name      += tc.function.name;
            if (tc.function?.arguments) t.function.arguments += tc.function.arguments;
          }
        }
      }
    }
    process.stdout.write('\n[stream end]\n');

    console.log(`[stream] sseEvents=${sseEventCount} finishReason=${finishReason} contentLen=${accumulated.length} toolCallsBuilt=${Object.keys(toolCallsMap).length} promptTokens=${promptTokens} completionTokens=${completionTokens}`);
    if (sseErrors.length) {
      const joined = sseErrors.join(' | ');
      console.error(`[stream] ${sseErrors.length} SSE error(s): ${joined}`);
      const contextShiftDisabled = /context shift is disabled/i.test(joined);
      streamMeta = {
        errors: sseErrors.slice(-3),
        contextShiftDisabled,
      };
      if (contextShiftDisabled && !finishReason) finishReason = 'context_shift_disabled';
    }

    content   = accumulated;
    const built = Object.values(toolCallsMap);
    toolCalls = built.length ? built : null;

    if (sseErrors.length && !content && !toolCalls) {
      const err = new Error(`${engine.type} stream error: ${sseErrors.join(' | ').slice(0, 500)}`);
      err.payload = {
        retryable: true,
        stage: 'inference_stream',
        jobId: job.id,
        status: 'failed',
        stream: streamMeta || null,
      };
      throw err;
    }

    if (toolCalls) {
      console.log(`[stream] tool_calls: ${toolCalls.map(tc => `${tc.function.name}(${tc.function.arguments.slice(0, 80)})`).join(', ')}`);
    }

    const elapsedSec = (Date.now() - startMs) / 1000;
    tokens = {
      prompt:       promptTokens,
      response:     completionTokens,
      total:        promptTokens + completionTokens,
      tokensPerSec: (completionTokens && elapsedSec > 0)
        ? Math.round((completionTokens / elapsedSec) * 10) / 10
        : null,
      };
    if (
      Number.isFinite(requestedMaxTokens) &&
      requestedMaxTokens > 0 &&
      completionTokens >= requestedMaxTokens &&
      (!finishReason || String(finishReason).toLowerCase() === 'stop')
    ) {
      finishReason = 'length';
    }
  } else {
    const data = await res.json();
    toolCalls = data.message?.tool_calls || null;
    content   = data.message?.content    || '';
    finishReason = data.done_reason || (data.done ? 'stop' : null);
    tokens = {
      prompt:       data.prompt_eval_count || 0,
      response:     data.eval_count        || 0,
      total:        (data.prompt_eval_count || 0) + (data.eval_count || 0),
      tokensPerSec: data.eval_duration
        ? Math.round((data.eval_count / (data.eval_duration / 1e9)) * 10) / 10
        : null,
    };
  }

  if (!toolCalls && !content) {
    // Model may have generated only thinking tokens (<think>...</think>) with no visible output.
    // Return empty content instead of crashing — agent loop will handle it.
    console.warn(`[job] empty response (no content, no tool_calls). completionTokens=${tokens.response}. Likely thinking-only output.`);
    content = '';
  }

  const result = { content, tokens };
  if (finishReason) result.finish_reason = finishReason;
  if (streamMeta) result.stream = streamMeta;
  if (toolCalls) result.tool_calls = toolCalls;
  return result;
}

async function submitResultWithRetry(managerUrl, jobId, result, error) {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const res = await fetch(`${managerUrl}/workers/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, result, error }),
      });

      if (res.ok) return true;
      if (res.status === 404) {
        console.warn(`[job] manager no longer has jobId=${jobId}; result will be dropped`);
        return false;
      }

      const body = await res.text().catch(() => '');
      console.warn(`[job] result submit attempt=${attempt} failed HTTP ${res.status}: ${body.slice(0, 200)}`);
    } catch (err) {
      console.warn(`[job] result submit attempt=${attempt} failed: ${err.message}`);
    }

    const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(attempt - 1, 5)));
    await new Promise(r => setTimeout(r, delay));
  }
}

// ---------- Poll loop ----------

async function pollLoop(managerUrl, id, engine, maxThreads, numCtx) {
  while (true) {
    let data;
    try {
      const controller = new AbortController();
      const pollTimer = setTimeout(() => controller.abort(), 20000);
      let res;
      try {
        res = await fetch(`${managerUrl}/workers/poll/${id}`, {
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(pollTimer);
      }
      if (res.status === 404) {
        console.error('[poll] Manager says worker not found — re-registering...');
        return; // exits poll loop, main() will re-register
      }
      if (!res.ok) {
        console.warn(`[poll] manager responded ${res.status} — retrying in 5s`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      // Body may have leading newlines from chunked-encoding keepalives.
      const text = await res.text();
      const trimmed = text.trimStart();
      data = trimmed ? JSON.parse(trimmed) : { job: null };
    } catch (err) {
      console.warn(`[poll] fetch failed: ${err.message} — retrying in 5s`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    if (!data.job) continue; // no job, poll again immediately

    const job = data.job;
    console.log(`[job] received jobId=${job.id} model=${job.model}`);

    // Real-time chunk forwarder — batch small deltas to avoid hundreds of HTTP
    // posts per response over the tunnel.
    let chunkBuffer = '';
    let chunkTimer = null;
    const flushChunks = () => {
      if (!chunkBuffer) return;
      const content = chunkBuffer;
      chunkBuffer = '';
      if (chunkTimer) {
        clearTimeout(chunkTimer);
        chunkTimer = null;
      }
      fetch(`${managerUrl}/workers/chunk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, content }),
      }).catch(() => {});
    };
    const onChunk = (content) => {
      chunkBuffer += content;
      if (chunkBuffer.length >= 1200) {
        flushChunks();
      } else if (!chunkTimer) {
        chunkTimer = setTimeout(flushChunks, 80);
      }
    };

    let result = null;
    let error  = null;
    let errorPayload = null;
    let jobHeartbeatTimer = setInterval(() => {
      sendJobHeartbeat(managerUrl, id, job.id, 'running').catch(() => {});
    }, 10_000);
    sendJobHeartbeat(managerUrl, id, job.id, 'running').catch(() => {});
    try {
      result = await runJob(job, engine, maxThreads, numCtx, onChunk);
      flushChunks();
      console.log(`[job] completed jobId=${job.id} tokens=${result.tokens.total}`);
    } catch (err) {
      flushChunks();
      error = err.message;
      errorPayload = err.payload || { retryable: true, stage: 'worker', jobId: job.id, status: 'failed' };
      console.error(`[job] failed jobId=${job.id}: ${err.message}`);
    } finally {
      clearInterval(jobHeartbeatTimer);
    }

    await sendJobHeartbeat(managerUrl, id, job.id, 'result_submitting');
    await submitResultWithRetry(managerUrl, job.id, result, errorPayload || error);
  }
}

// ---------- Main ----------

async function main() {
  const config = loadConfig();
  const engine = resolveEngine(config);

  const cores         = os.cpus().length;
  const maxThreads    = config.maxThreads    || Math.max(2, Math.round(cores * 0.85));
  const maxConcurrent = config.maxConcurrent || 1;
  const numCtx        = config.numCtx        || 32768;
  const capacity      = { cores, maxThreads, maxConcurrent };

  const managerUrl = await getManagerUrl(config);
  const models     = await getLocalModels(engine);
  const ip         = getLocalIp();
  const name       = config.name || os.hostname();

  console.log(`[worker] v3.0 — engine=${engine.type} url=${engine.url} (api-key=${engine.apiKey ? 'set' : 'none'})`);
  console.log(`Detected ${models.length} model(s): ${models.join(', ') || '(none)'}`);
  const ctxNote = engine.openai ? '(server-side context)' : `numCtx=${numCtx} (Ollama auto-GPU)`;
  console.log(`Capacity: ${cores} cores → maxThreads=${maxThreads}, maxConcurrent=${maxConcurrent}, ${ctxNote}`);
  console.log(`Registering as "${name}" (${ip}) with manager at ${managerUrl} ...`);

  let currentId = await register(managerUrl, name, ip, engine.port, models, capacity);
  console.log(`Registered (id=${currentId}). Polling for jobs... (Ctrl+C to stop)`);

  const heartbeatTimer = setInterval(() => sendHeartbeat(managerUrl, currentId), HEARTBEAT_EVERY);

  async function shutdown() {
    console.log('\nShutting down...');
    clearInterval(heartbeatTimer);
    await deregister(managerUrl, currentId);
    process.exit(0);
  }

  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  // Auto re-register if manager evicts this worker (poll returns 404)
  while (true) {
    await pollLoop(managerUrl, currentId, engine, maxThreads, numCtx);
    console.log('[worker] Evicted by manager — re-registering in 5s...');
    await new Promise(r => setTimeout(r, 5000));
    currentId = await register(managerUrl, name, ip, engine.port, models, capacity);
    console.log(`[worker] Re-registered (id=${currentId}). Resuming poll...`);
  }
}

main();
