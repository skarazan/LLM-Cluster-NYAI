'use strict';
const { test, expect } = require('@playwright/test');
const { launchApp, rect } = require('../helpers/app');

let ctx;
test.beforeEach(async () => {
  ctx = await launchApp({ width: 1280, height: 860 });
  await ctx.page.click('#mode-code');
});
test.afterEach(async () => { if (ctx) await ctx.app.close(); ctx = null; });

/** Fire a tool permission request through the dock and keep its promise on window. */
async function request(page, key, req) {
  await page.evaluate(([k, r]) => {
    window.__results = window.__results || {};
    window.LLMClusterUI.approvalDock
      .requestTool({ ...r, transcript: document.getElementById('chat') })
      .then((v) => { window.__results[k] = v; });
  }, [key, req]);
}
const result = (page, key) => page.evaluate((k) => (window.__results || {})[k], key);

const WRITE = { toolName: 'write_file', risk: 'write', canRemember: true, args: { path: '/ws/src/app.js', content: 'const a = 1;\nconsole.log(a);' } };
const SHELL = { toolName: 'run_shell', risk: 'shell', canRemember: false, args: { cmd: 'npm', args: ['test'] } };

test('permission prompt docks ABOVE the composer, outside the message stream', async () => {
  const { page } = ctx;
  await page.evaluate(() => window.LLMClusterUI.appendBubble('assistant', 'I will create the file now.'));
  await request(page, 'w', WRITE);
  const dock = page.locator('#approval-dock');
  await expect(dock).toBeVisible();
  await expect(dock.locator('.dock-title')).toHaveText('Write a file');
  await expect(dock.locator('.dock-target')).toContainText('/ws/src/app.js');
  await expect(dock.locator('.dock-preview .diff-add')).toHaveCount(2);
  await expect(dock.locator('.dock-option')).toHaveText([
    /Yes, allow once/,
    /don't ask again for write_file on src\/app\.js/,
    /No, deny/,
  ]);

  // Placement: directly above the composer, not inside #chat, no inline question card.
  const d = await rect(page, '#approval-dock');
  const c = await rect(page, '.composer');
  expect(d.bottom).toBeLessThanOrEqual(c.top);
  expect(c.top - d.bottom).toBeLessThan(24);
  expect(await page.evaluate(() => document.getElementById('chat').contains(document.getElementById('approval-dock')))).toBe(false);
  await expect(page.locator('#chat .bubble.approval')).toHaveCount(0);
  await expect(page.locator('#run-status')).toHaveText('Waiting for your approval');
  // Focus moves to the first option so the keyboard works immediately.
  expect(await page.evaluate(() => document.activeElement.dataset.choice)).toBe('once');
});

test('keyboard: number keys choose, Esc denies; an audit line is left in the transcript', async () => {
  const { page } = ctx;
  await request(page, 'a', WRITE);
  await page.keyboard.press('2');
  await expect.poll(() => result(page, 'a')).toBe('always');
  await expect(page.locator('#approval-dock')).toBeHidden();
  await expect(page.locator('#chat .decision-row.decision-always')).toContainText('Always allowed');

  await request(page, 'b', SHELL);
  await expect(page.locator('#approval-dock .dock-option')).toHaveCount(2); // no "always" for shell
  await page.keyboard.press('Escape');
  await expect.poll(() => result(page, 'b')).toBe('deny');
  await expect(page.locator('#chat .decision-row.decision-deny')).toContainText('Denied');
  await expect(page.locator('#chat .decision-row.decision-deny')).toContainText('npm test');
});

test('arrow keys move the selection and Enter confirms', async () => {
  const { page } = ctx;
  await request(page, 'k', WRITE);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#approval-dock .dock-option.is-selected')).toHaveAttribute('data-choice', 'deny');
  await page.keyboard.press('ArrowDown'); // wraps
  await expect(page.locator('#approval-dock .dock-option.is-selected')).toHaveAttribute('data-choice', 'once');
  await page.keyboard.press('Enter');
  await expect.poll(() => result(page, 'k')).toBe('once');
});

test('typing in the composer never answers a pending prompt', async () => {
  const { page } = ctx;
  await request(page, 't', WRITE);
  await page.click('#input');
  await page.keyboard.type('1 2 3');
  await page.keyboard.press('Escape');
  await expect(page.locator('#input')).toHaveValue('1 2 3');
  expect(await result(page, 't')).toBeUndefined();
  await expect(page.locator('#approval-dock')).toBeVisible();
});

test('a prompt never steals focus from a half-typed message; Shift+Tab jumps to it', async () => {
  const { page } = ctx;
  await page.click('#input');
  await page.keyboard.type('also add a footer and');
  await request(page, 'f', WRITE);
  await expect(page.locator('#approval-dock')).toBeVisible();
  await expect(page.locator('#input')).toBeFocused();
  await page.keyboard.type(' 2 more pages');
  await expect(page.locator('#input')).toHaveValue('also add a footer and 2 more pages');
  expect(await result(page, 'f')).toBeUndefined();

  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.activeElement.dataset.choice)).toBe('once');
  await page.keyboard.press('Enter');
  await expect.poll(() => result(page, 'f')).toBe('once');
  await expect(page.locator('#input')).toBeFocused(); // focus handed back
});

