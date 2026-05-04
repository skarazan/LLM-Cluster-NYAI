const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

let mainWindow;

// --- Auto-update wiring (uses GitHub Releases as the update server) ---
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', (info) => {
  if (mainWindow) mainWindow.webContents.send('update-status', { state: 'downloading', version: info.version });
});

autoUpdater.on('update-downloaded', async (info) => {
  if (mainWindow) mainWindow.webContents.send('update-status', { state: 'ready', version: info.version });
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    title: 'Update ready',
    message: `Version ${info.version} downloaded. Restart to install?`,
  });
  if (choice.response === 0) autoUpdater.quitAndInstall();
});

autoUpdater.on('error', (err) => {
  console.error('Updater error:', err);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    title: 'LLM Cluster Chat',
  });

  win.loadFile('renderer/index.html');
  win.setMenuBarVisibility(false);
  mainWindow = win;
}

app.whenReady().then(() => {
  createWindow();
  // Check for updates 3s after launch (skip in dev where app isn't packaged)
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(console.error), 3000);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Quick health check against backend
ipcMain.handle('ping-backend', async (event, { backendUrl }) => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${backendUrl}/`, { signal: ctrl.signal });
    clearTimeout(t);
    return { ok: res.ok };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Forward chat requests from renderer to backend (avoids CORS issues)
ipcMain.handle('send-prompt', async (event, { backendUrl, messages, model }) => {
  try {
    const res = await fetch(`${backendUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, model }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
