'use strict';

/* ==========================================================================
   Renderer controller — wires the DOM in index.html to the Electron main
   process (IPC) and to the code agent (lib/agentLoop.js).
   UI building blocks live in ./components (see UI_COMPONENTS.md).
   ========================================================================== */
const { ipcRenderer } = require('electron');
const { runAgentTurn } = require('../lib/agentLoop');
const { getToolSchemas } = require('../lib/tools');
const { h, clear, baseName, compactNumber } = require('./components/dom');
const { icon, brandMark } = require('./components/icons');
const { enhanceSelect } = require('./components/dropdown');
const { createPopover, autoGrow } = require('./components/ui');
const { createMessage, createTypingIndicator, createThinkingBlock, createActivityRow } = require('./components/messages');
const { getApprovalDock } = require('./components/approvalDock');
const { renderTodoPanel } = require('./components/todoPanel');

/* ── Platform / window chrome flags ─────────────────────────────────────── */
const query = new URLSearchParams(window.location.search);
const PLATFORM = query.get('platform') || process.platform;
const FRAME = query.get('frame') || 'native';
document.body.classList.add(`platform-${PLATFORM}`, `frame-${FRAME}`);

/* ── DOM refs ───────────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const updateBanner    = $('update-banner');
const updateMsg       = $('update-msg');
const updateBtn       = $('update-btn');
const updateDismiss   = $('update-dismiss');
const urlInput        = $('backend-url');
const discoverBtn     = $('discover-btn');
const discoveredList  = $('discovered');
const modelSelect     = $('model');
const pingBtn         = $('ping-btn');
const newChatBtn      = $('new-chat-btn');
const statusDot       = $('status-dot');
const connectionBtn   = $('connection-btn');
const connectionLabel = $('connection-label');
const connectionPop   = $('connection-popover');
const connectionStatus = $('connection-status');
const sessionTokensEl = $('session-tokens');
const runStatusEl     = $('run-status');
const conversation    = $('conversation');
const chat            = $('chat');
const input           = $('input');
const sendBtn         = $('send-btn');
const stopBtn         = $('stop-btn');
const composer        = $('composer');
const sidePanel       = $('side-panel');
const panelToggle     = $('panel-toggle');
const activityTitle   = $('activity-title');
const activitySubtitle = $('activity-subtitle');
const activityDetail  = $('activity-detail');
const activityClose   = $('activity-close');
const tabProgress     = $('tab-progress');
const tabDetails      = $('tab-details');
const panelProgress   = $('panel-progress');
const panelDetails    = $('panel-details');
const todoPanelEl     = $('todo-panel');
const todoCountEl     = $('todo-count');
const modeChatBtn     = $('mode-chat');
const modeCodeBtn     = $('mode-code');
const workspaceBtn    = $('workspace-btn');
const workspaceLabel  = $('workspace-label');
const workspaceCard   = $('workspace-card');
const workspaceCardName = $('workspace-card-name');
const workspaceCardPath = $('workspace-card-path');
const workspaceChangeBtn = $('workspace-change-btn');
const emptyWorkspaceBtn = $('empty-workspace-btn');
const emptyTitle      = $('empty-title');
const emptySubtitle   = $('empty-subtitle');
const suggestionsEl   = $('suggestions');
const approvalSel     = $('approval-mode');
const planModeCheck   = $('plan-mode');

/* ── Storage keys (unchanged from previous versions + model/panel) ──────── */
const STORAGE_KEY      = 'llm-cluster-backend-url';
const MODE_KEY         = 'llm-cluster-mode';
const WORKSPACE_KEY    = 'llm-cluster-workspace';
const APPROVAL_KEY     = 'llm-cluster-approval-mode';
const TODO_SESSION_KEY = 'llm-cluster-todo-session-id';
const MODEL_KEY        = 'llm-cluster-model';
const PANEL_KEY        = 'llm-cluster-panel';
const DEFAULT_URL      = 'https://llm.tutorrev.live';
const APPROVAL_ORDER   = ['strict', 'trusted', 'yolo'];

urlInput.value = localStorage.getItem(STORAGE_KEY) || DEFAULT_URL;

/* ── State ──────────────────────────────────────────────────────────────── */
let history       = [];
let sessionTokens = { prompt: 0, response: 0 };
let currentMode   = localStorage.getItem(MODE_KEY) === 'code' ? 'code' : 'chat';
let workspace     = localStorage.getItem(WORKSPACE_KEY) || '';
// Sanitize stale 'undefined' / 'null' strings that may have been written to localStorage
if (workspace === 'undefined' || workspace === 'null') {
  workspace = '';
  localStorage.removeItem(WORKSPACE_KEY);
}
let abortRef      = { aborted: false };
let remembered    = new Set(); // "toolName:pathPrefix" approved this conversation
let latestTodoDetail = 'No active todo list yet.';
let todoState     = { items: [] };
let activeRequestId = null;
let busy          = false;
let conversationEpoch = 0; // bumps on New chat so late results never leak into a fresh conversation
let workingEl     = null;
let panelAutoOpened = false;
let todoSessionId = localStorage.getItem(TODO_SESSION_KEY) || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
localStorage.setItem(TODO_SESSION_KEY, todoSessionId);

