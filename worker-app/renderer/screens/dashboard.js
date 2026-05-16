'use strict';

const ipc = require('electron').ipcRenderer;

window.Dashboard = {
  statsInterval: null,
  ipcBound: false,  // prevent duplicate listeners
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
    if (!this.ipcBound) {
      this.listenIPC();
      this.ipcBound = true;
    }
  },

  render() {
    this.container.innerHTML = `
      <div id="process-controls"></div>
      <div id="stats-cards"></div>
      <div id="log-viewer" style="flex: 1; min-height: 0;"></div>
    `;
    // Render immediately with current stats (no async wait)
    this._renderComponents();
    // Then update with fresh IPC data
    this.updateAll();
  },

  _renderComponents() {
    const config      = window.AppState?.config || {};
    const controlsEl  = this.container.querySelector('#process-controls');
    const statsEl     = this.container.querySelector('#stats-cards');
    const logEl       = this.container.querySelector('#log-viewer');

    if (controlsEl) ProcessControls.render(controlsEl, {
      config,
      llamaStatus:  { status: this.stats.status },
      workerStatus: { status: this.stats.status, jobCount: this.stats.jobCount },
    });
    if (statsEl) StatsCards.render(statsEl, this.stats);
    if (logEl)   LogViewer.render(logEl);
  },

  async updateAll() {
    if (!this.container) return;
    try {
      const config      = window.AppState?.config || {};
      const llamaStatus  = await ipc.invoke('llama:status');
      const workerStatus = await ipc.invoke('worker:status');

      this.stats.status      = llamaStatus.status;
      this.stats.uptime      = llamaStatus.uptime;
      this.stats.jobCount    = workerStatus.jobCount;
      this.stats.contextSize = config.workerApp?.contextSize || 0;

      const controlsEl = this.container.querySelector('#process-controls');
      const statsEl    = this.container.querySelector('#stats-cards');
      const logEl      = this.container.querySelector('#log-viewer');

      if (controlsEl) ProcessControls.render(controlsEl, { config, llamaStatus, workerStatus });
      if (statsEl)    StatsCards.render(statsEl, this.stats);
      if (logEl)      LogViewer.render(logEl);
    } catch (err) {
      console.error('[dashboard] updateAll error:', err);
    }
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
    ipc.on('llama:log',     (_e, line) => LogViewer.addLine('llama', line));
    ipc.on('worker:log',    (_e, line) => LogViewer.addLine('worker', line));
    ipc.on('llama:error',   (_e, err)  => LogViewer.addLine('errors', `llama-server error: ${err}`));
    ipc.on('worker:error',  (_e, err)  => LogViewer.addLine('errors', `Worker error: ${err}`));
    ipc.on('worker:job',    (_e, job)  => LogViewer.addLine('worker', `Job completed: ${job.raw || 'done'}`));

    ipc.on('llama:metrics', (_e, metrics) => {
      if (metrics.tokPerSec !== undefined) this.stats.tokPerSec = metrics.tokPerSec;
      if (metrics.vramUsed  !== undefined) this.stats.vramUsed  = metrics.vramUsed;
    });

    ipc.on('llama:ready', () => {
      LogViewer.addLine('llama', '✓ llama-server is ready!');
      this.stats.status = 'running';
    });

    ipc.on('llama:exit', (_e, code) => {
      LogViewer.addLine('llama', `llama-server exited (code ${code})`);
      this.stats.status = 'stopped';
    });

    ipc.on('worker:exit', (_e, code) => {
      LogViewer.addLine('worker', `Worker exited (code ${code})`);
    });
  },
};
