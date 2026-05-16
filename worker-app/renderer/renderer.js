'use strict';

const { ipcRenderer } = require('electron');

// ── Global app state ─────────────────────────────────────────────────────────
window.AppState = {
  config: {},
  currentScreen: 'dashboard',
};

// ── Screen switching ─────────────────────────────────────────────────────────
window.switchScreen = function(name) {
  // Hide all screens
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  // Show target screen
  const screenEl = document.getElementById(`screen-${name}`);
  const navBtn = document.querySelector(`.nav-btn[data-screen="${name}"]`);
  if (screenEl) screenEl.classList.add('active');
  if (navBtn) navBtn.classList.add('active');

  // Stop dashboard polling when leaving
  if (window.AppState.currentScreen === 'dashboard' && name !== 'dashboard') {
    if (window.Dashboard?.stopPolling) Dashboard.stopPolling();
  }

  window.AppState.currentScreen = name;

  // Init the screen
  const el = screenEl;
  if (name === 'dashboard') {
    el.innerHTML = '';
    Dashboard.init(el);
  } else if (name === 'setup') {
    el.innerHTML = '';
    SetupWizard.init(el);
  } else if (name === 'history') {
    el.innerHTML = '';
    ChatHistory.init(el);
  } else if (name === 'settings') {
    el.innerHTML = '';
    Settings.init(el);
  }
};

// ── Nav button click handlers ─────────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    switchScreen(btn.dataset.screen);
  });
});

// ── Update banner ─────────────────────────────────────────────────────────────
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

updateAction.addEventListener('click', async () => {
  await ipcRenderer.invoke('update:install');
});

updateDismiss.addEventListener('click', () => {
  updateBanner.classList.add('hidden');
});

// ── App version ────────────────────────────────────────────────────────────────
ipcRenderer.invoke('app:version').then(v => {
  const el = document.getElementById('app-version');
  if (el) el.textContent = `v${v}`;
});

// ── Boot ───────────────────────────────────────────────────────────────────────
async function boot() {
  // Load config
  window.AppState.config = await ipcRenderer.invoke('config:load');

  const setupComplete = window.AppState.config?.workerApp?.setupComplete;

  if (setupComplete) {
    switchScreen('dashboard');
  } else {
    // First launch — go to setup
    switchScreen('setup');
  }
}

boot();