const approvalDock = getApprovalDock(document);

/* ── Static chrome: icons, brand, dropdowns ─────────────────────────────── */
function hydrateIcons(root = document) {
  root.querySelectorAll('.icon-slot[data-icon]').forEach((slot) => {
    if (slot.dataset.hydrated) return;
    slot.appendChild(icon(slot.dataset.icon, { size: Number(slot.dataset.size) || 16 }));
    slot.dataset.hydrated = '1';
  });
}
hydrateIcons();
$('brand-mark').appendChild(brandMark({ size: 22 }));
$('empty-mark').appendChild(brandMark({ size: 40 }));

const savedModel = localStorage.getItem(MODEL_KEY);
if (savedModel && [...modelSelect.options].some(o => o.value === savedModel)) modelSelect.value = savedModel;
const modelDropdown = enhanceSelect(modelSelect, { ariaLabel: 'Model', icon: 'cpu', align: 'end', placement: 'top', title: 'Choose a model' });
modelSelect.addEventListener('change', () => {
  localStorage.setItem(MODEL_KEY, modelSelect.value);
  updateEmptyState();
});

approvalSel.value = APPROVAL_ORDER.includes(localStorage.getItem(APPROVAL_KEY)) ? localStorage.getItem(APPROVAL_KEY) : 'strict';
const approvalDropdown = enhanceSelect(approvalSel, { ariaLabel: 'Permission mode', placement: 'top', className: 'permission-trigger' });

const resizeInput = autoGrow(input, 280);

/* ── Update banner ──────────────────────────────────────────────────────── */
ipcRenderer.on('update-available', (_, { version }) => {
  updateMsg.textContent = `Update available: v${version}`;
  updateBanner.classList.remove('hidden');
});
updateBtn.addEventListener('click', () => ipcRenderer.send('open-releases'));
updateDismiss.addEventListener('click', () => updateBanner.classList.add('hidden'));

function openExternal(url) {
  ipcRenderer.invoke('open-external', url).catch(() => {});
}

/* ── Session tokens / run status ────────────────────────────────────────── */
function updateSessionTokensDisplay() {
  sessionTokensEl.textContent = `in ${compactNumber(sessionTokens.prompt)} · out ${compactNumber(sessionTokens.response)}`;
  sessionTokensEl.title = `Tokens this session — prompt: ${sessionTokens.prompt}, response: ${sessionTokens.response}`;
}

let transientStatus = null;
let transientTimer = null;
function flashStatus(text, ms = 1800) {
  transientStatus = text;
  clearTimeout(transientTimer);
  transientTimer = setTimeout(() => { transientStatus = null; updateRunStatus(); }, ms);
  updateRunStatus();
}

function updateRunStatus() {
  clear(runStatusEl);
  runStatusEl.classList.remove('is-awaiting');
  composer.classList.toggle('is-awaiting', approvalDock ? approvalDock.isOpen() : false);
  if (approvalDock && approvalDock.isOpen()) {
    runStatusEl.classList.add('is-awaiting');
    runStatusEl.append(icon('shield', { size: 13 }), document.createTextNode(
      approvalDock.pending > 1 ? `Waiting for your approval (${approvalDock.pending})` : 'Waiting for your approval'));
    return;
  }
  if (busy) {
    runStatusEl.append(icon('loader', { size: 13, className: 'spin' }), document.createTextNode(currentMode === 'code' ? 'Agent working…' : 'Generating…'));
    return;
  }
  if (transientStatus) runStatusEl.append(document.createTextNode(transientStatus));
}
if (approvalDock) {
  approvalDock.subscribe((state) => {
    updateRunStatus();
    // The dock shrinks the transcript; keep the latest context in view.
    if (state.open) requestAnimationFrame(scrollToBottom);
    // Once answered, hand the keyboard back to the composer.
    else if (!document.activeElement || document.activeElement === document.body) input.focus();
  });
}

/* ── Busy state ─────────────────────────────────────────────────────────── */
function updateSendState() {
  sendBtn.disabled = busy || !input.value.trim();
}

function setBusy(on) {
  busy = Boolean(on);
  document.body.classList.toggle('is-busy', busy);
  stopBtn.classList.toggle('hidden', !busy);
  sendBtn.classList.toggle('hidden', busy);
  modeChatBtn.disabled = busy;
  modeCodeBtn.disabled = busy;
  modelDropdown.setDisabled(busy);
  approvalDropdown.setDisabled(busy);
  planModeCheck.disabled = busy;
  workspaceBtn.disabled = busy;
  workspaceChangeBtn.disabled = busy;
  emptyWorkspaceBtn.disabled = busy;
  updateSendState();
  updateRunStatus();
}

