const { ipcRenderer } = require('electron');
const { runAgentTurn } = require('../lib/agentLoop');
const { getToolSchemas } = require('../lib/tools');

// --- Update banner ---
const updateBanner  = document.getElementById('update-banner');
const updateMsg     = document.getElementById('update-msg');
const updateBtn     = document.getElementById('update-btn');
const updateDismiss = document.getElementById('update-dismiss');

ipcRenderer.on('update-available', (_, { version }) => {
  updateMsg.textContent = `Update available: v${version}`;
  updateBanner.classList.remove('hidden');
});
updateBtn.addEventListener('click', () => ipcRenderer.send('open-releases'));
updateDismiss.addEventListener('click', () => updateBanner.classList.add('hidden'));

// --- DOM refs ---
const urlInput        = document.getElementById('backend-url');
const discoverBtn     = document.getElementById('discover-btn');
const discoveredSel   = document.getElementById('discovered');
const modelSelect     = document.getElementById('model');
const pingBtn         = document.getElementById('ping-btn');
const newChatBtn      = document.getElementById('new-chat-btn');
const statusDot       = document.getElementById('status-dot');
const sessionTokensEl = document.getElementById('session-tokens');
const chat            = document.getElementById('chat');
const input           = document.getElementById('input');
const sendBtn         = document.getElementById('send-btn');

// Code mode controls
const modeChatBtn    = document.getElementById('mode-chat');
const modeCodeBtn    = document.getElementById('mode-code');
const codeControls   = document.getElementById('code-controls');
const workspaceBtn   = document.getElementById('workspace-btn');
const workspaceLabel = document.getElementById('workspace-label');
const approvalSel    = document.getElementById('approval-mode');
const stopBtn        = document.getElementById('stop-btn');

const STORAGE_KEY      = 'llm-cluster-backend-url';
const MODE_KEY         = 'llm-cluster-mode';
const WORKSPACE_KEY    = 'llm-cluster-workspace';
const APPROVAL_KEY     = 'llm-cluster-approval-mode';
const DEFAULT_URL      = 'https://llm.tutorrev.live';

urlInput.value = localStorage.getItem(STORAGE_KEY) || DEFAULT_URL;

// --- State ---
let history       = [];
let sessionTokens = { prompt: 0, response: 0 };
let currentMode   = localStorage.getItem(MODE_KEY) || 'chat';  // 'chat' | 'code'
let workspace     = localStorage.getItem(WORKSPACE_KEY) || '';
// Sanitize stale 'undefined' / 'null' strings that may have been written to localStorage
if (workspace === 'undefined' || workspace === 'null') {
  workspace = '';
  localStorage.removeItem(WORKSPACE_KEY);
}
let abortRef      = { aborted: false };
let remembered    = new Set(); // "toolName:pathPrefix" approved this conversation

function updateSessionTokensDisplay() {
  sessionTokensEl.textContent = `in: ${sessionTokens.prompt} · out: ${sessionTokens.response}`;
}

// --- Mode toggle ---

function applyMode(mode) {
  currentMode = mode;
  localStorage.setItem(MODE_KEY, mode);
  if (mode === 'chat') {
    modeChatBtn.classList.add('active');
    modeCodeBtn.classList.remove('active');
    codeControls.classList.add('hidden');
  } else {
    modeCodeBtn.classList.add('active');
    modeChatBtn.classList.remove('active');
    codeControls.classList.remove('hidden');
    updateWorkspaceLabel();
    approvalSel.value = localStorage.getItem(APPROVAL_KEY) || 'strict';
  }
}

function updateWorkspaceLabel() {
  if (workspace) {
    const parts = workspace.split('/');
    workspaceLabel.textContent = parts[parts.length - 1] || workspace;
    workspaceBtn.title = workspace;
  } else {
    workspaceLabel.textContent = 'none';
    workspaceBtn.title = 'Click to choose a workspace folder';
  }
}

modeChatBtn.addEventListener('click', () => applyMode('chat'));
modeCodeBtn.addEventListener('click', () => applyMode('code'));

workspaceBtn.addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('agent:choose-workspace');
  if (result.ok && result.path && result.path !== 'undefined' && result.path !== 'null') {
    workspace = result.path;
    localStorage.setItem(WORKSPACE_KEY, workspace);
    updateWorkspaceLabel();
  }
});

approvalSel.addEventListener('change', () => {
  localStorage.setItem(APPROVAL_KEY, approvalSel.value);
});

stopBtn.addEventListener('click', () => {
  abortRef.aborted = true;
  stopBtn.classList.add('hidden');
  // sendBtn stays disabled until runAgentTurn resolves — prevents
  // sending a second prompt while the old request is still in-flight.
  // Show a status hint so the user knows we're waiting for the server.
  appendBubble('error', '[Stopping… waiting for server response to complete]');
});

// Apply stored mode on load
applyMode(currentMode);

// --- URL / connection ---

urlInput.addEventListener('change', () => {
  localStorage.setItem(STORAGE_KEY, urlInput.value.trim());
  setStatus('unknown');
});

function setStatus(s) {
  statusDot.className = `dot dot-${s}`;
  statusDot.title = s;
}

// --- Bubble helpers ---

function appendBubble(role, text, meta) {
  const wrap = document.createElement('div');
  wrap.className = `bubble ${role}`;
  const body = document.createElement('div');
  body.className = 'bubble-body';
  body.textContent = text;
  wrap.appendChild(body);
  if (meta) {
    const m = document.createElement('div');
    m.className = 'bubble-meta';
    m.textContent = meta;
    wrap.appendChild(m);
  }
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return wrap;
}

