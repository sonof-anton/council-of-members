'use strict';

const path = require('path');

// Where logs, transcripts and perf stats go. Running from source (npm start
// or the desktop shortcut) keeps them in <project>\logs as before. An
// installed copy can't rely on its working directory (Program Files is not
// writable and the shortcut's start folder varies), so it uses
// %APPDATA%\CouncilOfMembers\logs. Under plain node (tests) `electron`
// resolves to a path string with no `app`, so fall back to the cwd.
function logDir() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) return path.join(app.getPath('userData'), 'logs');
  } catch { /* not running inside Electron */ }
  return path.join(process.cwd(), 'logs');
}

module.exports = { logDir };