/* ── Mode toggle ────────────────────────────────────────────────────────── */
function applyMode(mode) {
  currentMode = mode === 'code' ? 'code' : 'chat';
  localStorage.setItem(MODE_KEY, currentMode);
  document.body.classList.toggle('mode-chat', currentMode === 'chat');
  document.body.classList.toggle('mode-code', currentMode === 'code');
  modeChatBtn.classList.toggle('active', currentMode === 'chat');
  modeCodeBtn.classList.toggle('active', currentMode === 'code');
  modeChatBtn.setAttribute('aria-selected', String(currentMode === 'chat'));
  modeCodeBtn.setAttribute('aria-selected', String(currentMode === 'code'));
  if (currentMode === 'code') {
    updateWorkspaceLabel();
    approvalSel.value = APPROVAL_ORDER.includes(localStorage.getItem(APPROVAL_KEY)) ? localStorage.getItem(APPROVAL_KEY) : 'strict';
    approvalDropdown.refresh();
    planModeCheck.checked = false;
  }
  updatePlaceholder();
  updateEmptyState();
  syncPanel();
}

function updatePlaceholder() {
  if (currentMode === 'chat') input.placeholder = 'Message the model…';
  else input.placeholder = workspace ? 'Describe a task for the agent…' : 'Choose a workspace, then describe a task…';
}

modeChatBtn.addEventListener('click', () => { if (!busy) applyMode('chat'); });
modeCodeBtn.addEventListener('click', () => { if (!busy) applyMode('code'); });

/* ── Workspace ──────────────────────────────────────────────────────────── */
function updateWorkspaceLabel() {
  if (workspace) {
    const name = baseName(workspace) || workspace;
    workspaceLabel.textContent = name;
    workspaceBtn.title = workspace;
    workspaceBtn.classList.add('is-set');
    workspaceBtn.classList.remove('is-missing');
    workspaceCardName.textContent = name;
    workspaceCardPath.textContent = workspace;
    workspaceCardPath.title = workspace;
    workspaceCard.classList.remove('is-missing');
    workspaceChangeBtn.textContent = 'Change';
  } else {
    workspaceLabel.textContent = 'Choose workspace';
    workspaceBtn.title = 'Click to choose a workspace folder';
    workspaceBtn.classList.remove('is-set');
    workspaceBtn.classList.add('is-missing');
    workspaceCardName.textContent = 'No workspace';
    workspaceCardPath.textContent = 'Pick a folder the agent may read and edit.';
    workspaceCardPath.title = '';
    workspaceCard.classList.add('is-missing');
    workspaceChangeBtn.textContent = 'Choose';
  }
  updatePlaceholder();
  updateEmptyState();
}

function setWorkspace(path) {
  if (!path || path === 'undefined' || path === 'null') return;
  workspace = path;
  localStorage.setItem(WORKSPACE_KEY, workspace);
  updateWorkspaceLabel();
  loadWorkspaceTodoState();
}

async function chooseWorkspace() {
  if (busy) return;
  const result = await ipcRenderer.invoke('agent:choose-workspace');
  if (result && result.ok) setWorkspace(result.path);
}

workspaceBtn.addEventListener('click', chooseWorkspace);
workspaceChangeBtn.addEventListener('click', chooseWorkspace);
emptyWorkspaceBtn.addEventListener('click', chooseWorkspace);

async function loadWorkspaceTodoState() {
  if (!workspace) return;
  try {
    const r = await ipcRenderer.invoke('agent:load-state', { workspace });
    if (r.ok && Array.isArray(r.state?.todos)) {
      if (r.state?.sessionId && r.state.sessionId !== todoSessionId) {
        todoState.items = [];
        latestTodoDetail = 'No active todo list yet.';
        renderTodos([]);
        return;
      }
      const items = r.state.todos;
      const hasActiveTodos = items.some(item => item && item.status !== 'done');
      if (!hasActiveTodos) {
        todoState.items = [];
        latestTodoDetail = 'No active todo list yet.';
        if (items.length) await resetPersistedWorkspaceState();
      } else {
        todoState.items = items;
        latestTodoDetail = formatTodoStateForPanel(todoState.items);
      }
      renderTodos(todoState.items);
    }
  } catch {}
}

/* ── Permission mode ────────────────────────────────────────────────────── */
approvalSel.addEventListener('change', () => {
  localStorage.setItem(APPROVAL_KEY, approvalSel.value);
});

function cycleApprovalMode() {
  if (busy) return;
  const idx = APPROVAL_ORDER.indexOf(approvalSel.value);
  const next = APPROVAL_ORDER[(idx + 1) % APPROVAL_ORDER.length];
  approvalDropdown.setValue(next);
  localStorage.setItem(APPROVAL_KEY, next);
  const label = approvalSel.selectedOptions[0]?.textContent || next;
  flashStatus(`Permission mode: ${label}`);
}

/* ── Stop ───────────────────────────────────────────────────────────────── */
function stopActiveRun() {
  abortRef.aborted = true;
  const requestId = activeRequestId;
  activeRequestId = null;
  stopBtn.classList.add('hidden');
  const backendUrl = urlInput.value.trim();
  if (requestId && backendUrl) {
    ipcRenderer.invoke('cancel-prompt', { backendUrl, requestId }).catch(() => {});
  }
  if (approvalDock) approvalDock.cancelAll();
  hideWorking();
  if (currentMode === 'code') appendBubble('notice', 'Stopped. The agent will not take further actions this turn.');
}
stopBtn.addEventListener('click', stopActiveRun);

