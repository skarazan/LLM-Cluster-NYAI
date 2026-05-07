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

  let history = [...messages];
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
      return history;
    }

    // Has tool calls — show approval cards and execute
    // Append assistant's tool_calls turn to history
    history.push({ role: 'assistant', content: data.response || '', tool_calls: data.tool_calls });

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

module.exports = { runAgentTurn };
