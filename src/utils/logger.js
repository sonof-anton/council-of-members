'use strict';

const fs = require('fs');
const path = require('path');

let logFile = null;

function initLogFile() {
  if (logFile) return;
  try {
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    logFile = path.join(logDir, `council-${ts}.log`);
  } catch {
    logFile = null;
  }
}

function log(level, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${message}`;

  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }

  try {
    initLogFile();
    if (logFile) {
      fs.appendFileSync(logFile, line + '\n');
    }
  } catch {
    // Silently fail file logging
  }
}

module.exports = { log };
