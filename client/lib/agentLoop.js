'use strict';

const { ipcRenderer }   = require('electron');
const { buildApprovalCard } = require('../renderer/components/approvalCard');
const { getTool }       = require('./tools');

const MAX_TOOL_CALLS = Infinity;
const WRITE_CHUNK_LINES = 80;
const WRITE_CHUNK_CHARS = 6000;

// Tools that can never be auto-approved or remembered
const ALWAYS_CONFIRM = new Set(['delete_file', 'run_shell']);
const TEXT_WRITE_TOOLS = new Set(['write_file', 'append_file']);

/**
 * Run one full agent turn.
 *
 * @param {object} opts
 *   - backendUrl {string}
 *   - messages   {array}   full history going into this turn
 *   - model      {string}
 *   - tools      {array}   tool schema array (getToolSchemas() result)
 *   - workspace  {string}  workspace root path
 *   - approvalMode {string} "strict"|"trusted"|"yolo"
 *   - chat       {HTMLElement} chat container for appending bubbles
 *   - appendBubble {function(role, text, meta) → wrap}
 *   - setLoading {function(bool)}
 *   - abortRef   {object}  { aborted: false } — caller sets .aborted = true to stop
 *   - remembered {Set}     set of "toolName:pathPrefix" already approved this conversation
 * @returns {array} updated messages array
 */
/**
 * Ask the model to create a plan before executing. Returns the plan text
 * or null if user rejects / aborts.
 */
async function requestPlan(opts) {
  const { backendUrl, messages, model, workspace, chat, appendBubble, setLoading, abortRef, requestId } = opts;

  const userTask = messages[messages.length - 1]?.content || '';
  const planMessages = [
    {
      role: 'system',
      content: `You are a coding assistant planning a task. The workspace is "${workspace}".
Create a concise, numbered plan for the task below. List each file to create/modify and what it will contain. Do NOT write any code — just the plan. Keep it brief.`,
    },
    { role: 'user', content: userTask },
  ];

  setLoading(true);
  const r = await ipcRenderer.invoke('send-prompt', { backendUrl, messages: planMessages, model, agentMode: 'code', requestId });
  setLoading(false);

  if (abortRef.aborted || !r.ok) return null;

  let planText = r.data.response || '';
  // Strip thinking blocks
  planText = planText.replace(/<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/g, '').trim();
  if (!planText) return null;

  return planText;
}

/**
 * Show plan approval card. Returns promise that resolves to 'approve', 'reject', or 'edit:<text>'.
 */
function showPlanApproval(chat, planText) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'bubble approval plan-approval';

    const header = document.createElement('div');
    header.className = 'approval-header';
    header.innerHTML = '<span class="approval-icon">📋</span><span><strong>Proposed Plan</strong></span>';
    wrap.appendChild(header);

    const body = document.createElement('pre');
    body.className = 'plan-body';
    body.textContent = planText;
    wrap.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'approval-actions';

    const btnApprove = document.createElement('button');
    btnApprove.className = 'approval-btn approve';
    btnApprove.textContent = 'Execute Plan';
    btnApprove.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach(b => b.disabled = true);
      resolve('approve');
    });

    const btnEdit = document.createElement('button');
    btnEdit.className = 'approval-btn remember';
    btnEdit.textContent = 'Edit Plan';
    btnEdit.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach(b => b.disabled = true);
      body.contentEditable = 'true';
      body.classList.add('editing');
      body.focus();
      const saveBtn = document.createElement('button');
      saveBtn.className = 'approval-btn approve';
      saveBtn.textContent = 'Save & Execute';
      saveBtn.addEventListener('click', () => {
        saveBtn.disabled = true;
        body.contentEditable = 'false';
        body.classList.remove('editing');
        resolve('edit:' + body.textContent);
      });
      actions.innerHTML = '';
      actions.appendChild(saveBtn);
    });

    const btnReject = document.createElement('button');
    btnReject.className = 'approval-btn reject';
    btnReject.textContent = 'Reject';
    btnReject.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach(b => b.disabled = true);
      resolve('reject');
    });

    actions.appendChild(btnApprove);
    actions.appendChild(btnEdit);
    actions.appendChild(btnReject);
    wrap.appendChild(actions);

    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
  });
}

