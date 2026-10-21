'use strict';

// Diagnostic script: dumps DOM info from each AI site to help find correct selectors
// Run with: npx electron src/main/diagnose.js

const { app, BrowserWindow, WebContentsView } = require('electron');
const path = require('path');
const { AI_NAMES, AI_URLS } = require('../utils/constants.js');
const { getSession } = require('./session-manager.js');

async function diagnose() {
  const win = new BrowserWindow({ width: 1400, height: 900, show: false });

  for (const name of AI_NAMES) {
    console.log(`\n========== ${name.toUpperCase()} ==========`);
    console.log(`URL: ${AI_URLS[name]}`);

    const view = new WebContentsView({
      webPreferences: {
        session: getSession(name),
        contextIsolation: true,
        sandbox: true
      }
    });

    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1400, height: 900 });

    try {
      await view.webContents.loadURL(AI_URLS[name]);
    } catch (e) {
      console.log('Load error (may be redirect):', e.message);
      // Wait for redirect to finish
    }
    // Wait for page JS to settle
    await new Promise(resolve => setTimeout(resolve, 8000));
    console.log('Final URL:', view.webContents.getURL());

    // Dump all contenteditable elements
    const editables = await view.webContents.executeJavaScript(`
      (function() {
        var els = document.querySelectorAll('[contenteditable="true"]');
        var result = [];
        els.forEach(function(el) {
          result.push({
            tag: el.tagName,
            classes: el.className,
            role: el.getAttribute('role'),
            ariaLabel: el.getAttribute('aria-label'),
            id: el.id,
            placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder')
          });
        });
        return result;
      })()
    `).catch(() => []);
    console.log('Contenteditable elements:', JSON.stringify(editables, null, 2));

    // Dump all textareas
    const textareas = await view.webContents.executeJavaScript(`
      (function() {
        var els = document.querySelectorAll('textarea');
        var result = [];
        els.forEach(function(el) {
          result.push({
            classes: el.className,
            placeholder: el.placeholder,
            ariaLabel: el.getAttribute('aria-label'),
            id: el.id
          });
        });
        return result;
      })()
    `).catch(() => []);
    console.log('Textareas:', JSON.stringify(textareas, null, 2));

    // Dump all buttons with send-related labels
    const buttons = await view.webContents.executeJavaScript(`
      (function() {
        var btns = document.querySelectorAll('button');
        var result = [];
        btns.forEach(function(btn) {
          var label = btn.getAttribute('aria-label') || '';
          var text = btn.textContent.trim().substring(0, 50);
          var testId = btn.getAttribute('data-testid') || '';
          if (label.toLowerCase().includes('send') || text.toLowerCase().includes('send') ||
              testId.toLowerCase().includes('send') || label.toLowerCase().includes('submit')) {
            result.push({
              ariaLabel: label,
              text: text,
              testId: testId,
              classes: btn.className.substring(0, 100),
              disabled: btn.disabled,
              type: btn.type
            });
          }
        });
        return result;
      })()
    `).catch(() => []);
    console.log('Send-related buttons:', JSON.stringify(buttons, null, 2));

    // Dump potential response containers
    const responses = await view.webContents.executeJavaScript(`
      (function() {
        var selectors = [
          '[data-testid*="message"]', '[data-testid*="response"]',
          '[class*="message"]', '[class*="response"]', '[class*="assistant"]',
          '[class*="claude"]', '[class*="bubble"]', '[class*="reply"]',
          'message-content', '.model-response-text'
        ];
        var result = {};
        selectors.forEach(function(sel) {
          try {
            var count = document.querySelectorAll(sel).length;
            if (count > 0) result[sel] = count;
          } catch(e) {}
        });
        return result;
      })()
    `).catch(() => ({}));
    console.log('Response element matches:', JSON.stringify(responses, null, 2));

    win.contentView.removeChildView(view);
  }

  app.quit();
}

app.whenReady().then(diagnose);