/* ── Connection ─────────────────────────────────────────────────────────── */
const connPopover = createPopover({
  anchor: connectionBtn,
  panel: connectionPop,
  placement: 'bottom',
  align: 'end',
  onOpen: () => { urlInput.focus(); urlInput.select(); },
});
connectionBtn.addEventListener('click', () => connPopover.toggle());

function hostLabel(url) {
  try { return new URL(url).host || url; } catch { return url || 'Not connected'; }
}

function updateConnectionLabel() {
  const url = urlInput.value.trim();
  connectionLabel.textContent = url ? hostLabel(url) : 'Set manager URL';
  connectionBtn.title = url ? `Manager: ${url}` : 'Set the manager URL';
}

const STATUS_COPY = {
  unknown: 'Not tested yet.',
  pending: 'Testing connection…',
  online: 'Connected — the manager is reachable.',
  offline: 'Can’t reach the manager.',
};

function setStatus(s, detail) {
  statusDot.className = `dot dot-${s}`;
  statusDot.title = s;
  connectionBtn.dataset.status = s;
  clear(connectionStatus);
  const text = s === 'offline' && detail ? `${STATUS_COPY.offline} ${detail}` : (STATUS_COPY[s] || '');
  connectionStatus.append(h('span', { class: `dot dot-${s}` }), h('span', { text }));
}

urlInput.addEventListener('change', () => {
  localStorage.setItem(STORAGE_KEY, urlInput.value.trim());
  updateConnectionLabel();
  setStatus('unknown');
});
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    localStorage.setItem(STORAGE_KEY, urlInput.value.trim());
    updateConnectionLabel();
    ping();
  }
});

let pingSeq = 0;
async function ping() {
  const url = urlInput.value.trim();
  updateConnectionLabel();
  if (!url) { setStatus('unknown'); return; }
  const seq = ++pingSeq;
  setStatus('pending');
  pingBtn.disabled = true;
  const r = await ipcRenderer.invoke('ping-backend', { backendUrl: url });
  if (seq !== pingSeq) return;
  pingBtn.disabled = false;
  setStatus(r.ok ? 'online' : 'offline', r.error);
}

async function discover() {
  discoverBtn.disabled = true;
  const label = discoverBtn.querySelector('.btn-label');
  if (label) label.textContent = 'Searching…';
  let managers = [];
  try { managers = await ipcRenderer.invoke('discover-managers'); } catch {}
  discoverBtn.disabled = false;
  if (label) label.textContent = 'Discover on LAN';
  clear(discoveredList);

  if (!managers || managers.length === 0) {
    discoveredList.classList.add('hidden');
    setStatus('unknown');
    clear(connectionStatus);
    connectionStatus.append(h('span', { class: 'dot dot-unknown' }), h('span', { text: 'No managers found on this network.' }));
    return;
  }
  if (managers.length === 1) {
    useManager(managers[0].url);
    return;
  }
  // Names come from the network (mDNS) — render as text only, never as HTML.
  for (const m of managers) {
    discoveredList.appendChild(h('button', {
      type: 'button',
      class: 'discovered-item',
      role: 'listitem',
      onClick: () => useManager(m.url),
    }, h('span', { class: 'discovered-name', text: m.name || 'Manager' }), h('span', { class: 'discovered-url', text: m.url })));
  }
  discoveredList.classList.remove('hidden');
  connPopover.reposition();
}

function useManager(url) {
  urlInput.value = url;
  localStorage.setItem(STORAGE_KEY, url);
  discoveredList.classList.add('hidden');
  clear(discoveredList);
  ping();
}

discoverBtn.addEventListener('click', discover);
pingBtn.addEventListener('click', () => {
  localStorage.setItem(STORAGE_KEY, urlInput.value.trim());
  ping();
});

/* ── Transcript helpers ─────────────────────────────────────────────────── */
function isNearBottom() {
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
}
function scrollToBottom() {
  chat.scrollTop = chat.scrollHeight;
}

function appendBubble(role, text, meta) {
  const wrap = createMessage({ role, text, meta, onLink: openExternal });
  chat.appendChild(wrap);
  if (workingEl && workingEl.parentNode === chat) chat.appendChild(workingEl); // keep indicator last
  scrollToBottom();
  return wrap;
}

function appendThinkingBlock(text) {
  chat.appendChild(createThinkingBlock(text));
  scrollToBottom();
}

function showWorking(label = 'Working') {
  if (!workingEl) workingEl = createTypingIndicator(label);
  const lbl = workingEl.querySelector('.typing-label');
  if (lbl) lbl.textContent = label;
  chat.appendChild(workingEl);
  scrollToBottom();
}

function hideWorking() {
  if (workingEl && workingEl.parentNode) workingEl.parentNode.removeChild(workingEl);
}