async function runAgentTurn(opts) {
  const {
    backendUrl, messages, model, tools,
    workspace, approvalMode, planMode,
    chat, appendBubble, appendActivity, updateTodoView, setLoading,
    abortRef, remembered, todoState, requestId,
  } = opts;
  const addActivity = (activity) => {
    if (typeof appendActivity === 'function') return appendActivity(activity);
    return appendBubble(activity.status === 'error' ? 'error' : 'assistant', activity.title || activity.subtitle || 'Activity');
  };
  const refreshTodoView = () => {
    if (typeof updateTodoView === 'function') updateTodoView(formatTodoListForDisplay(taskTodos));
  };

  // ── Plan Phase (only when toggled on) ───────────────────────────────
  let approvedPlan = null;
  if (planMode) {
    appendBubble('assistant', 'Creating plan…');
    const planText = await requestPlan(opts);

    if (!planText || abortRef.aborted) {
      appendBubble('error', 'Failed to generate plan.');
      return messages;
    }

    const decision = await showPlanApproval(chat, planText);
    if (decision === 'reject') {
      appendBubble('error', 'Plan rejected.');
      return messages;
    }

    approvedPlan = decision.startsWith('edit:') ? decision.slice(5) : planText;
    appendBubble('assistant', '✓ Plan approved. Executing…');
  }

  // ── Execution Phase ─────────────────────────────────────────────────
  let history = [...messages];
  const taskTodos = mergeTodoState(todoState, createTaskTodoList(messages, approvedPlan, workspace));
  const failureFingerprints = new Map();
  const toolCallNames = tools.filter(t => {
    const n = t.function?.name || t.name;
    return !TEXT_WRITE_TOOLS.has(n);
  }).map(t => t.function?.name || t.name).join(', ');
  const systemMsg = {
    role: 'system',
    content: `You are LLM Cluster Code Agent. The app state is the source of truth; your memory may be incomplete after compression. Tool calls: ${toolCallNames}. File writing: use <write_file> and <append_file> XML tags (see rules below).

WORKSPACE = "${workspace}"

CRITICAL PATH RULES — NEVER violate:
- Every tool call that takes a path argument MUST use an absolute path starting with "${workspace}/"
- list_dir root = "${workspace}" — call it as: list_dir({"path": "${workspace}"})
- read_file example: read_file({"path": "${workspace}/src/index.js"})
- write_file example: <write_file path="${workspace}/src/newfile.js">content here</write_file>
- NEVER pass "undefined", "null", "", ".", or any relative path as a path argument
- NEVER guess or omit the workspace prefix

FILE WRITING — use XML tags, NOT tool calls:
- To create/write a file, output: <write_file path="${workspace}/path/to/file">content here</write_file>
- To append to a file, output: <append_file path="${workspace}/path/to/file">content here</append_file>
- Safer alternative for large files:
  <<<FILE path="${workspace}/path/to/file" mode="write">
  content here
  <<<END_FILE
- For appends use mode="append".
- For files over 80 lines: use <write_file> for first 80 lines, then <append_file> for rest.
- The content goes BETWEEN the tags as raw text. No JSON escaping needed.
- You can use double quotes freely inside the tags.
- Do NOT use write_file or append_file as tool calls — ONLY as XML tags in your response text.
- NEVER use run_shell to write files (no cat >, echo >, heredoc, tee, etc). ONLY <write_file> tags.
- Use edit_file for small exact replacements.
- Use replace_file_range after read_file when exact-string editing is brittle.
- NEVER output placeholder paths like "/file", "path/to/file", or "/absolute/path/to/file". Use the actual absolute target path.

WORKFLOW RULES:
0. Complete the ENTIRE task without asking the user to continue.
1. Pick exactly one next action: inspect, write, edit, run, verify, or final.
2. Work on the first pending/failed todo. Do not create duplicate project folders.
3. Do not narrate progress only. If work remains, emit a tool call or complete file block.
4. NEVER show file contents in chat as markdown/code fences; use file blocks or tools.
5. After file creation/editing, verify locally with suitable commands when possible.
6. Say "Done." only when every todo is done and verification passes or is impossible with a stated reason.
7. Do not repeat successful completed operations. Re-read only when needed to edit or verify current file state.
${approvedPlan ? `\nAPPROVED PLAN — execute this exactly:\n${approvedPlan}` : ''}
${formatTodoListForPrompt(taskTodos)}
`,
  };
  if (history.length > 0 && history[0].role === 'system') {
    history = [systemMsg, ...history.slice(1)];
  } else {
    history = [systemMsg, ...history];
  }
  refreshTodoView();

  let toolCallCount = 0;
  let overflowRetries = 0;
  let forceTextWriteOnly = false;
  let plainContinuationCount = 0;
  let incompleteWriteRetries = 0;
  let emptyContinuationCount = 0;

  // Live stream bubble — shows tokens as they arrive via IPC 'stream-chunk'
  let activeStreamEl = null;
  const onStreamChunk = (_, text) => {
    if (typeof ensurePlaceholderRemoved === 'function') ensurePlaceholderRemoved();
    if (!activeStreamEl) {
      activeStreamEl = document.createElement('div');
      activeStreamEl.className = 'bubble assistant';
      const body = document.createElement('div');
      body.className = 'bubble-body';
      activeStreamEl.appendChild(body);
      chat.appendChild(activeStreamEl);
    }
    const body = activeStreamEl.querySelector('.bubble-body');
    const raw = (body.dataset.raw || '') + text;
    body.dataset.raw = raw;
    // Hide file content inside <write_file>/<append_file> tags and thinking blocks
    let display = raw
      .replace(/<(think|thinking|reasoning)>\s*/g, '💭 ')
      .replace(/\s*<\/(think|thinking|reasoning)>/g, '\n─────\n')
      .replace(/<(write_file|append_file)\s+path=(["'])([^"']*)\2>[^]*?<\/\1>/g, '📝 Writing $3…\n')
      .replace(/<(write_file|append_file)\s+path=(["'])([^"']*)\2>[^]*$/g, '📝 Writing $3…');
    body.textContent = display;
    chat.scrollTop = chat.scrollHeight;
  };
  ipcRenderer.on('stream-chunk', onStreamChunk);

  // Estimate rough token count (~4 chars per token)
  function estimateTokens(msgs) {
    return msgs.reduce((sum, m) => {
      let len = (m.content || '').length;
      if (m.tool_calls) len += JSON.stringify(m.tool_calls).length;
      return sum + Math.ceil(len / 4);
    }, 0);
  }

  const MAX_CTX_TOKENS = 24000;
  const COMPRESS_THRESHOLD = 20000;
  let lastCompressedAt = 0;

  // Compress old history into a summary via the model
  async function compressHistory(msgs) {
    // Need at least system + user + 8 turns to compress
    if (msgs.length < 10) return msgs;
    if (estimateTokens(msgs) < COMPRESS_THRESHOLD) return msgs;
    // Don't compress too frequently
    if (Date.now() - lastCompressedAt < 120000) return msgs;

    // Extract middle turns to summarize (keep system, first user, last 8)
    const head = msgs.slice(0, 2);  // system + original task
    const tail = msgs.slice(-8);     // recent context (2-3 tool call cycles)
    const middle = msgs.slice(2, -8);
    if (middle.length < 6) return msgs;

    // Build a compact summary with meaningful detail from each action
    const actions = [];
    for (const m of middle) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name || '';
          let rawArgs = tc.function?.arguments;
          if (typeof rawArgs === 'string') { try { rawArgs = JSON.parse(rawArgs); } catch { rawArgs = {}; } }
          const args = rawArgs || {};
          const path = args.path || '';
          if (name === 'write_file' && args.content) {
            const lines = args.content.split('\n');
            const preview = lines.slice(0, 5).join(' ').slice(0, 150);
            actions.push(`write_file(${path}) — ${lines.length} lines: ${preview}…`);
          } else if (name === 'append_file' && args.content) {
            actions.push(`append_file(${path}) — ${args.content.split('\n').length} lines appended`);
          } else if (name === 'edit_file') {
            const oldSnip = (args.old_string || '').slice(0, 60).replace(/\n/g, ' ');
            const newSnip = (args.new_string || '').slice(0, 60).replace(/\n/g, ' ');
            actions.push(`edit_file(${path}) — "${oldSnip}" → "${newSnip}"`);
          } else if (name === 'run_shell') {
            const cmd = [args.cmd, ...(args.args || [])].join(' ').slice(0, 100);
            actions.push(`run_shell: ${cmd}`);
          } else if (name === 'grep') {
            actions.push(`grep("${args.pattern}" in ${args.path || 'workspace'})`);
          } else if (name === 'read_file') {
            actions.push(`read_file(${path})`);
          } else {
            actions.push(`${name}(${path})`);
          }
        }
      } else if (m.role === 'assistant' && m.content) {
        const short = m.content.slice(0, 150).replace(/\n/g, ' ');
        if (short && !short.startsWith('ERROR')) actions.push(`said: ${short}`);
      }
    }

    if (actions.length === 0) return msgs;

    // Build summary locally (no API call — fast and free)
    const summary = `[Context compressed] Actions completed so far:\n${actions.map((a, i) => `${i + 1}. ${a}`).join('\n')}\n\nContinue from where you left off. Do NOT repeat any of the above actions.`;

    lastCompressedAt = Date.now();
    appendBubble('assistant', `Context compressed (${middle.length} turns → summary)`);

    return [...head, { role: 'assistant', content: summary }, ...tail];
  }

  // Trim history to fit context window.
  async function trimHistory(msgs) {
    // Step 1: compress if over threshold
    let trimmed = await compressHistory(msgs);

    // Step 2: truncate old tool results, keep last 4 full
    const MAX_TOOL_RESULT_CHARS = 400;
    const KEEP_RECENT = 4;
    let toolResultsSeen = 0;
    const total = trimmed.filter(m => m.role === 'tool').length;
    trimmed = trimmed.map(m => {
      if (m.role !== 'tool') return m;
      toolResultsSeen++;
      const isRecent = toolResultsSeen > total - KEEP_RECENT;
      if (isRecent) return m;
      if (m.content && m.content.length > MAX_TOOL_RESULT_CHARS) {
        return { ...m, content: m.content.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…[truncated]' };
      }
      return m;
    });

    // Step 3: truncate old assistant tool_calls args
    for (let i = 0; i < trimmed.length - 6; i++) {
      const m = trimmed[i];
      if (m.role === 'assistant' && m.tool_calls) {
        trimmed[i] = {
          ...m,
          tool_calls: m.tool_calls.map(tc => {
            if (!tc.function?.arguments) return tc;
            let args = tc.function.arguments;
            if (typeof args === 'string' && args.length > 200) {
              args = args.slice(0, 200) + '…';
            } else if (typeof args === 'object') {
              const s = JSON.stringify(args);
              if (s.length > 200) args = s.slice(0, 200) + '…';
            }
            return { ...tc, function: { ...tc.function, arguments: args } };
          }),
        };
      }
    }

    // Step 4: drop oldest middle turns if still over budget
    while (estimateTokens(trimmed) > MAX_CTX_TOKENS && trimmed.length > 6) {
      trimmed.splice(2, 1);
    }

    return trimmed;
  }

  while (true) {
    if (abortRef.aborted) break;

    // Remove any previous stream bubble before starting a new request
    if (activeStreamEl) { activeStreamEl.remove(); activeStreamEl = null; }

    // Send to backend — filter out file-body tools. Large source code is
    // streamed as text and written locally, never as llama.cpp tool-call JSON.
    const filteredTools = forceTextWriteOnly ? [] : tools.filter(t => {
      const name = t.function?.name || t.name;
      return !TEXT_WRITE_TOOLS.has(name);
    });
    const outgoingMessages = injectTodoStatus(
      sanitizeHistoryForTools(await trimHistory(history), filteredTools),
      taskTodos,
    );
    setLoading(true);
    const r = await ipcRenderer.invoke('send-prompt', {
      backendUrl,
      messages: outgoingMessages,
      model,
      tools: filteredTools,
      requestId,
      agentMode: 'code',
    });
    setLoading(false);

    // Remove stream bubble now that we have the final response
    if (activeStreamEl) { activeStreamEl.remove(); activeStreamEl = null; }

    if (abortRef.aborted) break;

    if (!r.ok) {
      appendBubble('error', `Error: ${r.error}`);
      break;
    }

    const data = r.data;

    // Extract thinking blocks (qwen3/r1/o1 variants) — render AFTER the response bubble.
    let pendingThinkText = null;
    if (data.response) {
      const thinkRe = /<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/g;
      const thinkMatches = [...data.response.matchAll(thinkRe)];
      if (thinkMatches.length > 0) {
        pendingThinkText = thinkMatches.map(m => m[2].trim()).join('\n\n---\n\n');
      }
      data.response = data.response.replace(thinkRe, '').trim();
    }
    // Extract file-write blocks from response text and execute them locally.
    // These never become native tool calls because llama.cpp's JSON parser is
    // fragile with large escaped source files.
    if (data.response) {
      const writeBlocks = extractTextWriteBlocks(data.response, history);
      for (let block of writeBlocks) {
        const normalized = normalizeTextWriteBlockPath(block, taskTodos, workspace);
        if (!normalized.ok) {
          markTodoFailed(taskTodos, block.path, normalized.error);
          refreshTodoView();
          addActivity({
            kind: 'write',
            status: 'error',
            title: `Rejected placeholder path ${block.path}`,
            subtitle: block.path,
            detail: { path: block.path, status: 'rejected', error: normalized.error, preview: previewText(block.content) },
          });
          history.push({
            role: 'user',
            content: `${normalized.error}\nUse an exact absolute path under "${workspace}". Pending todos are:\n${formatTodoListForPrompt(taskTodos)}`,
          });
          continue;
        }
        block = normalized.block;
        const result = await executeTextWriteBlock(block, workspace);
        if (result.ok) {
          markTodoDone(taskTodos, block.path);
          markRelatedTodosDone(taskTodos, block.path, block.content);
          refreshTodoView();
          const parts = result.chunks > 1 ? ` (${result.lines} lines, auto-chunked ${result.chunks} parts)` : '';
          addActivity({
            kind: 'write',
            status: 'success',
            title: `Wrote ${shortPath(block.path)}${parts}`,
            subtitle: block.path,
            detail: {
              path: block.path,
              tool: block.tool,
              status: 'written',
              lines: result.lines,
              chunks: result.chunks,
              preview: previewText(block.content),
              result: result.result,
            },
          });
          toolCallCount++;
        } else {
          markTodoFailed(taskTodos, block.path, result.error);
          refreshTodoView();
          addActivity({
            kind: 'write',
            status: 'error',
            title: `Failed writing ${shortPath(block.path)}`,
            subtitle: block.path,
            detail: { path: block.path, tool: block.tool, status: 'failed', error: result.error, preview: previewText(block.content) },
          });
          if (recordRepeatedFailure(failureFingerprints, 'text_write', block.path, result.error) >= 3) {
            appendBubble('error', `Repeated write failure for ${block.path} — stopping to avoid a loop.`);
            break;
          }
        }
        history.push({
          role: 'assistant',
          content: result.ok
            ? `Wrote ${block.path} (${result.lines || 0} lines)`
            : `Failed to write ${block.path}: ${result.error}`,
        });
      }
      if (writeBlocks.length > 0) {
        data.response = stripTextWriteBlocks(data.response).trim();
        overflowRetries = 0;
        forceTextWriteOnly = false;
        // If there was only file writes and no other content, loop for next action
        if (!data.response && !data.tool_calls) continue;
      }

      const incompleteWrite = findIncompleteTextWriteBlock(data.response);
      if (incompleteWrite) {
        incompleteWriteRetries++;
        if (incompleteWriteRetries > 2) {
          appendBubble('error', `Incomplete file write for ${incompleteWrite.path || 'unknown file'} repeated ${incompleteWriteRetries} times — stopping.`);
          break;
        }
        appendBubble('error', `Incomplete file write detected — retry ${incompleteWriteRetries}/2…`);
        forceTextWriteOnly = true;
        history.push({ role: 'assistant', content: stripLargeIncompleteWrite(data.response) });
        history.push({
          role: 'user',
          content: `Your previous <${incompleteWrite.tool}> block${incompleteWrite.path ? ` for "${incompleteWrite.path}"` : ''} was cut off before the closing tag, so it was NOT written. Re-send that file now using only complete XML blocks. Prefer smaller chunks with actual absolute paths under "${workspace}". Do not use placeholder paths, JSON tools, or say Done.`,
        });
        continue;
      }
    }

    if ((!data.tool_calls || data.tool_calls.length === 0) && data.response) {
      const extracted = extractToolCallsFromText(data.response, history);
      if (extracted.length > 0) {
        data.tool_calls = extracted;
        data.response = '';
      }
    }

    // Tool call overflow error from worker — retry with limit
    if (!data.tool_calls && data.response && data.response.startsWith('ERROR:')) {
      overflowRetries++;
      if (overflowRetries > 2) {
        appendBubble('error', `Tool call overflow repeated ${overflowRetries} times — stopping.`);
        break;
      }
      appendBubble('error', `Tool call too large — retry ${overflowRetries}/2…`);
      forceTextWriteOnly = true;
      history.push({ role: 'assistant', content: data.response });
      history.push({ role: 'user', content: 'CRITICAL: Native JSON tool calling crashed while trying to write a file. For the next response, DO NOT call any tools. Output only file-write text blocks with the real target filename under "' + workspace + '". Example: <write_file path="' + workspace + '/index.html">...</write_file>. Put the full code between the tags as plain text. Never use /file or /absolute/path/to/file. If the task is already complete, say "Done." instead.' });
      continue;
    }

    // No tool calls — final text response
    if (!data.tool_calls || data.tool_calls.length === 0) {
      const tok = data.tokens;
      const workerLabel = data.worker || 'worker';
      const modelLabel  = data.model  || model;
      let meta = `${workerLabel} · ${modelLabel}`;
      if (tok) {
        meta += ` · in ${tok.prompt} / out ${tok.response} tok`;
        if (tok.tokensPerSec != null) meta += ` · ${tok.tokensPerSec} tok/s`;
      }
      // data.response already has <think> blocks stripped above
      let rawResp = data.response || '';

      // Skip rendering if the model just echoed back a tool result (llama3.1 quirk)
      if (rawResp.startsWith('<tool_result') || rawResp.startsWith('<tool_response')) {
        // Model echoed the tool result — loop again to get the actual response
        history.push({ role: 'assistant', content: '' });
        continue;
      }

      // Ignore nonsense one-word responses the model sometimes emits (e.g. "undefined", "null")
      const meaningless = new Set(['undefined', 'null', 'none', '{}', '[]']);
      const respNorm = rawResp.toLowerCase().trim();
      const resp = meaningless.has(respNorm) ? '' : rawResp;

      if (isPrematureDone(resp, taskTodos)) {
        history.push({ role: 'assistant', content: resp });
        history.push({
          role: 'user',
          content: `You said Done, but the todo list still has unfinished work:\n${formatTodoListForPrompt(taskTodos)}\nContinue now. Emit the next tool call or complete file block. Do not say Done until pending and failed todos are resolved.`,
        });
        continue;
      }

      if (resp && /\bdone\b|completed|finished|all set/i.test(resp)) {
        const verification = await verifyTodoFiles(taskTodos, workspace);
        if (!verification.ok) {
          for (const item of verification.failed) markTodoFailed(taskTodos, item.path, item.error);
          refreshTodoView();
          history.push({ role: 'assistant', content: resp });
          history.push({
            role: 'user',
            content: `You said Done, but local verification failed:\n${verification.failed.map(f => `- ${f.path}: ${f.error}`).join('\n')}\nFix these files now. Do not say Done until verification passes.`,
          });
          continue;
        }
      }

      if (data.finish_reason && isTruncatedFinish(data.finish_reason) && toolCallCount > 0) {
        history.push({ role: 'assistant', content: resp || `[Generation stopped early: ${data.finish_reason}]` });
        history.push({
          role: 'user',
          content: `The previous response stopped because finish_reason="${data.finish_reason}". Continue exactly where it stopped. If writing a file, resend the current file using smaller complete <write_file>/<append_file> blocks. Do not say Done until all requested work is complete.`,
        });
        forceTextWriteOnly = true;
        continue;
      }

      if (!resp && toolCallCount > 0 && emptyContinuationCount < 2) {
        emptyContinuationCount++;
        history.push({ role: 'assistant', content: '' });
        history.push({
          role: 'user',
          content: 'Continue executing the task. Your previous response was empty, so nothing new was done. Emit the next tool call or complete <write_file>/<append_file> blocks. Say "Done." only after all requested files and steps are complete.',
        });
        continue;
      }

      if (resp && shouldContinueAfterPlainResponse(resp, toolCallCount, plainContinuationCount)) {
        plainContinuationCount++;
        appendBubble('assistant', resp, meta);
        history.push({ role: 'assistant', content: resp });
        history.push({
          role: 'user',
          content: 'Continue executing the task now. Do not narrate progress only. Either emit the next tool call, emit <write_file>/<append_file> blocks for the next file, or say "Done." only if every requested file and step is complete.',
        });
        continue;
      }

      const displayResp = resp || 'Stopped: model returned an empty response before confirming completion.';
      appendBubble('assistant', displayResp, meta);
      history.push({ role: 'assistant', content: displayResp });
      if (pendingThinkText) appendThinkingBlock(chat, pendingThinkText);
      ipcRenderer.removeListener('stream-chunk', onStreamChunk);
      if (todoState) todoState.items = taskTodos;
      // Strip the injected system message before returning — renderer stores clean history
      return history.filter(m => !(m.role === 'system' && m.content.startsWith('You are a coding assistant')));
    }

    // Has tool calls — show approval cards and execute
    // If model also sent commentary text alongside tool calls, render it as a bubble
    const commentary = (data.response || '').trim();
    if (commentary) {
      appendBubble('assistant', commentary);
    }
    // Append assistant's tool_calls turn to history (content set to commentary or empty)
    history.push({ role: 'assistant', content: commentary, tool_calls: data.tool_calls });

    if (toolCallCount >= MAX_TOOL_CALLS) {
      appendBubble('error', `Reached tool call limit (${MAX_TOOL_CALLS}) per turn. Stopping.`);
      break;
    }

    for (const call of data.tool_calls) {
      if (abortRef.aborted) break;
      toolCallCount++;

      const toolName = call.function?.name || call.name;
      if (TEXT_WRITE_TOOLS.has(toolName)) {
        appendBubble('error', `Tool "${toolName}" is disabled as a native tool. Use <${toolName} path="...">...</${toolName}> text blocks instead.`);
        history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: `${toolName} is not available as a JSON tool because large file contents break llama.cpp parsing. Emit XML write blocks in assistant text instead.` }) });
        continue;
      }
      // llama.cpp / OpenAI format returns arguments as a JSON *string*; Ollama returns a parsed object.
      // Always normalise to an object here.
      let rawArgs = call.function?.arguments ?? call.arguments ?? {};
      let args;
      if (typeof rawArgs === 'string') {
        try { args = JSON.parse(rawArgs); } catch {
          appendBubble('error', `Tool "${toolName}": malformed arguments (JSON parse failed). Skipping.`);
          history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: 'Malformed tool call arguments — JSON parse failed. The arguments string was truncated or invalid. Try again with shorter content, or use edit_file instead of write_file.' }) });
          continue;
        }
      } else {
        args = rawArgs;
      }
      const toolDef  = getTool(toolName);
      const risk     = toolDef ? toolDef.risk : 'write';

      // Check injection patterns in args
      const argsStr = JSON.stringify(args);
      const injectionPatterns = [
        /ignore\s+previous\s+instructions/i,
        /override\s+your\s+instructions/i,
        /you\s+are\s+now/i,
      ];
      const suspicious = injectionPatterns.some(p => p.test(argsStr));
      if (suspicious) {
        appendBubble('error', `⚠ Suspicious content detected in tool call arguments. Tool call blocked.`);
        history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: 'Blocked: suspicious content in arguments.' }) });
        continue;
      }

      // Determine if approval needed
      const needsApproval = shouldAskApproval({ toolName, risk, approvalMode, remembered, args });

      let approved = false;

      if (!needsApproval) {
        approved = true;
      } else {
        approved = await showApprovalCard({
          chat, toolName, args, risk, call, remembered,
        });
      }

      // Execute or reject
      let toolResult;
      if (approved) {
        toolResult = await ipcRenderer.invoke('agent:run-tool', { tool: toolName, args, workspace });

        // Auto-retry: edit_file "old_string not found" → read actual content and tell model
        if (!toolResult.ok && toolName === 'edit_file' && toolResult.error?.includes('old_string not found')) {
          const readResult = await ipcRenderer.invoke('agent:run-tool', { tool: 'read_file', args: { path: args.path }, workspace });
          if (readResult.ok) {
            toolResult = {
              ok: false,
              error: `old_string not found. Current file content:\n${readResult.result}\n\nUse a <write_file path="...">...</write_file> text block to rewrite the whole file with your changes applied.`,
            };
          }
        }

        // Surface errors visibly so the user can see what went wrong
        if (!toolResult.ok) {
          if (args.path) markTodoFailed(taskTodos, args.path, toolResult.error);
          refreshTodoView();
          addActivity({
            kind: activityKindForTool(toolName),
            status: 'error',
            title: `${toolName} failed${args.path ? `: ${shortPath(args.path)}` : ''}`,
            subtitle: args.path || args.root || args.cmd || '',
            detail: buildToolActivityDetail(toolName, args, toolResult),
          });
          if (recordRepeatedFailure(failureFingerprints, toolName, JSON.stringify(args).slice(0, 500), toolResult.error) >= 3) {
            appendBubble('error', `Repeated failure in ${toolName} — stopping to avoid a loop.`);
            break;
          }
        } else {
          if (['edit_file', 'replace_file_range', 'create_dir'].includes(toolName) && args.path) markTodoDone(taskTodos, args.path);
          if (toolName === 'edit_file') markRelatedTodosDone(taskTodos, args.path, args.new_string || '');
          if (toolName === 'replace_file_range') markRelatedTodosDone(taskTodos, args.path, args.content || '');
          refreshTodoView();
          // Show a brief success confirmation for write/shell tools
          const visibleTools = ['write_file', 'append_file', 'edit_file', 'replace_file_range', 'create_dir', 'delete_file', 'run_shell', 'read_file', 'list_dir', 'grep', 'glob'];
          if (visibleTools.includes(toolName)) {
            addActivity({
              kind: activityKindForTool(toolName),
              status: 'success',
              title: activityTitleForTool(toolName, args, toolResult),
              subtitle: args.path || args.root || args.pattern || args.cmd || '',
              detail: buildToolActivityDetail(toolName, args, toolResult),
            });
          }
        }
      } else {
        toolResult = { ok: false, error: 'User declined this tool call.' };
      }

      // Wrap result to guard against prompt injection
      const wrappedContent = `<tool_result tool="${toolName}">\n${JSON.stringify(toolResult)}\n</tool_result>`;
      history.push({ role: 'tool', tool_call_id: call.id, content: wrappedContent });
    }
  }

  ipcRenderer.removeListener('stream-chunk', onStreamChunk);
  if (todoState) todoState.items = taskTodos;
  return history;
}

