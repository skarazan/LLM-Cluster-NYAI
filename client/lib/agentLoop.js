'use strict';

const { ipcRenderer }   = require('electron');
const { buildApprovalCard } = require('../renderer/components/approvalCard');
const { getTool }       = require('./tools');

const MAX_TOOL_CALLS = 25;

// Tools that can never be auto-approved or remembered
const ALWAYS_CONFIRM = new Set(['delete_file', 'run_shell']);

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
async function runAgentTurn(opts) {
  const {
    backendUrl, messages, model, tools,
    workspace, approvalMode,
    chat, appendBubble, setLoading,
    abortRef, remembered,
  } = opts;

  // Prepend a system message so the model knows the workspace root
  // Replace or insert at index 0
  let history = [...messages];
  const toolNames = tools.map(t => t.function?.name || t.name).join(', ');
  const systemMsg = {
    role: 'system',
    content: `You are a coding assistant with filesystem tools. Tools: ${toolNames}.

WORKSPACE = "${workspace}"

CRITICAL PATH RULES — NEVER violate:
- Every tool call that takes a path argument MUST use an absolute path starting with "${workspace}/"
- list_dir root = "${workspace}" — call it as: list_dir({"path": "${workspace}"})
- read_file example: read_file({"path": "${workspace}/src/index.js"})
- write_file example: write_file({"path": "${workspace}/src/newfile.js", "content": "..."})
- NEVER pass "undefined", "null", "", ".", or any relative path as a path argument
- NEVER guess or omit the workspace prefix

WORKFLOW RULES:
0. Stay in context. Remember what you change, read or write. Do what the user tells you to accurately.
1. ALWAYS use tools to create/edit files. NEVER show file contents in chat as markdown or code blocks.
2. When asked to create multiple files, call write_file for EACH file one by one until ALL are created.
3. After each tool result, immediately call the next tool needed. You can explain but should go on to call more tools without stopping the work.
4. Do not create fake commands and do not forget slashes between files in directories.
`,
  };
  if (history.length > 0 && history[0].role === 'system') {
    history = [systemMsg, ...history.slice(1)];
  } else {
    history = [systemMsg, ...history];
  }

  let toolCallCount = 0;

  while (true) {
    if (abortRef.aborted) break;

    // Send to backend
    setLoading(true);
    const r = await ipcRenderer.invoke('send-prompt', { backendUrl, messages: history, model, tools });
    setLoading(false);

    if (abortRef.aborted) break;

    if (!r.ok) {
      appendBubble('error', `Error: ${r.error}`);
      break;
    }

    const data = r.data;

    // Extract and display thinking blocks (qwen3/r1/o1 variants) before stripping.
    if (data.response) {
      const thinkRe = /<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/g;
      const thinkMatches = [...data.response.matchAll(thinkRe)];
      if (thinkMatches.length > 0) {
        const thinkText = thinkMatches.map(m => m[2].trim()).join('\n\n---\n\n');
        appendThinkingBlock(chat, thinkText);
      }
      data.response = data.response.replace(thinkRe, '').trim();
    }
    if ((!data.tool_calls || data.tool_calls.length === 0) && data.response) {
      const extracted = extractToolCallsFromText(data.response, history);
      if (extracted.length > 0) {
        data.tool_calls = extracted;
        // Strip the JSON from response so it's not shown as text
        data.response = '';
      }
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

      // If model returned empty text after completing tool calls, show a completion message
      const displayResp = resp || (toolCallCount > 0 ? 'Done.' : '');
      appendBubble('assistant', displayResp, meta);
      history.push({ role: 'assistant', content: displayResp });
      // Strip the injected system message before returning — renderer stores clean history
      return history.filter(m => !(m.role === 'system' && m.content.startsWith('You are a coding assistant.')));
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
      const args     = call.function?.arguments || call.arguments || {};
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
              error: `old_string not found. Current file content:\n${readResult.result}\n\nUse write_file to rewrite the whole file with your changes applied.`,
            };
          }
        }

        // Surface errors visibly so the user can see what went wrong
        if (!toolResult.ok) {
          appendBubble('error', `Tool "${toolName}" failed: ${toolResult.error.split('\n')[0]}`);
        } else {
          // Show a brief success confirmation for write/shell tools
          const writingTools = ['write_file', 'edit_file', 'create_dir', 'delete_file', 'run_shell'];
          if (writingTools.includes(toolName)) {
            let summary;
            if (toolName === 'run_shell' && toolResult.result && typeof toolResult.result === 'object') {
              const { stdout, stderr, exitCode } = toolResult.result;
              summary = `✓ ran: exit ${exitCode ?? 0}` + (stdout ? `\n${stdout.slice(0, 300)}` : '') + (stderr ? `\nstderr: ${stderr.slice(0, 200)}` : '');
            } else {
              summary = `✓ ${toolResult.result || toolName + ' completed'}`;
            }
            appendBubble('assistant', summary);
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
      if (obj.name && (obj.arguments || obj.parameters)) {
        calls.push({
          id: `fallback_${idCounter++}`,
          function: { name: obj.name, arguments: obj.arguments || obj.parameters },
        });
      }
    } catch { /* not valid JSON */ }
  }
  if (calls.length > 0) return calls;

  // Pattern 2: JSON objects with "name" + "arguments"/"parameters"
  const objects = extractJsonObjects(text);
  for (const obj of objects) {
    if (obj.name && (obj.arguments || obj.parameters)) {
      calls.push({
        id: `fallback_${idCounter++}`,
        function: { name: obj.name, arguments: obj.arguments || obj.parameters },
      });
    }
  }
  if (calls.length > 0) return calls;

  // Pattern 3: markdown code blocks — with or without a filename before them
  const SOURCE_EXTS = /\.(html?|css|js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|json|yaml|yml|md|txt|sh|env|toml|xml|svg)$/i;
  const codeBlockRe = /(?:(?:\*\*|`)?([^\s`*()\n]+)(?:\*\*|`)?\s*\n)?```[a-zA-Z]*\n([\s\S]*?)```/g;

  // Find last file path used in history (for inferring filename when missing)
  let lastFilePath = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === 'tool' && msg.content) {
      const m = msg.content.match(/"path"\s*:\s*"([^"]+)"/);
      if (m) { lastFilePath = m[1]; break; }
    }
  }

  let match;
  while ((match = codeBlockRe.exec(text)) !== null) {
    let filename = match[1] || null;
    const content = match[2];
    if (!content || content.trim().length < 10) continue;

    // If no filename captured, try to infer from context
    if (!filename || !SOURCE_EXTS.test(filename)) {
      // Look for a filename mentioned anywhere before this code block in the text
      const before = text.slice(0, match.index);
      const nearby = before.match(/([^\s`*()\n]+\.(html?|css|js|ts|py|rb|go|java|c|cpp|json|yaml|yml|sh|txt))\b/gi);
      if (nearby) {
        filename = nearby[nearby.length - 1]; // use most recent mention
      } else if (lastFilePath) {
        filename = lastFilePath; // fall back to last written file
      }
    }

    if (filename && SOURCE_EXTS.test(filename)) {
      calls.push({
        id: `fallback_${idCounter++}`,
        function: { name: 'write_file', arguments: { path: filename, content } },
      });
    }
  }

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