function appendActivity({ kind = 'info', title, subtitle = '', detail = '', status = 'info' }) {
  const detailText = typeof detail === 'string' ? detail : formatActivityDetail(detail);
  const row = createActivityRow({
    kind,
    status,
    title,
    subtitle,
    onSelect: (el) => showActivityDetails(el, { title, subtitle, detailText }),
  });
  chat.appendChild(row);
  scrollToBottom();
  return row;
}

function showActivityDetails(row, { title, subtitle, detailText }) {
  chat.querySelectorAll('.activity-row.active').forEach(el => el.classList.remove('active'));
  if (row) row.classList.add('active');
  activityTitle.textContent = title || 'Activity';
  activitySubtitle.textContent = subtitle || '';
  renderDetailText(activityDetail, detailText || '(no details)');
  switchTab('details');
  openPanel({ remember: false });
}

/** Render detail text with light structure (labels + diff colouring) — text nodes only. */
function renderDetailText(pre, text) {
  clear(pre);
  let inDiff = false;
  for (const line of String(text || '').split('\n')) {
    if (/^(Diff):$/.test(line)) inDiff = true;
    else if (/^(Preview|Result|stdout|stderr):$/.test(line)) inDiff = false;
    let cls = 'detail-line';
    if (inDiff && line.startsWith('+')) cls += ' diff-add';
    else if (inDiff && line.startsWith('-')) cls += ' diff-del';
    else if (inDiff && line.startsWith('@@')) cls += ' diff-hunk';
    const m = !inDiff && line.match(/^([A-Z][A-Za-z -]{1,28}):(\s.*|)$/);
    if (m) {
      pre.appendChild(h('span', { class: cls }, h('span', { class: 'detail-key', text: `${m[1]}:` }), m[2]));
    } else {
      pre.appendChild(h('span', { class: cls, text: line }));
    }
  }
}

function formatActivityDetail(detail) {
  if (!detail || typeof detail !== 'object') return String(detail || '');
  const lines = [];
  if (detail.path) lines.push(`Path: ${detail.path}`);
  if (detail.tool) lines.push(`Tool: ${detail.tool}`);
  if (detail.status) lines.push(`Status: ${detail.status}`);
  if (detail.error) lines.push(`Error: ${detail.error}`);
  if (detail.command) lines.push(`Command: ${detail.command}`);
  if (detail.lines != null) lines.push(`Lines: ${detail.lines}`);
  if (detail.chunks != null) lines.push(`Chunks: ${detail.chunks}`);
  if (detail.alreadyExists != null) lines.push(`Already existed: ${detail.alreadyExists ? 'yes' : 'no'}`);
  if (detail.unchanged != null) lines.push(`Changed content: ${detail.unchanged ? 'no' : 'yes'}`);
  if (detail.repairedDirectory != null) lines.push(`Repaired file-path directory: ${detail.repairedDirectory ? 'yes' : 'no'}`);
  if (detail.previousBytes != null) lines.push(`Previous bytes: ${detail.previousBytes}`);
  if (detail.beforeBytes != null) lines.push(`Before bytes: ${detail.beforeBytes}`);
  if (detail.afterBytes != null) lines.push(`After bytes: ${detail.afterBytes}`);
  if (detail.bytes != null) lines.push(`Bytes: ${detail.bytes}`);
  if (detail.beforeHash) lines.push(`Before hash: ${detail.beforeHash}`);
  if (detail.afterHash) lines.push(`After hash: ${detail.afterHash}`);
  if (detail.mtimeMs != null) lines.push(`Modified: ${new Date(detail.mtimeMs).toLocaleString()}`);
  if (detail.changed != null) lines.push(`Changed: ${detail.changed ? 'yes' : 'no'}`);
  if (detail.dedup != null) lines.push(`Read deduped: ${detail.dedup ? 'yes' : 'no'}`);
  if (detail.preview) lines.push(`\nPreview:\n${detail.preview}`);
  if (detail.diff) lines.push(`\nDiff:\n${detail.diff}`);
  if (detail.result) lines.push(`\nResult:\n${typeof detail.result === 'string' ? detail.result : JSON.stringify(detail.result, null, 2)}`);
  if (detail.stdout) lines.push(`\nstdout:\n${detail.stdout}`);
  if (detail.stderr) lines.push(`\nstderr:\n${detail.stderr}`);
  return lines.join('\n');
}

/* ── Side panel ─────────────────────────────────────────────────────────── */
const narrowQuery = window.matchMedia('(max-width: 1080px)');
let panelOpen = localStorage.getItem(PANEL_KEY) !== 'closed' && !narrowQuery.matches;

function syncPanel() {
  const show = currentMode === 'code' && panelOpen;
  document.body.classList.toggle('panel-closed', !show);
  panelToggle.setAttribute('aria-pressed', String(show));
}

function openPanel({ remember = true } = {}) {
  panelOpen = true;
  if (remember && !narrowQuery.matches) localStorage.setItem(PANEL_KEY, 'open');
  syncPanel();
}

