'use strict';

// ── Global app state ─────────────────────────────────────────────────────────
window.AppState = {
  config: {},
  currentScreen: '',
};

// ── Screen switching ─────────────────────────────────────────────────────────
window.switchScreen = function(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  const screenEl = document.getElementById(`screen-${name}`);
  const navBtn   = document.querySelector(`.nav-btn[data-screen="${name}"]`);
  if (screenEl) screenEl.classList.add('active');
  if (navBtn)   navBtn.classList.add('active');

  if (window.AppState.currentScreen === 'dashboard' && name !== 'dashboard') {
    if (window.Dashboard?.stopPolling) Dashboard.stopPolling();
  }

  window.AppState.currentScreen = name;

  if (!screenEl) return;
  screenEl.innerHTML = '';

  try {
    if (name === 'dashboard') Dashboard.init(screenEl);
    else if (name === 'setup')   SetupWizard.init(screenEl);
    else if (name === 'history') ChatHistory.init(screenEl);
    else if (name === 'settings') Settings.init(screenEl);
  } catch (err) {
    showError(`Screen "${name}" failed to load: ${err.message}\n\n${err.stack}`);
  }
};

// ── Error display ─────────────────────────────────────────────────────────────
function showError(msg) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const el = document.getElementById('screen-error');
  const msgEl = document.getElementById('error-message');
  if (el) el.classList.add('active');
  if (msgEl) msgEl.textContent = msg;
  console.error('[boot error]', msg);
}

// ── Nav button click handlers ─────────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchScreen(btn.dataset.screen));
});

// ── Electron IPC (guard against non-electron contexts) ───────────────────────
let ipcRenderer = null;
try {
  ipcRenderer = require('electron').ipcRenderer;
} catch (e) {
  showError('Could not load Electron IPC. Are you running this inside Electron?\n\n' + e.message);
}

// ── Update banner ─────────────────────────────────────────────────────────────
if (ipcRenderer) {
  const updateBanner  = document.getElementById('update-banner');
  const updateText    = document.getElementById('update-text');
  const updateAction  = document.getElementById('update-action');
  const updateDismiss = document.getElementById('update-dismiss');

  ipcRenderer.on('update-available', (_e, version) => {
    updateText.textContent = `Update v${version} available — downloading in background...`;
    updateAction.style.display = 'none';
    updateBanner.classList.remove('hidden');
  });
  ipcRenderer.on('update-progress', (_e, percent) => {
    updateText.textContent = `Downloading update... ${Math.round(percent)}%`;
  });
  ipcRenderer.on('update-downloaded', (_e, version) => {
    updateText.textContent = `Update v${version} downloaded and ready.`;
    updateAction.style.display = '';
    updateBanner.classList.remove('hidden');
  });

  updateAction.addEventListener('click', () => ipcRenderer.invoke('update:install'));
  updateDismiss.addEventListener('click', () =>
    document.getElementById('update-banner').classList.add('hidden')
  );

  ipcRenderer.invoke('app:version').then(v => {
    const el = document.getElementById('app-version');
    if (el) el.textContent = `v${v}`;
  }).catch(() => {});
}

// ── Boot ───────────────────────────────────────────────────────────────────────
async function boot() {
  if (!ipcRenderer) return; // showError already called above

  try {
    window.AppState.config = await ipcRenderer.invoke('config:load');
  } catch (err) {
    showError(`Failed to load config via IPC: ${err.message}`);
    return;
  }

  const setupComplete = window.AppState.config?.workerApp?.setupComplete;

  try {
    switchScreen(setupComplete ? 'dashboard' : 'setup');
  } catch (err) {
    showError(`Failed to render screen: ${err.message}\n\n${err.stack}`);
  }
}

boot();
