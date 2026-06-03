'use strict';

const vscode = require('vscode');
const { requestCompletion } = require('./transport');
const {
  getConfig,
  getManagerBaseUrl,
  getModelName,
  getTimeoutMs,
  getInvocationMode,
  getEngineEndpoint,
  getClientProxyUrl,
  getPreferredWorkerId,
  getPreferredWorkerEndpoint,
  setInvocationMode,
  setEngineUrl,
  setClientProxyUrl,
  setPreferredWorkerId,
  setPreferredWorkerEndpoint,
  setUseWorkerEndpointForDirect,
  updateSetting,
} = require('./config');

const HISTORY_KEY = 'llm-cluster.dashboardHistory';
const DASHBOARD_TITLE = 'LLM Cluster Dashboard';
const DASHBOARD_SYSTEM_PROMPT = [
  'You are the LLM Cluster dashboard assistant.',
  'Help with extension settings, chat, history, and available commands.',
  'Be concise, practical, and accurate.',
].join(' ');

let dashboardPanel = null;
let dashboardState = null;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeMessages(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((message) => ({
      role: String(message?.role || 'assistant'),
      text: String(message?.text || message?.content || ''),
      pending: Boolean(message?.pending),
    }))
    .filter((message) => message.text.length > 0 || message.pending);
}

function normalizeHistoryEntries(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => ({
      id: String(entry?.id || `history-${Date.now()}`),
      title: String(entry?.title || 'Saved chat'),
      createdAt: String(entry?.createdAt || new Date().toISOString()),
      model: String(entry?.model || ''),
      messages: normalizeMessages(entry?.messages),
    }))
    .filter((entry) => entry.messages.length > 0);
}

function createHistoryTitle(messages) {
  const firstUser = normalizeMessages(messages).find((message) => message.role === 'user');
  if (!firstUser) {
    return 'Saved chat';
  }

  const preview = firstUser.text.replace(/\s+/g, ' ').trim().slice(0, 48);
  return preview ? `Chat: ${preview}${firstUser.text.length > 48 ? '…' : ''}` : 'Saved chat';
}

function getDashboardSettings() {
  return {
    managerUrl: normalizeText(getManagerBaseUrl()),
    model: normalizeText(getModelName()),
    enableInlineCompletions: Boolean(getConfig().get('enableInlineCompletions', true)),
    maxContextChars: Number(getConfig().get('maxContextChars', 6000)),
    maxSuffixChars: Number(getConfig().get('maxSuffixChars', 1500)),
    invocationMode: normalizeText(getInvocationMode()),
    engineUrl: normalizeText(getEngineEndpoint()),
    useWorkerEndpointForDirectCalls: Boolean(getConfig().get('useWorkerEndpointForDirectCalls', false)),
    clientProxyUrl: normalizeText(getClientProxyUrl()),
    requestTimeoutMs: Number(getTimeoutMs()),
    openOnStartup: Boolean(getConfig().get('openOnStartup', true)),
    preferredWorkerId: normalizeText(getPreferredWorkerId()),
    preferredWorkerEndpoint: normalizeText(getPreferredWorkerEndpoint()),
  };
}

function getInitialChatMessages(historyEntries) {
  const latestHistory = historyEntries[0];
  if (latestHistory && Array.isArray(latestHistory.messages) && latestHistory.messages.length > 0) {
    return latestHistory.messages.map((message) => ({ role: message.role, text: message.text }));
  }

  return [];
}

function buildRequestMessages(chatMessages) {
  const normalizedMessages = normalizeMessages(chatMessages);
  return [
    {
      role: 'system',
      content: DASHBOARD_SYSTEM_PROMPT,
    },
    ...normalizedMessages.filter((message) => !message.pending).map((message) => ({
      role: message.role,
      content: message.text,
    })),
  ];
}

function createState(context) {
  const historyEntries = normalizeHistoryEntries(context.globalState.get(HISTORY_KEY, []));

  return {
    settings: getDashboardSettings(),
    historyEntries,
    chatMessages: getInitialChatMessages(historyEntries),
    busy: false,
    status: 'Ready',
    error: '',
  };
}

async function persistHistory(context, historyEntries) {
  await context.globalState.update(HISTORY_KEY, historyEntries);
}