function closePanel({ remember = true } = {}) {
  panelOpen = false;
  if (remember && !narrowQuery.matches) localStorage.setItem(PANEL_KEY, 'closed');
  syncPanel();
  chat.querySelectorAll('.activity-row.active').forEach(el => el.classList.remove('active'));
}

function switchTab(tab) {
  const progress = tab !== 'details';
  tabProgress.classList.toggle('active', progress);
  tabDetails.classList.toggle('active', !progress);
  tabProgress.setAttribute('aria-selected', String(progress));
  tabDetails.setAttribute('aria-selected', String(!progress));
  panelProgress.classList.toggle('hidden', !progress);
  panelDetails.classList.toggle('hidden', progress);
}

panelToggle.addEventListener('click', () => (panelOpen && currentMode === 'code' ? closePanel() : openPanel()));
activityClose.addEventListener('click', () => closePanel());
tabProgress.addEventListener('click', () => switchTab('progress'));
tabDetails.addEventListener('click', () => switchTab('details'));
narrowQuery.addEventListener('change', () => {
  panelOpen = narrowQuery.matches ? false : localStorage.getItem(PANEL_KEY) !== 'closed';
  syncPanel();
});
// In overlay (narrow) mode, clicking the conversation dismisses the drawer.
conversation.addEventListener('pointerdown', () => {
  if (narrowQuery.matches && panelOpen) closePanel({ remember: false });
});

/* ── Todo list ──────────────────────────────────────────────────────────── */
function updateTodoView(detail, items) {
  latestTodoDetail = detail || 'No active todo list yet.';
  renderTodos(Array.isArray(items) ? items : todoState.items);
}

function renderTodos(items) {
  const summary = renderTodoPanel(todoPanelEl, items, {
    onSelectPath: (path, item) => showActivityDetails(null, {
      title: item.title || baseName(path),
      subtitle: path,
      detailText: [
        `Path: ${path}`,
        `Status: ${item.status || 'pending'}`,
        item.error ? `Error: ${item.error}` : '',
        item.evidence ? `\nResult:\n${JSON.stringify(item.evidence, null, 2)}` : '',
      ].filter(Boolean).join('\n'),
    }),
  });
  todoCountEl.textContent = summary.total ? `${summary.done}/${summary.total}` : '';
  todoCountEl.hidden = !summary.total;
  if (summary.total && !panelAutoOpened && currentMode === 'code' && !narrowQuery.matches) {
    panelAutoOpened = true;
    if (!panelOpen) openPanel({ remember: false });
    switchTab('progress');
  }
  return summary;
}

function formatTodoStateForPanel(items) {
  if (!items || !items.length) return 'No active todo list yet.';
  const mark = item => item.status === 'done' ? '[x]' : item.status === 'failed' ? '[!]' : item.status === 'in_progress' ? '[>]' : '[ ]';
  return ['Todo List', '', ...items.map(item => `${item.id}. ${mark(item)} ${item.title}${item.path ? `\n   ${item.path}` : ''}${item.error ? `\n   Error: ${item.error}` : ''}`)].join('\n');
}

/* ── Empty state ────────────────────────────────────────────────────────── */
const SUGGESTIONS = {
  chat: [
    { icon: 'sparkle', title: 'Explain a concept', sub: 'e.g. how attention works in transformers', prompt: 'Explain how transformer models use attention, with a simple analogy.' },
    { icon: 'pencil', title: 'Draft a message', sub: 'an email, a cover letter, a summary', prompt: 'Draft a short, polite email to my professor asking for a one-week extension on my project.' },
    { icon: 'listChecks', title: 'Summarize text', sub: 'paste notes or an article below', prompt: 'Summarize the following text in five bullet points:\n\n' },
    { icon: 'code', title: 'Debug an error', sub: 'paste a stack trace or snippet', prompt: 'Help me find the bug in this code:\n\n' },
  ],
  code: [
    { icon: 'filePlus', title: 'Build a small web app', sub: 'HTML, CSS and JS in this folder', prompt: 'Build a responsive landing page for a student hackathon with index.html, styles.css and script.js.' },
    { icon: 'search', title: 'Explain this project', sub: 'structure, entry points, how to run it', prompt: 'Inspect this project and explain its structure, entry points and how to run it.' },
    { icon: 'pencil', title: 'Make a focused change', sub: 'describe the edit you want', prompt: 'In this project, ' },
    { icon: 'terminal', title: 'Write and run tests', sub: 'add tests for the main module', prompt: 'Add unit tests for the main module and run them.' },
  ],
};

