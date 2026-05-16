'use strict';

const { ipcRenderer } = require('electron');

window.ProcessControls = {
  llamaRunning: false,
  workerRunning: false,

  render(container, state) {
    const { config, llamaStatus, workerStatus } = state;
    const isRunning = llamaStatus?.status === 'running' && workerStatus?.status === 'running';
    const isStarting = llamaStatus?.status === 'starting';
    const isStopped = llamaStatus?.status === 'stopped' && workerStatus?.status === 'stopped';

    const statusDot = isRunning ? 'dot-running' : isStarting ? 'dot-starting' : 'dot-stopped';
    const statusText = isRunning ? 'Running' : isStarting ? 'Starting...' : 'Stopped';
    const modelName = config?.workerApp?.selectedModel || 'No model';

    container.innerHTML = `
      <div class="process-bar">
        <div class="process-status">
          <span class="dot ${statusDot}"></span>
          <span class="process-name">${config?.name || 'Worker'}</span>
          <span style="color: var(--text-dim);">— ${statusText}</span>
        </div>
        <div class="process-spacer"></div>
        <span class="process-model">${modelName}</span>
        ${isStopped
          ? `<button class="btn btn-success" id="btn-run">▶ Run</button>`
          : `<button class="btn btn-danger" id="btn-stop">■ Stop</button>`}
      </div>`;

    const runBtn = container.querySelector('#btn-run');
    const stopBtn = container.querySelector('#btn-stop');

    if (runBtn) {
      runBtn.addEventListener('click', () => this.startAll(config));
    }
    if (stopBtn) {
      stopBtn.addEventListener('click', () => this.stopAll());
    }
  },

  async startAll(config) {
    const wa = config?.workerApp || {};

    if (!wa.llamaServerPath || !wa.modelPath) {
      alert('Setup not complete. Run the setup wizard first.');
      return;
    }

    const managerUrl = config?.preferredManager || 'https://llm.tutorrev.live';

    // Start llama-server
    await ipcRenderer.invoke('llama:start', {
      binaryPath: wa.llamaServerPath,
      modelPath: wa.modelPath,
      contextSize: wa.contextSize || 8192,
      ngl: 99,
      port: 8080,
      turboQuant: wa.turboQuant || false,
    });

    // Wait for llama-server ready, then start worker
    ipcRenderer.once('llama:ready', async () => {
      await ipcRenderer.invoke('worker:start', {
        managerUrl,
        engineType: 'llamacpp',
        engineUrl: 'http://localhost:8080',
        name: config?.name || `worker-${require('os').hostname()}`,
      });
    });
  },

  async stopAll() {
    await ipcRenderer.invoke('worker:stop');
    await ipcRenderer.invoke('llama:stop');
  }
};