function coerceSettingValue(key, value) {
  switch (key) {
    case 'enableInlineCompletions':
    case 'useWorkerEndpointForDirectCalls':
    case 'openOnStartup':
      return Boolean(value);
    case 'maxContextChars':
    case 'maxSuffixChars':
    case 'requestTimeoutMs':
      return Number(value);
    default:
      return String(value ?? '').trim();
  }
}

async function saveSetting(key, value) {
  const coerced = coerceSettingValue(key, value);

  switch (key) {
    case 'invocationMode':
      return setInvocationMode(coerced);
    case 'engineUrl':
      return setEngineUrl(coerced);
    case 'clientProxyUrl':
      return setClientProxyUrl(coerced);
    case 'preferredWorkerId':
      return setPreferredWorkerId(coerced);
    case 'preferredWorkerEndpoint':
      return setPreferredWorkerEndpoint(coerced);
    case 'useWorkerEndpointForDirectCalls':
      return setUseWorkerEndpointForDirect(coerced);
    default:
      return updateSetting(key, coerced);
  }
}

function renderDashboardHtml(state) {
  const initialState = scriptJson(state);
  // ... (HTML string remains the same, omitting here for brevity if you just copy-pasted it earlier, 
  // but included fully to ensure it works)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      color-scheme: dark;
      --bg: #091019;
      --panel: #121a26;
      --panel-2: #182131;
      --panel-3: #0f1722;
      --text: #eef4ff;
      --muted: #97a5be;
      --border: #273548;
      --accent: #7df0b0;
      --accent-2: #74b8ff;
      --warn: #ffd166;
      --danger: #ff8c82;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    body {
      margin: 0;
      padding: 14px;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(116, 184, 255, 0.18), transparent 28%),
        radial-gradient(circle at top right, rgba(125, 240, 176, 0.12), transparent 24%),
        linear-gradient(180deg, #07101a 0%, #0e1621 100%);
      color: var(--text);
      box-sizing: border-box;
    }
    * { box-sizing: border-box; }
    .shell {
      display: grid;
      grid-template-rows: auto 1fr;
      gap: 14px;
      min-height: calc(100vh - 28px);
    }
    .hero {
      border: 1px solid rgba(125, 240, 176, 0.18);
      border-radius: 20px;
      padding: 16px;
      background: linear-gradient(135deg, rgba(125, 240, 176, 0.12), rgba(116, 184, 255, 0.1));
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.36);
    }
    .hero-top {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      align-items: start;
    }
    .title {
      margin: 0;
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .subtitle {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
      max-width: 78ch;
    }
    .status-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 10px;
      border-radius: 999px;
      font-size: 12px;
      color: var(--text);
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(10px);
    }
    .chip strong { color: var(--accent); }
    .chip.secondary strong { color: var(--accent-2); }
    .chip.warn strong { color: var(--warn); }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.85fr);
      gap: 14px;
      min-height: 0;
    }
    .column {
      display: flex;
      flex-direction: column;
      gap: 14px;
      min-height: 0;
    }
    .panel {
      background: rgba(14, 20, 30, 0.78);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(12px);
      overflow: hidden;
    }
    .panel-header {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      padding: 14px 14px 10px;
      flex-wrap: wrap;
    }
    .panel-title {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    .panel-subtitle {
      color: var(--muted);
      font-size: 12px;
      margin-top: 3px;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .toolbar button,
    .history-actions button,
    .composer-actions button,
    .quick-actions button {
      border: 1px solid var(--border);
      background: var(--panel-2);
      color: var(--text);
      border-radius: 999px;
      padding: 9px 13px;
      cursor: pointer;
      font: inherit;
      transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
    }
    .toolbar button:hover,
    .history-actions button:hover,
    .composer-actions button:hover,
    .quick-actions button:hover { transform: translateY(-1px); }
    .toolbar button.primary,
    .history-actions button.primary,
    .composer-actions button.primary,
    .quick-actions button.primary {
      background: linear-gradient(135deg, rgba(125, 240, 176, 0.16), rgba(116, 184, 255, 0.18));
      border-color: rgba(125, 240, 176, 0.32);
    }
    .toolbar button.secondary,
    .history-actions button.secondary,
    .composer-actions button.secondary,
    .quick-actions button.secondary {
      background: rgba(255, 255, 255, 0.04);
    }
    .chat-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 0 14px 14px;
      min-height: 320px;
      max-height: 48vh;
      overflow: auto;
    }
    .message {
      border-radius: 16px;
      border: 1px solid var(--border);
      padding: 12px;
      background: rgba(255, 255, 255, 0.03);
      position: relative;
    }
    .message::before {
      content: '';
      position: absolute;
      left: 0;
      top: 12px;
      bottom: 12px;
      width: 3px;
      border-radius: 999px;
      background: var(--muted);
      opacity: 0.75;
    }
    .message.user::before { background: var(--accent-2); }
    .message.assistant::before { background: var(--accent); }
    .message.system::before { background: var(--warn); }
    .message-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      padding-left: 8px;
      margin-bottom: 8px;
    }
    .message-body {
      white-space: pre-wrap;
      line-height: 1.55;
      font-size: 13px;
      padding-left: 8px;
      word-break: break-word;
    }
    .empty {
      margin: 14px;
      padding: 18px;
      border-radius: 16px;
      border: 1px dashed var(--border);
      color: var(--muted);
      background: rgba(255, 255, 255, 0.02);
    }
    .composer {
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0.04));
    }
    textarea,
    input,
    select {
      width: 100%;
      color: var(--text);
      background: var(--panel-3);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 12px;
      font: inherit;
      outline: none;
    }
    textarea { min-height: 100px; resize: vertical; }
    textarea:focus,
    input:focus,
    select:focus {
      border-color: rgba(125, 240, 176, 0.45);
      box-shadow: 0 0 0 3px rgba(125, 240, 176, 0.12);
    }
    .composer-actions,
    .history-actions,
    .quick-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }
    .section-body {
      padding: 0 14px 14px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .settings-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .setting-card,
    .history-card {
      border: 1px solid var(--border);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.03);
      padding: 11px;
    }
    .setting-card label,
    .history-card .headline {
      display: block;
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 6px;
      color: var(--text);
    }
    .help {
      display: block;
      margin-top: 6px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
    }
    .history-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-height: 38vh;
      overflow: auto;
    }
    .history-meta {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 10px;
    }
    .pill-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .pill {
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 11px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--muted);
      background: rgba(255, 255, 255, 0.03);
    }
    .banner {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      padding: 0 14px 14px;
    }
    .error { color: var(--danger); }
    @media (max-width: 1080px) {
      .layout { grid-template-columns: 1fr; }
      .settings-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <section class="hero">
      <div class="hero-top">
        <div>
          <h1 class="title">LLM Cluster Dashboard</h1>
          <p class="subtitle">Dock this tab wherever you want in VS Code. Use the left side for chat, the right side for live settings and saved history.</p>
        </div>
        <div class="status-row">
          <span class="chip"><strong>Mode</strong> <span id="mode-chip"></span></span>
          <span class="chip secondary"><strong>Model</strong> <span id="model-chip"></span></span>
          <span class="chip warn"><strong>Status</strong> <span id="status-chip"></span></span>
        </div>
      </div>
      <div class="pill-row" id="settings-summary"></div>
    </section>

    <div class="layout">
      <div class="column">
        <section class="panel">
          <div class="panel-header">
            <div>
              <div class="panel-title">Chat</div>
              <div class="panel-subtitle">Ask questions, try prompts, or use the current chat as a scratchpad.</div>
            </div>
            <div class="toolbar">
              <button class="secondary" id="btn-open-chat">Open Sidebar Chat</button>
              <button class="secondary" id="btn-ask">Ask Prompt</button>
              <button class="secondary" id="btn-task">Send Task</button>
            </div>
          </div>
          <div class="chat-list" id="chat-list"></div>
          <div class="composer">
            <textarea id="chat-input" placeholder="Type a prompt for the dashboard chat..."></textarea>
            <div class="quick-actions">
              <button class="secondary" data-template="Give me a concise summary of this extension.">Summary</button>
              <button class="secondary" data-template="Show me the main commands and where they live in the code.">Commands</button>
              <button class="secondary" data-template="What settings can I change from this panel?">Settings help</button>
            </div>
            <div class="composer-actions">
              <button class="secondary" id="btn-clear">Clear Chat</button>
              <button class="secondary" id="btn-save">Save to History</button>
              <button class="primary" id="btn-send">Send</button>
            </div>
          </div>
        </section>
      </div>

      <div class="column">
        <section class="panel">
          <div class="panel-header">
            <div>
              <div class="panel-title">Live Settings</div>
              <div class="panel-subtitle">Changes save directly into the extension configuration.</div>
            </div>
            <div class="toolbar">
              <button class="secondary" id="btn-refresh-settings">Refresh</button>
              <button class="secondary" id="btn-open-settings">Open VS Code Settings</button>
            </div>
          </div>
          <div class="section-body">
            <div class="settings-grid" id="settings-grid"></div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <div class="panel-title">History</div>
              <div class="panel-subtitle">Saved chat snapshots live here and can be restored instantly.</div>
            </div>
            <div class="toolbar">
              <button class="secondary" id="btn-history-refresh">Refresh</button>
            </div>
          </div>
          <div class="section-body">
            <div class="history-meta" id="history-meta"></div>
            <div class="history-list" id="history-list"></div>
          </div>
        </section>
      </div>
    </div>

    <div class="banner" id="banner">Tip: drag this panel tab to dock it on the left, right, or bottom of the editor area.</div>
  </div>

  <script id="dashboard-state" type="application/json">${initialState}</script>
  <script>
    const vscode = acquireVsCodeApi();
    const initialState = JSON.parse(document.getElementById('dashboard-state').textContent);
    const state = {
      settings: initialState.settings || {},
      historyEntries: initialState.historyEntries || [],
      chatMessages: initialState.chatMessages || [],
      busy: Boolean(initialState.busy),
      status: initialState.status || 'Ready',
      error: initialState.error || '',
    };

    const settingsMeta = [
      { key: 'managerUrl', label: 'Manager URL', kind: 'text', help: 'Base URL for the manager routing path.' },
      { key: 'model', label: 'Model', kind: 'text', help: 'Model name or prefix sent with prompts.' },
      { key: 'enableInlineCompletions', label: 'Inline Completions', kind: 'checkbox', help: 'Enable ghost-text completions in the editor.' },
      { key: 'maxContextChars', label: 'Max Context Chars', kind: 'number', help: 'How much text before the cursor is included.' },
      { key: 'maxSuffixChars', label: 'Max Suffix Chars', kind: 'number', help: 'How much text after the cursor is included.' },
      { key: 'invocationMode', label: 'Invocation Mode', kind: 'select', options: ['manager', 'direct', 'client'], help: 'How prompts are routed.' },
      { key: 'engineUrl', label: 'Engine URL', kind: 'text', help: 'Direct engine endpoint for direct mode.' },
      { key: 'useWorkerEndpointForDirectCalls', label: 'Use Worker Endpoint', kind: 'checkbox', help: 'Auto-switch to the selected worker endpoint in direct mode.' },
      { key: 'clientProxyUrl', label: 'Client Proxy URL', kind: 'text', help: 'Desktop/web app proxy URL.' },
      { key: 'requestTimeoutMs', label: 'Request Timeout', kind: 'number', help: 'Timeout in milliseconds for manager calls.' },
      { key: 'openOnStartup', label: 'Open On Startup', kind: 'checkbox', help: 'Show the main chat view when VS Code starts.' },
    ];

    const el = {
      chatList: document.getElementById('chat-list'),
      chatInput: document.getElementById('chat-input'),
      settingsGrid: document.getElementById('settings-grid'),
      historyList: document.getElementById('history-list'),
      historyMeta: document.getElementById('history-meta'),
      statusChip: document.getElementById('status-chip'),
      modelChip: document.getElementById('model-chip'),
      modeChip: document.getElementById('mode-chip'),
      banner: document.getElementById('banner'),
      settingsSummary: document.getElementById('settings-summary'),
    };

    function saveState() {
      vscode.setState(state);
    }

    function formatValue(value, kind) {
      if (kind === 'checkbox') return Boolean(value);
      if (kind === 'number') return Number(value) || 0;
      return String(value ?? '');
    }

    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function renderChat() {
      if (!state.chatMessages.length) {
        el.chatList.innerHTML = '<div class="empty">Ask a question or try one of the quick templates to start a conversation.</div>';
        return;
      }

      el.chatList.innerHTML = state.chatMessages.map((message) => {
        const roleClass = message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant';
        const label = roleClass === 'user' ? 'user' : roleClass === 'system' ? 'system' : 'assistant';
        const body = escapeHtml(message.text || '').replace(/\\n/g, '<br/>');
        return '<div class="message ' + roleClass + '"><div class="message-head"><span>' + label + '</span></div><div class="message-body">' + body + '</div></div>';
      }).join('');

      el.chatList.scrollTop = el.chatList.scrollHeight;
    }

    function renderSettings() {
      el.settingsGrid.innerHTML = settingsMeta.map((item) => {
        const value = state.settings[item.key];
        const id = \`setting-\${item.key}\`;
        if (item.kind === 'checkbox') {
          return \`
            <div class="setting-card">
              <label for="\${id}">\${escapeHtml(item.label)}</label>
              <input id="\${id}" type="checkbox" data-setting="\${item.key}" \${value ? 'checked' : ''} />
              <span class="help">\${escapeHtml(item.help || '')}</span>
            </div>
          \`;
        }

        if (item.kind === 'select') {
          return \`
            <div class="setting-card">
              <label for="\${id}">\${escapeHtml(item.label)}</label>
              <select id="\${id}" data-setting="\${item.key}">
                \${(item.options || []).map((option) => \`<option value="\${escapeHtml(option)}" \${String(value) === String(option) ? 'selected' : ''}>\${escapeHtml(option)}</option>\`).join('')}
              </select>
              <span class="help">\${escapeHtml(item.help || '')}</span>
            </div>
          \`;
        }

        return \`
          <div class="setting-card">
            <label for="\${id}">\${escapeHtml(item.label)}</label>
            <input id="\${id}" type="\${item.kind === 'number' ? 'number' : 'text'}" data-setting="\${item.key}" value="\${escapeHtml(formatValue(value, item.kind))}" />
            <span class="help">\${escapeHtml(item.help || '')}</span>
          </div>
        \`;
      }).join('');

      document.querySelectorAll('[data-setting]').forEach((field) => {
        field.onchange = async () => {
          const key = field.getAttribute('data-setting');
          const meta = settingsMeta.find((entry) => entry.key === key);
          let value;
          if (meta && meta.kind === 'checkbox') {
            value = field.checked;
          } else if (meta && meta.kind === 'number') {
            value = field.value === '' ? '' : Number(field.value);
          } else {
            value = field.value;
          }
          vscode.postMessage({ type: 'setting:update', key, value });
        };
      });
    }

    function renderHistory() {
      const total = state.historyEntries.length;
      el.historyMeta.textContent = total ? \`\${total} saved chat snapshot\${total === 1 ? '' : 's'} available.\` : 'No saved chat snapshots yet.';
      if (!total) {
        el.historyList.innerHTML = '<div class="empty">Use "Save to History" to keep a snapshot of the current conversation.</div>';
        return;
      }

      el.historyList.innerHTML = state.historyEntries.map((entry) => {
        const preview = (entry.messages.find((message) => message.role === 'user')?.text || entry.title || '').replace(/\\s+/g, ' ').trim();
        return \`
          <div class="history-card" data-history-id="\${escapeHtml(entry.id)}">
            <div class="headline">\${escapeHtml(entry.title || 'Saved chat')}</div>
            <div class="history-meta">\${escapeHtml(new Date(entry.createdAt).toLocaleString())} • \${escapeHtml(entry.messages.length)} messages</div>
            <div class="message-body" style="padding-left:0; font-size:12px; color: var(--muted);">\${escapeHtml(preview.slice(0, 120) || 'No preview available.')}</div>
            <div class="history-actions" style="margin-top:10px; justify-content:flex-start;">
              <button class="primary" data-action="history-load" data-history-id="\${escapeHtml(entry.id)}">Load</button>
              <button class="secondary" data-action="history-delete" data-history-id="\${escapeHtml(entry.id)}">Delete</button>
            </div>
          </div>
        \`;
      }).join('');

      document.querySelectorAll('[data-action="history-load"]').forEach((button) => {
        button.onclick = () => {
          vscode.postMessage({ type: 'history:load', id: button.getAttribute('data-history-id') });
        };
      });

      document.querySelectorAll('[data-action="history-delete"]').forEach((button) => {
        button.onclick = () => {
          vscode.postMessage({ type: 'history:delete', id: button.getAttribute('data-history-id') });
        };
      });
    }

    function renderSummary() {
      const summaryItems = [
        ['managerUrl', state.settings.managerUrl],
        ['invocationMode', state.settings.invocationMode],
        ['requestTimeoutMs', state.settings.requestTimeoutMs],
        ['openOnStartup', state.settings.openOnStartup ? 'enabled' : 'disabled'],
      ];

      el.settingsSummary.innerHTML = summaryItems.map(([label, value]) => \`<span class="pill"><strong>\${escapeHtml(label)}</strong> \${escapeHtml(value)}</span>\`).join('');
      el.modeChip.textContent = state.settings.invocationMode || 'manager';
      el.modelChip.textContent = state.settings.model || 'unknown';
      el.statusChip.textContent = state.error ? \`Error: \${state.error}\` : state.busy ? 'Thinking…' : state.status || 'Ready';
      el.statusChip.parentElement.classList.toggle('warn', Boolean(state.error || state.busy));
      el.banner.innerHTML = state.error ? \`<span class="error">\${escapeHtml(state.error)}</span>\` : 'Tip: drag this panel tab to dock it on the left, right, or bottom of the editor area.';
    }

    function renderAll() {
      renderSummary();
      renderChat();
      renderSettings();
      renderHistory();
      saveState();
    }

    function appendAssistantChunk(chunk) {
      const last = state.chatMessages[state.chatMessages.length - 1];
      if (last && last.role === 'assistant') {
        last.text = (last.text === 'Thinking...' ? '' : String(last.text || '')) + String(chunk || '');
        renderChat();
        saveState();
      }
    }

    document.getElementById('btn-send').onclick = () => {
      const prompt = String(el.chatInput.value || '').trim();
      if (!prompt) return;
      state.error = '';
      state.chatMessages.push({ role: 'user', text: prompt });
      state.chatMessages.push({ role: 'assistant', text: 'Thinking...' });
      el.chatInput.value = '';
      renderAll();
      vscode.postMessage({ type: 'chat:send', prompt, messages: state.chatMessages });
    };

    document.getElementById('btn-clear').onclick = () => {
      state.chatMessages = [];
      state.error = '';
      renderAll();
      vscode.postMessage({ type: 'chat:clear' });
    };

    document.getElementById('btn-save').onclick = () => {
      vscode.postMessage({ type: 'history:save', messages: state.chatMessages });
    };

    document.getElementById('btn-refresh-settings').onclick = () => {
      vscode.postMessage({ type: 'panel:refreshSettings' });
    };

    document.getElementById('btn-history-refresh').onclick = () => {
      vscode.postMessage({ type: 'panel:refreshHistory' });
    };

    document.getElementById('btn-open-settings').onclick = () => {
      vscode.postMessage({ type: 'panel:openSettings' });
    };

    document.getElementById('btn-open-chat').onclick = () => {
      vscode.postMessage({ type: 'panel:openChatView' });
    };

    document.getElementById('btn-ask').onclick = () => {
      vscode.postMessage({ type: 'panel:runCommand', command: 'llmCluster.ask' });
    };

    document.getElementById('btn-task').onclick = () => {
      vscode.postMessage({ type: 'panel:runCommand', command: 'llmCluster.sendTask' });
    };

    document.querySelectorAll('.quick-actions button[data-template]').forEach((button) => {
      button.onclick = () => {
        const template = button.getAttribute('data-template') || '';
        el.chatInput.value = template;
        el.chatInput.focus();
      };
    });

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      switch (message.type) {
        case 'dashboard:init':
        case 'dashboard:state':
          if (message.settings) state.settings = message.settings;
          if (message.historyEntries) state.historyEntries = message.historyEntries;
          if (message.chatMessages) state.chatMessages = message.chatMessages;
          if (typeof message.busy === 'boolean') state.busy = message.busy;
          if (typeof message.status === 'string') state.status = message.status;
          state.error = message.error || '';
          renderAll();
          break;
        case 'settings:updated':
          if (message.settings) state.settings = message.settings;
          state.error = '';
          renderAll();
          break;
        case 'settings:error':
          state.error = message.error || 'Failed to update settings';
          renderAll();
          break;
        case 'history:sync':
          state.historyEntries = message.historyEntries || [];
          renderAll();
          break;
        case 'history:apply':
          state.chatMessages = message.messages || [];
          state.error = '';
          renderAll();
          break;
        case 'chat:chunk':
          appendAssistantChunk(message.chunk);
          break;
        case 'chat:done':
          if (state.chatMessages.length && state.chatMessages[state.chatMessages.length - 1].role === 'assistant') {
            state.chatMessages[state.chatMessages.length - 1].text = String(message.responseText || state.chatMessages[state.chatMessages.length - 1].text || '').trim();
            state.chatMessages[state.chatMessages.length - 1].pending = false;
          }
          state.busy = false;
          state.status = 'Ready';
          state.error = '';
          renderAll();
          break;
        case 'chat:error':
          if (state.chatMessages.length && state.chatMessages[state.chatMessages.length - 1].role === 'assistant') {
            state.chatMessages[state.chatMessages.length - 1].text = \`Error: \${message.error || 'Unknown error'}\`;
          }
          state.busy = false;
          state.status = 'Ready';
          state.error = message.error || 'Chat request failed';
          renderAll();
          break;
        case 'chat:cleared':
          state.chatMessages = [];
          state.busy = false;
          state.status = 'Ready';
          renderAll();
          break;
        default:
          break;
      }
    });

    renderAll();
    vscode.postMessage({ type: 'dashboard:ready' });
  </script>
</body>
</html>`;
}

async function handleSettingUpdate(panel, context, state, key, value) {
  try {
    const ok = await saveSetting(key, value);
    if (ok) {
      state.settings = getDashboardSettings();
      panel.webview.postMessage({ type: 'settings:updated', settings: state.settings });
    } else {
      panel.webview.postMessage({ type: 'settings:error', error: 'Validation failed or save rejected.' });
    }
  } catch (error) {
    panel.webview.postMessage({ type: 'settings:error', error: error.message });
  }
}

// ==========================================
// NEW: Added Webview Panel Initialization 
// ==========================================

function showDashboard(context) {
  if (dashboardPanel) {
    dashboardPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  dashboardState = createState(context);

  dashboardPanel = vscode.window.createWebviewPanel(
    'llmClusterDashboard',
    DASHBOARD_TITLE,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: []
    }
  );

  dashboardPanel.webview.html = renderDashboardHtml(dashboardState);

  dashboardPanel.webview.onDidReceiveMessage(async (message) => {
    switch (message.type) {
      case 'dashboard:ready':
        dashboardPanel.webview.postMessage({ type: 'dashboard:init', ...dashboardState });
        break;

      case 'setting:update':
        await handleSettingUpdate(dashboardPanel, context, dashboardState, message.key, message.value);
        break;

      case 'chat:send':
        dashboardState.busy = true;
        dashboardPanel.webview.postMessage({ type: 'dashboard:state', busy: true });
        try {
          const payloadMessages = buildRequestMessages(message.messages);
          const response = await requestCompletion(payloadMessages, null, (chunk) => {
            dashboardPanel.webview.postMessage({ type: 'chat:chunk', chunk });
          });
          dashboardState.chatMessages = message.messages;
          dashboardPanel.webview.postMessage({ type: 'chat:done', responseText: response });
        } catch (error) {
          dashboardPanel.webview.postMessage({ type: 'chat:error', error: error.message });
        }
        break;

      case 'chat:clear':
        dashboardState.chatMessages = [];
        dashboardPanel.webview.postMessage({ type: 'chat:cleared' });
        break;

      case 'history:save':
        const newEntry = {
          id: `history-${Date.now()}`,
          title: createHistoryTitle(message.messages),
          createdAt: new Date().toISOString(),
          model: getModelName(),
          messages: message.messages
        };
        dashboardState.historyEntries.unshift(newEntry);
        await persistHistory(context, dashboardState.historyEntries);
        dashboardPanel.webview.postMessage({ type: 'history:sync', historyEntries: dashboardState.historyEntries });
        break;

      case 'history:load':
        const entryToLoad = dashboardState.historyEntries.find(e => e.id === message.id);
        if (entryToLoad) {
          dashboardState.chatMessages = entryToLoad.messages;
          dashboardPanel.webview.postMessage({ type: 'history:apply', messages: dashboardState.chatMessages });
        }
        break;

      case 'history:delete':
        dashboardState.historyEntries = dashboardState.historyEntries.filter(e => e.id !== message.id);
        await persistHistory(context, dashboardState.historyEntries);
        dashboardPanel.webview.postMessage({ type: 'history:sync', historyEntries: dashboardState.historyEntries });
        break;

      case 'panel:refreshSettings':
        dashboardState.settings = getDashboardSettings();
        dashboardPanel.webview.postMessage({ type: 'settings:updated', settings: dashboardState.settings });
        break;

      case 'panel:openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'llm-cluster');
        break;

      case 'panel:runCommand':
        vscode.commands.executeCommand(message.command);
        break;
    }
  });

  dashboardPanel.onDidDispose(() => {
    dashboardPanel = null;
    dashboardState = null;
  });
}

module.exports = {
  openDashboardPanel: showDashboard,
  showDashboard
};