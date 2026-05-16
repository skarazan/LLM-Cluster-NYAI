'use strict';

const { spawn } = require('child_process');
const EventEmitter = require('events');
const path = require('path');

class LlamaServerManager extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.status = 'stopped'; // stopped | starting | running | error
    this.metrics = { tokPerSec: 0, vramUsed: 0, requestsServed: 0 };
    this.startTime = null;
  }

  /**
   * Start llama-server with the given options.
   * @param {Object} opts
   *   - binaryPath: string — path to llama-server executable
   *   - modelPath: string — path to GGUF model file
   *   - contextSize: number — context window size (default 8192)
   *   - ngl: number — GPU layers (default 99 = all)
   *   - host: string — bind host (default 0.0.0.0)
   *   - port: number — bind port (default 8080)
   *   - turboQuant: boolean — use experimental KV cache quant
   *   - extraArgs: string[] — additional flags
   */
  start(opts) {
    if (this.process) {
      this.emit('error', 'llama-server already running');
      return;
    }

    const args = [
      '-m', opts.modelPath,
      '-ngl', String(opts.ngl ?? 99),
      '-c', String(opts.contextSize ?? 8192),
      '--host', opts.host || '0.0.0.0',
      '--port', String(opts.port || 8080),
      '-fa', // flash attention
    ];

    // TurboQuant — experimental KV cache quantization
    if (opts.turboQuant) {
      args.push('--cache-type-k', 'turbo4');
      args.push('--cache-type-v', 'turbo3');
    }

    if (opts.extraArgs) args.push(...opts.extraArgs);

    this.status = 'starting';
    this.startTime = Date.now();
    this.emit('log', `[llama-server] Starting: ${opts.binaryPath} ${args.join(' ')}`);

    this.process = spawn(opts.binaryPath, args, {
      cwd: path.dirname(opts.binaryPath),
      env: { ...process.env },
    });

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
        this._parseLine(line);
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
    this.emit('log', '[llama-server] Stopping...');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.process) this.process.kill('SIGKILL');
        resolve();
      }, 5000);

      this.process.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.process.kill('SIGTERM');
    });
  }

  getStatus() {
    return {
      status: this.status,
      metrics: { ...this.metrics },
      uptime: this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
      pid: this.process?.pid || null,
    };
  }

  _parseLine(line) {
    // Detect ready signal
    if (line.includes('server listening') || line.includes('HTTP server listening')) {
      this.status = 'running';
      this.emit('ready');
    }

    // Parse tok/s from llama.cpp output
    // Format: "... tok/s: 45.23 ..."  or "speed: 45.23 t/s"
    const tokMatch = line.match(/(\d+\.?\d*)\s*(?:tok\/s|t\/s|tokens?\/s)/i);
    if (tokMatch) {
      this.metrics.tokPerSec = parseFloat(tokMatch[1]);
      this.emit('metrics', { ...this.metrics });
    }

    // Parse VRAM usage
    // Format: "VRAM used: 5234.56 MiB" or "model size: 5.2 GiB"
    const vramMatch = line.match(/(\d+\.?\d*)\s*(MiB|GiB|MB|GB)\s*(?:VRAM|used)/i);
    if (vramMatch) {
      let vram = parseFloat(vramMatch[1]);
      if (vramMatch[2] === 'MiB' || vramMatch[2] === 'MB') vram /= 1024;
      this.metrics.vramUsed = Math.round(vram * 10) / 10;
      this.emit('metrics', { ...this.metrics });
    }

    // Count requests
    if (line.includes('slot ') && line.includes('released')) {
      this.metrics.requestsServed++;
      this.emit('metrics', { ...this.metrics });
    }

    // Detect errors
    if (line.includes('error') && line.includes('CUDA') ||
        line.includes('failed to') ||
        line.includes('GGML_ASSERT')) {
      this.emit('error', line);
    }
  }
}

// Singleton
module.exports = new LlamaServerManager();
