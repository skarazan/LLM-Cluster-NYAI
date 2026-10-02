'use strict';
/**
 * Code mode, end-to-end through the REAL agent loop (lib/agentLoop.js) and the
 * real local tool execution in the main process. Only the model is fake: the
 * 'send-prompt' IPC handler is replaced with a scripted responder, so no
 * manager, worker or model is ever started.
 */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { launchApp, fakeModel, fakeModelCalls, chooseWorkspace, makeWorkspace, waitIdle } = require('../helpers/app');

let ctx;
test.afterEach(async () => { if (ctx) await ctx.app.close(); ctx = null; });

async function setup(script, { mode = 'strict' } = {}) {
  const ws = makeWorkspace({ 'README.md': '# Demo\n', 'notes.txt': 'hello\n' });
  ctx = await launchApp({ width: 1320, height: 860, beforeReload: (page) => page.evaluate((m) => localStorage.setItem('llm-cluster-approval-mode', m), mode) });
  await fakeModel(ctx.app, typeof script === 'function' ? script(ws) : script);
  await ctx.page.click('#mode-code');
  await chooseWorkspace(ctx.app, ctx.page, ws);
  return ws;
}

async function send(page, text) {
  await page.fill('#input', text);
  await page.keyboard.press('Enter');
}

const listThenDone = (ws) => [
  { chunks: ['Let me look at the folder.'], tool_calls: [{ name: 'list_dir', args: { path: ws } }] },
  { response: 'Done. The folder has **README.md** and `notes.txt`.' },
];

