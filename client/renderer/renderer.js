const { ipcRenderer } = require('electron');

const urlInput = document.getElementById('backend-url');
const modelSelect = document.getElementById('model');
const pingBtn = document.getElementById('ping-btn');
const statusDot = document.getElementById('status-dot');
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');

const STORAGE_KEY = 'llm-cluster-backend-url';
urlInput.value = localStorage.getItem(STORAGE_KEY) || 'http://localhost:3000';

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

async function send() {
  const prompt = input.value.trim();
  if (!prompt) return;
  const backendUrl = urlInput.value.trim();
  const model = modelSelect.value;

  appendBubble('user', prompt);
  input.value = '';
  sendBtn.disabled = true;

  const placeholder = appendBubble('assistant', 'thinking…');
  placeholder.classList.add('loading');

  const r = await ipcRenderer.invoke('send-prompt', { backendUrl, prompt, model });
  placeholder.remove();

  if (r.ok) {
    appendBubble('assistant', r.data.response, `${r.data.worker} · ${r.data.model}`);
  } else {
    appendBubble('error', `Error: ${r.error}`);
  }
  sendBtn.disabled = false;
  input.focus();
}

sendBtn.addEventListener('click', send);
pingBtn.addEventListener('click', ping);

input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

ping(); // auto-test on launch
