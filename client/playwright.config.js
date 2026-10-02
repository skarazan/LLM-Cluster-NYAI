// @ts-check
const { defineConfig } = require('@playwright/test');

/**
 * UI tests for the Electron client.
 *   npm run test:ui     → everything (Electron tests need a display; use Xvfb on headless Linux)
 *   npm run test:unit   → pure Node tests only (no Electron, no display)
 *
 * The Electron tests launch ONLY the client. The manager / worker / model are
 * never started: IPC handlers that would reach the network are replaced with
 * scripted fakes inside the Electron main process (see tests/helpers/app.js).
 */
module.exports = defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results',
});
