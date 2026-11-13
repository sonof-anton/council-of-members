'use strict';

const { ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AI_NAMES } = require('../utils/constants.js');
const ClaudeAdapter = require('../automation/adapters/claude-adapter.js');
const GrokAdapter = require('../automation/adapters/grok-adapter.js');
const GeminiAdapter = require('../automation/adapters/gemini-adapter.js');
const Router = require('../protocol/router.js');
const { getConstitutionSource } = require('../protocol/message-formatter.js');
const { consultOutside } = require('./consult-window.js');

let router = null;
let sessionRunning = false;
let loginPollInterval = null;

const adapterClasses = {
  claude: ClaudeAdapter,
  grok: GrokAdapter,
  gemini: GeminiAdapter
};

function createControllers(windowManager) {
  const views = windowManager.getAllViews();
  const controllers = {};
  for (const name of AI_NAMES) {
    const AdapterClass = adapterClasses[name];
    controllers[name] = new AdapterClass(views[name].webContents);
    controllers[name].revealPanels = () => windowManager.revealPanels();
  }
  return controllers;
}

function registerIpcHandlers(mainWindow, windowManager) {
  // Login polling and mode changes run outside sessions on their own
  // controllers, so they never share callbacks with a running router.
  const idleControllers = createControllers(windowManager);

  function createRouter() {
    const controllers = createControllers(windowManager);

    router = new Router(controllers, { consult: consultOutside });

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

    router.on('member-activity', (data) => {
      windowManager.uiView.webContents.send('council:member-activity', data);
    });

    router.on('consult-status', (data) => {
      windowManager.uiView.webContents.send('council:consult-status', data);
    });

    return router;
  }

  ipcMain.handle('council:send-prompt', async (_event, prompt, files) => {
    if (!prompt || typeof prompt !== 'string') {
      return { success: false, reason: 'Invalid prompt' };
    }
    let filePaths;
    try {
      filePaths = resolveAttachments(files);
    } catch (err) {
      return { success: false, reason: err.message };
    }
    // Two routers would type into the same three tabs at once
    if (sessionRunning) {
      return { success: false, reason: 'A session is already running' };
    }

    sessionRunning = true;
    try {
      const r = createRouter();
      return await r.run(prompt.trim(), { files: filePaths });
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

  ipcMain.handle('council:retry-member', async (_event, name) => {
    if (router && sessionRunning) return router.retryMember(name);
    return { success: false, reason: 'No active session' };
  });

  ipcMain.handle('council:force-member', async (_event, name) => {
    if (router && sessionRunning) return router.forceMember(name);
    return { success: false, reason: 'No active session' };
  });

  ipcMain.handle('council:advance-round', async () => {
    if (router && sessionRunning) {
      return { success: router.advanceRound() };
    }
    return { success: false, reason: 'No active session' };
  });

  ipcMain.handle('council:get-constitution', async () => getConstitutionSource());

  // ===== Modes =====
  // Changing a model mid-session would change who answers between rounds
  function modeGuard(name) {
    if (sessionRunning) throw new Error('Modes can only change between sessions');
    if (name && !idleControllers[name]) throw new Error(`Unknown member: ${name}`);
  }

  ipcMain.handle('council:get-modes', async () => {
    const modes = {};
    for (const name of AI_NAMES) modes[name] = await idleControllers[name].getMode();
    return modes;
  });

  ipcMain.handle('council:list-modes', async (_event, name) => {
    modeGuard(name);
    return idleControllers[name].listModes();
  });

  ipcMain.handle('council:select-mode', async (_event, name, optionText) => {
    modeGuard(name);
    const escaped = String(optionText).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const picked = await idleControllers[name].selectMode([`^${escaped}$`]);
    if (!picked) throw new Error(`${name}: option "${optionText}" not found`);
    return idleControllers[name].getMode();
  });

  // Global FAST / HEAVY buttons: each member's preset from its domain profile
  ipcMain.handle('council:apply-mode-preset', async (_event, preset) => {
    modeGuard();
    const result = {};
    await Promise.all(AI_NAMES.map(async (name) => {
      try {
        result[name] = { mode: await idleControllers[name].applyModePreset(preset) };
      } catch (err) {
        result[name] = { error: err.message, mode: await idleControllers[name].getMode() };
      }
    }));
    return result;
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
  startLoginPolling(windowManager, idleControllers);
}

// Attachments arrive as { name, path } when the file came from disk, or
// { name, dataUrl } when it has no path (e.g. pasted) — those are written to
// a temp file, since the sites' upload inputs only take paths.
function resolveAttachments(files) {
  if (!Array.isArray(files)) return [];
  return files.map((f) => {
    if (f && typeof f.path === 'string' && f.path && fs.existsSync(f.path)) return f.path;
    const m = f && typeof f.dataUrl === 'string' && f.dataUrl.match(/^data:[^,]*;base64,(.*)$/);
    if (!m) throw new Error(`Attachment ${f && f.name} could not be read`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'council-attach-'));
    const file = path.join(dir, path.basename(f.name || 'attachment'));
    fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
    return file;
  });
}

// Every 5s: each member's logged-in state (the domain profile's loggedIn
// marker, not just a prompt box — Grok and Gemini let logged-out visitors
// chat) and its current mode, for the login tab and the mode readouts.
function startLoginPolling(windowManager, controllers) {
  if (loginPollInterval) {
    clearInterval(loginPollInterval);
  }

  const poll = async () => {
    const status = {};
    const modes = {};
    let hidden = false;
    for (const name of AI_NAMES) {
      status[name] = await controllers[name].isLoggedIn().catch(() => false);
      modes[name] = await controllers[name].getMode().catch(() => null);
      hidden = hidden || await controllers[name].isPageHidden();
    }
    // Keep every member page marked visible between sessions too
    if (hidden) await windowManager.revealPanels();
    windowManager.uiView.webContents.send('council:login-status', status);
    windowManager.uiView.webContents.send('council:modes', modes);
  };
  loginPollInterval = setInterval(poll, 5000);
  setTimeout(poll, 1500);
}

module.exports = { registerIpcHandlers };