test('strict: tool call is gated by the dock, then runs and is logged', async () => {
  await setup(listThenDone);
  const { page, app, errors } = ctx;
  await send(page, 'List the files in this folder');

  await expect(page.locator('#approval-dock .dock-title')).toHaveText('List a folder');
  await expect(page.locator('#chat .bubble.approval')).toHaveCount(0);
  await expect(page.locator('#stop-btn')).toBeVisible();
  await expect(page.locator('#send-btn')).toBeHidden();
  await expect(page.locator('#mode-chat')).toBeDisabled();

  await page.keyboard.press('1');
  await waitIdle(page);
  await expect(page.locator('#chat .decision-row')).toContainText('Allowed once');
  await expect(page.locator('#chat .activity-row.read')).toContainText('Listed');
  const final = page.locator('#chat .bubble.assistant').last();
  await expect(final.locator('strong')).toHaveText('README.md');
  await expect(final.locator('code')).toHaveText('notes.txt');
  await expect(final.locator('.bubble-meta')).toContainText('test-worker · test-model');
  await expect(page.locator('#send-btn')).toBeVisible();
  await expect(page.locator('#stop-btn')).toBeHidden();

  // The tool step opens its details in the side panel.
  await page.locator('#chat .activity-row').first().click();
  await expect(page.locator('#tab-details')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#activity-detail')).toContainText('Tool: list_dir');

  const calls = await fakeModelCalls(app);
  expect(calls.length).toBe(2);
  expect(calls.every(c => c.agentMode === 'code')).toBe(true);
  expect(errors).toEqual([]);
});

test('strict: denying a tool call is reported to the model and logged', async () => {
  await setup(listThenDone);
  const { page } = ctx;
  await send(page, 'List the files in this folder');
  await expect(page.locator('#approval-dock')).toBeVisible();
  await page.keyboard.press('Escape');
  await waitIdle(page);
  await expect(page.locator('#chat .decision-row.decision-deny')).toContainText('Denied');
  await expect(page.locator('#chat .activity-row')).toHaveCount(0);
});

test('Stop while a prompt is pending ends the turn cleanly', async () => {
  await setup(listThenDone);
  const { page } = ctx;
  await send(page, 'List the files in this folder');
  await expect(page.locator('#approval-dock')).toBeVisible();
  await page.click('#stop-btn');
  await waitIdle(page);
  await expect(page.locator('#approval-dock')).toBeHidden();
  await expect(page.locator('#chat .bubble.notice')).toContainText('Stopped');
  await expect(page.locator('#run-status')).toHaveText('');
});

test('trusted: read-only tools run without asking', async () => {
  await setup(listThenDone, { mode: 'trusted' });
  const { page } = ctx;
  await expect(page.locator('#approval-mode-trigger')).toContainText('Trusted');
  await send(page, 'List the files in this folder');
  await waitIdle(page);
  await expect(page.locator('#chat .activity-row.read')).toContainText('Listed');
  await expect(page.locator('#chat .decision-row')).toHaveCount(0);
});

test('yolo: even shell commands run without asking; trigger is tinted as a warning', async () => {
  await setup((ws) => [
    { tool_calls: [{ name: 'run_shell', args: { cmd: 'node', args: ['--version'], cwd: ws } }] },
    { response: 'Done. Node is installed.' },
  ], { mode: 'yolo' });
  const { page } = ctx;
  await expect(page.locator('#approval-mode-trigger')).toHaveAttribute('data-tone', 'warning');
  await send(page, 'Check the node version');
  await waitIdle(page);
  await expect(page.locator('#chat .decision-row')).toHaveCount(0);
  await expect(page.locator('#chat .activity-row.shell')).toBeVisible();
});

test('file work shows live structured progress in the side panel', async () => {
  const ws = await setup((dir) => [
    { response: `<write_file path="${dir}/hello.txt">Hello from the cluster!\n</write_file>` },
    { response: 'Done. Created hello.txt.' },
  ]);
  const { page } = ctx;
  await send(page, 'Create hello.txt with a friendly greeting');
  await waitIdle(page);
  expect(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8').trim()).toBe('Hello from the cluster!');
  await expect(page.locator('#side-panel')).toBeVisible();
  await expect(page.locator('#todo-panel .todo-item')).toHaveCount(1);
  await expect(page.locator('#todo-panel .todo-item')).toHaveAttribute('data-status', 'done');
  await expect(page.locator('#todo-panel .todo-title')).toContainText('hello.txt');
  await expect(page.locator('#todo-count')).toHaveText('1/1');
  await expect(page.locator('.progress-summary-label')).toHaveText('1 of 1 done');
  await expect(page.locator('#chat .activity-row.write')).toContainText('hello.txt');
});

test('plan mode: the plan is reviewed in the dock before anything runs', async () => {
  const plan = (ws) => `## Goal\nAdd a notes file.\n\n## Implementation Plan\n1. Write notes\n\n## File Manifest\n1. ${ws}/plan-notes.md — notes\n\n## Todos\n1. Create plan-notes.md`;
  await setup((ws) => [
    { response: plan(ws) },
    { response: `<write_file path="${ws}/plan-notes.md"># Notes\n</write_file>` },
    { response: 'Done.' },
  ]);
  const { page, app } = ctx;
  await page.click('.switch');
  await expect(page.locator('#plan-mode')).toBeChecked();
  await send(page, 'Add a notes file');
  await expect(page.locator('#chat .plan-card')).toBeVisible();
  await expect(page.locator('#approval-dock .dock-title')).toHaveText('Review the proposed plan');
  expect((await fakeModelCalls(app)).length).toBe(1); // nothing executed yet
  await page.keyboard.press('1');
  await waitIdle(page);
  await expect(page.locator('#chat .plan-status')).toHaveText('Approved');
  expect((await fakeModelCalls(app)).length).toBeGreaterThan(1);
});

test('missing workspace is explained inline and the chip is highlighted', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.click('#mode-code');
  await send(page, 'do something');
  await expect(page.locator('#chat .bubble.error')).toContainText('No workspace selected');
  await expect(page.locator('#workspace-btn')).toHaveClass(/is-missing/);
});

test('Shift+Tab in the composer cycles the permission mode', async () => {
  await setup(listThenDone);
  const { page } = ctx;
  await page.click('#input');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#approval-mode-trigger')).toContainText('Trusted');
  await expect(page.locator('#run-status')).toHaveText('Permission mode: Trusted');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#approval-mode-trigger')).toContainText('Yolo');
  expect(await page.evaluate(() => localStorage.getItem('llm-cluster-approval-mode'))).toBe('yolo');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#approval-mode-trigger')).toContainText('Strict');
});
