const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs/promises');
const fsSync = require('fs');
const cp     = require('child_process');
const crypto = require('crypto');
const { resolveSafe, checkShellCommand } = require('./lib/sandbox');
const { getTool } = require('./lib/tools');

let mainWindow;

const RELEASES_URL = 'https://github.com/skarazan/LLM-Cluster-NYAI/releases/latest';
const RELEASES_API = 'https://api.github.com/repos/skarazan/LLM-Cluster-NYAI/releases/latest';
const MAX_NATIVE_WRITE_CHARS = 7000;
const DEFAULT_READ_LINES = 5000;
const MAX_READ_LINES = 5000;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 200;
const MAX_PROJECT_CONTEXT_CHARS = 12000;
const MAX_BATCH_READ_FILES = 12;
const MAX_BATCH_READ_CHARS = 40000;
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.vite', 'coverage', '.cache']);
const PROJECT_MEMORY_FILES = ['CLAUDE.md', 'AGENTS.md', 'README.md', '.cursorrules'];
const PROJECT_CONFIG_FILES = ['package.json', 'pyproject.toml', 'requirements.txt', 'vite.config.js', 'next.config.js', 'tailwind.config.js', 'tsconfig.json'];
const FILE_LIKE_EXTENSION_RE = /\.(?:html?|css|js|mjs|cjs|ts|jsx|tsx|py|json|md|txt|sh|yml|yaml|toml|svg|xml|env)$/i;
const activePromptControllers = new Map();

function hashText(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function safeStateKey(workspace) {
  return crypto.createHash('sha256').update(String(workspace || ''), 'utf8').digest('hex');
}

function agentStatePath(workspace) {
  return path.join(app.getPath('userData'), 'agent-state', `${safeStateKey(workspace)}.json`);
}

function emptyAgentState(workspace) {
  return {
    version: 1,
    sessionId: safeStateKey(workspace).slice(0, 16),
    workspace,
    updatedAt: new Date().toISOString(),
    todos: [],
    fileHistory: [],
    readState: {},
    actionFingerprints: {},
  };
}

async function loadAgentState(workspace) {
  const statePath = agentStatePath(workspace);
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    return { ...emptyAgentState(workspace), ...JSON.parse(raw), workspace };
  } catch {
    return emptyAgentState(workspace);
  }
}

async function saveAgentState(workspace, state) {
  const statePath = agentStatePath(workspace);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const payload = {
    ...emptyAgentState(workspace),
    ...(state || {}),
    workspace,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(statePath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

async function snapshotFile(resolved) {
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) return { isFile: false, isDirectory: stat.isDirectory(), bytes: stat.size, mtimeMs: stat.mtimeMs };
  const raw = await fs.readFile(resolved, 'utf8');
  return {
    isFile: true,
    isDirectory: false,
    bytes: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
    hash: hashText(raw),
    preview: raw.split('\n').slice(0, 20).join('\n').slice(0, 2000),
  };
}

async function collectProjectContext(workspace) {
  const rootCheck = resolveSafe(workspace, '.');
  if (!rootCheck.ok) return { ok: false, error: rootCheck.error };
  const root = rootCheck.resolved;
  const files = [];
  const scripts = {};
  let chars = 0;

  for (const name of [...PROJECT_MEMORY_FILES, ...PROJECT_CONFIG_FILES]) {
    const full = path.join(root, name);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile() || stat.size > 250_000) continue;
      const raw = await fs.readFile(full, 'utf8');
      const remaining = MAX_PROJECT_CONTEXT_CHARS - chars;
      if (remaining <= 0) break;
      const text = raw.slice(0, Math.min(raw.length, remaining));
      chars += text.length;
      files.push({
        path: full,
        name,
        bytes: stat.size,
        truncated: raw.length > text.length,
        text,
      });
      if (name === 'package.json') {
        try {
          const pkg = JSON.parse(raw);
          Object.assign(scripts, pkg.scripts || {});
        } catch {}
      }
    } catch {}
  }

  const tree = await buildWorkspaceTree(root, root, 2, 180);
  return {
    ok: true,
    workspace,
    files,
    scripts,
    tree,
    summary: renderProjectContext({ workspace, files, scripts, tree }),
  };
}

