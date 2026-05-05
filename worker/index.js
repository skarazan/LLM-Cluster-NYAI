'use strict';

const readline = require('readline');
const os       = require('os');
const fs       = require('fs');
const path     = require('path');
const { getCpuPct } = require('./lib/cpuSampler');

const OLLAMA_URL      = 'http://localhost:11434';
const HEARTBEAT_EVERY = 15_000; // 15s

// ---------- Config loader ----------

function loadConfig() {
  const configPath = path.join(os.homedir(), '.llm-cluster-worker.json');
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn(`[config] Could not read ${configPath}: ${err.message}`);
  }
  return {};
}

// ---------- Manager URL discovery ----------

async function discoverManager() {
  try {
    const { Bonjour } = require('bonjour-service');
    const b = new Bonjour();
    return await new Promise((resolve) => {
      const found = [];
      const browser = b.find({ type: 'llmcluster' }, (svc) => {
        const addr = (svc.addresses || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
        if (addr) found.push(`http://${addr}:${svc.port}`);
      });
      setTimeout(() => {
        browser.stop();
        b.destroy();
        resolve(found);
      }, 3000);
    });
  } catch {
    return [];
  }
}

async function getManagerUrl(config) {
  // 1. CLI arg
  if (process.argv[2]) return process.argv[2].replace(/\/$/, '');

  // 2. Env var
  if (process.env.LLM_MANAGER_URL) return process.env.LLM_MANAGER_URL.replace(/\/$/, '');

  // 3. Config file preferred manager
  if (config.preferredManager) return config.preferredManager.replace(/\/$/, '');

  // 4. mDNS discovery
  console.log('[discovery] Searching for manager on LAN (3s)...');
  const found = await discoverManager();
  if (found.length === 1) {
    console.log(`[discovery] Found manager: ${found[0]}`);
    return found[0];
  }
  if (found.length > 1) {
    console.log(`[discovery] Found ${found.length} managers: ${found.join(', ')}`);
    console.log(`[discovery] Using first: ${found[0]}`);
    return found[0];
  }

  // 5. Interactive prompt
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Manager URL (e.g. http://192.168.1.100:3000): ', (answer) => {
      rl.close();
      resolve(answer.trim().replace(/\/$/, ''));
    });
  });
}

// ---------- Ollama helpers ----------

async function getLocalModels() {
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/tags`);
  } catch (err) {
    console.error(`Cannot reach Ollama at ${OLLAMA_URL}. Is it running?`);
    console.error(err.message);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Ollama responded with HTTP ${res.status}`);
    process.exit(1);
  }
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

// ---------- Manager communication ----------

async function register(managerUrl, name, ip, models, capacity) {
  let res;
  try {
    res = await fetch(`${managerUrl}/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ip, port: 11434, models, capacity, version: '2.0' }),
    });
  } catch (err) {
    console.error(`Cannot reach manager at ${managerUrl}.`);
    console.error(err.message);
    process.exit(1);
  }
  if (!res.ok) {
    const body = await res.text();
    console.error(`Registration failed (HTTP ${res.status}): ${body}`);
    process.exit(1);
  }
  const data = await res.json();
  return data.id;
}

async function sendHeartbeat(managerUrl, id) {
  // Sample CPU once per heartbeat
  getCpuPct(); // warm first call discarded; real value used below after 1s
  await new Promise(r => setTimeout(r, 1000));
  const cpuPct   = getCpuPct();
  const loadAvg1 = os.loadavg()[0];

  try {
    const res = await fetch(`${managerUrl}/workers/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, metrics: { cpuPct, loadAvg1 } }),
    });
    if (!res.ok) {
      console.warn(`[heartbeat] manager responded ${res.status} — will retry`);
    }
  } catch (err) {
    console.warn(`[heartbeat] failed to reach manager: ${err.message} — will retry`);
  }
}

async function deregister(managerUrl, id) {
  try {
    const res = await fetch(`${managerUrl}/workers/deregister`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      console.log('Deregistered from manager. Goodbye.');
    } else {
      console.warn(`Deregister responded HTTP ${res.status} — manager will expire the entry in 30s.`);
    }
  } catch (err) {
    console.warn(`Could not reach manager to deregister: ${err.message}`);
    console.warn('Manager will expire the entry in 30s.');
  }
}

// ---------- Main ----------

async function main() {
  const config = loadConfig();

  // Determine capacity
  const cores      = os.cpus().length;
  const maxThreads = config.maxThreads    || Math.max(2, cores - 2);
  const maxConcurrent = config.maxConcurrent || 1;
  const capacity   = { cores, maxThreads, maxConcurrent };

  const managerUrl = await getManagerUrl(config);
  const models     = await getLocalModels();
  const ip         = getLocalIp();
  const name       = config.name || os.hostname();

  console.log(`Detected ${models.length} model(s): ${models.join(', ') || '(none)'}`);
  console.log(`Capacity: ${cores} cores → maxThreads=${maxThreads}, maxConcurrent=${maxConcurrent}`);
  console.log(`Registering as "${name}" (${ip}) with manager at ${managerUrl} ...`);

  const id = await register(managerUrl, name, ip, models, capacity);

  console.log('Registered with manager. Sending heartbeats... (Ctrl+C to stop)');

  const heartbeatTimer = setInterval(() => sendHeartbeat(managerUrl, id), HEARTBEAT_EVERY);

  async function shutdown() {
    console.log('\nShutting down...');
    clearInterval(heartbeatTimer);
    await deregister(managerUrl, id);
    process.exit(0);
  }

  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

main();
