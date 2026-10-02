'use strict';
const { test, expect } = require('@playwright/test');
const { launchApp, resize, rect } = require('../helpers/app');

let ctx;
test.afterEach(async () => { if (ctx) await ctx.app.close(); ctx = null; });

test('boots cleanly: one window, no DevTools, no renderer errors', async () => {
  ctx = await launchApp();
  const { app, page, errors } = ctx;
  await page.waitForTimeout(300);
  expect(app.windows()).toHaveLength(1);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened())).toBe(false);
  expect(errors).toEqual([]);
  await expect(page).toHaveTitle('LLM Cluster Chat');
});

test('custom title bar is draggable and leaves room for the OS window controls', async () => {
  ctx = await launchApp({ width: 1100 });
  const { page } = ctx;
  const info = await page.evaluate(() => {
    const bar = document.querySelector('.titlebar');
    const cs = getComputedStyle(bar);
    const wco = navigator.windowControlsOverlay;
    const area = wco && wco.visible ? wco.getTitlebarAreaRect() : null;
    const btn = document.getElementById('new-chat-btn').getBoundingClientRect();
    return {
      drag: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region'),
      height: bar.getBoundingClientRect().height,
      areaRight: area ? area.x + area.width : null,
      btnRight: btn.right,
      bodyClasses: document.body.className,
    };
  });
  expect(info.drag).toBe('drag');
  expect(info.height).toBe(44);
  expect(info.bodyClasses).toMatch(/frame-custom/);
  expect(info.bodyClasses).toMatch(new RegExp(`platform-${process.platform}`));
  if (info.areaRight != null) expect(info.btnRight).toBeLessThanOrEqual(info.areaRight);
  // Buttons inside the drag region must stay clickable.
  const noDrag = await page.evaluate(() => getComputedStyle(document.getElementById('mode-code')).getPropertyValue('-webkit-app-region') || getComputedStyle(document.getElementById('mode-code')).getPropertyValue('app-region'));
  expect(noDrag).toBe('no-drag');
});

test('chat mode: centred empty state with suggestions; code-only controls hidden', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('#empty-title')).toHaveText('How can I help today?');
  await expect(page.locator('.suggestion')).toHaveCount(4);
  for (const sel of ['#workspace-btn', '#approval-mode-trigger', '.switch', '#side-panel', '#panel-toggle']) {
    await expect(page.locator(sel)).toBeHidden();
  }
  await expect(page.locator('#model-trigger')).toBeVisible();
  // Clicking a suggestion pre-fills (does not auto-send) the composer.
  await page.locator('.suggestion').first().click();
  await expect(page.locator('#input')).toHaveValue(/attention/);
  await expect(page.locator('#send-btn')).toBeEnabled();
  expect(await page.locator('#chat > *').count()).toBe(0);
});

test('code mode: workspace chip, permission mode and plan switch live in the composer; mode persists', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.click('#mode-code');
  await expect(page.locator('#mode-code')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#workspace-btn')).toBeVisible();
  await expect(page.locator('#workspace-label')).toHaveText('Choose workspace');
  await expect(page.locator('#approval-mode-trigger')).toContainText('Strict');
  await expect(page.locator('.switch')).toBeVisible();
  await expect(page.locator('#empty-title')).toHaveText('What should we build?');
  await expect(page.locator('#empty-workspace-btn')).toBeVisible();
  await expect(page.locator('#side-panel')).toBeVisible();
  // All controls sit inside the composer, below the input.
  const composer = await rect(page, '.composer');
  const input = await rect(page, '#input');
  for (const sel of ['#workspace-btn', '#approval-mode-trigger', '#model-trigger', '#send-btn']) {
    const r = await rect(page, sel);
    expect(r.top).toBeGreaterThanOrEqual(input.bottom - 1);
    expect(r.bottom).toBeLessThanOrEqual(composer.bottom);
  }
  await page.reload();
  await page.waitForFunction(() => Boolean(window.LLMClusterUI));
  expect(await page.evaluate(() => window.LLMClusterUI.getState().mode)).toBe('code');
});

