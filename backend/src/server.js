const express = require('express');
const os = require('os');
const chatRoutes = require('./routes/chatRoutes');
const workerRoutes = require('./routes/workerRoutes');
const openaiRoutes = require('./routes/openaiRoutes');
const { requireApiKey } = require('./middleware/auth');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'LLM Cluster backend is running.' });
});

app.use('/chat', requireApiKey, chatRoutes);
app.use('/workers', workerRoutes);
app.use('/v1', requireApiKey, openaiRoutes);

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
  if (!process.env.CLUSTER_API_KEY) {
    console.warn('[auth] CLUSTER_API_KEY not set — /chat and /v1 are OPEN. Set it before exposing this manager publicly.');
  }
  if (!process.env.WORKER_SHARED_SECRET) {
    console.warn('[auth] WORKER_SHARED_SECRET not set — anyone can register as a worker.');
  }

  // mDNS advertisement — lets clients and workers auto-discover this manager on the LAN
  // Set MDNS=0 to disable (e.g. on networks that block multicast)
  if (process.env.MDNS !== '0') {
    try {
      const { Bonjour } = require('bonjour-service');
      const bonjour = new Bonjour();
      const service = bonjour.publish({
        name: `${os.hostname()} LLM Cluster`,
        type: 'llmcluster',
        protocol: 'tcp',
        port: PORT,
        txt: { version: '2.0', api: '/chat' },
      });
      const cleanup = () => { service.stop(() => bonjour.destroy()); };
      process.on('SIGINT',  cleanup);
      process.on('SIGTERM', cleanup);
      console.log(`[mdns] published llmcluster on port ${PORT}`);
    } catch (err) {
      console.warn(`[mdns] not available: ${err.message}`);
    }
  }
});
