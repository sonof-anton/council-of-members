'use strict';

const { BrowserWindow } = require('electron');
const ConsultController = require('../automation/consult-controller.js');
const { CONSULT_TIMEOUT_MS, CONSULT_MIN_REPLY_LENGTH } = require('../utils/constants.js');
const { log } = require('../utils/logger.js');

// Consultation windows stay open after the reply so the Chancellor can read
// the exchange; keep references so they aren't garbage collected.
const openWindows = new Set();

function waitForLoad(webContents, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('page did not finish loading')), timeoutMs);
    webContents.once('did-finish-load', () => { clearTimeout(timer); resolve(); });
    webContents.once('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (!isMainFrame) return;
      clearTimeout(timer);
      reject(new Error(`page failed to load: ${desc} (${code})`));
    });
  });
}

// Open `url` in a new window, ask `question` in its chat, return the reply.
async function consultOutside(url, question, { onActivity } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`only web addresses can be consulted, not ${parsed.protocol}`);
  }

  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    title: `COUNCIL CONSULTATION — ${parsed.hostname}`,
    backgroundColor: '#000000',
    webPreferences: {
      // Its own login partition: an outside site never sees members' sessions
      partition: 'persist:consult',
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  openWindows.add(win);
  win.on('closed', () => openWindows.delete(win));
  // Keep the window title ours, not the site's
  win.on('page-title-updated', (e) => e.preventDefault());

  const report = (text) => { if (onActivity) onActivity(text); };
  report(`Opening ${parsed.hostname}`);
  const loaded = waitForLoad(win.webContents, 45000);
  win.loadURL(url).catch(() => {});
  await loaded;

  const controller = new ConsultController(win.webContents, url);
  controller.onActivity = report;
  await controller.send(question);
  const reply = await controller.waitForReply(question, {
    timeoutMs: CONSULT_TIMEOUT_MS,
    minLength: CONSULT_MIN_REPLY_LENGTH
  });
  log('info', `consult ${parsed.hostname}: reply received (${reply.length} chars)`);
  return reply;
}

module.exports = { consultOutside };
