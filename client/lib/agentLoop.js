'use strict';

const { ipcRenderer }   = require('electron');
const { buildApprovalCard } = require('../renderer/components/approvalCard');
const { getTool }       = require('./tools');

const MAX_TOOL_CALLS = 8;

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
    content: `You are a coding assistant. You have access to tools: ${toolNames}.

CRITICAL RULES:
- ALWAYS call tools directly using the tool call mechanism. NEVER write tool call JSON in your text response.
- NEVER say "I would use write_file" or show code blocks with tool JSON. Just CALL the tool.
- The workspace root is: ${workspace}
- ALL file paths in tool calls must use this exact workspace root as the base directory.
- For write_file, the path must look like: ${workspace}/filename.txt
- NEVER use placeholder paths. NEVER use /path/to/ or ~/Desktop/project/ unless that IS the workspace.
- Complete the task by actually calling tools. Do not explain what you will do, just do it.`,
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

    // Fallback: model sometimes dumps tool call JSON as plain text instead of using tool_calls field.
    // Try to extract and convert it so the loop still works.
    if ((!data.tool_calls || data.tool_calls.length === 0) && data.response) {
      const extracted = extractToolCallsFromText(data.response);
      if (extracted.length > 0) {
        data.tool_calls = extracted;
        // Strip the JSON from response so it's not shown as text
        data.response = '';
      }
    }

    // No tool calls — final text response
    if (!data.tool_calls || data.tool_calls.length === 0) {
      const tok = data.tokens;
      let meta = `${data.worker} · ${data.model}`;
      if (tok) {
        meta += ` · in ${tok.prompt} / out ${tok.response} tok`;
        if (tok.tokensPerSec != null) meta += ` · ${tok.tokensPerSec} tok/s`;
      }
      appendBubble('assistant', data.response, meta);
      history.push({ role: 'assistant', content: data.response });
      // Strip the injected system message before returning — renderer stores clean history
      return history.filter(m => !(m.role === 'system' && m.content.startsWith('You are a coding assistant.')));
    }

    // Has tool calls — show approval cards and execute
    // Append assistant's tool_calls turn to history (suppress response text — it's often the raw JSON or a preamble)
    history.push({ role: 'assistant', content: '', tool_calls: data.tool_calls });

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
        // Surface errors visibly so the user can see what went wrong
        if (!toolResult.ok) {
          appendBubble('error', `Tool "${toolName}" failed: ${toolResult.error}`);
        } else {
          // Show a brief success confirmation for write/shell tools
          const writingTools = ['write_file', 'edit_file', 'create_dir', 'delete_file', 'run_shell'];
          if (writingTools.includes(toolName)) {
            appendBubble('assistant', `✓ ${toolResult.result || toolName + ' completed'}`);
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
 * Some models (llama3.1) dump tool call JSON as plain text instead of using tool_calls.
 * This parser finds those and converts them into the standard tool_calls format.
 * Handles patterns like:
 *   {"name": "write_file", "parameters": {...}}
 *   [{"name": "write_file", "arguments": {...}}]
 *   <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 */
function extractToolCallsFromText(text) {
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

  // Pattern 2: extract all balanced JSON objects from the text, then check each
  const objects = extractJsonObjects(text);
  for (const obj of objects) {
    if (obj.name && (obj.arguments || obj.parameters)) {
      calls.push({
        id: `fallback_${idCounter++}`,
        function: { name: obj.name, arguments: obj.arguments || obj.parameters },
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

module.exports = { runAgentTurn };
