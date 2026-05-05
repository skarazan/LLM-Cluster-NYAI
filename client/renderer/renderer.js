const { ipcRenderer } = require('electron');

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

const STORAGE_KEY = 'llm-cluster-backend-url';
urlInput.value = localStorage.getItem(STORAGE_KEY) || '';

// In-memory conversation history — cleared on "New Chat"
let history = [];
let sessionTokens = { prompt: 0, response: 0 };

function updateSessionTokensDisplay() {
  sessionTokensEl.textContent = `in: ${sessionTokens.prompt} · out: ${sessionTokens.response}`;
}

urlInput.addEventListener('change', () => {
  localStorage.setItem(STORAGE_KEY, urlInput.value.trim());
  setStatus('unknown');
});

function setStatus(s) {
  statusDot.className = `dot dot-${s}`;
  statusDot.title = s;
}

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

async function ping() {
  const url = urlInput.value.trim();
  if (!url) return;
  setStatus('pending');
  const r = await ipcRenderer.invoke('ping-backend', { backendUrl: url });
  setStatus(r.ok ? 'online' : 'offline');
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

  // Multiple managers found — show dropdown
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

// --- Chat ---

async function send() {
  const prompt = input.value.trim();
  if (!prompt) return;
  const backendUrl = urlInput.value.trim();
  const model = modelSelect.value;

  history.push({ role: 'user', content: prompt });

  appendBubble('user', prompt);
  input.value = '';
  sendBtn.disabled = true;

  const placeholder = appendBubble('assistant', 'thinking…');
  placeholder.classList.add('loading');

  const r = await ipcRenderer.invoke('send-prompt', { backendUrl, messages: history, model });
  placeholder.remove();

  if (r.ok) {
    const tok = r.data.tokens;
    let meta = `${r.data.worker} · ${r.data.model}`;
    if (tok) {
      meta += ` · in ${tok.prompt} / out ${tok.response} tok`;
      if (tok.tokensPerSec !== null && tok.tokensPerSec !== undefined) {
        meta += ` · ${tok.tokensPerSec} tok/s`;
      }
    }
    appendBubble('assistant', r.data.response, meta);
    history.push({ role: 'assistant', content: r.data.response });

    if (tok) {
      sessionTokens.prompt   += tok.prompt   || 0;
      sessionTokens.response += tok.response || 0;
      updateSessionTokensDisplay();
    }
  } else {
    appendBubble('error', `Error: ${r.error}`);
    history.pop(); // roll back optimistic user push
  }
  sendBtn.disabled = false;
  input.focus();
}

function newChat() {
  history = [];
  sessionTokens = { prompt: 0, response: 0 };
  updateSessionTokensDisplay();
  chat.innerHTML = '';
  input.focus();
}

sendBtn.addEventListener('click', send);
pingBtn.addEventListener('click', ping);
newChatBtn.addEventListener('click', newChat);

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

// On launch: auto-discover if no URL saved, otherwise ping existing
if (!localStorage.getItem(STORAGE_KEY)) {
  discover();
} else {
  ping();
}
