const express = require('express');
const os = require('os');
const chatRoutes = require('./routes/chatRoutes');
const workerRoutes = require('./routes/workerRoutes');

const app = express();
const PORT = 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'LLM Cluster backend is running.' });
});

app.use('/chat', chatRoutes);
app.use('/workers', workerRoutes);

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);

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
