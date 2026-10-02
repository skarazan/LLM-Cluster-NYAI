'use strict';

/**
 * Window chrome configuration shared by every OS build.
 *
 * Goal: the app looks the same on Windows, macOS and Linux. We hide the native
 * title bar and enable the Window Controls Overlay (WCO) everywhere, so the app
 * draws its own dark title bar (renderer/styles/layout.css → .titlebar) and the
 * OS only draws its window buttons on top:
 *   - Windows / Linux: min/max/close on the right, tinted with our colours
 *   - macOS: traffic lights on the left (titleBarOverlay enables the
 *     titlebar-area-* CSS env() variables there too)
 *
 * Escape hatch: LLM_CLUSTER_NATIVE_FRAME=1 restores the native frame (e.g. for
 * an exotic Linux window manager).
 *
 * Pure function — unit tested in tests/unit/windowChrome.spec.js.
 */
const THEME = Object.freeze({
  background: '#07090E',  // --bg-app   (avoids a white flash before first paint)
  chrome: '#0B1120',      // --bg-chrome (title bar)
  chromeSymbol: '#A9B1C2', // --text-2   (window button glyphs)
  titleBarHeight: 44,     // --titlebar-h
});

function windowChromeOptions(platform = process.platform, env = process.env) {
  if (env && env.LLM_CLUSTER_NATIVE_FRAME === '1') {
    return { frame: 'native', options: { backgroundColor: THEME.background } };
  }
  if (platform === 'darwin') {
    return {
      frame: 'custom',
      options: {
        backgroundColor: THEME.background,
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 16, y: 15 },
        titleBarOverlay: { height: THEME.titleBarHeight },
      },
    };
  }
  return {
    frame: 'custom',
    options: {
      backgroundColor: THEME.background,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: THEME.chrome,
        symbolColor: THEME.chromeSymbol,
        height: THEME.titleBarHeight,
      },
    },
  };
}

/** DevTools no longer pop open for every user; opt in with --devtools or LLM_CLUSTER_DEVTOOLS=1. */
function shouldOpenDevTools(argv = process.argv, env = process.env) {
  return (env && env.LLM_CLUSTER_DEVTOOLS === '1') || (Array.isArray(argv) && argv.includes('--devtools'));
}

/** Only these URL schemes may leave the app (opened in the system browser). */
function isSafeExternalUrl(url) {
  return /^(https?:\/\/|mailto:)/i.test(String(url || '').trim());
}

module.exports = { THEME, windowChromeOptions, shouldOpenDevTools, isSafeExternalUrl };
