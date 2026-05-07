const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs/promises');
const fsSync = require('fs');
const cp     = require('child_process');
const { resolveSafe, checkShellCommand } = require('./lib/sandbox');
const { getTool } = require('./lib/tools');

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
  win.webContents.openDevTools();
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
ipcMain.handle('send-prompt', async (event, { backendUrl, messages, model, tools }) => {
  try {
    const body = { messages, model };
    if (tools && tools.length > 0) body.tools = tools;
    const res = await fetch(`${backendUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text.trim()); }
    catch { throw new Error(`Server returned non-JSON (HTTP ${res.status}): ${text.trim().slice(0, 200)}`); }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Agent: workspace picker ──────────────────────────────────────────────────
ipcMain.handle('agent:choose-workspace', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose Workspace Folder',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false };
  return { ok: true, path: result.filePaths[0] };
});

// ── Agent: execute a tool in the main process (sandboxed) ───────────────────
ipcMain.handle('agent:run-tool', async (event, { tool, args, workspace }) => {
  console.log(`[tool] ${tool} workspace="${workspace}" args=${JSON.stringify(args)}`);
  const toolDef = getTool(tool);
  if (!toolDef) return { ok: false, error: `Unknown tool: ${tool}` };

  try {
    switch (tool) {

      case 'read_file': {
        const check = resolveSafe(workspace, args.path);
        if (!check.ok) return { ok: false, error: check.error };
        const raw = await fs.readFile(check.resolved, 'utf8');
        const lines = raw.split('\n');
        const off   = Math.max(0, (args.offset || 1) - 1);
        const lim   = args.limit || lines.length;
        return { ok: true, result: lines.slice(off, off + lim).join('\n') };
      }

      case 'list_dir': {
        const check = resolveSafe(workspace, args.path);
        if (!check.ok) return { ok: false, error: check.error };
        const entries = await fs.readdir(check.resolved, { withFileTypes: true });
        const list = entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
        return { ok: true, result: list };
      }

      case 'glob': {
        const rootPath = args.root ? args.root : '.';
        const check = resolveSafe(workspace, rootPath);
        if (!check.ok) return { ok: false, error: check.error };
        // Use Node glob (available in Node 22+) or fall back to simple recursive walk
        const { glob } = require('fs');
        const matches = await new Promise((resolve, reject) => {
          glob(args.pattern, { cwd: check.resolved }, (err, files) => {
            if (err) reject(err); else resolve(files);
          });
        });
        return { ok: true, result: matches };
      }

      case 'grep': {
        const searchRoot = args.path ? args.path : '.';
        const check = resolveSafe(workspace, searchRoot);
        if (!check.ok) return { ok: false, error: check.error };
        const useRegex = args.regex !== false;
        const pattern  = useRegex ? new RegExp(args.pattern) : args.pattern;
        const results  = await grepDir(check.resolved, pattern, args.glob || null, useRegex);
        return { ok: true, result: results };
      }

      case 'write_file': {
        const check = resolveSafe(workspace, args.path);
        if (!check.ok) return { ok: false, error: check.error };
        await fs.mkdir(path.dirname(check.resolved), { recursive: true });
        await fs.writeFile(check.resolved, args.content, 'utf8');
        return { ok: true, result: `Written ${check.resolved}` };
      }

      case 'edit_file': {
        const check = resolveSafe(workspace, args.path);
        if (!check.ok) return { ok: false, error: check.error };
        const content = await fs.readFile(check.resolved, 'utf8');
        const count = content.split(args.old_string).length - 1;
        if (count === 0) return { ok: false, error: `old_string not found in ${args.path}` };
        if (count > 1)   return { ok: false, error: `old_string appears ${count} times — must be unique` };
        await fs.writeFile(check.resolved, content.replace(args.old_string, args.new_string), 'utf8');
        return { ok: true, result: `Edited ${check.resolved}` };
      }

      case 'create_dir': {
        const check = resolveSafe(workspace, args.path);
        if (!check.ok) return { ok: false, error: check.error };
        await fs.mkdir(check.resolved, { recursive: true });
        return { ok: true, result: `Created ${check.resolved}` };
      }

      case 'delete_file': {
        const check = resolveSafe(workspace, args.path);
        if (!check.ok) return { ok: false, error: check.error };
        await fs.unlink(check.resolved);
        return { ok: true, result: `Deleted ${check.resolved}` };
      }

      case 'run_shell': {
        const shellCheck = checkShellCommand(args.cmd, args.args || []);
        if (!shellCheck.ok) return { ok: false, error: shellCheck.error };
        const cwdCheck = resolveSafe(workspace, args.cwd || '.');
        if (!cwdCheck.ok) return { ok: false, error: cwdCheck.error };
        const timeout = args.timeout_ms || 30000;
        const output  = await new Promise((resolve, reject) => {
          cp.execFile(args.cmd, args.args || [], {
            cwd: cwdCheck.resolved,
            timeout,
            maxBuffer: 1_000_000,
            shell: false,
          }, (err, stdout, stderr) => {
            if (err && !stdout && !stderr) return reject(err);
            resolve({ stdout: (stdout || '').slice(0, 100000), stderr: (stderr || '').slice(0, 10000), exitCode: err ? err.code : 0 });
          });
        });
        return { ok: true, result: output };
      }

      default:
        return { ok: false, error: `Tool "${tool}" not implemented.` };
    }
  } catch (err) {
    console.error(`[tool] ${tool} threw: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

// ── Helper: simple recursive grep ───────────────────────────────────────────
async function grepDir(root, pattern, globFilter, useRegex) {
  const results = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        if (globFilter) {
          const ext = path.extname(entry.name).slice(1);
          if (globFilter !== '*' && !globFilter.includes(ext) && globFilter !== `*.${ext}`) continue;
        }
        try {
          const text = await fs.readFile(full, 'utf8');
          const lines = text.split('\n');
          lines.forEach((line, i) => {
            const hit = useRegex ? pattern.test(line) : line.includes(pattern);
            if (hit) results.push({ file: full, line: i + 1, text: line });
          });
        } catch { /* binary or unreadable */ }
      }
    }
  }
  await walk(root);
  return results;
}

// mDNS discovery — browse for managers on the LAN for up to 2.5s
ipcMain.handle('discover-managers', async () => {
  try {
    const { Bonjour } = require('bonjour-service');
    const b = new Bonjour();
    return await new Promise((resolve) => {
      const found = [];
      const browser = b.find({ type: 'llmcluster' }, (svc) => {
        const addr = (svc.addresses || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
        if (addr) found.push({ name: svc.name, url: `http://${addr}:${svc.port}` });
      });
      setTimeout(() => { browser.stop(); b.destroy(); resolve(found); }, 2500);
    });
  } catch {
    return [];
  }
});