/** Returns true if the user needs to approve this call. */
function shouldAskApproval({ toolName, risk, approvalMode, remembered, args }) {
  if (approvalMode === 'yolo') return false;
  if (risk === 'read' && approvalMode === 'trusted') return false;

  // Check "remember" set
  if (!ALWAYS_CONFIRM.has(toolName)) {
    const pathArg = args.path || args.root || args.cwd || '';
    const key = `${toolName}:${pathArg}`;
    if (remembered.has(key) || remembered.has(`${toolName}:`)) return false;
  }

  return true;
}

/**
 * Show an approval card in chat and wait for the user's decision.
 * Returns true (approved) or false (rejected).
 */
function showApprovalCard({ chat, toolName, args, risk, call, remembered }) {
  return new Promise((resolve) => {
    const canRemember = !ALWAYS_CONFIRM.has(toolName);

    const card = buildApprovalCard({
      toolName,
      args,
      risk,
      canRemember,
      onApprove: () => resolve(true),
      onApproveRemember: () => {
        const pathArg = args.path || args.root || args.cwd || '';
        remembered.add(`${toolName}:${pathArg}`);
        resolve(true);
      },
      onReject: () => resolve(false),
    });

    chat.appendChild(card);
    chat.scrollTop = chat.scrollHeight;
  });
}

