'use strict';

const { app, BrowserWindow } = require('electron');
const WindowManager = require('./window-manager.js');
const { registerIpcHandlers } = require('./ipc-handlers.js');

let mainWindow;
let windowManager;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#000000',
    title: 'COUNCIL OF MEMBERS'
  });

  windowManager = new WindowManager(mainWindow);
  windowManager.createViews();
  windowManager.createUiView();
  windowManager.layout();

  registerIpcHandlers(mainWindow, windowManager);

  mainWindow.on('resize', () => windowManager.layout());
}

// A second copy would share the persist:* login partitions with the first
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createWindow);
}

app.on('window-all-closed', () => {
  app.quit();
});