for (const width of [640, 900, 1280, 1600]) {
  test(`layout holds at ${width}px: no overflow, no overlapping title bar controls`, async () => {
    ctx = await launchApp({ width, height: 760 });
    const { page } = ctx;
    await page.click('#mode-code');
    await page.waitForTimeout(150);
    const res = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const overflow = [...document.querySelectorAll('body *')].filter((e) => {
        const b = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return b.width > 0 && b.right > vw + 1 && cs.position !== 'fixed' && !e.closest('.popover-root');
      }).map(e => e.id || e.className);
      const ids = ['brand', 'mode-switch', 'connection-btn', 'panel-toggle', 'new-chat-btn'];
      const boxes = ids.map(id => [id, document.getElementById(id).getBoundingClientRect()]).filter(([, b]) => b.width > 0);
      const overlaps = [];
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const [a, A] = boxes[i]; const [b, B] = boxes[j];
        if (A.left < B.right && B.left < A.right && A.top < B.bottom && B.top < A.bottom) overlaps.push(`${a}/${b}`);
      }
      const composer = document.querySelector('.composer').getBoundingClientRect();
      return { overflow, overlaps, composerW: composer.width, scrollW: document.body.scrollWidth, vw };
    });
    expect(res.overflow).toEqual([]);
    expect(res.overlaps).toEqual([]);
    expect(res.scrollW).toBeLessThanOrEqual(res.vw);
    expect(res.composerW).toBeLessThanOrEqual(800);
  });
}

test('side panel docks on wide windows and becomes a dismissible drawer on narrow ones', async () => {
  ctx = await launchApp({ width: 1400 });
  const { app, page } = ctx;
  await page.click('#mode-code');
  const docked = await page.evaluate(() => getComputedStyle(document.getElementById('side-panel')).position);
  expect(docked).toBe('static');
  const chatR = await rect(page, '#chat');
  const panelR = await rect(page, '#side-panel');
  expect(chatR.right).toBeLessThanOrEqual(panelR.left + 1);

  await resize(app, 900, 760);
  await page.waitForTimeout(200);
  await expect(page.locator('#side-panel')).toBeHidden();
  await page.click('#panel-toggle');
  await expect(page.locator('#side-panel')).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('side-panel')).position)).toBe('absolute');
  await page.mouse.click(200, 300); // click the conversation
  await expect(page.locator('#side-panel')).toBeHidden();
});

test('cross-OS consistency: SVG icons only, one font stack, custom scrollbars and form controls', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.click('#mode-code');
  const res = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('.icon-slot')];
    return {
      emptySlots: slots.filter(s => !s.querySelector('svg')).length,
      bodyFont: getComputedStyle(document.body).fontFamily,
      nativeSelectsVisible: [...document.querySelectorAll('select')].filter(s => s.getBoundingClientRect().width > 0).length,
      checkboxVisible: document.getElementById('plan-mode').getBoundingClientRect().width > 1,
      scrollbarRule: [...document.styleSheets].some(function walk(s) {
        try { return [...s.cssRules].some(r => (r.styleSheet && walk(r.styleSheet)) || (r.selectorText || '').includes('::-webkit-scrollbar')); } catch { return false; }
      }),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
    };
  });
  expect(res.emptySlots).toBe(0);
  // Chromium normalizes BlinkMacSystemFont to "system-ui" on macOS.
  expect(res.bodyFont).toMatch(/^-apple-system, (?:BlinkMacSystemFont|"system-ui"), "Segoe UI Variable Text", "Segoe UI"/);
  expect(res.nativeSelectsVisible).toBe(0);
  expect(res.checkboxVisible).toBe(false);
  expect(res.scrollbarRule).toBe(true);
  expect(res.colorScheme).toBe('dark');
});

test('palette is applied: black transcript, navy chrome/surfaces, rust primary action', async () => {
  ctx = await launchApp();
  const { page } = ctx;
  await page.fill('#input', 'hello');
  // Wait for the disabled → enabled colour transition to settle.
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.getElementById('send-btn')).backgroundColor)).toBe('rgb(181, 72, 28)');
  const c = await page.evaluate(() => ({
    app: getComputedStyle(document.querySelector('.workspace-main')).backgroundColor,
    chrome: getComputedStyle(document.querySelector('.titlebar')).backgroundColor,
    composer: getComputedStyle(document.querySelector('.composer')).backgroundColor,
    send: getComputedStyle(document.getElementById('send-btn')).backgroundColor,
    sendFg: getComputedStyle(document.getElementById('send-btn')).color,
    text: getComputedStyle(document.body).color,
  }));
  expect(c.app).toBe('rgb(7, 9, 14)');
  expect(c.chrome).toBe('rgb(11, 17, 32)');
  expect(c.composer).toBe('rgb(15, 23, 41)');
  expect(c.send).toBe('rgb(181, 72, 28)');
  expect(c.sendFg).toBe('rgb(255, 247, 242)');
  expect(c.text).toBe('rgb(232, 235, 241)');
});
