'use strict';
const { test, expect } = require('@playwright/test');
const { launchApp, mockIpc } = require('../helpers/app');

let ctx;
test.afterEach(async () => { if (ctx) await ctx.app.close(); ctx = null; });

test('connection pill opens a popover; testing reports status', async () => {
  ctx = await launchApp();
  const { app, page } = ctx;
  await expect(page.locator('#connection-label')).toHaveText('llm.tutorrev.live');
  await expect(page.locator('#status-dot')).toHaveClass(/dot-offline/);
  await page.click('#connection-btn');
  await expect(page.locator('#connection-popover')).toBeVisible();
  await expect(page.locator('#backend-url')).toBeFocused();
  await expect(page.locator('#connection-status')).toContainText('Can’t reach the manager');

  await mockIpc(app, 'ping-backend', { ok: true });
  await page.fill('#backend-url', 'http://10.0.0.5:3000');
  await page.keyboard.press('Enter');
  await expect(page.locator('#status-dot')).toHaveClass(/dot-online/);
  await expect(page.locator('#connection-label')).toHaveText('10.0.0.5:3000');
  await expect(page.locator('#connection-status')).toContainText('Connected');
  expect(await page.evaluate(() => localStorage.getItem('llm-cluster-backend-url'))).toBe('http://10.0.0.5:3000');

  await page.keyboard.press('Escape');
  await expect(page.locator('#connection-popover')).toBeHidden();
});

test('discovered managers are listed safely (mDNS names are never parsed as HTML)', async () => {
  ctx = await launchApp();
  const { app, page } = ctx;
  await mockIpc(app, 'discover-managers', [
    { name: '<img src=x onerror="window.__pwned=1">Lab A', url: 'http://192.168.1.20:3000' },
    { name: 'Lab B', url: 'http://192.168.1.21:3000' },
  ]);
  await mockIpc(app, 'ping-backend', { ok: true });
  await page.click('#connection-btn');
  await page.click('#discover-btn');
  const items = page.locator('#discovered .discovered-item');
  await expect(items).toHaveCount(2);
  await expect(page.locator('#discovered img')).toHaveCount(0);
  await expect(items.first()).toContainText('<img src=x');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await items.nth(1).click();
  await expect(page.locator('#backend-url')).toHaveValue('http://192.168.1.21:3000');
  await expect(page.locator('#status-dot')).toHaveClass(/dot-online/);
});

test('model picker is a custom listbox grouped by size and the choice persists', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.click('#model-trigger');
  const menu = page.locator('.menu:not([hidden])');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.menu-group-label')).toHaveText(['Small · 1–4B', 'Medium · 7–9B', 'Large · 14B+', 'Code']);
  // Opens upward from the composer and stays inside the window.
  const box = await menu.boundingBox();
  const trigger = await page.locator('#model-trigger').boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(trigger.y);
  expect(box.y).toBeGreaterThanOrEqual(0);
  await menu.locator('.menu-item', { hasText: 'Qwen 2.5 Coder 7B' }).click();
  await expect(page.locator('#model-trigger')).toContainText('Qwen 2.5 Coder 7B');
  await page.reload();
  await page.waitForFunction(() => Boolean(window.LLMClusterUI));
  expect(await page.evaluate(() => window.LLMClusterUI.getState().model)).toBe('qwen2.5-coder-7b');
  await expect(page.locator('#empty-subtitle')).toContainText('Qwen 2.5 Coder 7B');
});

test('permission-mode menu explains each mode and is keyboard operable', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.click('#mode-code');
  await page.focus('#approval-mode-trigger');
  await page.keyboard.press('Enter');
  const menu = page.locator('.menu:not([hidden])');
  await expect(menu.locator('.menu-item-desc')).toHaveText([
    'Ask before every tool call',
    'Auto-approve reads · ask before edits and commands',
    'Never ask · every tool call runs automatically',
  ]);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(page.locator('#approval-mode-trigger')).toContainText('Trusted');
  expect(await page.evaluate(() => localStorage.getItem('llm-cluster-approval-mode'))).toBe('trusted');
});

test('update banner appears on update-available and can be dismissed', async () => {
  ctx = await launchApp();
  const { app, page } = ctx;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('update-available', { version: '9.9.9' }));
  await expect(page.locator('#update-banner')).toBeVisible();
  await expect(page.locator('#update-msg')).toHaveText('Update available: v9.9.9');
  await page.click('#update-dismiss');
  await expect(page.locator('#update-banner')).toBeHidden();
});
