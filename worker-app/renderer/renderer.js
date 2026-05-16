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

// ── Boot steps UI ─────────────────────────────────────────────────────────────
const bootStepsEl = document.getElementById('boot-steps');
const bootErrorEl = document.getElementById('boot-error');

function bootStep(label) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:13px;color:var(--text-dim);';
  row.innerHTML = `
    <span class="boot-spinner" style="width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0;"></span>
    <span>${label}</span>`;
  bootStepsEl.appendChild(row);

  return {
    done(note = '') {
      row.style.color = 'var(--text)';
      row.querySelector('.boot-spinner').outerHTML = '<span style="width:14px;text-align:center;color:var(--green);flex-shrink:0;">✓</span>';
      if (note) row.querySelector('span:last-child').textContent += `  ${note}`;
      // re-grab after innerHTML swap
      row.querySelectorAll('span')[0].style.cssText = 'width:14px;text-align:center;color:var(--green);flex-shrink:0;';
    },
    fail(msg) {
      row.style.color = 'var(--red)';
      row.querySelector('.boot-spinner').outerHTML = '<span style="width:14px;text-align:center;flex-shrink:0;">✗</span>';
      if (bootErrorEl) bootErrorEl.textContent = msg;
    },
  };
}

// Inject spin keyframe once
const styleTag = document.createElement('style');
styleTag.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
document.head.appendChild(styleTag);

// ── Boot ───────────────────────────────────────────────────────────────────────
async function boot() {
  if (!ipcRenderer) return;

  // Step 1 — config
  const s1 = bootStep('Loading config...');
  try {
    window.AppState.config = await ipcRenderer.invoke('config:load');
    s1.done();
  } catch (err) {
    s1.fail(`Config load failed: ${err.message}`);
    return;
  }

  const setupComplete = window.AppState.config?.workerApp?.setupComplete;

  if (!setupComplete) {
    // First launch path — pre-load GPU + models so wizard is instant
    const s2 = bootStep('Detecting GPU...');
    try {
      window.AppState.gpuInfo = await ipcRenderer.invoke('gpu:detect');
      const gpu = window.AppState.gpuInfo?.gpus?.[0];
      s2.done(gpu ? `${gpu.name} · ${gpu.vram} GB` : 'No GPU — CPU only');
    } catch (err) {
      window.AppState.gpuInfo = { cpuFallback: true };
      s2.fail(`GPU detect failed: ${err.message}`);
    }

    const s3 = bootStep('Loading model catalog...');
    try {
      const gpu = window.AppState.gpuInfo?.gpus?.[0] || { vram: 0, bandwidth: null };
      window.AppState.models = await ipcRenderer.invoke('models:recommend', gpu);
      s3.done(`${window.AppState.models.length} models`);
    } catch (err) {
      window.AppState.models = [];
      s3.fail(`Model catalog failed: ${err.message}`);
    }

  } else {
    // Returning user path — just check worker status
    const s2 = bootStep('Checking worker status...');
    try {
      const status = await ipcRenderer.invoke('llama:status');
      s2.done(status.status === 'running' ? 'Running' : 'Stopped');
    } catch {
      s2.done('—');
    }
  }

  const sLast = bootStep('Ready!');
  sLast.done();

  // Brief pause so the user sees "Ready!" tick
  await new Promise(r => setTimeout(r, 400));

  try {
    switchScreen(setupComplete ? 'dashboard' : 'setup');
  } catch (err) {
    showError(`Failed to render screen: ${err.message}\n\n${err.stack}`);
  }
}

boot();