function updateEmptyState() {
  const modelName = modelSelect.selectedOptions[0]?.textContent?.trim() || modelSelect.value;
  clear(emptySubtitle);
  if (currentMode === 'chat') {
    emptyTitle.textContent = 'How can I help today?';
    emptySubtitle.append(`Chatting with ${modelName} on an idle cluster machine — nothing runs on this computer.`);
    emptyWorkspaceBtn.classList.add('hidden');
  } else {
    emptyTitle.textContent = 'What should we build?';
    if (workspace) {
      emptySubtitle.append('The agent can read and edit files in ', h('code', { text: baseName(workspace) || workspace }), '. You approve actions above the message box.');
      emptyWorkspaceBtn.classList.add('hidden');
    } else {
      emptySubtitle.append('Choose a workspace folder so the agent can read and edit files.');
      emptyWorkspaceBtn.classList.remove('hidden');
    }
  }
  clear(suggestionsEl);
  for (const s of SUGGESTIONS[currentMode]) {
    suggestionsEl.appendChild(h('button', {
      type: 'button',
      class: 'suggestion',
      role: 'listitem',
      onClick: () => {
        input.value = s.prompt;
        resizeInput();
        updateSendState();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      },
    },
    h('span', { class: 'suggestion-icon' }, icon(s.icon, { size: 16 })),
    h('span', { class: 'suggestion-text' },
      h('span', { class: 'suggestion-title', text: s.title }),
      h('span', { class: 'suggestion-sub', text: s.sub }))));
  }
}

function syncEmptyState() {
  conversation.classList.toggle('is-empty', chat.childElementCount === 0);
}
new MutationObserver(syncEmptyState).observe(chat, { childList: true });

/* ── Chat (plain mode) ──────────────────────────────────────────────────── */
const THINK_RE = /<(think|thinking|reasoning)>([\s\S]*?)<\/\1>/g;

/** Text that should be visible while streaming: hide finished and still-open reasoning blocks. */
function visibleStreamText(raw) {
  let t = String(raw || '').replace(THINK_RE, '');
  const open = t.match(/<(think|thinking|reasoning)>/);
  if (open) t = t.slice(0, open.index);
  return t.replace(/^\s+/, '');
}

async function sendChat(prompt) {
  const backendUrl = urlInput.value.trim();
  const model      = modelSelect.value;
  const epoch      = conversationEpoch;
  const requestId  = `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  history.push({ role: 'user', content: prompt });
  appendBubble('user', prompt);
  activeRequestId = requestId;
  showWorking('Thinking');

  let raw = '';
  let streamEl = null;
  const onChunk = (_, text) => {
    if (epoch !== conversationEpoch) return;
    raw += text;
    const visible = visibleStreamText(raw);
    if (!visible) return;
    const stick = isNearBottom();
    hideWorking();
    if (!streamEl) {
      streamEl = h('div', { class: 'bubble assistant streaming' }, h('div', { class: 'bubble-body' }));
      chat.appendChild(streamEl);
    }
    streamEl.firstChild.textContent = visible;
    if (stick) scrollToBottom();
  };
  ipcRenderer.on('stream-chunk', onChunk);

  let r;
  try {
    r = await ipcRenderer.invoke('send-prompt', { backendUrl, messages: history, model, requestId });
  } catch (err) {
    r = { ok: false, error: err.message };
  } finally {
    ipcRenderer.removeListener('stream-chunk', onChunk);
    if (activeRequestId === requestId) activeRequestId = null;
  }
  hideWorking();
  if (streamEl) streamEl.remove();
  if (epoch !== conversationEpoch) return;

  if (r.ok) {
    const tok = r.data.tokens;
    let meta = `${r.data.worker} · ${r.data.model}`;
    if (tok) {
      meta += ` · in ${tok.prompt} / out ${tok.response} tok`;
      if (tok.tokensPerSec != null) meta += ` · ${tok.tokensPerSec} tok/s`;
    }
    let rawResp = r.data.response || '';
    // Extract and show thinking blocks before stripping them.
    // Match <think>, <thinking>, <reasoning> — all variants emitted by qwen3 / r1 / o1-style models.
    const thinkMatches = [...rawResp.matchAll(THINK_RE)];
    if (thinkMatches.length > 0) {
      const thinkText = thinkMatches.map(m => m[2].trim()).join('\n\n---\n\n');
      appendThinkingBlock(thinkText);
      rawResp = rawResp.replace(THINK_RE, '').trim();
    }
    const resp = rawResp || '';
    appendBubble('assistant', resp, meta);
    history.push({ role: 'assistant', content: resp });
    if (tok) {
      sessionTokens.prompt   += tok.prompt   || 0;
      sessionTokens.response += tok.response || 0;
      updateSessionTokensDisplay();
    }
  } else if (/cancel/i.test(String(r.error || ''))) {
    const partial = visibleStreamText(raw).trim();
    if (partial) {
      appendBubble('assistant', partial, 'Stopped early');
      history.push({ role: 'assistant', content: partial });
    } else {
      history.pop();
      appendBubble('notice', 'Stopped — no response was generated.');
    }
  } else {
    appendBubble('error', `Error: ${r.error}`);
    history.pop();
  }
}

/* ── Code mode (agent loop) ─────────────────────────────────────────────── */
async function sendCode(prompt) {
  const backendUrl   = urlInput.value.trim();
  const model        = modelSelect.value;
  const approvalMode = approvalSel.value;
  const epoch        = conversationEpoch;

  if (!workspace) {
    appendBubble('error', 'No workspace selected. Use “Choose workspace” below the message box to pick a folder.');
    workspaceBtn.classList.add('is-missing');
    workspaceBtn.focus();
    return;
  }

  history.push({ role: 'user', content: prompt });
  appendBubble('user', prompt);

  abortRef = { aborted: false };
  const requestId = `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  activeRequestId = requestId;
  showWorking('Thinking');

  // The agent loop renders its own live stream bubble; we only drop the indicator.
  const onChunk = () => hideWorking();
  ipcRenderer.on('stream-chunk', onChunk);

  try {
    const nextHistory = await runAgentTurn({
      backendUrl,
      messages: history,
      model,
      tools: getToolSchemas(workspace),
      workspace,
      approvalMode,
      planMode: planModeCheck.checked,
      requestId,
      chat,
      appendBubble: (...args) => { hideWorking(); return appendBubble(...args); },
      appendActivity: (activity) => { hideWorking(); return appendActivity(activity); },
      updateTodoView,
      setLoading: (on) => { if (on) showWorking('Working'); else hideWorking(); },
      abortRef,
      remembered,
      todoState,
      sessionId: todoSessionId,
    });
    if (epoch === conversationEpoch) history = nextHistory;
  } catch (err) {
    hideWorking();
    if (epoch === conversationEpoch) {
      appendBubble('error', `Agent error: ${err.message}`);
      history.pop();
    }
  } finally {
    ipcRenderer.removeListener('stream-chunk', onChunk);
    hideWorking();
    if (activeRequestId === requestId) activeRequestId = null;
    if (epoch === conversationEpoch) renderTodos(todoState.items);
  }
}

