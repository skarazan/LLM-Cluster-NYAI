'use strict';

const { fork } = require('child_process');
const EventEmitter = require('events');
const path = require('path');
const fs   = require('fs');

class WorkerProcessManager extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.status = 'stopped'; // stopped | running | error
    this.jobCount = 0;
    this.startTime = null;
  }

  /**
   * Start the worker script as a child process.
   * @param {Object} opts
   *   - managerUrl: string — manager URL
   *   - engineType: string — 'llamacpp'
   *   - engineUrl: string — local llama-server URL (default http://localhost:8080)
   *   - name: string — worker name
   *   - engineApiKey: string — optional API key
   */
  start(opts) {
    if (this.process) {
      this.emit('error', 'Worker already running');
      return;
    }

    // Find worker/index.js — either in extraResources (packaged) or relative (dev)
    let workerScript;
    const resourcesPath = process.resourcesPath;
    const packagedPath = resourcesPath
      ? path.join(resourcesPath, 'worker', 'index.js')
      : null;
    const devPath = path.join(__dirname, '..', '..', 'worker', 'index.js');

    if (packagedPath && fs.existsSync(packagedPath)) {
      workerScript = packagedPath;
    } else if (fs.existsSync(devPath)) {
      workerScript = devPath;
    } else {
      this.emit('error', `Worker script not found. Checked:\n  ${packagedPath}\n  ${devPath}`);
      return;
    }

    this.emit('log', `[worker] Starting: ${workerScript}`);
    this.emit('log', `[worker] Manager: ${opts.managerUrl}`);

    const env = {
      ...process.env,
      LLM_ENGINE_TYPE: opts.engineType || 'llamacpp',
      LLM_ENGINE_URL: opts.engineUrl || 'http://localhost:8080',
      LLM_MANAGER_URL: opts.managerUrl,
    };

    if (opts.engineApiKey) env.LLM_ENGINE_API_KEY = opts.engineApiKey;
    if (opts.name) env.LLM_WORKER_NAME = opts.name;

    this.process = fork(workerScript, [opts.managerUrl], {
      env,
      silent: true, // capture stdout/stderr
    });

    this.status = 'running';
    this.startTime = Date.now();

    this.process.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        this.emit('log', line);
        this._parseLine(line);
      }
    });

    this.process.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        this.emit('log', `[stderr] ${line}`);
      }
    });

    // IPC messages from worker (if worker supports it)
    this.process.on('message', (msg) => {
      if (msg.type === 'job') {
        this.jobCount++;
        this.emit('job', msg.data);
      }
    });

    this.process.on('error', (err) => {
      this.status = 'error';
      this.emit('error', err.message);
    });

    this.process.on('exit', (code) => {
      this.status = 'stopped';
      this.process = null;
      this.emit('exit', code);
    });
  }

  async stop() {
    if (!this.process) return;
    this.emit('log', '[worker] Stopping...');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) this.process.kill('SIGKILL');
        resolve();
      }, 5000);

      this.process.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      // Send SIGINT first (triggers graceful deregister in worker)
      this.process.kill('SIGINT');
    });
  }

  getStatus() {
    return {
      status: this.status,
      jobCount: this.jobCount,
      uptime: this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
      pid: this.process?.pid || null,
    };
  }

  _parseLine(line) {
    // Detect job activity
    if (line.includes('[job]') || line.includes('Running job')) {
      this.jobCount++;
      this.emit('job', { raw: line, timestamp: Date.now() });
    }

    // Detect registration
    if (line.includes('Registered as') || line.includes('[register]')) {
      this.emit('log', `✓ ${line}`);
    }
  }
}

// Singleton
module.exports = new WorkerProcessManager();
