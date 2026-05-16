'use strict';

const ipcWiz = require('electron').ipcRenderer;

window.SetupWizard = {
  step: 1,
  gpuInfo: null,
  models: [],
  selectedModel: null,
  managerUrl: '',
  downloads: { llama: { percent: 0 }, model: { percent: 0 } },
  llamaServerPath: null,
  modelPath: null,

  async init(container) {
    this.container = container;
    // Use pre-cached data from boot() so step 1 & 2 are instant
    if (!this.gpuInfo && window.AppState.gpuInfo) {
      this.gpuInfo = window.AppState.gpuInfo;
    }
    if (!this.models.length && window.AppState.models?.length) {
      this.models = window.AppState.models;
    }
    this.render();
  },

  render() {
    const steps = [
      { num: 1, label: 'GPU' },
      { num: 2, label: 'Model' },
      { num: 3, label: 'Download' },
      { num: 4, label: 'Manager' },
      { num: 5, label: 'Ready' },
    ];

    this.container.innerHTML = `
      <div class="wizard-steps">
        ${steps.map((s, i) => {
          let cls = '';
          if (s.num === this.step) cls = 'active';
          else if (s.num < this.step) cls = 'done';
          const arrow = i < steps.length - 1 ? '<span class="wizard-step-arrow">→</span>' : '';
          return `<div class="wizard-step ${cls}">
            <span class="wizard-step-num">${s.num < this.step ? '✓' : s.num}</span>
            ${s.label}
          </div>${arrow}`;
        }).join('')}
      </div>
      <div class="wizard-content" id="wizard-content"></div>
    `;

    const content = this.container.querySelector('#wizard-content');
    switch (this.step) {
      case 1: this.renderGpuStep(content); break;
      case 2: this.renderModelStep(content); break;
      case 3: this.renderDownloadStep(content); break;
      case 4: this.renderManagerStep(content); break;
      case 5: this.renderReadyStep(content); break;
    }
  },

  // ── Step 1: GPU Detection ──────────────────────────────────────────────
  async renderGpuStep(el) {
    el.innerHTML = `
      <h2 style="margin-bottom: 16px;">GPU Detection</h2>
      <div id="gpu-result"></div>
      <div class="wizard-actions">
        <button class="btn btn-primary" id="gpu-detect-btn">Detect GPU</button>
        <button class="btn btn-primary" id="gpu-next-btn" disabled>Next →</button>
      </div>`;

    const resultEl = el.querySelector('#gpu-result');
    const detectBtn = el.querySelector('#gpu-detect-btn');
    const nextBtn = el.querySelector('#gpu-next-btn');

    if (this.gpuInfo) {
      GpuCard.render(resultEl, this.gpuInfo);
      nextBtn.disabled = false;
    }

    detectBtn.addEventListener('click', async () => {
      detectBtn.disabled = true;
      detectBtn.textContent = 'Detecting...';
      GpuCard.render(resultEl, null); // show loading
      this.gpuInfo = await ipcWiz.invoke('gpu:detect');
      GpuCard.render(resultEl, this.gpuInfo);
      detectBtn.textContent = 'Re-detect';
      detectBtn.disabled = false;
      nextBtn.disabled = false;
    });

    nextBtn.addEventListener('click', () => {
      this.step = 2;
      this.render();
    });

    // Auto-detect on first visit
    if (!this.gpuInfo) {
      detectBtn.click();
    }
  },

  // ── Step 2: Model Selection ────────────────────────────────────────────
  async renderModelStep(el) {
    // Use cached models from boot() if available
    if (!this.models.length) {
      const gpu = this.gpuInfo?.gpus?.[0] || { vram: 0, bandwidth: null };
      this.models = await ipcWiz.invoke('models:recommend', gpu);
    }

    const turboQuant = window.AppState?.config?.workerApp?.turboQuant || false;

    el.innerHTML = `
      <h2 style="margin-bottom: 4px;">Choose a Model</h2>
      <p style="color: var(--text-dim); font-size: 13px; margin-bottom: 16px;">
        Filtered for your GPU. Green = fits easily, Yellow = tight, Red = won't fit.
        ${turboQuant ? '<span class="turbo-badge">⚡ TurboQuant ON — context estimates boosted</span>' : ''}
      </p>
      <div id="model-list" style="flex: 1; overflow-y: auto;"></div>
      <div class="wizard-actions">
        <button class="btn btn-secondary" id="model-back">← Back</button>
        <button class="btn btn-primary" id="model-next" disabled>Next →</button>
      </div>`;

    const listEl = el.querySelector('#model-list');
    const nextBtn = el.querySelector('#model-next');

    ModelBrowser.render(listEl, this.models, {
      turboQuant,
      onSelect: (name) => {
        this.selectedModel = this.models.find(m => m.name === name);
        nextBtn.disabled = false;
      },
    });

    if (this.selectedModel) {
      ModelBrowser.selectedModel = this.selectedModel.name;
      ModelBrowser.render(listEl, this.models, {
        turboQuant,
        onSelect: (name) => {
          this.selectedModel = this.models.find(m => m.name === name);
          nextBtn.disabled = false;
        },
      });
      nextBtn.disabled = false;
    }

    el.querySelector('#model-back').addEventListener('click', () => { this.step = 1; this.render(); });
    nextBtn.addEventListener('click', () => { this.step = 3; this.render(); });
  },

  // ── Step 3: Downloads ──────────────────────────────────────────────────
  async renderDownloadStep(el) {
    el.innerHTML = `
      <h2 style="margin-bottom: 4px;">Downloading</h2>
      <p style="color: var(--text-dim); font-size: 13px; margin-bottom: 16px;">
        Downloading llama-server and ${this.selectedModel?.name || 'model'}. This may take a while.
      </p>
      <div id="download-bars"></div>
      <div class="wizard-actions">
        <button class="btn btn-secondary" id="dl-cancel">Cancel</button>
        <button class="btn btn-primary" id="dl-next" disabled>Next →</button>
      </div>`;

    const barsEl = el.querySelector('#download-bars');
    const nextBtn = el.querySelector('#dl-next');
    const cancelBtn = el.querySelector('#dl-cancel');

    const updateBars = () => {
      DownloadProgress.render(barsEl, [
        { label: 'llama-server', ...this.downloads.llama },
        { label: this.selectedModel?.hfFile || 'Model', ...this.downloads.model },
      ]);
    };
    updateBars();

    // Listen for progress updates
    const llamaHandler = (_e, progress) => {
      this.downloads.llama = progress;
      updateBars();
    };
    const modelHandler = (_e, progress) => {
      this.downloads.model = progress;
      updateBars();
    };
    ipcWiz.on('download:llama-progress', llamaHandler);
    ipcWiz.on('download:model-progress', modelHandler);

    // Start downloads in parallel
    let llamaDone = false, modelDone = false;
    const checkDone = () => {
      if (llamaDone && modelDone) {
        this.downloads.llama.percent = 100;
        this.downloads.llama.status = 'done';
        this.downloads.model.percent = 100;
        this.downloads.model.status = 'done';
        updateBars();
        nextBtn.disabled = false;
      }
    };

    ipcWiz.invoke('download:llama-server', {}).then(result => {
      this.llamaServerPath = result.path;
      llamaDone = true;
      checkDone();
    }).catch(err => {
      this.downloads.llama.status = `Error: ${err.message}`;
      updateBars();
    });

    ipcWiz.invoke('download:model', this.selectedModel).then(result => {
      this.modelPath = result.path;
      modelDone = true;
      checkDone();
    }).catch(err => {
      this.downloads.model.status = `Error: ${err.message}`;
      updateBars();
    });

    cancelBtn.addEventListener('click', async () => {
      await ipcWiz.invoke('download:cancel');
      ipcWiz.removeListener('download:llama-progress', llamaHandler);
      ipcWiz.removeListener('download:model-progress', modelHandler);
      this.step = 2;
      this.render();
    });

    nextBtn.addEventListener('click', () => {
      ipcWiz.removeListener('download:llama-progress', llamaHandler);
      ipcWiz.removeListener('download:model-progress', modelHandler);
      this.step = 4;
      this.render();
    });
  },

  // ── Step 4: Manager URL ────────────────────────────────────────────────
  async renderManagerStep(el) {
    el.innerHTML = `
      <h2 style="margin-bottom: 4px;">Connect to Manager</h2>
      <p style="color: var(--text-dim); font-size: 13px; margin-bottom: 16px;">
        Enter your manager URL or auto-discover on the local network.
      </p>
      <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 16px;">
        <input class="input" id="manager-url" style="flex: 1;"
               value="${this.managerUrl || 'https://llm.tutorrev.live'}"
               placeholder="https://your-manager:3000">
        <button class="btn btn-secondary" id="manager-discover">🔍 Discover</button>
        <button class="btn btn-primary" id="manager-test">Test</button>
      </div>
      <div id="manager-result" style="font-size: 13px; min-height: 30px;"></div>
      <div id="discovered-list"></div>
      <div class="wizard-actions">
        <button class="btn btn-secondary" id="mgr-back">← Back</button>
        <button class="btn btn-primary" id="mgr-next">Next →</button>
      </div>`;

    const urlInput = el.querySelector('#manager-url');
    const resultEl = el.querySelector('#manager-result');
    const discoverBtn = el.querySelector('#manager-discover');
    const testBtn = el.querySelector('#manager-test');
    const discoveredEl = el.querySelector('#discovered-list');

    testBtn.addEventListener('click', async () => {
      const url = urlInput.value.trim();
      resultEl.innerHTML = '<span style="color: var(--yellow);">Testing...</span>';
      const result = await ipcWiz.invoke('manager:test', url);
      if (result.ok) {
        resultEl.innerHTML = '<span style="color: var(--green);">✓ Connected successfully!</span>';
        this.managerUrl = url;
      } else {
        resultEl.innerHTML = `<span style="color: var(--red);">✗ Failed: ${result.error || `HTTP ${result.status}`}</span>`;
      }
    });

    discoverBtn.addEventListener('click', async () => {
      discoverBtn.disabled = true;
      discoverBtn.textContent = 'Searching...';
      const found = await ipcWiz.invoke('mdns:discover');
      discoverBtn.textContent = '🔍 Discover';
      discoverBtn.disabled = false;

      if (found.length === 0) {
        discoveredEl.innerHTML = '<p style="color: var(--text-dim); font-size: 13px;">No managers found on local network.</p>';
      } else {
        discoveredEl.innerHTML = found.map(f => `
          <div class="conv-item" data-url="${f.url}" style="margin-top: 8px;">
            <span style="color: var(--green);">📡</span>
            <span class="conv-preview">${f.name}</span>
            <span style="color: var(--text-dim);">${f.url}</span>
          </div>
        `).join('');
        discoveredEl.querySelectorAll('.conv-item').forEach(item => {
          item.addEventListener('click', () => {
            urlInput.value = item.dataset.url;
            this.managerUrl = item.dataset.url;
          });
        });
      }
    });

    el.querySelector('#mgr-back').addEventListener('click', () => { this.step = 3; this.render(); });
    el.querySelector('#mgr-next').addEventListener('click', () => {
      this.managerUrl = urlInput.value.trim() || 'https://llm.tutorrev.live';
      this.step = 5;
      this.render();
    });
  },

  // ── Step 5: Ready ──────────────────────────────────────────────────────
  async renderReadyStep(el) {
    const gpu = this.gpuInfo?.gpus?.[0];
    const contextSize = this.selectedModel?.contextFits || 8192;

    el.innerHTML = `
      <h2 style="margin-bottom: 16px;">Ready to Go!</h2>
      <div class="card" style="margin-bottom: 16px;">
        <div class="card-title">Setup Summary</div>
        <div style="display: grid; grid-template-columns: 140px 1fr; gap: 8px; font-size: 14px;">
          <span style="color: var(--text-dim);">GPU:</span>
          <span>${gpu?.name || 'CPU Only'} (${gpu?.vram || 0} GB)</span>
          <span style="color: var(--text-dim);">Model:</span>
          <span>${this.selectedModel?.name || 'None'}</span>
          <span style="color: var(--text-dim);">Est. Speed:</span>
          <span>${this.selectedModel?.estimatedTokS ? `~${this.selectedModel.estimatedTokS} tok/s` : 'Unknown'}</span>
          <span style="color: var(--text-dim);">Context Size:</span>
          <span>${Math.round(contextSize / 1024)}K tokens</span>
          <span style="color: var(--text-dim);">Manager:</span>
          <span>${this.managerUrl}</span>
          <span style="color: var(--text-dim);">llama-server:</span>
          <span style="font-size: 12px; word-break: break-all;">${this.llamaServerPath || 'Not downloaded'}</span>
          <span style="color: var(--text-dim);">Model File:</span>
          <span style="font-size: 12px; word-break: break-all;">${this.modelPath || 'Not downloaded'}</span>
        </div>
      </div>
      <div style="display: flex; gap: 12px; align-items: center;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <label style="font-size: 13px; color: var(--text-dim);">Worker Name:</label>
          <input class="input" id="worker-name" value="${require('os').hostname()}" style="width: 200px;">
        </div>
      </div>
      <div class="wizard-actions">
        <button class="btn btn-secondary" id="ready-back">← Back</button>
        <button class="btn btn-success" id="ready-start" style="font-size: 16px; padding: 12px 32px;">
          🚀 Save & Start Worker
        </button>
      </div>`;

    el.querySelector('#ready-back').addEventListener('click', () => { this.step = 4; this.render(); });
    el.querySelector('#ready-start').addEventListener('click', async () => {
      const workerName = el.querySelector('#worker-name').value.trim() || require('os').hostname();

      // Save config
      await ipcWiz.invoke('config:save', {
        name: workerName,
        engineType: 'llamacpp',
        engineUrl: 'http://localhost:8080',
        preferredManager: this.managerUrl,
        workerApp: {
          setupComplete: true,
          gpu: this.gpuInfo?.gpus?.[0] || null,
          llamaServerPath: this.llamaServerPath,
          modelPath: this.modelPath,
          selectedModel: this.selectedModel?.name,
          contextSize: contextSize,
          turboQuant: window.AppState?.config?.workerApp?.turboQuant || false,
        },
      });

      // Switch to dashboard and start
      window.AppState.config = await ipcWiz.invoke('config:load');
      window.switchScreen('dashboard');
      setTimeout(() => ProcessControls.startAll(window.AppState.config), 500);
    });
  },
};
