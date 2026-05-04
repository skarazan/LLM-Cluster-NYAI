const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

let mainWindow;

const RELEASES_URL = 'https://github.com/skarazan/LLM-Cluster-NYAI/releases/latest';
const RELEASES_API = 'https://api.github.com/repos/skarazan/LLM-Cluster-NYAI/releases/latest';

// --- Update check: compare current version against latest GitHub release ---
async function checkForUpdates() {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { 'User-Agent': 'LLM-Cluster-Chat' },
    });
    if (!res.ok) return;
    const data = await res.json();
    const latest = (data.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    if (latest && latest !== current) {
      if (mainWindow) mainWindow.webContents.send('update-available', { version: latest });
    }
  } catch (err) {
    console.error('[updater] check failed:', err.message);
  }
}

ipcMain.on('open-releases', () => {
  shell.openExternal(RELEASES_URL);
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
  setTimeout(checkForUpdates, 3000);
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
