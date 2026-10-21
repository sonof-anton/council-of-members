'use strict';

const selectors = require('./selectors.json');
const { log } = require('../utils/logger.js');

class BrowserController {
  constructor(aiName, webContents) {
    this.aiName = aiName;
    this.webContents = webContents;
    this.config = selectors[aiName];
    if (!this.config) throw new Error(`No selectors for AI: ${aiName}`);
  }

  async findSelector(selectorList) {
    for (const sel of selectorList) {
      const found = await this.webContents.executeJavaScript(
        `!!document.querySelector(${JSON.stringify(sel)})`
      ).catch(() => false);
      if (found) return sel;
    }
    return null;
  }

  _safeStringify(text) {
    return JSON.stringify(text);
  }

  _wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async sendMessage(text) {
    // 1. Give this view OS-level focus
    this.webContents.focus();
    await this._wait(200);

    // 2. Focus the input element
    const selector = await this.findSelector(this.config.inputSelectors);
    if (!selector) throw new Error(`${this.aiName}: No input element found`);

    await this.webContents.executeJavaScript(
      `(function() {` +
      `  var el = document.querySelector(${this._safeStringify(selector)});` +
      `  el.focus();` +
      `  el.click();` +
      `})()`
    );
    await this._wait(200);

    // 3. Type the message
    await this.webContents.insertText(text);
    await this._wait(800);

    // 4. Send it
    await this.submitMessage();

    log('info', `${this.aiName}: Message sent (${text.length} chars)`);
  }

  // Default: trust that a click succeeding means the message was actually
  // submitted. Override in an adapter when that's not reliable — observed
  // on both Gemini and Claude under heavy load: element.click() reports
  // success (fires, returns true) with no real conversation turn created,
  // apparently a UI/framework-level race rather than anything the click
  // call itself can detect.
  async verifySubmitted() {
    return true;
  }

  // Fallback for when a plain element.click() didn't actually result in a
  // submission — dispatch a real, coordinate-based mouse click instead
  // (scrolling the button into view first), the way an actual user would.
  async realClickSubmit(btnSelector) {
    const rect = await this.webContents.executeJavaScript(
      `(function() {` +
      `  var btn = document.querySelector(${this._safeStringify(btnSelector)});` +
      `  if (!btn) return null;` +
      `  btn.scrollIntoView({block: 'center'});` +
      `  var r = btn.getBoundingClientRect();` +
      `  return {x: r.left + r.width / 2, y: r.top + r.height / 2, vh: window.innerHeight};` +
      `})()`
    ).catch(() => null);
    if (!rect || rect.y < 0 || rect.y > rect.vh) {
      log('warn', `${this.aiName}: send button off-screen even after scrollIntoView (y=${rect && rect.y}, viewport=${rect && rect.vh})`);
      return false;
    }
    this.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
    this.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await this._wait(50);
    this.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    return true;
  }

  // Click, then confirm it actually landed via verifySubmitted(); if not,
  // fall through to a real coordinate-based click before giving up on this
  // attempt entirely.
  async clickAndVerify(btnSelector, label) {
    const clicked = await this.webContents.executeJavaScript(
      `(function() {` +
      `  var btn = document.querySelector(${this._safeStringify(btnSelector)});` +
      `  if (btn && !btn.disabled) { btn.click(); return true; }` +
      `  return false;` +
      `})()`
    ).catch(() => false);
    if (!clicked) return false;

    await this._wait(800);
    if (await this.verifySubmitted()) {
      log('info', `${this.aiName}: Clicked send button (${label})`);
      return true;
    }

    log('warn', `${this.aiName}: .click() fired (${label}) but nothing was actually submitted — trying a real mouse click`);
    if (await this.realClickSubmit(btnSelector)) {
      await this._wait(800);
      if (await this.verifySubmitted()) {
        log('info', `${this.aiName}: Real mouse click confirmed submission (${label})`);
        return true;
      }
    }
    return false;
  }

  async submitMessage() {
    // Try clicking a send button first
    const btnSelector = await this.findSelector(this.config.sendSelectors);
    if (btnSelector) {
      // Wait for button to enable (sites may need a moment after text input)
      await this._wait(500);
      if (await this.clickAndVerify(btnSelector, 'attempt 1')) return;

      log('warn', `${this.aiName}: Send button disabled, trying harder...`);

      // Try again after a longer wait
      await this._wait(1000);
      if (await this.clickAndVerify(btnSelector, '2nd attempt')) return;
    }

    // Scan ALL buttons for anything send-related
    const scanned = await this.webContents.executeJavaScript(
      `(function() {` +
      `  var btns = document.querySelectorAll('button');` +
      `  for (var i = 0; i < btns.length; i++) {` +
      `    var b = btns[i];` +
      `    var label = (b.getAttribute('aria-label') || '').toLowerCase();` +
      `    var testId = (b.getAttribute('data-testid') || '').toLowerCase();` +
      `    if ((label.includes('send') || label.includes('submit') || testId.includes('send') || testId.includes('submit')) && !b.disabled) {` +
      `      b.click(); return label || testId;` +
      `    }` +
      `  }` +
      `  return false;` +
      `})()`
    ).catch(() => false);

    if (scanned) {
      await this._wait(800);
      if (await this.verifySubmitted()) {
        log('info', `${this.aiName}: Clicked send via scan: ${scanned}`);
        return;
      }
      log('warn', `${this.aiName}: scan-click (${scanned}) fired but nothing was submitted`);
    }

    // Last resort: Enter key — only works for textarea inputs (Grok).
    // For contenteditable (Claude, Gemini), Enter just adds a newline.
    if (this.config.inputType === 'textarea') {
      log('info', `${this.aiName}: No send button, pressing Enter`);
      this.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      await this._wait(50);
      this.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    } else {
      throw new Error(`${this.aiName}: Send button not available`);
    }
  }

  async getLastResponseText() {
    const selector = await this.findSelector(this.config.responseSelectors);
    if (!selector) return null;

    return this.webContents.executeJavaScript(
      `(function() {` +
      `  var els = document.querySelectorAll(${this._safeStringify(selector)});` +
      `  if (els.length === 0) return null;` +
      `  return els[els.length - 1].innerText;` +
      `})()`
    ).catch(() => null);
  }

  async getResponseCount() {
    const selector = await this.findSelector(this.config.responseSelectors);
    if (!selector) return 0;

    return this.webContents.executeJavaScript(
      `document.querySelectorAll(${this._safeStringify(selector)}).length`
    ).catch(() => 0);
  }
}

module.exports = BrowserController;
