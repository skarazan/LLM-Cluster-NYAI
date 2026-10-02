'use strict';
const { test, expect } = require('@playwright/test');
const { windowChromeOptions, shouldOpenDevTools, isSafeExternalUrl, THEME } = require('../../lib/windowChrome');

test.describe('window chrome is coherent on every OS', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    test(`${platform}: hidden native title bar + window-controls overlay + dark background`, () => {
      const { frame, options } = windowChromeOptions(platform, {});
      expect(frame).toBe('custom');
      expect(options.titleBarStyle).toBe('hidden');
      expect(options.titleBarOverlay).toBeTruthy();
      expect(options.titleBarOverlay.height).toBe(THEME.titleBarHeight);
      expect(options.backgroundColor).toBe(THEME.background);
    });
  }

  test('Windows/Linux overlay buttons use the chrome colours', () => {
    for (const p of ['win32', 'linux']) {
      const { options } = windowChromeOptions(p, {});
      expect(options.titleBarOverlay).toMatchObject({ color: THEME.chrome, symbolColor: THEME.chromeSymbol });
    }
  });

  test('macOS traffic lights are vertically centred in the title bar', () => {
    const { options } = windowChromeOptions('darwin', {});
    expect(options.trafficLightPosition.y * 2 + 14).toBe(THEME.titleBarHeight);
  });

  test('LLM_CLUSTER_NATIVE_FRAME=1 restores the native frame', () => {
    const { frame, options } = windowChromeOptions('linux', { LLM_CLUSTER_NATIVE_FRAME: '1' });
    expect(frame).toBe('native');
    expect(options.titleBarStyle).toBeUndefined();
  });

  test('DevTools are opt-in', () => {
    expect(shouldOpenDevTools(['electron', '.'], {})).toBe(false);
    expect(shouldOpenDevTools(['electron', '.', '--devtools'], {})).toBe(true);
    expect(shouldOpenDevTools([], { LLM_CLUSTER_DEVTOOLS: '1' })).toBe(true);
  });

  test('only web/mail links may leave the app', () => {
    expect(isSafeExternalUrl('https://github.com')).toBe(true);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('file:///C:/Windows')).toBe(false);
  });
});
