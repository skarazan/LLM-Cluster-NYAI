'use strict';
const { test, expect } = require('@playwright/test');
const { launchApp, fakeModel, fakeModelCalls, recordIpc, ipcCalls, waitIdle } = require('../helpers/app');

let ctx;
test.afterEach(async () => { if (ctx) await ctx.app.close(); ctx = null; });

async function send(page, text) {
  await page.fill('#input', text);
  await page.keyboard.press('Enter');
}

const ANSWER = [
  '<think>User wants a timer. Use setInterval.</think>',
  'Here is a **countdown**:',
  '',
  '```js',
  'setInterval(tick, 1000);',
  '```',
  '',
  '- uses `setInterval`',
  '- see [MDN](https://developer.mozilla.org)',
].join('\n');

test('streams tokens live, then renders the final answer as markdown with reasoning collapsed', async () => {
  ctx = await launchApp();
  const { app, page, errors } = ctx;
  await fakeModel(app, [{ chunks: ['<think>planning', '</think>Here ', 'is a ', '**countdown**'], delayMs: 900, response: ANSWER }]);
  await send(page, 'How do I make a countdown?');

  await expect(page.locator('#chat .bubble.user')).toHaveText('How do I make a countdown?');
  // Live bubble shows visible text only (reasoning hidden) with a streaming caret.
  const live = page.locator('#chat .bubble.assistant.streaming');
  await expect(live).toContainText('Here is a');
  await expect(live).not.toContainText('planning');
  await expect(page.locator('#run-status')).toHaveText('Generating…');

  await waitIdle(page);
  await expect(page.locator('#chat .bubble.streaming')).toHaveCount(0);
  const final = page.locator('#chat .bubble.assistant').last();
  await expect(final.locator('strong')).toHaveText('countdown');
  await expect(final.locator('.md-code .md-code-lang')).toHaveText('js');
  await expect(final.locator('.md-code pre')).toHaveText('setInterval(tick, 1000);');
  await expect(final.locator('.md-list li')).toHaveCount(2);
  await expect(final.locator('a.md-link')).toHaveText('MDN');
  await expect(final.locator('.bubble-meta')).toContainText('test-worker · test-model · in 12 / out 34 tok');

  const think = page.locator('#chat .thinking-block');
  await expect(think.locator('.thinking-content')).toBeHidden();
  await think.locator('.thinking-toggle').click();
  await expect(think.locator('.thinking-content')).toHaveText('User wants a timer. Use setInterval.');
  await expect(page.locator('#session-tokens')).toHaveText('in 12 · out 34');

  // Chat requests now carry a requestId so they can be cancelled.
  const calls = await fakeModelCalls(app);
  expect(calls[0].requestId).toMatch(/^chat-/);
  expect(errors).toEqual([]);
});

test('Stop cancels a chat generation and keeps the partial answer', async () => {
  ctx = await launchApp();
  const { app, page } = ctx;
  await fakeModel(app, [{ chunks: ['Partial ', 'answer so far'], waitForCancel: true }]);
  await send(page, 'Write a long essay');
  await expect(page.locator('#chat .bubble.streaming')).toContainText('Partial answer so far');
  await expect(page.locator('#stop-btn')).toBeVisible();
  await page.click('#stop-btn');
  await waitIdle(page);
  const final = page.locator('#chat .bubble.assistant').last();
  await expect(final).toContainText('Partial answer so far');
  await expect(final.locator('.bubble-meta')).toContainText('Stopped early');
});

test('errors show as an inline notice and the composer recovers', async () => {
  ctx = await launchApp();
  const { app, page } = ctx;
  await fakeModel(app, [{ error: 'No worker available for model qwen3-8b' }]);
  await send(page, 'hi');
  await waitIdle(page);
  await expect(page.locator('#chat .bubble.error')).toContainText('No worker available');
  await expect(page.locator('#chat .bubble.error svg')).toHaveCount(1);
  await expect(page.locator('#input')).toBeFocused();
});

test('links in answers open in the system browser, never inside the app', async () => {
  ctx = await launchApp();
  const { app, page } = ctx;
  await recordIpc(app, 'open-external', { ok: true });
  await page.evaluate(() => window.LLMClusterUI.appendBubble('assistant', 'Read [the docs](https://example.com/docs) or [this](javascript:alert(1)).'));
  await page.locator('#chat a.md-link').click();
  await page.waitForTimeout(200);
  expect(page.url()).toMatch(/^file:/);
  expect(await ipcCalls(app, 'open-external')).toEqual([['https://example.com/docs']]);
  await expect(page.locator('#chat a.md-link')).toHaveCount(1); // the javascript: link is plain text
});

test('model output containing HTML is shown as text, not executed', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.evaluate(() => window.LLMClusterUI.appendBubble('assistant', '<img src=x onerror="window.__pwned=1"> **bold**'));
  await expect(page.locator('#chat .bubble.assistant img')).toHaveCount(0);
  await expect(page.locator('#chat .bubble.assistant')).toContainText('<img src=x');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test('New chat clears the conversation and late results never leak into it', async () => {
  ctx = await launchApp();
  const { app, page } = ctx;
  await fakeModel(app, [{ response: 'old answer', delayMs: 1200 }]);
  await send(page, 'first question');
  await expect(page.locator('#chat .bubble.user')).toHaveCount(1);
  await page.click('#new-chat-btn');
  await expect(page.locator('#empty-state')).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.locator('#chat > *')).toHaveCount(0);
  expect(await page.evaluate(() => window.LLMClusterUI.getState().historyLength)).toBe(0);
});

test('send button reflects input state; Shift+Enter inserts a newline', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await expect(page.locator('#send-btn')).toBeDisabled();
  await page.click('#input');
  await page.keyboard.type('line one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('line two');
  await expect(page.locator('#input')).toHaveValue('line one\nline two');
  await expect(page.locator('#send-btn')).toBeEnabled();
  const h1 = await page.evaluate(() => document.getElementById('input').getBoundingClientRect().height);
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('line three');
  const h2 = await page.evaluate(() => document.getElementById('input').getBoundingClientRect().height);
  expect(h2).toBeGreaterThan(h1); // auto-grows
});