async function executeTextWriteBlock(block, workspace) {
  const lines = block.content.split('\n');
  const chunks = chunkFileContent(block.content);
  const firstTool = block.tool === 'append_file' ? 'append_file' : 'write_file';
  let result = await ipcRenderer.invoke('agent:run-tool', {
    tool: firstTool,
    args: { path: block.path, content: chunks[0] || '' },
    workspace,
  });

  for (let i = 1; i < chunks.length && result.ok; i++) {
    result = await ipcRenderer.invoke('agent:run-tool', {
      tool: 'append_file',
      args: { path: block.path, content: chunks[i].startsWith('\n') ? chunks[i] : '\n' + chunks[i] },
      workspace,
    });
  }

  return { ...result, lines: lines.length, chunks: chunks.length };
}

function chunkFileContent(content) {
  const lines = content.split('\n');
  const chunks = [];
  let current = [];
  let currentChars = 0;

  for (const line of lines) {
    const lineChars = line.length + 1;
    if (current.length > 0 && (current.length >= WRITE_CHUNK_LINES || currentChars + lineChars > WRITE_CHUNK_CHARS)) {
      chunks.push(current.join('\n'));
      current = [];
      currentChars = 0;
    }
    current.push(line);
    currentChars += lineChars;
  }

  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks.length ? chunks : [''];
}