function appendThinkingBlock(text) {
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

// --- mDNS Discovery ---

async function discover() {
  discoverBtn.disabled = true;
  discoverBtn.textContent = '...';
  const managers = await ipcRenderer.invoke('discover-managers');
  discoverBtn.disabled = false;
  discoverBtn.textContent = 'Discover';

  if (managers.length === 0) {
    discoveredSel.classList.add('hidden');
    return;
  }
  if (managers.length === 1) {
    urlInput.value = managers[0].url;
    localStorage.setItem(STORAGE_KEY, managers[0].url);
    discoveredSel.classList.add('hidden');
    ping();
    return;
  }
  discoveredSel.innerHTML = managers.map(m =>
    `<option value="${m.url}">${m.name} (${m.url})</option>`
  ).join('');
  discoveredSel.classList.remove('hidden');
}

discoverBtn.addEventListener('click', discover);
discoveredSel.addEventListener('change', () => {
  urlInput.value = discoveredSel.value;
  localStorage.setItem(STORAGE_KEY, discoveredSel.value);
  discoveredSel.classList.add('hidden');
  ping();
});

// --- Ping ---

async function ping() {
  const url = urlInput.value.trim();
  if (!url) return;
  setStatus('pending');
  const r = await ipcRenderer.invoke('ping-backend', { backendUrl: url });
  setStatus(r.ok ? 'online' : 'offline');
}

// --- Chat (plain mode) ---

async function sendChat(prompt) {
  const backendUrl = urlInput.value.trim();
  const model      = modelSelect.value;

  history.push({ role: 'user', content: prompt });
  appendBubble('user', prompt);

  const placeholder = appendBubble('assistant', 'thinking…');
  placeholder.classList.add('loading');

  const r = await ipcRenderer.invoke('send-prompt', { backendUrl, messages: history, model });
  placeholder.remove();

  if (r.ok) {
    const tok = r.data.tokens;
    let meta = `${r.data.worker} · ${r.data.model}`;
    if (tok) {
      meta += ` · in ${tok.prompt} / out ${tok.response} tok`;
      if (tok.tokensPerSec != null) meta += ` · ${tok.tokensPerSec} tok/s`;
    }
    let raw = r.data.response || '';
    // Extract and show thinking blocks before stripping them.
    // Match <think>, <thinking>, <reasoning> — all variants emitted by qwen3 / r1 / o1-style models.
    const thinkRe = /<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/g;
    const thinkMatches = [...raw.matchAll(thinkRe)];
    if (thinkMatches.length > 0) {
      const thinkText = thinkMatches.map(m => m[2].trim()).join('\n\n---\n\n');
      appendThinkingBlock(thinkText);
      raw = raw.replace(thinkRe, '').trim();
    }
    const resp = raw || '';
    appendBubble('assistant', resp, meta);
    history.push({ role: 'assistant', content: resp });
    if (tok) {
      sessionTokens.prompt   += tok.prompt   || 0;
      sessionTokens.response += tok.response || 0;
      updateSessionTokensDisplay();
    }
  } else {
    appendBubble('error', `Error: ${r.error}`);
    history.pop();
  }
}

// --- Code mode (agent loop) ---

async function sendCode(prompt) {
  const backendUrl   = urlInput.value.trim();
  const model        = modelSelect.value;
  const approvalMode = approvalSel.value;

  if (!workspace) {
    appendBubble('error', 'No workspace selected. Click "Workspace" in the header to choose a folder.');
    return;
  }

  history.push({ role: 'user', content: prompt });
  appendBubble('user', prompt);

  abortRef = { aborted: false };
  stopBtn.classList.remove('hidden');

  let placeholder = appendBubble('assistant', 'thinking…');
  placeholder.classList.add('loading');

  let placeholderRemoved = false;
  function ensurePlaceholderRemoved() {
    if (!placeholderRemoved) { placeholder.remove(); placeholderRemoved = true; }
  }

  try {
    history = await runAgentTurn({
      backendUrl,
      messages: history,
      model,
      tools: getToolSchemas(workspace),
      workspace,
      approvalMode,
      chat,
      appendBubble: (...args) => { ensurePlaceholderRemoved(); return appendBubble(...args); },
      setLoading: (on) => {
        if (on && !placeholderRemoved) {
          // placeholder already showing
        } else if (!on) {
          ensurePlaceholderRemoved();
        }
      },
      abortRef,
      remembered,
    });
  } catch (err) {
    ensurePlaceholderRemoved();
    appendBubble('error', `Agent error: ${err.message}`);
    history.pop();
  }

  stopBtn.classList.add('hidden');
}

// --- Unified send ---

async function send() {
  const prompt = input.value.trim();
  if (!prompt) return;
  input.value = '';
  sendBtn.disabled = true;

  if (currentMode === 'code') {
    await sendCode(prompt);
  } else {
    await sendChat(prompt);
  }

  sendBtn.disabled = false;
  input.focus();
}

// --- New Chat ---

function newChat() {
  history       = [];
  sessionTokens = { prompt: 0, response: 0 };
  remembered    = new Set();
  abortRef      = { aborted: true }; // cancel any in-flight loop
  updateSessionTokensDisplay();
  chat.innerHTML = '';
  stopBtn.classList.add('hidden');
  input.focus();
}

// --- Event listeners ---

sendBtn.addEventListener('click', send);
pingBtn.addEventListener('click', ping);
newChatBtn.addEventListener('click', newChat);

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) send();
  }
});

// On launch: ping the default/saved URL
ping();
