'use strict';

const { WebContentsView } = require('electron');
const path = require('path');
const { AI_NAMES, AI_URLS } = require('../utils/constants.js');
const { getSession } = require('./session-manager.js');

class WindowManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.views = {};
    this.currentLevel = 1;
    this.uiView = null;
  }

  // The Chancellor UI lives in its own view rather than the window's base
  // webContents, because child views always paint above the base page. As a
  // view it can be stacked above the AI panels on Level 1/2 (covering them
  // while they keep rendering at full size) and below them on Level 0/3.
  createUiView() {
    this.uiView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    this.uiView.setBackgroundColor('#000000');
    this.uiView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    // Panels created underneath the UI never get marked visible by Chromium
    // (document.hidden stays true until they are first actually uncovered —
    // a setVisible() toggle doesn't do it). Briefly put the UI underneath
    // once the window is up, then restore the normal stacking.
    this.uiView.webContents.once('did-finish-load', () => {
      this.setUiOnTop(false);
      setTimeout(() => this.layout(), 500);
    });
    this.mainWindow.contentView.addChildView(this.uiView);
    const { width, height } = this.mainWindow.getContentBounds();
    this.uiView.setBounds({ x: 0, y: 0, width, height });
    return this.uiView;
  }

  // Re-adding an existing child view moves it to the requested z-position
  setUiOnTop(onTop) {
    if (onTop) this.mainWindow.contentView.addChildView(this.uiView);
    else this.mainWindow.contentView.addChildView(this.uiView, 0);
  }

  createViews() {
    for (const name of AI_NAMES) {
      const sess = getSession(name);

      // Block Grammarly and other extensions from loading in embedded views
      sess.webRequest.onBeforeRequest(
        { urls: ['*://*.grammarly.com/*', '*://*.grammarly.io/*', '*://*.grammarly.cloud/*'] },
        (_details, callback) => { callback({ cancel: true }); }
      );

      // Remove all extensions from this session (if API available)
      try {
        if (sess.getAllExtensions) {
          sess.getAllExtensions().forEach(ext => {
            try { sess.removeExtension(ext.id); } catch (_) { /* ignore */ }
          });
        }
      } catch (_) { /* ignore if API not available */ }

      const view = new WebContentsView({
        webPreferences: {
          session: sess,
          contextIsolation: true,
          sandbox: true,
          // The router drives these pages while the user sits on Level 1/2;
          // throttled timers stall the sites' streaming UI and send buttons.
          backgroundThrottling: false
        }
      });
      view.webContents.loadURL(AI_URLS[name]);

      // Remove Grammarly after each page load
      view.webContents.on('did-finish-load', () => {
        view.webContents.executeJavaScript(`
          (function() {
            var remove = function() {
              document.querySelectorAll('grammarly-desktop-integration, grammarly-extension, [data-grammarly-shadow-root], grammarly-popups').forEach(function(el) { el.remove(); });
              document.querySelectorAll('[contenteditable]').forEach(function(el) {
                el.setAttribute('data-gramm', 'false');
                el.setAttribute('data-gramm_editor', 'false');
                el.setAttribute('data-enable-grammarly', 'false');
              });
            };
            remove();
            new MutationObserver(function() { remove(); }).observe(document.body, { childList: true, subtree: true });
          })()
        `).catch(() => {});
      });

      this.views[name] = view;
      this.mainWindow.contentView.addChildView(view);
    }
  }

  setLevel(level) {
    this.currentLevel = level;
    this.layout();
  }

  // Measure the actual bottom edge of the header content above the browser
  // panels, instead of guessing a fixed pixel offset — the header heights
  // depend on CSS (font metrics, padding) and drift out of sync with any
  // hardcoded constant.
  async getPanelTopOffset(selector) {
    const bottom = await this.uiView.webContents.executeJavaScript(
      `(function() {` +
      `  var el = document.querySelector(${JSON.stringify(selector)});` +
      `  return el ? el.getBoundingClientRect().bottom : 0;` +
      `})()`
    ).catch(() => 0);
    return Math.ceil(bottom) || 63; // fall back to the old constant if measurement fails
  }

  async layout() {
    const bounds = this.mainWindow.getContentBounds();
    const w = bounds.width;
    const h = bounds.height;
    this.uiView.setBounds({ x: 0, y: 0, width: w, height: h });
    this.setUiOnTop(this.currentLevel !== 0 && this.currentLevel !== 3);

    if (this.currentLevel === 0) {
      // Login mode: browser panels fill most of the window
      const topOffset = await this.getPanelTopOffset('#login-labels');
      const panelHeight = h - topOffset;
      const panelWidth = Math.floor(w / 3);

      AI_NAMES.forEach((name, i) => {
        const view = this.views[name];
        view.setBounds({
          x: i * panelWidth,
          y: topOffset,
          width: i === 2 ? w - 2 * panelWidth : panelWidth,
          height: panelHeight
        });
        view.setVisible(true);
      });
    } else if (this.currentLevel === 3) {
      // Full view: top portion is renderer (status/log), bottom is browser panels
      const topOffset = await this.getPanelTopOffset('#l3-ai-status');
      const panelHeight = h - topOffset - 200; // 200px for message log at bottom
      const panelWidth = Math.floor(w / 3);

      AI_NAMES.forEach((name, i) => {
        const view = this.views[name];
        view.setBounds({
          x: i * panelWidth,
          y: topOffset,
          width: i === 2 ? w - 2 * panelWidth : panelWidth,
          height: panelHeight > 100 ? panelHeight : 100
        });
        view.setVisible(true);
      });
    } else {
      // Level 1 and 2: panels stay full-size underneath the UI view.
      // setVisible(false) would shrink them to 0x0 and mark them
      // document.hidden — Gemini's send button then ignores clicks and Grok's
      // response never renders, so automation silently stalls.
      const panelWidth = Math.floor(w / 3);
      AI_NAMES.forEach((name, i) => {
        this.views[name].setBounds({
          x: i * panelWidth,
          y: 0,
          width: i === 2 ? w - 2 * panelWidth : panelWidth,
          height: h
        });
        this.views[name].setVisible(true);
      });
    }
  }

  getView(name) {
    return this.views[name];
  }

  getAllViews() {
    return this.views;
  }
}

module.exports = WindowManager;