function extractTextWriteBlocks(text, history = []) {
  const blocks = [];

  const xmlRe = /<(write_file|append_file)\s+path=(["'])([^"']+)\2>([\s\S]*?)<\/\1>/g;
  for (const match of text.matchAll(xmlRe)) {
    blocks.push({
      tool: match[1],
      path: match[3],
      content: match[4],
      fullMatch: match[0],
    });
  }
  if (blocks.length > 0) return blocks;

  const fileBlockRe = /<<<FILE\s+path=(["'])([^"']+)\1(?:\s+mode=(["']?)(write|append)\3)?\s*\n([\s\S]*?)\n?<<<END_FILE/g;
  for (const match of text.matchAll(fileBlockRe)) {
    blocks.push({
      tool: match[4] === 'append' ? 'append_file' : 'write_file',
      path: match[2],
      content: match[5],
      fullMatch: match[0],
    });
  }
  if (blocks.length > 0) return blocks;

  // Fallback for models that ignore XML instructions and emit
  // "path/to/file.js" followed by a markdown code block.
  const codeBlockRe = /(?:(?:\*\*|`)?([^\s`*()\n]+)(?:\*\*|`)?\s*\n)?```[a-zA-Z]*\n([\s\S]*?)```/g;
  for (const match of text.matchAll(codeBlockRe)) {
    const filename = inferCodeBlockFilename(text, match, history);
    const content = match[2];
    if (!filename || !looksLikeSourcePath(filename) || !content || content.trim().length < 10) continue;
    blocks.push({
      tool: 'write_file',
      path: filename,
      content,
      fullMatch: match[0],
    });
  }

  return blocks;
}

function stripTextWriteBlocks(text) {
  let stripped = text.replace(/<(write_file|append_file)\s+path=(["'])([^"']+)\2>[\s\S]*?<\/\1>/g, '');
  stripped = stripped.replace(/<<<FILE\s+path=(["'])([^"']+)\1(?:\s+mode=(["']?)(write|append)\3)?\s*\n[\s\S]*?\n?<<<END_FILE/g, '');
  const blocks = extractTextWriteBlocks(stripped);
  for (const block of blocks) {
    stripped = stripped.replace(block.fullMatch, '');
  }
  return stripped;
}

function findIncompleteTextWriteBlock(text) {
  const openRe = /<(write_file|append_file)\s+path=(["'])([^"']+)\2>/g;
  let match;
  let last = null;
  while ((match = openRe.exec(text)) !== null) {
    last = {
      tool: match[1],
      path: match[3],
      index: match.index,
      openTag: match[0],
    };
  }
  if (last) {
    const afterOpen = text.slice(last.index + last.openTag.length);
    const closeTag = `</${last.tool}>`;
    if (!afterOpen.includes(closeTag)) return last;
  }

  const fileStartRe = /<<<FILE\s+path=(["'])([^"']+)\1(?:\s+mode=(["']?)(write|append)\3)?\s*\n/g;
  let fileMatch;
  let lastFile = null;
  while ((fileMatch = fileStartRe.exec(text)) !== null) {
    lastFile = {
      tool: fileMatch[4] === 'append' ? 'append_file' : 'write_file',
      path: fileMatch[2],
      index: fileMatch.index,
      openTag: fileMatch[0],
    };
  }
  if (!lastFile) return null;
  return text.slice(lastFile.index + lastFile.openTag.length).includes('<<<END_FILE') ? null : lastFile;
}

function stripLargeIncompleteWrite(text) {
  const incomplete = findIncompleteTextWriteBlock(text);
  if (!incomplete) return text;
  const prefix = text.slice(0, incomplete.index).trim();
  const note = `[Incomplete ${incomplete.tool} block for ${incomplete.path || 'unknown file'} omitted from prompt history]`;
  return prefix ? `${prefix}\n\n${note}` : note;
}

function inferCodeBlockFilename(text, match, history = []) {
  let filename = match[1] || null;
  if (filename && looksLikeSourcePath(filename)) return filename;

  const before = text.slice(0, match.index);
  const nearby = before.match(/([^\s`*()\n]+\.(?:html?|css|js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|json|yaml|yml|md|txt|sh|env|toml|xml|svg))\b/gi);
  if (nearby) return nearby[nearby.length - 1];

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    const wrote = msg.content && msg.content.match(/Wrote\s+(.+?)\s+\(\d+\s+lines\)/);
    if (wrote && looksLikeSourcePath(wrote[1])) return wrote[1];
  }
  return null;
}