async function buildWorkspaceTree(root, dir, depth, limit, prefix = '') {
  if (depth < 0 || limit <= 0) return [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries = entries
    .filter(entry => !entry.name.startsWith('.') || PROJECT_MEMORY_FILES.includes(entry.name))
    .filter(entry => !IGNORE_DIRS.has(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  const rows = [];
  for (const entry of entries) {
    if (rows.length >= limit) break;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    rows.push(`${entry.isDirectory() ? 'dir ' : 'file'} ${rel}`);
    if (entry.isDirectory() && depth > 0) {
      const childRows = await buildWorkspaceTree(root, path.join(dir, entry.name), depth - 1, limit - rows.length, rel);
      rows.push(...childRows);
    }
  }
  return rows;
}

function renderProjectContext(ctx) {
  const parts = [`PROJECT CONTEXT for ${ctx.workspace}`];
  if (ctx.tree?.length) parts.push(`Top-level tree:\n${ctx.tree.slice(0, 120).join('\n')}`);
  if (Object.keys(ctx.scripts || {}).length) {
    parts.push(`Package scripts:\n${Object.entries(ctx.scripts).map(([k, v]) => `- npm run ${k}: ${v}`).join('\n')}`);
  }
  for (const file of ctx.files || []) {
    parts.push(`--- ${file.name}${file.truncated ? ' (truncated)' : ''} ---\n${file.text}`);
  }
  return parts.join('\n\n');
}

function splitCommandLine(input) {
  const out = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (const ch of String(input || '')) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function normalizeShellInvocation(args) {
  let cmd = String(args.cmd || '').trim();
  let safeArgs = Array.isArray(args.args) ? args.args.map(a => String(a)) : [];
  if (cmd && safeArgs.length === 0 && /\s/.test(cmd)) {
    const parts = splitCommandLine(cmd);
    if (parts.length > 0) {
      cmd = parts[0];
      safeArgs = parts.slice(1);
    }
  }
  return { cmd, args: safeArgs };
}

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
    if (finalData.error) return { ok: false, error: finalData.error, error_details: finalData.error_details || null, jobId: finalData.jobId || requestId || null };
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

ipcMain.handle('agent:load-state', async (event, { workspace }) => {
  if (!workspace) return { ok: false, error: 'Missing workspace' };
  try {
    return { ok: true, state: await loadAgentState(workspace) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('agent:save-state', async (event, { workspace, state }) => {
  if (!workspace) return { ok: false, error: 'Missing workspace' };
  try {
    return { ok: true, state: await saveAgentState(workspace, state) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('agent:get-file-state', async (event, { workspace, path: targetPath }) => {
  const check = resolveSafe(workspace, targetPath);
  if (!check.ok) return { ok: false, error: check.error };
  try {
    return { ok: true, path: targetPath, resolved: check.resolved, snapshot: await snapshotFile(check.resolved) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('agent:get-project-context', async (event, { workspace }) => {
  if (!workspace) return { ok: false, error: 'Missing workspace' };
  try {
    return await collectProjectContext(workspace);
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
        const stat = await fs.stat(check.resolved);
        const fullHash = hashText(raw);
        const lines = raw.split('\n');
        const off   = Math.max(0, (args.offset || 1) - 1);
        const lim   = Math.min(Math.max(1, args.limit || DEFAULT_READ_LINES), MAX_READ_LINES);
        const end = Math.min(lines.length, off + lim);
        const isFullRead = off === 0 && end >= lines.length;
        if (
          args.readSnapshot &&
          args.readSnapshot.hash === fullHash &&
          Number(args.readSnapshot.offset || 1) === off + 1 &&
          Number(args.readSnapshot.limit || DEFAULT_READ_LINES) === lim
        ) {
          return {
            ok: true,
            result: `File unchanged since last read: ${args.path}. Use the earlier read_file result in this conversation unless you need a different range.`,
            dedup: true,
            snapshot: {
              path: args.path,
              hash: fullHash,
              bytes: stat.size,
              mtimeMs: Math.floor(stat.mtimeMs),
              offset: off + 1,
              limit: lim,
              totalLines: lines.length,
              isFullRead,
            },
          };
        }
        const body = lines.slice(off, end).join('\n');
        const suffix = end < lines.length
          ? `\n\n[read_file preview: file has ${lines.length} total lines; only lines ${off + 1}-${end} are shown to save context. This does NOT mean the file is incomplete. Call read_file with offset=${end + 1} only if you truly need later lines.]`
          : '';
        return {
          ok: true,
          result: body + suffix,
          snapshot: {
            path: args.path,
            hash: fullHash,
            bytes: stat.size,
            mtimeMs: Math.floor(stat.mtimeMs),
            offset: off + 1,
            limit: lim,
            totalLines: lines.length,
            isFullRead,
          },
        };
      }

      case 'read_many_files': {
        const paths = Array.isArray(args.paths) ? args.paths.slice(0, MAX_BATCH_READ_FILES) : [];
        if (paths.length === 0) return { ok: false, error: 'read_many_files requires a non-empty paths array' };
        const readSnapshots = args.readSnapshots && typeof args.readSnapshots === 'object' ? args.readSnapshots : {};
        let usedChars = 0;
        const files = [];
        for (const targetPath of paths) {
          const check = resolveSafe(workspace, targetPath);
          if (!check.ok) {
            files.push({ path: targetPath, ok: false, error: check.error });
            continue;
          }
          try {
            const raw = await fs.readFile(check.resolved, 'utf8');
            const stat = await fs.stat(check.resolved);
            const fullHash = hashText(raw);
            const lines = raw.split('\n');
            const snap = readSnapshots[targetPath] || readSnapshots[check.resolved] || null;
            const snapshot = {
              path: targetPath,
              hash: fullHash,
              bytes: stat.size,
              mtimeMs: Math.floor(stat.mtimeMs),
              offset: 1,
              limit: lines.length,
              totalLines: lines.length,
              isFullRead: true,
            };
            if (snap && snap.hash === fullHash && snap.isFullRead) {
              files.push({ path: targetPath, ok: true, dedup: true, result: `File unchanged since last full read: ${targetPath}`, snapshot });
              continue;
            }
            const remaining = MAX_BATCH_READ_CHARS - usedChars;
            if (remaining <= 0) {
              files.push({ path: targetPath, ok: false, error: `Batch read budget exhausted after ${MAX_BATCH_READ_CHARS} chars` });
              continue;
            }
            const content = raw.slice(0, remaining);
            usedChars += content.length;
            files.push({
              path: targetPath,
              ok: true,
              result: content + (content.length < raw.length ? `\n...[read_many_files truncated ${raw.length - content.length} chars]` : ''),
              truncated: content.length < raw.length,
              snapshot,
            });
          } catch (err) {
            files.push({ path: targetPath, ok: false, error: err.message });
          }
        }
        return { ok: true, result: files, files, truncated: paths.length > MAX_BATCH_READ_FILES };
      }

      case 'file_state': {
        const paths = Array.isArray(args.paths) ? args.paths.slice(0, MAX_BATCH_READ_FILES) : [args.path].filter(Boolean);
        if (paths.length === 0) return { ok: false, error: 'file_state requires path or paths' };
        const files = [];
        for (const targetPath of paths) {
          const check = resolveSafe(workspace, targetPath);
          if (!check.ok) {
            files.push({ path: targetPath, ok: false, error: check.error });
            continue;
          }
          try {
            const snap = await snapshotFile(check.resolved);
            files.push({ path: targetPath, ok: true, ...snap });
          } catch (err) {
            files.push({ path: targetPath, ok: false, exists: false, error: err.message });
          }
        }
        return { ok: true, result: files, files };
      }

      case 'inspect_project': {
        return await collectProjectContext(workspace);
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
        let existed = false;
        let previousBytes = 0;
        let beforeHash = null;
        let beforeMtimeMs = null;
        let previousContent = null;
        let repairedDirectory = false;
        try {
          const stat = await fs.stat(check.resolved);
          if (stat.isDirectory()) {
            const entries = await fs.readdir(check.resolved);
            if (entries.length > 0) {
              return {
                ok: false,
                error: `Cannot write file because a non-empty directory exists at ${check.resolved}. Choose the correct file path or remove that directory manually.`,
                pathIsDirectory: true,
              };
            }
            await fs.rmdir(check.resolved);
            repairedDirectory = true;
          } else {
            existed = stat.isFile();
            previousBytes = stat.size;
            beforeMtimeMs = Math.floor(stat.mtimeMs);
            if (existed) {
              previousContent = await fs.readFile(check.resolved, 'utf8');
              beforeHash = hashText(previousContent);
              const snap = args.readSnapshot || null;
              if (!snap || !snap.isFullRead) {
                return { ok: false, error: `Existing file must be read fully before overwrite: ${args.path}`, needsRead: true };
              }
              if (snap.hash !== beforeHash || Math.floor(Number(snap.mtimeMs || 0)) !== beforeMtimeMs) {
                return { ok: false, error: `File changed since last read: ${args.path}. Read it again before writing.`, staleRead: true };
              }
            }
          }
        } catch {
          existed = false;
        }
        await fs.mkdir(path.dirname(check.resolved), { recursive: true });
        await fs.writeFile(check.resolved, args.content, 'utf8');
        const bytes = Buffer.byteLength(String(args.content), 'utf8');
        const unchanged = existed && previousContent === String(args.content);
        const afterStat = await fs.stat(check.resolved);
        const afterHash = hashText(String(args.content));
        return {
          ok: true,
          result: unchanged ? `File unchanged: ${check.resolved}` : existed ? `Overwrote existing file: ${check.resolved}` : `Created file: ${check.resolved}`,
          alreadyExists: existed,
          previousBytes,
          beforeHash,
          afterHash,
          beforeBytes: previousBytes,
          afterBytes: bytes,
          beforeMtimeMs,
          mtimeMs: Math.floor(afterStat.mtimeMs),
          bytes,
          changed: !unchanged,
          unchanged,
          repairedDirectory,
        };
      }

      case 'append_file': {
        if (args.content == null) return { ok: false, error: 'append_file requires "content" argument' };
        if (String(args.content).length === 0) return { ok: false, error: 'append_file content is empty; no file changes were made' };
        if (String(args.content).length > MAX_NATIVE_WRITE_CHARS) {
          return { ok: false, error: `append_file content is too large for a native tool call (${String(args.content).length} chars). Use <append_file> text blocks so the client can chunk it safely.` };
        }
        const check = resolveSafe(workspace, args.path);
        if (!check.ok) return { ok: false, error: check.error };
        let existed = false;
        let previousBytes = 0;
        let beforeHash = null;
        let beforeMtimeMs = null;
        let repairedDirectory = false;
        try {
          const stat = await fs.stat(check.resolved);
          if (stat.isDirectory()) {
            const entries = await fs.readdir(check.resolved);
            if (entries.length > 0) {
              return {
                ok: false,
                error: `Cannot append to file because a non-empty directory exists at ${check.resolved}. Choose the correct file path or remove that directory manually.`,
                pathIsDirectory: true,
              };
            }
            await fs.rmdir(check.resolved);
            repairedDirectory = true;
          } else {
            existed = stat.isFile();
            previousBytes = stat.size;
            beforeMtimeMs = Math.floor(stat.mtimeMs);
            if (existed) {
              const previousContent = await fs.readFile(check.resolved, 'utf8');
              beforeHash = hashText(previousContent);
              const snap = args.readSnapshot || null;
              if (!snap || !snap.isFullRead) return { ok: false, error: `Existing file must be read fully before append: ${args.path}`, needsRead: true };
              if (snap.hash !== beforeHash || Math.floor(Number(snap.mtimeMs || 0)) !== beforeMtimeMs) {
                return { ok: false, error: `File changed since last read: ${args.path}. Read it again before appending.`, staleRead: true };
              }
            }
          }
        } catch {
          existed = false;
        }
        await fs.mkdir(path.dirname(check.resolved), { recursive: true });
        await fs.appendFile(check.resolved, args.content, 'utf8');
        const after = await snapshotFile(check.resolved);
        return {
          ok: true,
          result: existed ? `Appended to existing file: ${check.resolved}` : `Created file by append: ${check.resolved}`,
          alreadyExists: existed,
          previousBytes,
          beforeHash,
          afterHash: after.hash,
          beforeBytes: previousBytes,
          afterBytes: after.bytes,
          beforeMtimeMs,
          mtimeMs: after.mtimeMs,
          bytes: previousBytes + Buffer.byteLength(String(args.content), 'utf8'),
          changed: true,
          repairedDirectory,
        };
      }

      case 'edit_file': {
        const check = resolveSafe(workspace, args.path);
        if (!check.ok) return { ok: false, error: check.error };
        const beforeStat = await fs.stat(check.resolved);
        const content = await fs.readFile(check.resolved, 'utf8');
        const beforeHash = hashText(content);
        const snap = args.readSnapshot || null;
        if (!snap || !snap.isFullRead) return { ok: false, error: `File must be read fully before edit: ${args.path}`, needsRead: true };
        if (snap.hash !== beforeHash || Math.floor(Number(snap.mtimeMs || 0)) !== Math.floor(beforeStat.mtimeMs)) {
          return { ok: false, error: `File changed since last read: ${args.path}. Read it again before editing.`, staleRead: true };
        }
        const count = content.split(args.old_string).length - 1;
        if (count === 0) return { ok: false, error: `old_string not found in ${args.path}` };
        if (count > 1)   return { ok: false, error: `old_string appears ${count} times — must be unique` };
        const updated = content.replace(args.old_string, args.new_string);
        await fs.writeFile(check.resolved, updated, 'utf8');
        const after = await snapshotFile(check.resolved);
        return {
          ok: true,
          result: `Edited ${check.resolved}`,
          beforeHash,
          afterHash: after.hash,
          beforeBytes: beforeStat.size,
          afterBytes: after.bytes,
          beforeMtimeMs: Math.floor(beforeStat.mtimeMs),
          mtimeMs: after.mtimeMs,
          changed: beforeHash !== after.hash,
        };
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
        const beforeStat = await fs.stat(check.resolved);
        const raw = await fs.readFile(check.resolved, 'utf8');
        const beforeHash = hashText(raw);
        const snap = args.readSnapshot || null;
        if (!snap || !snap.isFullRead) return { ok: false, error: `File must be read fully before replacing lines: ${args.path}`, needsRead: true };
        if (snap.hash !== beforeHash || Math.floor(Number(snap.mtimeMs || 0)) !== Math.floor(beforeStat.mtimeMs)) {
          return { ok: false, error: `File changed since last read: ${args.path}. Read it again before replacing lines.`, staleRead: true };
        }
        const lines = raw.split('\n');
        if (end > lines.length) return { ok: false, error: `Line range ${start}-${end} exceeds file length ${lines.length}` };
        const replacement = String(args.content || '').split('\n');
        lines.splice(start - 1, end - start + 1, ...replacement);
        await fs.writeFile(check.resolved, lines.join('\n'), 'utf8');
        const after = await snapshotFile(check.resolved);
        return {
          ok: true,
          result: `Replaced lines ${start}-${end} in ${check.resolved}`,
          beforeHash,
          afterHash: after.hash,
          beforeBytes: beforeStat.size,
          afterBytes: after.bytes,
          beforeMtimeMs: Math.floor(beforeStat.mtimeMs),
          mtimeMs: after.mtimeMs,
          changed: beforeHash !== after.hash,
        };
      }

      case 'create_dir': {
        const check = resolveSafe(workspace, args.path);
        if (!check.ok) return { ok: false, error: check.error };
        if (FILE_LIKE_EXTENSION_RE.test(path.basename(check.resolved))) {
          return {
            ok: false,
            error: `create_dir was called with a file-looking path (${args.path}). Start a file block with <write_file path="${args.path}">, write the real file contents, then close it with </write_file>.`,
            pathLooksLikeFile: true,
          };
        }
        const knownTodoFilePaths = Array.isArray(args.knownTodoFilePaths) ? args.knownTodoFilePaths.map(String) : [];
        if (knownTodoFilePaths.includes(String(args.path)) || knownTodoFilePaths.includes(check.resolved)) {
          return {
            ok: false,
            error: `create_dir was called for a known file todo (${args.path}). Start a file block with <write_file path="${args.path}">, write the real file contents, then close it with </write_file>.`,
            pathLooksLikeFile: true,
          };
        }
        let existed = false;
        try {
          existed = (await fs.stat(check.resolved)).isDirectory();
        } catch {
          existed = false;
        }
        await fs.mkdir(check.resolved, { recursive: true });
        return {
          ok: true,
          result: existed ? `Directory already exists: ${check.resolved}` : `Created ${check.resolved}`,
          alreadyExists: existed,
        };
      }

      case 'delete_file': {
        const check = resolveSafe(workspace, args.path);
        if (!check.ok) return { ok: false, error: check.error };
        let before = null;
        try { before = await snapshotFile(check.resolved); } catch {}
        await fs.unlink(check.resolved);
        return {
          ok: true,
          result: `Deleted ${check.resolved}`,
          beforeHash: before?.hash || null,
          beforeBytes: before?.bytes || 0,
          beforeMtimeMs: before?.mtimeMs || null,
          changed: true,
        };
      }

      case 'run_shell': {
        const normalized = normalizeShellInvocation(args);
        if (!normalized.cmd) return { ok: false, error: 'run_shell requires a command' };
        const shellCheck = checkShellCommand(normalized.cmd, normalized.args || []);
        if (!shellCheck.ok) return { ok: false, error: shellCheck.error };
        const cwdCheck = resolveSafe(workspace, args.cwd || '.');
        if (!cwdCheck.ok) return { ok: false, error: cwdCheck.error };
        if (normalized.cmd === 'mkdir' && normalized.args[0] === '-p' && normalized.args.length === 2) {
          const dirCheck = resolveSafe(workspace, normalized.args[1]);
          if (!dirCheck.ok) return { ok: false, error: dirCheck.error };
          if (FILE_LIKE_EXTENSION_RE.test(path.basename(dirCheck.resolved))) {
            return { ok: false, error: `mkdir -p target looks like a file path (${normalized.args[1]}). Use <write_file> instead.` };
          }
          await fs.mkdir(dirCheck.resolved, { recursive: true });
          return {
            ok: true,
            result: { stdout: `Created directory: ${dirCheck.resolved}\n`, stderr: '', exitCode: 0 },
            normalizedCommand: normalized,
            changed: true,
          };
        }
        const timeout = args.timeout_ms || 30000;
        const safeArgs = normalized.args;
        const output  = await new Promise((resolve, reject) => {
          cp.execFile(normalized.cmd, safeArgs, {
            cwd: cwdCheck.resolved,
            timeout,
            maxBuffer: 1_000_000,
            shell: false,
          }, (err, stdout, stderr) => {
            if (err && !stdout && !stderr) return reject(err);
            resolve({ stdout: (stdout || '').slice(0, 100000), stderr: (stderr || '').slice(0, 10000), exitCode: err ? err.code : 0 });
          });
        });
        return { ok: true, result: output, normalizedCommand: normalized };
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

ipcMain.handle('agent:verify-todos', async (event, { todos, workspace }) => {
  const paths = [...new Set((todos || []).map(todo => todo && todo.path).filter(Boolean))];
  if (paths.length === 0) return { ok: true, results: [] };
  const results = [];
  for (const p of paths) {
    const check = resolveSafe(workspace, p);
    if (!check.ok) {
      results.push({ path: p, ok: false, error: check.error });
      continue;
    }
    try {
      const snap = await snapshotFile(check.resolved);
      results.push({
        path: p,
        ok: Boolean(snap.isFile && snap.bytes > 0),
        bytes: snap.bytes,
        hash: snap.hash || null,
        error: snap.isFile && snap.bytes > 0 ? null : 'target is not a non-empty file',
      });
    } catch (err) {
      results.push({ path: p, ok: false, error: err.message });
    }
  }
  return { ok: results.every(item => item.ok), results };
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
