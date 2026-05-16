'use strict';

const { ipcRenderer: ipcS } = require('electron');

window.Settings = {
  config: {},

  async init(container) {
    this.container = container;
    this.config = await ipcS.invoke('config:load');
    this.render();
  },

  render() {
    const wa = this.config.workerApp || {};
    const turboQuant = wa.turboQuant || false;

    this.container.innerHTML = `
      <h2 style="margin-bottom: 20px;">Settings</h2>

      <div class="settings-group">
        <h3>Worker</h3>
        <div class="settings-row">
          <span class="settings-label">Worker Name</span>
          <input class="input" id="set-name" value="${this.config.name || ''}">
        </div>
        <div class="settings-row">
          <span class="settings-label">Manager URL</span>
          <input class="input" id="set-manager" value="${this.config.preferredManager || 'https://llm.tutorrev.live'}">
        </div>
      </div>

      <div class="settings-group">
        <h3>Engine</h3>
        <div class="settings-row">
          <span class="settings-label">Engine Type</span>
          <input class="input" id="set-engine-type" value="${this.config.engineType || 'llamacpp'}" readonly style="opacity: 0.6;">
        </div>
        <div class="settings-row">
          <span class="settings-label">Engine URL</span>
          <input class="input" id="set-engine-url" value="${this.config.engineUrl || 'http://localhost:8080'}">
        </div>
        <div class="settings-row">
          <span class="settings-label">Engine API Key</span>
          <input class="input" id="set-api-key" type="password" value="${this.config.engineApiKey || ''}" placeholder="Optional">
        </div>
      </div>

      <div class="settings-group">
        <h3>Model & Performance</h3>
        <div class="settings-row">
          <span class="settings-label">llama-server Path</span>
          <input class="input" id="set-llama-path" value="${wa.llamaServerPath || ''}" style="font-size: 12px;">
        </div>
        <div class="settings-row">
          <span class="settings-label">Model Path</span>
          <input class="input" id="set-model-path" value="${wa.modelPath || ''}" style="font-size: 12px;">
        </div>
        <div class="settings-row">
          <span class="settings-label">Context Size</span>
          <input class="input" id="set-context" type="number" value="${wa.contextSize || 8192}" style="width: 120px;">
          <span style="font-size: 12px; color: var(--text-dim);">tokens</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">
            ⚡ TurboQuant
            <span class="turbo-badge" style="margin-left: 8px;">Experimental</span>
          </span>
          <label class="toggle">
            <input type="checkbox" id="set-turbo" ${turboQuant ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div style="margin-left: 192px; font-size: 12px; color: var(--text-dim); margin-top: -4px; margin-bottom: 8px;">
          Enables KV cache quantization (turbo3/turbo4). Reduces VRAM ~40% for context but may affect quality.
          <br>Requires compatible llama.cpp build.
        </div>
      </div>

      <div class="settings-group">
        <h3>Actions</h3>
        <div style="display: flex; gap: 12px; flex-wrap: wrap;">
          <button class="btn btn-primary" id="set-save">Save Settings</button>
          <button class="btn btn-secondary" id="set-wizard">Re-run Setup Wizard</button>
          <button class="btn btn-secondary" id="set-update-check">Check for Updates</button>
        </div>
      </div>

      <div id="set-status" style="font-size: 13px; margin-top: 12px;"></div>
    `;

    // Save handler
    this.container.querySelector('#set-save').addEventListener('click', async () => {
      const newConfig = {
        name: this.container.querySelector('#set-name').value.trim(),
        preferredManager: this.container.querySelector('#set-manager').value.trim(),
        engineType: this.container.querySelector('#set-engine-type').value.trim(),
        engineUrl: this.container.querySelector('#set-engine-url').value.trim(),
        engineApiKey: this.container.querySelector('#set-api-key').value.trim(),
        workerApp: {
          ...wa,
          llamaServerPath: this.container.querySelector('#set-llama-path').value.trim(),
          modelPath: this.container.querySelector('#set-model-path').value.trim(),
          contextSize: parseInt(this.container.querySelector('#set-context').value) || 8192,
          turboQuant: this.container.querySelector('#set-turbo').checked,
        },
      };

      this.config = await ipcS.invoke('config:save', newConfig);
      window.AppState.config = this.config;
      this.container.querySelector('#set-status').innerHTML =
        '<span style="color: var(--green);">✓ Settings saved!</span>';
    });

    // Re-run wizard
    this.container.querySelector('#set-wizard').addEventListener('click', () => {
      window.switchScreen('setup');
    });

    // Check for updates
    this.container.querySelector('#set-update-check').addEventListener('click', async () => {
      await ipcS.invoke('update:check');
      this.container.querySelector('#set-status').innerHTML =
        '<span style="color: var(--accent);">Checking for updates...</span>';
    });
  },
};
