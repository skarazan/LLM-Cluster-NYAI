'use strict';

const { ipcRenderer: ipc } = require('electron');

window.Dashboard = {
  statsInterval: null,
  stats: {
    status: 'stopped',
    tokPerSec: 0,
    vramUsed: 0,
    jobCount: 0,
    uptime: 0,
    contextSize: 0,
  },

  init(container) {
    this.container = container;
    this.render();
    this.startPolling();
    this.listenIPC();
  },

  render() {
    this.container.innerHTML = `
      <div id="process-controls"></div>
      <div id="stats-cards"></div>
      <div id="log-viewer" style="flex: 1; min-height: 0;"></div>
    `;

    this.updateAll();
  },

  async updateAll() {
    const config = window.AppState?.config || {};
    const llamaStatus = await ipc.invoke('llama:status');
    const workerStatus = await ipc.invoke('worker:status');

    // Update stats
    this.stats.status = llamaStatus.status;
    this.stats.uptime = llamaStatus.uptime;
    this.stats.jobCount = workerStatus.jobCount;
    this.stats.contextSize = config.workerApp?.contextSize || 0;

    // Render sub-components
    const controlsEl = this.container.querySelector('#process-controls');
    const statsEl = this.container.querySelector('#stats-cards');
    const logEl = this.container.querySelector('#log-viewer');

    if (controlsEl) ProcessControls.render(controlsEl, { config, llamaStatus, workerStatus });
    if (statsEl) StatsCards.render(statsEl, this.stats);
    if (logEl) LogViewer.render(logEl);
  },

  startPolling() {
    if (this.statsInterval) clearInterval(this.statsInterval);
    this.statsInterval = setInterval(() => this.updateAll(), 2000);
  },

  stopPolling() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  },

  listenIPC() {
    ipc.on('llama:log', (_e, line) => {
      LogViewer.addLine('llama', line);
    });

    ipc.on('worker:log', (_e, line) => {
      LogViewer.addLine('worker', line);
    });

    ipc.on('llama:metrics', (_e, metrics) => {
      if (metrics.tokPerSec) this.stats.tokPerSec = metrics.tokPerSec;
      if (metrics.vramUsed) this.stats.vramUsed = metrics.vramUsed;
    });

    ipc.on('llama:ready', () => {
      LogViewer.addLine('llama', '✓ llama-server is ready!');
    });

    ipc.on('llama:error', (_e, err) => {
      LogViewer.addLine('errors', `llama-server error: ${err}`);
    });

    ipc.on('llama:exit', (_e, code) => {
      LogViewer.addLine('llama', `llama-server exited with code ${code}`);
      this.stats.status = 'stopped';
    });

    ipc.on('worker:error', (_e, err) => {
      LogViewer.addLine('errors', `Worker error: ${err}`);
    });

    ipc.on('worker:exit', (_e, code) => {
      LogViewer.addLine('worker', `Worker exited with code ${code}`);
    });

    ipc.on('worker:job', (_e, jobData) => {
      LogViewer.addLine('worker', `Job completed: ${jobData.raw || 'unknown'}`);
    });
  },

  destroy() {
    this.stopPolling();
  }
};
