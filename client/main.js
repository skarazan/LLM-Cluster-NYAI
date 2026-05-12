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
const MAX_NATIVE_WRITE_CHARS = 7000;
const DEFAULT_READ_LINES = 300;
const MAX_READ_LINES = 1000;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 200;
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.vite', 'coverage', '.cache']);
const activePromptControllers = new Map();

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
// Streams token chunks via IPC 'stream-chunk' events before returning the final response.
ipcMain.handle('send-prompt', async (event, { backendUrl, messages, model, tools, requestId, agentMode }) => {
  const controller = new AbortController();
  if (requestId) activePromptControllers.set(requestId, controller);
  try {
    const body = { messages, model };
    if (tools && tools.length > 0) body.tools = tools;
    if (requestId) body.requestId = requestId;
    if (agentMode) body.agentMode = agentMode;
    const res = await fetch(`${backendUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const decoder = new TextDecoder();
    let buf = '';
    let finalData = null;

    for await (const rawChunk of res.body) {
      buf += decoder.decode(rawChunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if ('chunk' in parsed) {
            // stream token chunk — forward to renderer
            event.sender.send('stream-chunk', parsed.chunk);
          } else {
            finalData = parsed; // final full response
          }
        } catch {}
      }
    }
    // handle any leftover in buffer
    if (buf.trim()) {
      try { finalData = finalData || JSON.parse(buf.trim()); } catch {}
    }

    if (!finalData) throw new Error('No response received from server');
    if (finalData.error) throw new Error(finalData.error);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, data: finalData };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Request cancelled' : err.message };
  } finally {
    if (requestId) activePromptControllers.delete(requestId);
  }
});

ipcMain.handle('cancel-prompt', async (event, { backendUrl, requestId }) => {
  if (!requestId) return { ok: false, error: 'Missing requestId' };
  const controller = activePromptControllers.get(requestId);
  if (controller) controller.abort();
  try {
    await fetch(`${backendUrl}/chat/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    });
  } catch {
    // The local abort matters most; the manager may already have finished.
  }
  return { ok: true };
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
        const lim   = Math.min(Math.max(1, args.limit || DEFAULT_READ_LINES), MAX_READ_LINES);
        const end = Math.min(lines.length, off + lim);
        const body = lines.slice(off, end).join('\n');
        const suffix = end < lines.length ? `\n\n[read_file truncated: showing lines ${off + 1}-${end} of ${lines.length}. Call read_file with offset=${end + 1} to continue.]` : '';
        return { ok: true, result: body + suffix };
      }

      case 'list_dir': {
        const check = resolveSafe(workspace, args.path);
        if (!check.ok) return { ok: false, error: check.error };
        const entries = await fs.readdir(check.resolved, { withFileTypes: true });
        const visible = entries
          .filter(e => !IGNORE_DIRS.has(e.name))
          .slice(0, MAX_LIST_ENTRIES)
          .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
        const truncated = entries.length > visible.length;
        return { ok: true, result: truncated ? { entries: visible, truncated: true, limit: MAX_LIST_ENTRIES } : visible };
      }

      case 'glob': {
        const rootPath = args.root ? args.root : '.';
        const check = resolveSafe(workspace, rootPath);
        if (!check.ok) return { ok: false, error: check.error };
        const matches = await simpleGlob(check.resolved, args.pattern);
        return { ok: true, result: matches.slice(0, MAX_SEARCH_RESULTS), truncated: matches.length > MAX_SEARCH_RESULTS };
      }

      case 'grep': {
        const searchRoot = args.path ? args.path : '.';
        const check = resolveSafe(workspace, searchRoot);
        if (!check.ok) return { ok: false, error: check.error };
        const useRegex = args.regex !== false;
        const pattern  = useRegex ? new RegExp(args.pattern) : args.pattern;
        const results  = await grepDir(check.resolved, pattern, args.glob || null, useRegex);
        return { ok: true, result: results.slice(0, MAX_SEARCH_RESULTS), truncated: results.length > MAX_SEARCH_RESULTS };
      }

      case 'write_file': {
        if (args.content == null) return { ok: false, error: 'write_file requires "content" argument (received undefined)' };
        if (String(args.content).length > MAX_NATIVE_WRITE_CHARS) {
          return { ok: false, error: `write_file content is too large for a native tool call (${String(args.content).length} chars). Use <write_file> text blocks so the client can chunk it safely.` };
        }
        const check = resolveSafe(workspace, args.path);
        if (!check.ok) return { ok: false, error: check.error };
        await fs.mkdir(path.dirname(check.resolved), { recursive: true });
        await fs.writeFile(check.resolved, args.content, 'utf8');
        return { ok: true, result: `Written ${check.resolved}` };
      }

      case 'append_file': {
        if (args.content == null) return { ok: false, error: 'append_file requires "content" argument' };
        if (String(args.content).length > MAX_NATIVE_WRITE_CHARS) {
          return { ok: false, error: `append_file content is too large for a native tool call (${String(args.content).length} chars). Use <append_file> text blocks so the client can chunk it safely.` };
        }
        const check = resolveSafe(workspace, args.path);
        if (!check.ok) return { ok: false, error: check.error };
        await fs.appendFile(check.resolved, args.content, 'utf8');
        return { ok: true, result: `Appended to ${check.resolved}` };
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

      case 'replace_file_range': {
        if (String(args.content || '').length > MAX_NATIVE_WRITE_CHARS) {
          return { ok: false, error: `replace_file_range content is too large (${String(args.content || '').length} chars). Use <write_file> text blocks for large rewrites.` };
        }
        const check = resolveSafe(workspace, args.path);
        if (!check.ok) return { ok: false, error: check.error };
        const start = Number(args.start_line);
        const end = Number(args.end_line);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
          return { ok: false, error: 'replace_file_range requires valid 1-indexed start_line and end_line' };
        }
        const raw = await fs.readFile(check.resolved, 'utf8');
        const lines = raw.split('\n');
        if (end > lines.length) return { ok: false, error: `Line range ${start}-${end} exceeds file length ${lines.length}` };
        const replacement = String(args.content || '').split('\n');
        lines.splice(start - 1, end - start + 1, ...replacement);
        await fs.writeFile(check.resolved, lines.join('\n'), 'utf8');
        return { ok: true, result: `Replaced lines ${start}-${end} in ${check.resolved}` };
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
        const safeArgs = (args.args || []).map(a => String(a));
        const output  = await new Promise((resolve, reject) => {
          cp.execFile(args.cmd, safeArgs, {
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

ipcMain.handle('agent:verify-files', async (event, { paths, workspace }) => {
  const results = [];
  for (const p of paths || []) {
    const check = resolveSafe(workspace, p);
    if (!check.ok) {
      results.push({ path: p, ok: false, error: check.error });
      continue;
    }
    try {
      const stat = await fs.stat(check.resolved);
      if (!stat.isFile()) {
        results.push({ path: p, ok: false, bytes: stat.size, error: 'not a file' });
        continue;
      }
      if (stat.size === 0) {
        results.push({ path: p, ok: false, bytes: stat.size, error: 'file is empty' });
        continue;
      }
      if (/\.json$/i.test(p)) {
        try {
          JSON.parse(await fs.readFile(check.resolved, 'utf8'));
        } catch (err) {
          results.push({ path: p, ok: false, bytes: stat.size, error: `invalid JSON: ${err.message}` });
          continue;
        }
      }
      if (/\.html?$/i.test(p)) {
        const frontendCheck = await verifyFrontendFile(check.resolved);
        if (!frontendCheck.ok) {
          results.push({ path: p, ok: false, bytes: stat.size, error: frontendCheck.error });
          continue;
        }
      }
      results.push({ path: p, ok: true, bytes: stat.size, error: null });
    } catch (err) {
      results.push({ path: p, ok: false, error: err.message });
    }
  }
  return { ok: true, results };
});

async function verifyFrontendFile(htmlPath) {
  const dir = path.dirname(htmlPath);
  const html = await fs.readFile(htmlPath, 'utf8');
  const issues = [];

  const cssText = [];
  for (const href of extractAttrValues(html, /<link\b[^>]*rel=['"]?stylesheet['"]?[^>]*>/gi, 'href')) {
    const cssPath = path.resolve(dir, href);
    try {
      cssText.push(await fs.readFile(cssPath, 'utf8'));
    } catch {
      issues.push(`missing stylesheet: ${href}`);
    }
  }

  const jsText = [];
  for (const src of extractAttrValues(html, /<script\b[^>]*src=['"][^'"]+['"][^>]*>/gi, 'src')) {
    const jsPath = path.resolve(dir, src);
    try {
      jsText.push(await fs.readFile(jsPath, 'utf8'));
    } catch {
      issues.push(`missing script: ${src}`);
    }
  }

  const htmlClasses = extractHtmlClasses(html);
  const cssClasses = extractCssClasses(cssText.join('\n'));
  const importantMissingClasses = htmlClasses
    .filter(cls => /header|search|product|cart|modal|checkout|hero|nav|grid|card|button|filter/i.test(cls))
    .filter(cls => !cssClasses.has(cls));
  if (htmlClasses.length >= 8 && importantMissingClasses.length >= 5) {
    issues.push(`many important HTML classes have no CSS rule: ${importantMissingClasses.slice(0, 12).join(', ')}`);
  }

  const htmlIds = extractHtmlIds(html);
  const jsIds = extractJsIds(jsText.join('\n'));
  const missingIds = [...jsIds].filter(id => !htmlIds.has(id));
  if (missingIds.length > 0) {
    issues.push(`JavaScript references missing element ids: ${missingIds.slice(0, 12).join(', ')}`);
  }

  return issues.length
    ? { ok: false, error: issues.join('; ') }
    : { ok: true };
}

function extractAttrValues(html, tagRe, attr) {
  const values = [];
  for (const tagMatch of html.matchAll(tagRe)) {
    const attrMatch = tagMatch[0].match(new RegExp(`${attr}\\s*=\\s*['"]([^'"]+)['"]`, 'i'));
    if (attrMatch && !/^https?:\/\//i.test(attrMatch[1])) values.push(attrMatch[1]);
  }
  return values;
}

function extractHtmlClasses(html) {
  const classes = new Set();
  for (const match of html.matchAll(/\bclass\s*=\s*['"]([^'"]+)['"]/gi)) {
    match[1].split(/\s+/).filter(Boolean).forEach(cls => classes.add(cls));
  }
  return [...classes];
}

function extractHtmlIds(html) {
  const ids = new Set();
  for (const match of html.matchAll(/\bid\s*=\s*['"]([^'"]+)['"]/gi)) ids.add(match[1]);
  return ids;
}

function extractCssClasses(css) {
  const classes = new Set();
  for (const match of css.matchAll(/\.([_a-zA-Z][_a-zA-Z0-9-]*)/g)) classes.add(match[1]);
  return classes;
}

function extractJsIds(js) {
  const ids = new Set();
  for (const match of js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(match[1]);
  for (const match of js.matchAll(/querySelector(?:All)?\(\s*['"]#([^'".\s>]+)['"]/g)) ids.add(match[1]);
  return ids;
}

// ── Helper: simple recursive grep ───────────────────────────────────────────
async function grepDir(root, pattern, globFilter, useRegex) {
  const results = [];
  async function walk(dir) {
    if (results.length >= MAX_SEARCH_RESULTS * 2) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS * 2) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
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

async function simpleGlob(root, pattern) {
  const results = [];
  const matcher = globToRegExp(pattern || '**/*');
  async function walk(dir, relDir = '') {
    if (results.length >= MAX_SEARCH_RESULTS * 2) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS * 2) return;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (matcher.test(rel)) {
        results.push(rel);
      }
    }
  }
  await walk(root);
  return results;
}

function globToRegExp(pattern) {
  let source = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\0/g, '.*');
  if (source.startsWith('.*/')) source = '(?:.*/)?' + source.slice(3);
  return new RegExp(`^${source}$`);
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
