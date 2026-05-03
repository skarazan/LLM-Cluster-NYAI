const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

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
}

app.whenReady().then(createWindow);

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
ipcMain.handle('send-prompt', async (event, { backendUrl, prompt, model }) => {
  try {
    const res = await fetch(`${backendUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
