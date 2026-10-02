'use strict';

/**
 * Test helpers: launch the Electron client in an isolated profile and install
 * scripted fakes for IPC handlers that would otherwise hit the network or open
 * native dialogs. Nothing outside the client is started.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('@playwright/test');

const CLIENT_DIR = path.resolve(__dirname, '..', '..');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * @param {object} [opts]
 * @param {number} [opts.width=1280]  content width
 * @param {number} [opts.height=800]  content height
 * @param {object} [opts.env]         extra env vars
 * @param {(page) => Promise<void>} [opts.beforeReload] seed localStorage etc.
 */
async function launchApp(opts = {}) {
  const userData = tmpDir('llmc-profile-');
  const app = await electron.launch({
    args: ['--no-sandbox', CLIENT_DIR],
    cwd: CLIENT_DIR,
    env: {
      ...process.env,
      LLM_CLUSTER_USER_DATA: userData,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ...(opts.env || {}),
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  // Make the boot-time ping deterministic (no network in tests).
  await mockIpc(app, 'ping-backend', { ok: false, error: 'offline (test)' });
  await resize(app, opts.width || 1280, opts.height || 800);
  if (opts.beforeReload) await opts.beforeReload(page);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.LLMClusterUI));
  return { app, page, errors, userData };
}

async function resize(app, width, height) {
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(w, h);
  }, [width, height]);
}

/** Replace an ipcMain.handle() handler with one that returns a fixed value. */
async function mockIpc(app, channel, value) {
  await app.evaluate(({ ipcMain }, [ch, val]) => {
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, async () => val);
  }, [channel, value]);
}

/** Record calls to an IPC channel (args are stored on global.__ipcCalls[channel]). */
async function recordIpc(app, channel, value) {
  await app.evaluate(({ ipcMain }, [ch, val]) => {
    global.__ipcCalls = global.__ipcCalls || {};
    global.__ipcCalls[ch] = [];
    ipcMain.removeHandler(ch);
    ipcMain.handle(ch, async (_e, ...args) => { global.__ipcCalls[ch].push(args); return val; });
  }, [channel, value]);
}

async function ipcCalls(app, channel) {
  return app.evaluate((_electron, ch) => (global.__ipcCalls && global.__ipcCalls[ch]) || [], channel);
}

/**
 * Install a scripted fake model behind the 'send-prompt' IPC channel.
 * `script` is an array of steps consumed one per request:
 *   { response?: string, tool_calls?: [{ name, args }], chunks?: string[], delayMs?: number,
 *     error?: string, waitForCancel?: boolean }
 * The last step repeats when the script runs out.
 */
async function fakeModel(app, script) {
  await app.evaluate(({ ipcMain }, steps) => {
    global.__fakeModel = { steps, calls: [], pending: null };
    ipcMain.removeHandler('send-prompt');
    ipcMain.handle('send-prompt', async (event, payload) => {
      const fm = global.__fakeModel;
      const step = fm.steps[Math.min(fm.calls.length, fm.steps.length - 1)];
      fm.calls.push({
        messages: payload.messages.length,
        tools: (payload.tools || []).map(t => t.function?.name || t.name),
        requestId: payload.requestId || null,
        agentMode: payload.agentMode || null,
      });
      for (const chunk of step.chunks || []) {
        event.sender.send('stream-chunk', chunk);
        await new Promise(r => setTimeout(r, 40));
      }
      if (step.waitForCancel) {
        return new Promise((resolve) => { fm.pending = resolve; });
      }
      await new Promise(r => setTimeout(r, step.delayMs ?? 60));
      if (step.error) return { ok: false, error: step.error };
      const data = {
        response: step.response || '',
        worker: 'test-worker',
        model: 'test-model',
        tokens: { prompt: 12, response: 34, tokensPerSec: 25 },
      };
      if (step.tool_calls) {
        data.tool_calls = step.tool_calls.map((c, i) => ({
          id: `call_${fm.calls.length}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
        }));
      }
      return { ok: true, data };
    });
    ipcMain.removeHandler('cancel-prompt');
    ipcMain.handle('cancel-prompt', async () => {
      const fm = global.__fakeModel;
      if (fm.pending) { fm.pending({ ok: false, error: 'Request cancelled' }); fm.pending = null; }
      return { ok: true };
    });
  }, script);
}

async function fakeModelCalls(app) {
  return app.evaluate(() => (global.__fakeModel ? global.__fakeModel.calls : []));
}

/** Make the "choose workspace" dialog return `dir` and pick it through the real UI. */
async function chooseWorkspace(app, page, dir) {
  await mockIpc(app, 'agent:choose-workspace', { ok: true, path: dir });
  await page.click('#workspace-btn');
  await page.waitForFunction((d) => window.LLMClusterUI.getState().workspace === d, dir);
}

function makeWorkspace(files = {}) {
  const dir = tmpDir('llmc-ws-');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

async function waitIdle(page, timeout = 20_000) {
  await page.waitForFunction(() => !document.body.classList.contains('is-busy'), null, { timeout });
}

async function rect(page, selector) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height, top: b.top, bottom: b.bottom, left: b.left, right: b.right };
  }, selector);
}

module.exports = {
  CLIENT_DIR,
  launchApp,
  resize,
  mockIpc,
  recordIpc,
  ipcCalls,
  fakeModel,
  fakeModelCalls,
  chooseWorkspace,
  makeWorkspace,
  waitIdle,
  rect,
  tmpDir,
};