/* ── Unified send ───────────────────────────────────────────────────────── */
async function send() {
  const prompt = input.value.trim();
  if (!prompt || busy) return;
  input.value = '';
  resizeInput();
  setBusy(true);
  try {
    if (currentMode === 'code') await sendCode(prompt);
    else await sendChat(prompt);
  } finally {
    setBusy(false);
    input.focus();
  }
}

/* ── New Chat ───────────────────────────────────────────────────────────── */
async function resetPersistedWorkspaceState() {
  if (!workspace) return;
  try {
    await ipcRenderer.invoke('agent:save-state', {
      workspace,
      state: {
        sessionId: todoSessionId,
        todos: [],
        fileHistory: [],
        readState: {},
        actionFingerprints: {},
      },
    });
  } catch {}
}

async function newChat() {
  conversationEpoch += 1;
  todoSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem(TODO_SESSION_KEY, todoSessionId);
  history       = [];
  sessionTokens = { prompt: 0, response: 0 };
  remembered    = new Set();
  todoState     = { items: [] };
  abortRef.aborted = true;
  abortRef      = { aborted: true }; // cancel any in-flight loop
  if (activeRequestId && urlInput.value.trim()) {
    ipcRenderer.invoke('cancel-prompt', { backendUrl: urlInput.value.trim(), requestId: activeRequestId }).catch(() => {});
  }
  activeRequestId = null;
  if (approvalDock) approvalDock.cancelAll();
  hideWorking();
  updateSessionTokensDisplay();
  clear(chat);
  clear(activityDetail);
  activityTitle.textContent = 'Activity details';
  activitySubtitle.textContent = 'Select a tool step in the conversation to inspect it.';
  switchTab('progress');
  latestTodoDetail = 'No active todo list yet.';
  updateTodoView(latestTodoDetail, []);
  panelAutoOpened = false;
  input.value = '';
  resizeInput();
  updateSendState();
  await resetPersistedWorkspaceState();
  input.focus();
}

/* ── Event listeners ────────────────────────────────────────────────────── */
sendBtn.addEventListener('click', send);
newChatBtn.addEventListener('click', () => { void newChat(); });
input.addEventListener('input', updateSendState);

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!busy) send();
  } else if (e.key === 'Tab' && e.shiftKey && approvalDock && approvalDock.isOpen()) {
    e.preventDefault();
    approvalDock.focus(); // jump to the pending permission prompt
  } else if (e.key === 'Tab' && e.shiftKey && currentMode === 'code') {
    e.preventDefault();
    cycleApprovalMode();
  }
});

/* ── Test / extension hook (documented in UI_COMPONENTS.md) ─────────────── */
window.LLMClusterUI = {
  appendBubble,
  appendActivity,
  appendThinkingBlock,
  updateTodoView,
  showWorking,
  hideWorking,
  applyMode,
  setWorkspace,
  newChat,
  setBusy,
  approvalDock,
  getState: () => ({
    mode: currentMode,
    workspace,
    busy,
    approvalMode: approvalSel.value,
    model: modelSelect.value,
    historyLength: history.length,
    panelOpen,
    todoText: latestTodoDetail, // plain-text todo summary from the agent (debugging / copy)
  }),
};

/* ── Boot ───────────────────────────────────────────────────────────────── */
applyMode(currentMode);
updateWorkspaceLabel();
updateSessionTokensDisplay();
updateConnectionLabel();
setStatus('unknown');
renderTodos([]);
updateSendState();
syncEmptyState();
input.focus();

// On launch: ping the default/saved URL
ping();
loadWorkspaceTodoState();
