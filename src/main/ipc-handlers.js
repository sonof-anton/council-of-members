'use strict';

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { AI_NAMES } = require('../utils/constants.js');
const ClaudeAdapter = require('../automation/adapters/claude-adapter.js');
const GrokAdapter = require('../automation/adapters/grok-adapter.js');
const GeminiAdapter = require('../automation/adapters/gemini-adapter.js');
const Router = require('../protocol/router.js');

let router = null;
let sessionRunning = false;
let loginPollInterval = null;

const adapterClasses = {
  claude: ClaudeAdapter,
  grok: GrokAdapter,
  gemini: GeminiAdapter
};

function registerIpcHandlers(mainWindow, windowManager) {
  function createRouter() {
    const views = windowManager.getAllViews();
    const controllers = {};

    for (const name of AI_NAMES) {
      const AdapterClass = adapterClasses[name];
      controllers[name] = new AdapterClass(views[name].webContents);
    }

    router = new Router(controllers);

    router.on('phase-change', (data) => {
      windowManager.uiView.webContents.send('council:phase-change', data);
    });

    router.on('ai-status', (data) => {
      windowManager.uiView.webContents.send('council:ai-status', data);
    });

    router.on('round-update', (data) => {
      windowManager.uiView.webContents.send('council:round-update', data);
    });

    router.on('consensus', (data) => {
      windowManager.uiView.webContents.send('council:consensus', data);
    });

    router.on('individual-consensus', (data) => {
      windowManager.uiView.webContents.send('council:individual-consensus', data);
    });

    router.on('log-message', (data) => {
      windowManager.uiView.webContents.send('council:log-message', data);
    });

    router.on('error', (data) => {
      windowManager.uiView.webContents.send('council:error', data);
    });

    router.on('timeout-tick', (data) => {
      windowManager.uiView.webContents.send('council:timeout-tick', data);
    });

    router.on('ai-thought', (data) => {
      windowManager.uiView.webContents.send('council:ai-thought', data);
    });

    router.on('perf-update', (data) => {
      windowManager.uiView.webContents.send('council:perf-update', data);
    });

    return router;
  }

  ipcMain.handle('council:send-prompt', async (_event, prompt) => {
    if (!prompt || typeof prompt !== 'string') {
      return { success: false, reason: 'Invalid prompt' };
    }
    // Two routers would type into the same three tabs at once
    if (sessionRunning) {
      return { success: false, reason: 'A session is already running' };
    }

    sessionRunning = true;
    try {
      const r = createRouter();
      return await r.run(prompt.trim());
    } finally {
      sessionRunning = false;
    }
  });

  ipcMain.handle('council:abort', async () => {
    if (router) {
      router.abort();
      return { success: true };
    }
    return { success: false, reason: 'No active session' };
  });

  ipcMain.handle('council:set-level', async (_event, level) => {
    windowManager.setLevel(level);
    return { success: true };
  });

  ipcMain.handle('council:get-state', async () => {
    if (!router) return { phase: 'IDLE', round: 0 };
    return {
      phase: router.state.phase,
      round: router.state.round,
      votes: router.state.getVotes()
    };
  });

  ipcMain.handle('council:skip-member', async (_event, name) => {
    if (router) {
      router.skipMember(name);
      return { success: true };
    }
    return { success: false, reason: 'No active session' };
  });

  ipcMain.handle('council:wait-member', async (_event, name) => {
    if (router) {
      router.waitMember(name);
      return { success: true };
    }
    return { success: false, reason: 'No active session' };
  });

  ipcMain.handle('council:nav-back', async (_event, name) => {
    const views = windowManager.getAllViews();
    if (views[name] && views[name].webContents.canGoBack()) {
      views[name].webContents.goBack();
    }
    return { success: true };
  });

  ipcMain.handle('council:nav-forward', async (_event, name) => {
    const views = windowManager.getAllViews();
    if (views[name] && views[name].webContents.canGoForward()) {
      views[name].webContents.goForward();
    }
    return { success: true };
  });

  ipcMain.handle('council:diagnose', async () => {
    const views = windowManager.getAllViews();
    const results = {};
    for (const name of AI_NAMES) {
      const wc = views[name].webContents;
      const data = await wc.executeJavaScript(`
        (function() {
          var selectors = [
            '[data-testid*="message"]', '[data-testid*="response"]', '[data-testid*="chat"]',
            '[class*="message"]', '[class*="response"]', '[class*="assistant"]',
            '[class*="claude"]', '[class*="bubble"]', '[class*="reply"]', '[class*="answer"]',
            '[class*="markdown"]', '[class*="prose"]', '[class*="content"]',
            'message-content', '.model-response-text', 'article',
            '[role="article"]', '[role="log"]', '[role="presentation"]'
          ];
          var result = {};
          selectors.forEach(function(sel) {
            try {
              var count = document.querySelectorAll(sel).length;
              if (count > 0) result[sel] = count;
            } catch(e) {}
          });
          // Also get all data-testid values on the page
          var testIds = {};
          document.querySelectorAll('[data-testid]').forEach(function(el) {
            var id = el.getAttribute('data-testid');
            testIds[id] = (testIds[id] || 0) + 1;
          });
          return { selectors: result, testIds: testIds, url: location.href };
        })()
      `).catch(() => ({ error: 'Failed to execute' }));
      results[name] = data;
    }
    console.log('\\n=== DIAGNOSTIC DUMP ===');
    console.log(JSON.stringify(results, null, 2));
    console.log('=== END DIAGNOSTIC ===\\n');
    return results;
  });

  // One-shot deep DOM probe for Gemini debugging
  ipcMain.handle('council:deep-probe', async () => {
    const views = windowManager.getAllViews();
    const wc = views['gemini'].webContents;
    const result = await wc.executeJavaScript(`
      (function() {
        var info = { tags: {}, shadowHosts: [], customElements: [], iframes: 0 };
        // Count all tag types
        var all = document.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var tag = all[i].tagName.toLowerCase();
          info.tags[tag] = (info.tags[tag] || 0) + 1;
          if (all[i].shadowRoot) info.shadowHosts.push(tag);
          if (tag.includes('-')) {
            if (!info.customElements.includes(tag)) info.customElements.push(tag);
          }
        }
        info.iframes = document.querySelectorAll('iframe').length;
        // Check body text length
        info.bodyTextLen = (document.body.innerText || '').length;
        info.bodyTextPreview = (document.body.innerText || '').substring(0, 500);
        info.url = location.href;
        return info;
      })()
    `).catch(e => ({ error: e.message }));
    console.log('\\n=== GEMINI DEEP PROBE ===');
    console.log(JSON.stringify(result, null, 2));
    console.log('=== END PROBE ===\\n');
    return result;
  });

  // Start login polling
  startLoginPolling(mainWindow, windowManager);
}

function startLoginPolling(mainWindow, windowManager) {
  const selectorsPath = path.join(__dirname, '..', 'automation', 'selectors.json');
  const selectors = JSON.parse(fs.readFileSync(selectorsPath, 'utf-8'));

  if (loginPollInterval) {
    clearInterval(loginPollInterval);
  }

  loginPollInterval = setInterval(async () => {
    const views = windowManager.getAllViews();
    const status = {};

    for (const name of AI_NAMES) {
      if (!views[name] || !views[name].webContents) {
        status[name] = false;
        continue;
      }

      const inputSels = selectors[name].inputSelectors;
      const selectorChecks = inputSels.map(s => JSON.stringify(s)).join(', ');

      try {
        status[name] = await views[name].webContents.executeJavaScript(
          `(function() {
            var sels = [${selectorChecks}];
            for (var i = 0; i < sels.length; i++) {
              if (document.querySelector(sels[i])) return true;
            }
            return false;
          })()`
        );
      } catch (e) {
        status[name] = false;
      }
    }

    windowManager.uiView.webContents.send('council:login-status', status);
  }, 5000);
}

module.exports = { registerIpcHandlers };