function looksLikeSourcePath(pathLike) {
  return /\.(html?|css|js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|json|yaml|yml|md|txt|sh|env|toml|xml|svg)$/i.test(pathLike);
}

function createTaskTodoList(messages, approvedPlan, workspace) {
  const source = [approvedPlan, messages.map(m => m.content || '').join('\n')].filter(Boolean).join('\n');
  const todos = [];
  const seen = new Set();

  const planLines = String(approvedPlan || '')
    .split('\n')
    .map(line => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(line => line.length > 8);

  for (const line of planLines) addTodo(todos, seen, line, extractFirstPath(line, workspace));

  const pathRe = /(?:^|[\s"'`(])((?:\/|[A-Za-z]:\\)?[^\s"'`()<>]+\.(?:html?|css|js|ts|jsx|tsx|py|json|md|txt|sh|yml|yaml|toml|svg|xml))/gi;
  for (const match of source.matchAll(pathRe)) {
    const filePath = normalizeTodoPath(match[1].replace(/[.,;:]+$/, ''), workspace);
    addTodo(todos, seen, `Create or update ${shortPath(filePath)}`, filePath);
  }

  if (/tailwind/i.test(source) && !todos.some(t => /tailwind/i.test(t.title) || /tailwind/i.test(t.path || ''))) {
    addTodo(todos, seen, 'Configure Tailwind CSS styling', null);
  }
  if (/css|style/i.test(source) && !todos.some(t => /\.css$/i.test(t.path || '') || /css|style/i.test(t.title))) {
    addTodo(todos, seen, 'Create or update CSS styling', `${workspace}/style.css`);
  }

  return todos;
}

function mergeTodoState(todoState, freshTodos) {
  const existing = Array.isArray(todoState?.items) ? todoState.items : [];
  if (existing.length === 0) {
    if (todoState) todoState.items = freshTodos;
    return freshTodos;
  }

  const merged = existing.map(todo => ({ ...todo }));
  const seen = new Set(merged.map(todo => todo.path || todo.title.toLowerCase()));
  for (const todo of freshTodos) {
    const key = todo.path || todo.title.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push({ ...todo, id: merged.length + 1 });
    }
  }
  if (todoState) todoState.items = merged;
  return merged;
}

function addTodo(todos, seen, title, path) {
  const key = path || title.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  todos.push({ id: todos.length + 1, title, path, status: 'pending', error: '' });
}

function extractFirstPath(text, workspace) {
  const match = String(text || '').match(/((?:\/|[A-Za-z]:\\)?[^\s"'`()<>]+\.(?:html?|css|js|ts|jsx|tsx|py|json|md|txt|sh|yml|yaml|toml|svg|xml))/i);
  return match ? normalizeTodoPath(match[1].replace(/[.,;:]+$/, ''), workspace) : null;
}

function normalizeTodoPath(path, workspace) {
  let p = String(path || '').trim();
  if (workspace && p && !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p)) {
    p = stripWorkspaceEchoPrefix(p, workspace);
  }
  if (workspace && p && !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p)) p = `${workspace}/${p.replace(/^\.?\//, '')}`;
  return p;
}

function stripWorkspaceEchoPrefix(relativePath, workspace) {
  const workspaceBase = String(workspace || '').split(/[\\/]/).filter(Boolean).at(-1) || '';
  const compactBase = workspaceBase.replace(/\s+/g, '');
  const parts = String(relativePath || '').split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return relativePath;
  if (parts[0] === workspaceBase || parts[0] === compactBase || parts[0] === workspaceBase.split(/\s+/).at(-1)) {
    return parts.slice(1).join('/');
  }
  return relativePath;
}

function markTodoDone(todos, pathOrTitle) {
  const todo = findTodoForTarget(todos, pathOrTitle);
  if (!todo) return;
  todo.status = 'done';
  todo.error = '';
}

function markTodoFailed(todos, pathOrTitle, error) {
  const todo = findTodoForTarget(todos, pathOrTitle) || addAdHocTodo(todos, pathOrTitle);
  todo.status = 'failed';
  todo.error = error || 'unknown error';
}

function markRelatedTodosDone(todos, path, content) {
  const haystack = `${path || ''}\n${content || ''}`;
  for (const todo of todos) {
    if (todo.status === 'done') continue;
    const title = todo.title.toLowerCase();
    if (/tailwind/i.test(title) && /tailwind|cdn\.tailwindcss|@tailwind/i.test(haystack)) {
      todo.status = 'done';
      todo.error = '';
    }
    if (/(css|style|styling)/i.test(title) && (/\.css$/i.test(path || '') || /<style|stylesheet|class=/i.test(haystack))) {
      todo.status = 'done';
      todo.error = '';
    }
  }
}

function addAdHocTodo(todos, target) {
  const todo = { id: todos.length + 1, title: `Resolve ${target || 'failed action'}`, path: target || null, status: 'pending', error: '' };
  todos.push(todo);
  return todo;
}

function findTodoForTarget(todos, target) {
  const t = String(target || '');
  return todos.find(todo =>
    todo.path === t ||
    (todo.path && shortPath(todo.path) === shortPath(t)) ||
    (!todo.path && t && todo.title.toLowerCase().includes(shortPath(t).toLowerCase())) ||
    (/tailwind/i.test(todo.title) && /tailwind/i.test(t)) ||
    (!todo.path && /(css|style|styling)/i.test(todo.title) && /\.css$/i.test(t))
  );
}

function isPlaceholderPath(path, workspace) {
  const p = String(path || '').trim();
  if (!p) return true;
  if (/^\/?(absolute\/path\/to\/file|path\/to\/file|file)$/i.test(p)) return true;
  if (/\/absolute\/path\/to\/file/i.test(p)) return true;
  if (p === '/file' || p === `${workspace}/path/to/file`) return true;
  return false;
}

function normalizeTextWriteBlockPath(block, todos, workspace) {
  let path = String(block.path || '').trim();
  if (isPlaceholderPath(path, workspace)) {
    const pending = getPendingTodos(todos);
    const replacement = pending.map(t => t.path).find(p => p && looksLikeSourcePath(p));
    if (!replacement) {
      return {
        ok: false,
        error: `The model used placeholder path "${path}". No pending todo with a concrete file path was available to safely map it to.`,
      };
    }
    return { ok: true, block: { ...block, path: replacement } };
  }

  if (workspace && !path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) {
    path = `${workspace}/${stripWorkspaceEchoPrefix(path.replace(/^\.?\//, ''), workspace)}`;
  }
  return { ok: true, block: { ...block, path } };
}

function getPendingTodos(todos) {
  return todos.filter(todo => todo.status !== 'done');
}

function formatTodoListForPrompt(todos) {
  if (!todos.length) return '';
  const visible = todos
    .filter(todo => todo.status !== 'done')
    .slice(0, 8)
    .map(todo => `${todo.id}. [${todo.status}] ${todo.title}${todo.path ? ` (${todo.path})` : ''}${todo.error ? ` — ${todo.error}` : ''}`);
  if (!visible.length) return '\nTODO LIST: all items done.\n';
  return `\nTODO LIST - finish these before saying Done:\n${visible.join('\n')}\n`;
}

function formatTodoListForDisplay(todos) {
  return [
    'Todo List',
    '',
    ...(todos.length
      ? todos.map(todo => `${todo.id}. ${todo.status === 'done' ? '[x]' : todo.status === 'failed' ? '[!]' : '[ ]'} ${todo.title}${todo.path ? `\n   ${todo.path}` : ''}${todo.error ? `\n   Error: ${todo.error}` : ''}`)
      : ['  (no todos detected)']),
  ].join('\n');
}

function injectTodoStatus(messages, todos) {
  const note = formatTodoListForPrompt(todos);
  if (!note) return messages;
  const done = todos
    .filter(todo => todo.status === 'done')
    .slice(-12)
    .map(todo => `- ${todo.title}${todo.path ? ` (${todo.path})` : ''}`)
    .join('\n');
  const completed = done ? `\nCOMPLETED OPS - do not repeat these:\n${done}\n` : '';
  return [
    ...messages,
    {
      role: 'user',
      content: `${note}${completed}\nUse this todo list as state. Work on the first pending/failed item next. Do not say Done until every todo is [done].`,
    },
  ];
}

function isPrematureDone(resp, todos) {
  if (!resp || !/\bdone\b|completed|finished|all set/i.test(resp)) return false;
  return getPendingTodos(todos).length > 0;
}

function recordRepeatedFailure(failures, tool, target, error) {
  const key = `${tool}:${target}:${String(error || '').slice(0, 200)}`;
  const count = (failures.get(key) || 0) + 1;
  failures.set(key, count);
  return count;
}

function shortPath(path) {
  if (!path) return '';
  const parts = String(path).split(/[\\/]/);
  return parts.slice(-2).join('/');
}

function previewText(text, maxLines = 80, maxChars = 6000) {
  const s = String(text || '');
  const lines = s.split('\n');
  const clipped = lines.slice(0, maxLines).join('\n').slice(0, maxChars);
  const more = lines.length > maxLines || s.length > maxChars;
  return more ? `${clipped}\n...[truncated preview]` : clipped;
}

function activityKindForTool(toolName) {
  if (toolName === 'edit_file') return 'edit';
  if (toolName === 'replace_file_range') return 'edit';
  if (['write_file', 'append_file', 'create_dir', 'delete_file'].includes(toolName)) return 'write';
  if (['read_file', 'list_dir', 'grep', 'glob'].includes(toolName)) return 'read';
  if (toolName === 'run_shell') return 'shell';
  return 'info';
}

function activityTitleForTool(toolName, args, toolResult) {
  if (toolName === 'edit_file') return `Edited ${shortPath(args.path)}`;
  if (toolName === 'replace_file_range') return `Edited ${shortPath(args.path)}:${args.start_line}-${args.end_line}`;
  if (toolName === 'create_dir') return `Created ${shortPath(args.path)}`;
  if (toolName === 'delete_file') return `Deleted ${shortPath(args.path)}`;
  if (toolName === 'read_file') return `Read ${shortPath(args.path)}`;
  if (toolName === 'list_dir') return `Listed ${shortPath(args.path || args.root || '.')}`;
  if (toolName === 'grep') return `Searched "${args.pattern}"`;
  if (toolName === 'glob') return `Matched "${args.pattern}"`;
  if (toolName === 'run_shell') {
    const exitCode = toolResult.result && typeof toolResult.result === 'object' ? toolResult.result.exitCode : 0;
    return `Ran ${args.cmd} (exit ${exitCode ?? 0})`;
  }
  return `${toolName} completed`;
}

function buildToolActivityDetail(toolName, args, toolResult) {
  const detail = {
    tool: toolName,
    path: args.path || args.root || args.cwd || '',
    status: toolResult.ok ? 'ok' : 'failed',
    error: toolResult.ok ? '' : toolResult.error,
  };
  if (toolName === 'edit_file') {
    const oldLines = String(args.old_string || '').split('\n').map(l => `- ${l}`).join('\n');
    const newLines = String(args.new_string || '').split('\n').map(l => `+ ${l}`).join('\n');
    detail.diff = `${oldLines}\n${newLines}`;
  }
  if (toolName === 'replace_file_range') {
    detail.diff = `@@ ${args.start_line}-${args.end_line} @@\n${String(args.content || '').split('\n').map(l => `+ ${l}`).join('\n')}`;
  }
  if (toolName === 'run_shell') {
    detail.command = [args.cmd, ...(args.args || [])].join(' ');
    if (toolResult.result && typeof toolResult.result === 'object') {
      detail.stdout = toolResult.result.stdout || '';
      detail.stderr = toolResult.result.stderr || '';
      detail.result = { exitCode: toolResult.result.exitCode ?? 0 };
    }
  } else if (toolName === 'read_file') {
    detail.preview = previewText(toolResult.result || '');
  } else if (toolResult.result) {
    detail.result = toolResult.result;
  }
  return detail;
}

async function verifyTodoFiles(todos, workspace) {
  const paths = todos.map(todo => todo.path).filter(Boolean);
  if (paths.length === 0) return { ok: true, failed: [] };
  const uniquePaths = [...new Set(paths)];
  const r = await ipcRenderer.invoke('agent:verify-files', { paths: uniquePaths, workspace });
  if (!r.ok) return { ok: false, failed: uniquePaths.map(path => ({ path, error: r.error || 'verification failed' })) };
  const failed = (r.results || []).filter(item => !item.ok);
  return { ok: failed.length === 0, failed };
}

function shouldContinueAfterPlainResponse(text, toolCallCount, continuationCount) {
  if (toolCallCount === 0 || continuationCount >= 3) return false;

  const normalized = text.toLowerCase().trim();
  if (!normalized || /\bdone\b|completed|finished|all files|task is complete/.test(normalized)) return false;

  const progressOnlyPatterns = [
    /\bnow let me\b/,
    /\blet me (create|add|build|write|update|implement)\b/,
    /\bi'?ll (create|add|build|write|update|implement|continue)\b/,
    /\bstarting (with|on)\b/,
    /\bnext,?\s+(i|let me|we)\b/,
    /\bcontinue (with|by|to)\b/,
    /\bremaining files?\b/,
    /\bcreate all the files\b/,
    /:\s*$/,
  ];

  return progressOnlyPatterns.some(pattern => pattern.test(normalized));
}

function isTruncatedFinish(reason) {
  return ['length', 'max_tokens', 'content_filter', 'context_length', 'truncated'].includes(String(reason).toLowerCase());
}

function sanitizeHistoryForTools(messages, activeTools = []) {
  const activeToolNames = new Set(activeTools.map(t => t.function?.name || t.name).filter(Boolean));
  const allowToolCalls = activeToolNames.size > 0;
  const keptToolCallIds = new Set();

  return messages.map(m => {
    if (m.role === 'assistant' && m.tool_calls) {
      const keptCalls = allowToolCalls
        ? m.tool_calls.filter(tc => activeToolNames.has(tc.function?.name || tc.name))
        : [];

      if (keptCalls.length === 0) {
        const content = (m.content || '').trim();
        return content
          ? { role: 'assistant', content }
          : { role: 'assistant', content: '[Previous tool call omitted from prompt history]' };
      }

      for (const tc of keptCalls) {
        if (tc.id) keptToolCallIds.add(tc.id);
      }
      return { ...m, tool_calls: keptCalls };
    }

    // llama.cpp can stay in tool-call parsing mode if old tool result roles
    // appear without matching active tools. Keep the useful fact, not the role.
    if (m.role === 'tool' && (!allowToolCalls || !keptToolCallIds.has(m.tool_call_id))) {
      return {
        role: 'user',
        content: `<previous_tool_result>\n${m.content || ''}\n</previous_tool_result>`,
      };
    }

    return m;
  });
}

/**
 * Some models dump tool call JSON as plain text or show file contents as markdown code blocks.
 * This parser extracts both and converts them into tool_calls format.
 */
function extractToolCallsFromText(text, history = []) {
  const calls = [];
  let idCounter = 0;

  // Pattern 1: <tool_call>...</tool_call> tags
  const tagMatches = [...text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)];
  for (const m of tagMatches) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj.name && (obj.arguments || obj.parameters) && !TEXT_WRITE_TOOLS.has(obj.name)) {
        calls.push({
          id: `fallback_${idCounter++}`,
          type: 'function',
          function: { name: obj.name, arguments: obj.arguments || obj.parameters },
        });
      }
    } catch { /* not valid JSON */ }
  }
  if (calls.length > 0) return calls;

  // Pattern 2: JSON objects with "name" + "arguments"/"parameters"
  const objects = extractJsonObjects(text);
  for (const obj of objects) {
    if (obj.name && (obj.arguments || obj.parameters) && !TEXT_WRITE_TOOLS.has(obj.name)) {
      calls.push({
        id: `fallback_${idCounter++}`,
        type: 'function',
        function: { name: obj.name, arguments: obj.arguments || obj.parameters },
      });
    }
  }
  if (calls.length > 0) return calls;

  return calls;
}

/** Extract all top-level balanced JSON objects from a string. */
function extractJsonObjects(text) {
  const results = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      // Find the matching closing brace
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') { depth--; if (depth === 0) break; }
        j++;
      }
      if (depth === 0) {
        try {
          const obj = JSON.parse(text.slice(i, j + 1));
          results.push(obj);
        } catch { /* not valid JSON */ }
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return results;
}

/** Render a collapsible thinking block in the chat container. */
function appendThinkingBlock(chat, text) {
  const wrap = document.createElement('div');
  wrap.className = 'thinking-block';

  const toggle = document.createElement('button');
  toggle.className = 'thinking-toggle';
  toggle.textContent = 'Thinking…';

  const content = document.createElement('div');
  content.className = 'thinking-content';
  content.textContent = text;

  toggle.addEventListener('click', () => {
    toggle.classList.toggle('open');
    content.classList.toggle('open');
  });

  wrap.appendChild(toggle);
  wrap.appendChild(content);
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
}

module.exports = { runAgentTurn };
