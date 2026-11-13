'use strict';

const { app, dialog } = require('electron');
const { log } = require('../utils/logger.js');

// Auto-update from the GitHub Releases named in electron-builder.yml
// (publish:). Only an installed copy updates; running from source
// (npm start / the dev shortcut) is updated with git instead.
//
// The new version downloads in the background. Installing needs a restart,
// which would kill a running council session, so the user is asked first;
// "Later" installs it the next time the app is closed.
function initAutoUpdate(mainWindow) {
  if (!app.isPackaged) return;

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    log('warn', `Updater unavailable: ${err.message}`);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => log('info', `Updater: ${m}`),
    warn: (m) => log('warn', `Updater: ${m}`),
    error: (m) => log('error', `Updater: ${m}`),
    debug: () => {}
  };

  autoUpdater.on('update-available', (info) => log('info', `Updater: downloading ${info.version}`));
  autoUpdater.on('update-not-available', () => log('info', `Updater: ${app.getVersion()} is the latest`));
  autoUpdater.on('error', (err) => log('warn', `Updater: ${err.message}`));

  autoUpdater.on('update-downloaded', async (info) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Restart and update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Council of Members ${info.version} is ready to install.`,
      detail: `You have ${app.getVersion()}. Restarting ends any council session in progress. ` +
        'Choose Later to install it automatically the next time you close the app.'
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });

  // Offline or GitHub unreachable just logs a warning; the app runs normally
  autoUpdater.checkForUpdates().catch((err) => log('warn', `Updater: ${err.message}`));
}

module.exports = { initAutoUpdate };
