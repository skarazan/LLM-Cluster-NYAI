const OLLAMA_TIMEOUT_MS = 60000; // 60s — llama3 can be slow on CPU

const workers = [
  { id: 1, name: 'Laptop 1', url: 'http://localhost:11434',   status: 'online'  },
  { id: 2, name: 'Laptop 2', url: 'http://192.168.1.2:11434', status: 'offline' },
  { id: 3, name: 'Laptop 3', url: 'http://192.168.1.3:11434', status: 'offline' },
];

let currentIndex = 0;

function getNextWorker() {
  const online = workers.filter(w => w.status === 'online');
  if (online.length === 0) return null;
  const worker = online[currentIndex % online.length];
  currentIndex = (currentIndex + 1) % online.length;
  return worker;
}

function getAllWorkers() {
  return workers;
}

async function sendPromptToWorker(worker, prompt, model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  try {
    const res = await fetch(`${worker.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Worker ${worker.name} returned HTTP ${res.status}`);
    }

    const data = await res.json();
    return data.response;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getNextWorker, getAllWorkers, sendPromptToWorker };
