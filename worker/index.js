'use strict';

const readline = require('readline');
const os       = require('os');

const OLLAMA_URL      = 'http://localhost:11434';
const HEARTBEAT_EVERY = 15_000; // 15s

async function getManagerUrl() {
  const fromArg = process.argv[2];
  if (fromArg) return fromArg.replace(/\/$/, '');

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Manager URL (e.g. http://192.168.1.100:3000): ', (answer) => {
      rl.close();
      resolve(answer.trim().replace(/\/$/, ''));
    });
  });
}

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

async function register(managerUrl, name, ip, models) {
  let res;
  try {
    res = await fetch(`${managerUrl}/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ip, port: 11434, models }),
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
  try {
    const res = await fetch(`${managerUrl}/workers/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
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

async function main() {
  const managerUrl = await getManagerUrl();
  const models     = await getLocalModels();
  const ip         = getLocalIp();
  const name       = os.hostname();

  console.log(`Detected ${models.length} model(s): ${models.join(', ') || '(none)'}`);
  console.log(`Registering as "${name}" (${ip}) with manager at ${managerUrl} ...`);

  const id = await register(managerUrl, name, ip, models);

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
