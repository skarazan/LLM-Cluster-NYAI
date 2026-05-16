'use strict';

/**
 * Auto-update wrapper.
 *
 * electron-updater is initialized in main.js directly because it needs
 * access to the BrowserWindow. This module provides helpers if needed
 * for more complex update logic (e.g., staged rollouts).
 *
 * For now, main.js handles everything:
 *   - autoUpdater.checkForUpdatesAndNotify() on launch
 *   - IPC events: update-available, update-progress, update-downloaded
 *   - IPC handler: update:install → autoUpdater.quitAndInstall()
 *
 * No paid developer account needed. electron-updater works with:
 *   - GitHub Releases (free, what we use)
 *   - S3/generic server
 *   - Bintray (deprecated)
 *
 * The app must be code-signed for macOS auto-update.
 * On Windows, NSIS installer works without signing (just shows SmartScreen warning once).
 */

module.exports = {
  // Placeholder for future update logic (e.g., beta channel, staged rollout)
};
