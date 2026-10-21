'use strict';

const selectors = require('./selectors.json');
const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger.js');

// For matching files against an <input accept="image/*"> style list
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic', '.pdf': 'application/pdf'
};

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

  // Put local files into the composer the way the site's own file picker
  // would: DevTools DOM.setFileInputFiles on its <input type=file>, which
  // fires the input/change events the site listens for. Sites whose inputs
  // only exist while their upload menu is open (Gemini) list the menu
  // button in uploadMenuSelectors; the file is set with the menu open.
  async attachFiles(paths) {
    if (!paths || paths.length === 0) return;
    const dbg = this.webContents.debugger;
    const attachedHere = !dbg.isAttached();
    if (attachedHere) dbg.attach('1.3');
    try {
      const before = await this.countAttachments();
      const totalBytes = paths.reduce((sum, p) => sum + fs.statSync(p).size, 0);
      log('info', `${this.aiName}: Uploading ${paths.length} file(s), ${(totalBytes / 1e6).toFixed(1)} MB`);
      for (const file of paths) {
        let input = await this._findFileInput(dbg, file);
        let menuOpen = false;
        if (!input && this.config.uploadMenuSelectors) {
          menuOpen = await this._clickUploadMenu(dbg);
          await this._wait(1000);
          input = await this._findFileInput(dbg, file);
        }
        try {
          if (!input) throw new Error(`${this.aiName}: no upload input accepts ${path.basename(file)}`);
          await dbg.sendCommand('DOM.setFileInputFiles', { files: [file], objectId: input });
        } finally {
          if (menuOpen) await this._clickUploadMenu(dbg); // the button toggles the menu shut
        }
        log('info', `${this.aiName}: Attached ${path.basename(file)}`);
        await this._wait(500);
      }
      await this.waitForAttachments(before, paths.length, totalBytes);
      log('info', `${this.aiName}: Attachment upload finished`);
    } finally {
      if (attachedHere) {
        try { dbg.detach(); } catch { /* already gone */ }
      }
    }
  }

  // First enabled file input whose accept list takes this file (an empty
  // accept takes anything). Gemini keeps images and documents on separate
  // inputs, and each only handles its own kind.
  async _findFileInput(dbg, file) {
    const ext = path.extname(file).toLowerCase();
    const mime = MIME_BY_EXT[ext] || '';
    const { result } = await dbg.sendCommand('Runtime.evaluate', {
      expression:
        `(function() {` +
        `  var ext = ${JSON.stringify(ext)}, mime = ${JSON.stringify(mime)};` +
        `  var els = document.querySelectorAll('input[type="file"]');` +
        `  for (var i = 0; i < els.length; i++) {` +
        `    if (els[i].disabled) continue;` +
        `    var acc = (els[i].accept || '').toLowerCase().split(',').map(function(a) { return a.trim(); }).filter(Boolean);` +
        `    if (acc.length === 0) return els[i];` +
        `    for (var j = 0; j < acc.length; j++) {` +
        `      var a = acc[j];` +
        `      if (a === ext || a === mime || (a.endsWith('/*') && mime.indexOf(a.slice(0, -1)) === 0)) return els[i];` +
        `    }` +
        `  }` +
        `  return null;` +
        `})()`
    });
    return result && result.objectId ? result.objectId : null;
  }

  async _clickUploadMenu(dbg) {
    const { result } = await dbg.sendCommand('Runtime.evaluate', {
      userGesture: true,
      expression:
        `(function() {` +
        `  var sels = ${JSON.stringify(this.config.uploadMenuSelectors)};` +
        `  for (var i = 0; i < sels.length; i++) {` +
        `    var el = document.querySelector(sels[i]);` +
        `    if (el) { el.click(); return true; }` +
        `  }` +
        `  return false;` +
        `})()`
    });
    return !!(result && result.value);
  }

  async countAttachments() {
    const sels = this.config.attachmentSelectors;
    if (!sels || sels.length === 0) return 0;
    return this.webContents.executeJavaScript(
      `(function() {` +
      `  var sels = ${JSON.stringify(sels)}, n = 0;` +
      `  for (var i = 0; i < sels.length; i++) n = Math.max(n, document.querySelectorAll(sels[i]).length);` +
      `  return n;` +
      `})()`
    ).catch(() => 0);
  }

  // Wait for the attachment chips to appear, then for any upload spinner in
  // them to clear. Sending before the upload finishes either fails or sends
  // the question without the file, and the member answers blind.
  // Large files take minutes: a 29 MB PDF took ~100-130s on every site at
  // ~0.3 MB/s upload, so allow 60s plus 10s per MB (capped at 15 min).
  // Busy state is either an element (uploadBusySelectors) or chip text
  // such as Grok's "Uploading 37%" (uploadBusyText).
  async waitForAttachments(before, count, totalBytes = 0) {
    const timeoutMs = Math.min(60000 + (totalBytes / 1e6) * 10000, 15 * 60000);
    const deadline = Date.now() + timeoutMs;
    if (this.config.attachmentSelectors) {
      while ((await this.countAttachments()) < before + count) {
        if (Date.now() > deadline) throw new Error(`${this.aiName}: attachment never appeared in the composer`);
        await this._wait(500);
      }
    }
    const busy = this.config.uploadBusySelectors || [];
    const busyText = this.config.uploadBusyText || null;
    await this._wait(1500);
    while (busy.length > 0 || busyText) {
      const uploading = await this.webContents.executeJavaScript(
        `(function() {` +
        `  if (${JSON.stringify(busy)}.some(function(s) { return !!document.querySelector(s); })) return true;` +
        `  var bt = ${JSON.stringify(busyText)};` +
        `  if (!bt) return false;` +
        `  var els = document.querySelectorAll(bt.selector);` +
        `  for (var i = 0; i < els.length; i++) if (new RegExp(bt.pattern, 'i').test(els[i].innerText)) return true;` +
        `  return false;` +
        `})()`
      ).catch(() => false);
      if (!uploading) break;
      if (Date.now() > deadline) throw new Error(`${this.aiName}: attachment upload did not finish`);
      await this._wait(500);
    }
  }

  async getLastResponseText() {
    const selector = await this.findSelector(this.config.responseSelectors);
    if (!selector) return null;

    return this.webContents.executeJavaScript(
      `(function() {` +
      `  var els = document.querySelectorAll(${this._safeStringify(selector)});` +
      `  if (els.length === 0) return null;` +
      // KaTeX keeps a visually hidden MathML copy of every formula, which
      // innerText still reads, one token per line. Read a clone without it,
      // attached off-screen since innerText needs layout.
      `  var clone = els[els.length - 1].cloneNode(true);` +
      `  var mathml = clone.querySelectorAll('.katex-mathml');` +
      `  for (var i = 0; i < mathml.length; i++) mathml[i].remove();` +
      `  clone.style.position = 'fixed'; clone.style.left = '-99999px';` +
      `  document.body.appendChild(clone);` +
      `  var t = clone.innerText;` +
      `  clone.remove();` +
      `  return t;` +
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
