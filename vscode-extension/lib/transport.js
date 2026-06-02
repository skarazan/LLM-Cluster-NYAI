'use strict';

const vscode = require('vscode');
const {
  getManagerBaseUrl,
  getModelName,
  getTimeoutMs,
  getInvocationMode,
  getEngineEndpoint,
  getClientProxyUrl,
} = require('./config');

function stripCodeFences(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';

  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  return trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/\s*```$/, '').trim();
}

function parseManagerResponse(bodyText) {
  const lines = String(bodyText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // Ignore keepalive noise or partial lines.
    }
  }

  const finalPayload = [...parsed].reverse().find((item) => item && typeof item.response === 'string');
  if (finalPayload) {
    return finalPayload.response;
  }

  const streamed = parsed
    .map((item) => (item && typeof item.chunk === 'string' ? item.chunk : ''))
    .join('');
  if (streamed) {
    return streamed;
  }

  const lastLine = lines[lines.length - 1] || '';
  if (lastLine) {
    try {
      const obj = JSON.parse(lastLine);
      if (obj && typeof obj.response === 'string') {
        return obj.response;
      }
    } catch {
      // Fall through to a clearer error below.
    }
  }

  throw new Error('Manager response did not contain a usable completion.');
}

async function requestCompletion(messages, token, onChunk, options = {}) {
  const managerBaseUrl = getManagerBaseUrl();
  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (token && typeof token.onCancellationRequested === 'function') {
    token.onCancellationRequested(() => controller.abort());
  }

  try {
    const mode = String(options.modeOverride || getInvocationMode());
    let endpoint = '';
    if (mode === 'direct') {
      endpoint = getEngineEndpoint();
    } else if (mode === 'client') {
      endpoint = getClientProxyUrl();
    } else {
      endpoint = `${managerBaseUrl}/chat`;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: getModelName(),
        messages,
        ...(Array.isArray(options.tools) && options.tools.length > 0 ? { tools: options.tools } : {}),
        ...(mode === 'manager' ? {
          preferredWorkerId: String(options.preferredWorkerId || '').trim(),
          agentMode: options.agentMode || null,
        } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Manager returned ${response.status} ${response.statusText}`);
    }

    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop();
        for (const part of parts) {
          const line = part;
          if (!line) continue;
          const trimmed = line.trim();
          if (!trimmed) continue;
          let handled = false;
          try {
            const obj = JSON.parse(trimmed);
            if (obj && typeof obj.chunk === 'string') {
              accumulated += obj.chunk;
              try { if (typeof onChunk === 'function') onChunk(obj.chunk); } catch {}
              handled = true;
            }
            if (obj && typeof obj.response === 'string') {
              accumulated = obj.response;
              try { if (typeof onChunk === 'function') onChunk(obj.response); } catch {}
              handled = true;
            }
          } catch {
            // not JSON — fall through to treat as raw text
          }
          if (!handled) {
            accumulated += trimmed;
            try { if (typeof onChunk === 'function') onChunk(trimmed); } catch {}
          }
        }
      }

      if (buffer.trim()) {
        const tb = buffer.trim();
        try {
          const obj = JSON.parse(tb);
          if (obj && typeof obj.chunk === 'string') {
            accumulated += obj.chunk;
            try { if (typeof onChunk === 'function') onChunk(obj.chunk); } catch {}
          }
          if (obj && typeof obj.response === 'string') {
            accumulated = obj.response;
            try { if (typeof onChunk === 'function') onChunk(obj.response); } catch {}
          }
        } catch {
          accumulated += tb;
          try { if (typeof onChunk === 'function') onChunk(tb); } catch {}
        }
      }

      return stripCodeFences(accumulated);
    }

    const bodyText = await response.text();
    let result = '';
    try {
      result = stripCodeFences(parseManagerResponse(bodyText));
    } catch {
      result = bodyText;
    }
    if (typeof onChunk === 'function' && result) onChunk(result);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function pingManager() {
  try {
    const response = await fetch(getManagerBaseUrl(), { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

async function showResultInEditor(text, languageId) {
  const document = await vscode.workspace.openTextDocument({
    content: text,
    language: languageId || 'markdown',
  });
  await vscode.window.showTextDocument(document, { preview: false });
}

module.exports = {
  stripCodeFences,
  parseManagerResponse,
  requestCompletion,
  pingManager,
  showResultInEditor,
};
