'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function canConnect(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const onDone = (v) => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    sock.setTimeout(timeout);
    sock.once('error', () => onDone(false));
    sock.once('timeout', () => onDone(false));
    sock.connect(port, host, () => onDone(true));
  });
}

function readLocalConfig() {
  try {
    const cfg = path.join(os.homedir(), '.llm-cluster-worker.json');
    if (fs.existsSync(cfg)) return JSON.parse(fs.readFileSync(cfg, 'utf8'));
  } catch (e) {}
  return {};
}

function findScript() {
  const root = path.resolve(__dirname, '..', '..');
  const candidates = [
    path.join(root, 'scripts', 'install-llamacpp.ps1'),
    path.join(root, 'scripts', 'install-llamacpp.sh'),
  ];
  return candidates.find(p => fs.existsSync(p));
}

function runShellCommand(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, detached: false, stdio: 'inherit', ...opts });
    child.on('error', (err) => reject(err));
    child.on('exit', (code, sig) => {
      if (code === 0) resolve(); else reject(new Error(`exit ${code || sig}`));
    });
  });
}

async function ensureRunning(engine, opts = {}) {
  const host = (new URL(engine.url)).hostname || '127.0.0.1';
  const port = Number(engine.port || 8080);

  if (await canConnect(host, port, 1000)) return true;

  const cfg = readLocalConfig();
  const envCmd = process.env.LLM_ENGINE_AUTO_START_CMD;
  const cfgCmd = cfg.engineAutoStartCmd;
  const startCmd = opts.startCmd || envCmd || cfgCmd;

  if (startCmd) {
    console.log(`[llamacpp] attempting to start engine with configured command: ${startCmd}`);
    try {
      // start in background
      spawn(startCmd, { shell: true, detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      console.warn('[llamacpp] failed to spawn configured start command:', e.message);
    }
    // wait for it to appear
    for (let i = 0; i < 30; i++) {
      if (await canConnect(host, port, 1000)) return true;
      await wait(1000);
    }
    console.warn('[llamacpp] configured start command did not bring the engine up in time');
  }

  // If no configured start command, attempt to run repository script (best-effort)
  const script = findScript();
  if (script) {
    console.log(`[llamacpp] running install script: ${script}`);
    try {
      await runShellCommand(script);
    } catch (e) {
      console.warn('[llamacpp] install script failed:', e.message);
    }
    // try to run a default binary name
    const binFromEnv = process.env.LLM_ENGINE_BIN || cfg.engineBin;
    const binCandidates = [];
    if (binFromEnv) binCandidates.push(binFromEnv);
    binCandidates.push(path.join(process.cwd(), 'llama-server'));
    binCandidates.push(path.join(process.cwd(), 'bin', 'llama-server'));

    for (const b of binCandidates) {
      try {
        if (fs.existsSync(b)) {
          console.log(`[llamacpp] starting binary: ${b}`);
          spawn(`"${b}"`, { shell: true, detached: true, stdio: 'ignore' }).unref();
          // wait a bit
          for (let i = 0; i < 20; i++) {
            if (await canConnect(host, port, 1000)) return true;
            await wait(1000);
          }
        }
      } catch (e) {
        console.warn('[llamacpp] starting binary failed:', e.message);
      }
    }
  }

  console.warn('[llamacpp] engine is not running and could not be auto-started');
  return false;
}

module.exports = { ensureRunning, canConnect };
