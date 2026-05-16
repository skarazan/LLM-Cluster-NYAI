'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(os.homedir(), '.llm-cluster-worker.json');
const APP_DIR     = path.join(os.homedir(), 'llm-cluster');
const BIN_DIR     = path.join(APP_DIR, 'bin');
const MODELS_DIR  = path.join(APP_DIR, 'models');
const HISTORY_DIR = path.join(APP_DIR, 'history');

function ensureDirs() {
  for (const dir of [APP_DIR, BIN_DIR, MODELS_DIR, HISTORY_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function load() {
  ensureDirs();
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (err) {
    console.warn('[config] Read error:', err.message);
  }
  return {};
}

function save(config) {
  ensureDirs();
  const existing = load();
  const merged = { ...existing, ...config };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

function getWorkerApp() {
  const cfg = load();
  return cfg.workerApp || {};
}

function saveWorkerApp(appConfig) {
  const cfg = load();
  cfg.workerApp = { ...(cfg.workerApp || {}), ...appConfig };
  return save(cfg);
}

module.exports = {
  load, save, getWorkerApp, saveWorkerApp, ensureDirs,
  CONFIG_PATH, APP_DIR, BIN_DIR, MODELS_DIR, HISTORY_DIR,
};
