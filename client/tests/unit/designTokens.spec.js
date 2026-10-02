'use strict';
/**
 * Design-system guard rails (pure Node — no Electron needed).
 *  1. Readability: every text/background pairing we use meets WCAG AA (4.5:1).
 *  2. Palette discipline: raw hex colours only live in tokens.css.
 *  3. Cross-OS determinism: no fractional line-heights/opacity/font-sizes
 *     (integer px rounds identically on every platform's rasteriser).
 *  4. No emoji in UI sources (they render with a different font per OS).
 */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const STYLES = path.resolve(__dirname, '../../renderer/styles');
const RENDERER = path.resolve(__dirname, '../../renderer');
const tokensCss = fs.readFileSync(path.join(STYLES, 'tokens.css'), 'utf8');

function readTokens(css) {
  const map = {};
  for (const m of css.matchAll(/(--[\w-]+):\s*([^;]+);/g)) map[m[1]] = m[2].trim();
  const resolve = (v, depth = 0) => {
    const ref = /^var\((--[\w-]+)\)$/.exec(v);
    return ref && depth < 5 ? resolve(map[ref[1]], depth + 1) : v;
  };
  return new Proxy(map, { get: (t, k) => resolve(t[k]) });
}

function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const T = readTokens(tokensCss);

test.describe('palette: black / dark navy / rust orange', () => {
  test('the three brand families exist and are what they claim to be', () => {
    const hsl = (hex) => {
      const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(1 + i, 3 + i), 16) / 255);
      const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
      let hue = 0;
      if (d) hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return { h: (hue * 60 + 360) % 360, l: (max + min) / 2 };
    };
    expect(hsl(T['--black-900']).l).toBeLessThan(0.05);              // black
    const navy = hsl(T['--navy-850']);
    expect(navy.h).toBeGreaterThan(200); expect(navy.h).toBeLessThan(240); // navy hue
    expect(navy.l).toBeLessThan(0.15);                                  // dark
    const rust = hsl(T['--rust-500']);
    expect(rust.h).toBeGreaterThan(10); expect(rust.h).toBeLessThan(30); // rust orange hue
  });

  const surfaces = ['--bg-app', '--bg-chrome', '--bg-raised', '--bg-hover', '--bg-user', '--bg-code'];
  const texts = ['--text-1', '--text-2', '--text-3', '--rust-300', '--rust-200', '--success', '--warning', '--danger', '--info', '--code-text'];
  for (const fg of texts) {
    test(`${fg} is readable (≥ 4.5:1) on every surface`, () => {
      for (const bg of surfaces) {
        const ratio = contrast(T[fg], T[bg]);
        expect(ratio, `${fg} ${T[fg]} on ${bg} ${T[bg]} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  test('labels on rust buttons are readable in every state', () => {
    for (const fill of ['--rust-500', '--rust-450', '--rust-600']) {
      expect(contrast(T['--text-on-accent'], T[fill]), fill).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('selected rows keep secondary/tertiary text readable', () => {
    expect(contrast(T['--text-2'], T['--bg-selected'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(T['--text-3'], T['--bg-selected'])).toBeGreaterThanOrEqual(4.5);
  });

  test('rust accent stands out from the background as a UI element (≥ 3:1)', () => {
    expect(contrast(T['--rust-500'], T['--bg-app'])).toBeGreaterThanOrEqual(3);
    expect(contrast(T['--rust-300'], T['--bg-raised'])).toBeGreaterThanOrEqual(3);
  });
});

test.describe('stylesheet hygiene', () => {
  const sheets = fs.readdirSync(STYLES).filter(f => f.endsWith('.css'));
  const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

  test('raw hex colours only appear in tokens.css', () => {
    for (const f of sheets.filter(n => n !== 'tokens.css')) {
      const hits = strip(fs.readFileSync(path.join(STYLES, f), 'utf8')).match(/#[0-9a-fA-F]{3,8}\b/g) || [];
      expect(hits, `${f} should use var(--token) instead of ${hits.join(', ')}`).toEqual([]);
    }
  });

  test('no fractional line-height, opacity or px font sizes', () => {
    for (const f of sheets) {
      const css = strip(fs.readFileSync(path.join(STYLES, f), 'utf8'));
      expect(css, `${f}: unitless fractional line-height`).not.toMatch(/line-height:\s*\d*\.\d+\s*[;}]/);
      expect(css, `${f}: fractional opacity`).not.toMatch(/opacity:\s*0?\.\d+/);
      expect(css, `${f}: fractional font-size`).not.toMatch(/font-size:\s*\d+\.\d+px/);
    }
  });

  test('style.css imports every stylesheet in cascade order', () => {
    const entry = fs.readFileSync(path.join(RENDERER, 'style.css'), 'utf8');
    const order = [...entry.matchAll(/styles\/([\w-]+\.css)/g)].map(m => m[1]);
    expect(order[0]).toBe('tokens.css');
    expect(order[1]).toBe('base.css');
    expect(order.sort()).toEqual([...sheets].sort());
  });
});

test('UI sources contain no emoji (they render differently on each OS)', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html|css)$/.test(e.name)) files.push(p);
    }
  };
  walk(RENDERER);
  files.push(path.resolve(__dirname, '../../lib/agentLoop.js'));
  const emoji = /\p{Extended_Pictographic}/u;
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const bad = lines.map((l, i) => [i + 1, l]).filter(([, l]) => emoji.test(l) && !/^\s*(\/\/|\*)/.test(l));
    expect(bad.map(([n, l]) => `${path.basename(f)}:${n}: ${l.trim().slice(0, 80)}`)).toEqual([]);
  }
});
