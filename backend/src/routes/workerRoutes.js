const express = require('express');
const router = express.Router();
const { getAllWorkers } = require('../services/workerService');

// GET /workers — lists all registered workers and their status
router.get('/', (req, res) => {
  res.json({ workers: getAllWorkers() });
});

module.exports = router;
