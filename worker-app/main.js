const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const configStore     = require('./lib/configStore');
const gpuDetect       = require('./lib/gpuDetect');
const modelCatalog    = require('./lib/modelCatalog');
const modelRecommender = require('./lib/modelRecommender');
const downloadManager = require('./lib/downloadManager');
const llamaServer     = require('./lib/llamaServerManager');
const workerProcess   = require('./lib/workerProcessManager');
const mdns            = require('./lib/mdnsDiscovery');
const chatHistory     = require('./lib/chatHistoryStore');

let mainWindow;

// ── Auto-update ───────────────────────────────────────────────────────────────
// Worker-app releases use the tag prefix `worker-v{version}` to avoid
// colliding with client releases (`v{version}`) in the same repo.
// electron-updater's GitHub provider doesn't support tag prefixes natively,
// so we use the generic provider pointing to a static redirector.
// TODO v1.0.1: set up a simple redirect endpoint or move to separate repo.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', (info) => {
  if (mainWindow) mainWindow.webContents.send('update-available', info.version);
});
autoUpdater.on('download-progress', (progress) => {
  if (mainWindow) mainWindow.webContents.send('update-progress', progress.percent);
});
autoUpdater.on('update-downloaded', (info) => {
  if (mainWindow) mainWindow.webContents.send('update-downloaded', info.version);
});
autoUpdater.on('error', (err) => {
  console.error('[auto-update]', err.message);
});

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: 'LLM Cluster Worker',
    backgroundColor: '#1a1b26',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

  // Check for updates after window loads (not in dev)
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 3000);
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', async () => {
  // Graceful shutdown
  await llamaServer.stop();
  await workerProcess.stop();
  app.quit();
});
app.on('activate', () => {
  if (!mainWindow) createWindow();
});

// ── IPC: Config ───────────────────────────────────────────────────────────────
ipcMain.handle('config:load', () => configStore.load());
ipcMain.handle('config:save', (_e, config) => configStore.save(config));

// ── IPC: GPU Detection ───────────────────────────────────────────────────────
ipcMain.handle('gpu:detect', () => gpuDetect.detect());

// ── IPC: Models ──────────────────────────────────────────────────────────────
ipcMain.handle('models:catalog', () => modelCatalog.getAll());
ipcMain.handle('models:recommend', (_e, gpuInfo) => modelRecommender.recommend(gpuInfo));

// ── IPC: Downloads ───────────────────────────────────────────────────────────
ipcMain.handle('download:llama-server', (_e, opts) => {
  return downloadManager.downloadLlamaServer(opts, (progress) => {
    if (mainWindow) mainWindow.webContents.send('download:llama-progress', progress);
  });
});

ipcMain.handle('download:model', (_e, model) => {
  return downloadManager.downloadModel(model, (progress) => {
    if (mainWindow) mainWindow.webContents.send('download:model-progress', progress);
  });
});

ipcMain.handle('download:cancel', () => downloadManager.cancelAll());

// ── IPC: mDNS Discovery ─────────────────────────────────────────────────────
ipcMain.handle('mdns:discover', () => mdns.discover());

// ── IPC: Manager Connection Test ─────────────────────────────────────────────
ipcMain.handle('manager:test', async (_e, url) => {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/workers`, {
      signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: llama-server management ─────────────────────────────────────────────
ipcMain.handle('llama:start', (_e, opts) => {
  llamaServer.start(opts);
  llamaServer.on('log', (line) => {
    if (mainWindow) mainWindow.webContents.send('llama:log', line);
  });
  llamaServer.on('metrics', (m) => {
    if (mainWindow) mainWindow.webContents.send('llama:metrics', m);
  });
  llamaServer.on('ready', () => {
    if (mainWindow) mainWindow.webContents.send('llama:ready');
  });
  llamaServer.on('error', (err) => {
    if (mainWindow) mainWindow.webContents.send('llama:error', err);
  });
  llamaServer.on('exit', (code) => {
    if (mainWindow) mainWindow.webContents.send('llama:exit', code);
  });
  return { ok: true };
});

ipcMain.handle('llama:stop', () => llamaServer.stop());
ipcMain.handle('llama:status', () => llamaServer.getStatus());

// ── IPC: Worker process management ───────────────────────────────────────────
ipcMain.handle('worker:start', (_e, opts) => {
  workerProcess.start(opts);
  workerProcess.on('log', (line) => {
    if (mainWindow) mainWindow.webContents.send('worker:log', line);
  });
  workerProcess.on('job', (jobData) => {
    if (mainWindow) mainWindow.webContents.send('worker:job', jobData);
    chatHistory.recordJob(jobData);
  });
  workerProcess.on('error', (err) => {
    if (mainWindow) mainWindow.webContents.send('worker:error', err);
  });
  workerProcess.on('exit', (code) => {
    if (mainWindow) mainWindow.webContents.send('worker:exit', code);
  });
  return { ok: true };
});

ipcMain.handle('worker:stop', () => workerProcess.stop());
ipcMain.handle('worker:status', () => workerProcess.getStatus());

// ── IPC: Chat History ────────────────────────────────────────────────────────
ipcMain.handle('history:list', () => chatHistory.listConversations());
ipcMain.handle('history:get', (_e, id) => chatHistory.getConversation(id));
ipcMain.handle('history:auth', (_e, password) => {
  return password === 'SabaBaba' || password === 'BabaSaba';
});

// ── IPC: Auto-update ─────────────────────────────────────────────────────────
ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());
ipcMain.handle('update:check', () => {
  if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify();
});

// ── IPC: Shell / Misc ────────────────────────────────────────────────────────
ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:paths', () => ({
  home: require('os').homedir(),
  userData: app.getPath('userData'),
  resources: process.resourcesPath || path.join(__dirname, '..'),
}));
