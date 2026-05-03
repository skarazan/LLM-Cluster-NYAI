const express = require('express');
const chatRoutes = require('./routes/chatRoutes');
const workerRoutes = require('./routes/workerRoutes');

const app = express();
const PORT = 3000;

// Parse incoming JSON request bodies
app.use(express.json());

// Health check — confirms the backend is alive
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'LLM Cluster backend is running.' });
});

// Mount route groups
app.use('/chat', chatRoutes);
app.use('/workers', workerRoutes);

app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});