test('requests queue FIFO with a "1 of N" counter', async () => {
  const { page } = ctx;
  await request(page, 'q1', WRITE);
  await request(page, 'q2', SHELL);
  await expect(page.locator('.dock-queue')).toHaveText('1 of 2');
  await expect(page.locator('#run-status')).toContainText('(2)');
  await page.locator('.dock-option[data-choice="once"]').click();
  await expect(page.locator('.dock-title')).toHaveText('Run a shell command');
  await expect(page.locator('.dock-queue')).toBeHidden();
  await page.locator('.dock-option[data-choice="once"]').click();
  expect([await result(page, 'q1'), await result(page, 'q2')]).toEqual(['once', 'once']);
});

test('Stop / New chat cancel pending prompts so the agent never hangs', async () => {
  const { page } = ctx;
  await request(page, 'c1', WRITE);
  await request(page, 'c2', SHELL);
  await page.evaluate(() => window.LLMClusterUI.approvalDock.cancelAll());
  expect([await result(page, 'c1'), await result(page, 'c2')]).toEqual(['deny', 'deny']);
  await expect(page.locator('#approval-dock')).toBeHidden();
  await expect(page.locator('#chat .decision-cancelled')).toHaveCount(2);

  await request(page, 'c3', WRITE);
  await page.click('#new-chat-btn');
  await expect.poll(() => result(page, 'c3')).toBe('deny');
  await expect(page.locator('#approval-dock')).toBeHidden();
});

test('agentLoop.showApprovalCard uses the dock and records "always allow" in the remembered set', async () => {
  const { page } = ctx;
  await page.evaluate(() => {
    const { __test } = require('../lib/agentLoop');
    window.__remembered = new Set();
    window.__approved = __test.showApprovalCard({
      chat: document.getElementById('chat'),
      toolName: 'edit_file',
      args: { path: '/ws/a.js', old_string: 'x', new_string: 'y' },
      risk: 'write',
      remembered: window.__remembered,
    });
  });
  await expect(page.locator('#approval-dock .dock-title')).toHaveText('Edit a file');
  await expect(page.locator('#chat .bubble.approval')).toHaveCount(0);
  await page.locator('.dock-option[data-choice="always"]').click();
  const out = await page.evaluate(async () => ({ ok: await window.__approved, keys: [...window.__remembered] }));
  expect(out).toEqual({ ok: true, keys: ['edit_file:/ws/a.js'] });
  // The agent's own rule now skips the prompt for that file.
  const asks = await page.evaluate(() => require('../lib/agentLoop').__test.shouldAskApproval({
    toolName: 'edit_file', risk: 'write', approvalMode: 'strict', remembered: window.__remembered, args: { path: '/ws/a.js' },
  }));
  expect(asks).toBe(false);
});

test('plan approval: plan document in the transcript, decision in the dock, edit then execute', async () => {
  const { page } = ctx;
  await page.evaluate(() => {
    const { __test } = require('../lib/agentLoop');
    window.__plan = __test.showPlanApproval(document.getElementById('chat'), '## Goal\nShip it.\n\n## Todos\n1. Write index.html');
  });
  const card = page.locator('#chat .plan-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.md-h2').first()).toHaveText('Goal');
  await expect(card.locator('.plan-status')).toHaveText('Awaiting approval');
  await expect(page.locator('#approval-dock .dock-title')).toHaveText('Review the proposed plan');
  await expect(page.locator('#approval-dock .dock-option')).toHaveText([/execute this plan/, /Edit the plan/, /reject/]);

  await page.keyboard.press('2'); // edit
  const editor = card.locator('.plan-editor');
  await expect(editor).toBeVisible();
  await expect(page.locator('#approval-dock .dock-title')).toHaveText('Editing the proposed plan');
  await editor.fill('## Goal\nShip it today.');
  await page.keyboard.press('Control+Enter');
  expect(await page.evaluate(() => window.__plan)).toBe('edit:## Goal\nShip it today.');
  await expect(card.locator('.plan-status')).toHaveText('Edited & approved');
  await expect(card.locator('.plan-body')).toContainText('Ship it today.');
  await expect(page.locator('#approval-dock')).toBeHidden();
});

test('plan rejection via Esc', async () => {
  const { page } = ctx;
  await page.evaluate(() => {
    window.__plan = require('../lib/agentLoop').__test.showPlanApproval(document.getElementById('chat'), 'A plan');
  });
  await expect(page.locator('#approval-dock')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.__plan)).toBe('reject');
  await expect(page.locator('#chat .plan-status')).toHaveText('Rejected');
});

test('fallback: without a dock element the agent still asks via the (restyled) inline card', async () => {
  const { page } = ctx;
  await page.evaluate(() => {
    document.getElementById('approval-dock').remove();
    const { __test } = require('../lib/agentLoop');
    window.__fallback = __test.showApprovalCard({
      chat: document.getElementById('chat'),
      toolName: 'run_shell',
      args: { cmd: 'npm', args: ['test'] },
      risk: 'shell',
      remembered: new Set(),
    });
  });
  const card = page.locator('#chat .bubble.approval');
  await expect(card).toBeVisible();
  await expect(card.locator('svg')).toHaveCount(1);              // SVG icon, not emoji
  await expect(card.locator('.approval-btn')).toHaveText(['Approve', 'Reject']); // shell can't be remembered
  await card.locator('.approval-btn.approve').click();
  expect(await page.evaluate(() => window.__fallback)).toBe(true);
});
