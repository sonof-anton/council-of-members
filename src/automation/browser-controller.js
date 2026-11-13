'use strict';

const { getProfile } = require('./domain-library.js');
const { MEMBER_DOMAINS } = require('../utils/constants.js');
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
    if (!MEMBER_DOMAINS[aiName]) throw new Error(`No domain for member: ${aiName}`);
    this.config = getProfile(MEMBER_DOMAINS[aiName]);
  }

  // Fine-grained progress for the Level 2 activity line. `ind` lights one of
  // the member's indicator chips (tx, upload, wait, stream, settle, limit).
  activity(text, ind) {
    if (this.onActivity) this.onActivity(text, ind);
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

  isPageHidden() {
    return this.webContents.executeJavaScript(`document.visibilityState === 'hidden'`).catch(() => false);
  }

  // A hidden page ignores clicks (Gemini's send button) and stalls its
  // rendering; revealPanels (set by ipc-handlers) uncovers it for a moment.
  async ensurePageVisible() {
    if (!this.revealPanels || !(await this.isPageHidden())) return;
    log('warn', `${this.aiName}: page is hidden — uncovering the panels`);
    this.activity('Tab hidden — uncovering it', 'tx');
    await this.revealPanels();
  }

  async sendMessage(text) {
    await this.ensurePageVisible();

    // 1. Give this view OS-level focus
    this.activity('Focusing chat tab', 'tx');
    this.webContents.focus();
    await this._wait(200);

    // 2. Focus the input element
    this.activity('Finding prompt entry', 'tx');
    const selector = await this.findSelector(this.config.promptEntry.selectors);
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
    this.activity(`Typing ${text.length} chars`, 'tx');
    await this.webContents.insertText(text);
    await this._wait(800);

    // 4. Send it
    this.activity('Clicking send', 'tx');
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
    const btnSelector = await this.findSelector(this.config.sendButton);
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
    if (this.config.promptEntry.type === 'textarea') {
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
  // button in uploadMenu; the file is set with the menu open.
  async attachFiles(paths) {
    if (!paths || paths.length === 0) return;
    const dbg = this.webContents.debugger;
    const attachedHere = !dbg.isAttached();
    if (attachedHere) dbg.attach('1.3');
    try {
      const before = await this.countAttachments();
      const markersBefore = await this.countPreviewMarkers();
      const totalBytes = paths.reduce((sum, p) => sum + fs.statSync(p).size, 0);
      log('info', `${this.aiName}: Uploading ${paths.length} file(s), ${(totalBytes / 1e6).toFixed(1)} MB`);
      for (const [i, file] of paths.entries()) {
        this.activity(`Attaching file ${i + 1}/${paths.length}: ${path.basename(file)}`, 'upload');
        let input = await this._findFileInput(dbg, file);
        if (!input && this.config.uploadMenu) {
          input = await this._openMenuAndFindInput(dbg, file);
        }
        try {
          if (!input) throw new Error(`${this.aiName}: no upload input accepts ${path.basename(file)}`);
          await dbg.sendCommand('DOM.setFileInputFiles', { files: [file], objectId: input });
        } finally {
          if (this.config.uploadMenu) await this._closeUploadMenu(dbg);
        }
        log('info', `${this.aiName}: Attached ${path.basename(file)}`);
        await this._wait(500);
      }
      await this.waitForAttachments(before, paths.length, totalBytes, paths.map(p => path.basename(p)), markersBefore);
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

  // The menu may close by itself once a file is chosen, so toggling its
  // button to close it can reopen it instead and throw later files out of
  // step. Open with a click and poll for the input; close with Escape,
  // which never reopens it.
  async _openMenuAndFindInput(dbg, file) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this._clickUploadMenu(dbg);
      for (let i = 0; i < 8; i++) {
        await this._wait(250);
        const input = await this._findFileInput(dbg, file);
        if (input) return input;
      }
      await this._closeUploadMenu(dbg);
    }
    return null;
  }

  async _closeUploadMenu(dbg) {
    for (let i = 0; i < 4; i++) {
      const open = await this.webContents.executeJavaScript(
        `document.querySelectorAll('input[type="file"]').length > 0`
      ).catch(() => false);
      if (!open) return;
      for (const type of ['keyDown', 'keyUp']) {
        await dbg.sendCommand('Input.dispatchKeyEvent', {
          type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27
        }).catch(() => {});
      }
      await this._wait(300);
    }
  }

  async _clickUploadMenu(dbg) {
    const { result } = await dbg.sendCommand('Runtime.evaluate', {
      userGesture: true,
      expression:
        `(function() {` +
        `  var sels = ${JSON.stringify(this.config.uploadMenu)};` +
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
    const sels = this.config.attachments;
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
  // Busy state is either an element (uploadBusy) or chip text
  // such as Grok's "Uploading 37%" (uploadBusyText).
  // Fallback when the chip selector stops matching (Grok changed its markup
  // in Nov 2026 and every upload "never appeared"): count how many of the
  // attached file names are shown on the page.
  async countFileNamesShown(names) {
    if (!names || names.length === 0) return 0;
    return this.webContents.executeJavaScript(
      `(function() {` +
      `  var t = document.body.innerText || '', names = ${JSON.stringify(names)}, n = 0;` +
      `  for (var i = 0; i < names.length; i++) {` +
      `    var stem = names[i].replace(/\\.[^.]+$/, '');` +
      `    if (t.indexOf(names[i]) !== -1 || (stem.length >= 4 && t.indexOf(stem) !== -1)) n++;` +
      `  }` +
      `  return n;` +
      `})()`
    ).catch(() => 0);
  }

  // Last-resort fallback when neither the chip selector nor the file name
  // finds the upload: Grok shows an image upload as a bare thumbnail with
  // no file name. Count preview images (blob:/data: src) and remove-file
  // buttons; a rise after attaching means the file is in the composer.
  async countPreviewMarkers() {
    return this.webContents.executeJavaScript(
      `(function() {` +
      `  var imgs = Array.prototype.filter.call(document.querySelectorAll('img'), function(i) {` +
      `    return /^(blob:|data:)/.test(i.getAttribute('src') || '');` +
      `  }).length;` +
      `  var rm = Array.prototype.filter.call(document.querySelectorAll('button[aria-label]'), function(b) {` +
      `    return /^(remove|delete)\\b/i.test(b.getAttribute('aria-label'));` +
      `  }).length;` +
      `  return Math.max(imgs, rm);` +
      `})()`
    ).catch(() => 0);
  }

  async waitForAttachments(before, count, totalBytes = 0, names = [], markersBefore = null) {
    const timeoutMs = Math.min(60000 + (totalBytes / 1e6) * 10000, 15 * 60000);
    const deadline = Date.now() + timeoutMs;
    this.activity('Waiting for upload to finish', 'upload');
    let byName = false;
    if (this.config.attachments) {
      while ((await this.countAttachments()) < before + count) {
        if (this.forceProceed) { log('warn', `${this.aiName}: upload wait forced by Chancellor`); return; }
        if (names.length > 0 && (await this.countFileNamesShown(names)) >= names.length) {
          log('warn', `${this.aiName}: attachment chips not matched by selector — detected uploads by file name`);
          byName = true;
          break;
        }
        if (markersBefore !== null && (await this.countPreviewMarkers()) >= markersBefore + count) {
          log('warn', `${this.aiName}: attachment chips not matched by selector — detected uploads by preview thumbnail`);
          byName = true;
          break;
        }
        if (Date.now() > deadline) throw new Error(`${this.aiName}: attachment never appeared in the composer`);
        await this._wait(500);
      }
    }
    // The configured busy check rides on the same (stale) chip selector, so
    // also watch for a generic "Uploading 37%" anywhere on the page.
    if (byName) {
      await this._wait(1500);
      while (await this.webContents.executeJavaScript(
        `/Uploading\\s*\\d+\\s*%|Uploading\\.\\.\\./i.test(document.body.innerText || '')`
      ).catch(() => false)) {
        if (this.forceProceed) return;
        if (Date.now() > deadline) throw new Error(`${this.aiName}: attachment upload did not finish`);
        await this._wait(500);
      }
    }
    const busy = this.config.uploadBusy || [];
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
      if (!uploading || this.forceProceed) break;
      if (Date.now() > deadline) throw new Error(`${this.aiName}: attachment upload did not finish`);
      await this._wait(500);
    }
  }

  // Logged in = the profile's loggedIn marker (account menu / avatar) is on
  // the page. The prompt entry alone isn't proof: Grok and Gemini both let
  // a logged-out visitor chat.
  // Grok only renders its account button while the side menu is open, so a
  // profile can also list loggedOutText: with the prompt entry on the page
  // and no visible button/link reading e.g. "Sign in", it counts as logged in.
  async isLoggedIn() {
    const sels = this.config.loggedIn || [];
    const outText = this.config.loggedOutText || null;
    if (sels.length === 0 && !outText) return true;
    const promptSels = (this.config.promptEntry && this.config.promptEntry.selectors) || [];
    return this.webContents.executeJavaScript(
      `(function() {` +
      `  if (${JSON.stringify(sels)}.some(function(s) { return !!document.querySelector(s); })) return true;` +
      `  var out = ${JSON.stringify(outText)};` +
      `  if (!out) return false;` +
      `  if (!${JSON.stringify(promptSels)}.some(function(s) { return !!document.querySelector(s); })) return false;` +
      `  var re = new RegExp(out, 'i');` +
      `  var els = document.querySelectorAll('button, a, [role="button"]');` +
      `  for (var i = 0; i < els.length; i++) {` +
      `    var el = els[i];` +
      `    if (!el.offsetParent && el.getClientRects().length === 0) continue;` +
      `    if (re.test((el.innerText || el.getAttribute('aria-label') || '').trim())) return false;` +
      `  }` +
      `  return true;` +
      `})()`
    ).catch(() => false);
  }

  // Returns the matched notice when text reads like the site's usage-limit
  // message, else null.
  matchUsageLimit(text) {
    if (!text) return null;
    for (const p of this.config.usageLimit) {
      const m = text.match(new RegExp(`[^\\n]{0,120}${p}[^\\n]{0,120}`, 'i'));
      if (m) return m[0].trim();
    }
    return null;
  }

  // Look for a usage-limit notice in the page's banners, toasts and dialogs.
  // Text inside members' answers is skipped: an answer about rate limits is
  // not the site refusing to answer.
  async detectUsageLimit() {
    const notice = await this.webContents.executeJavaScript(
      `(function() {` +
      `  var pats = ${JSON.stringify(this.config.usageLimit)}.map(function(p) { return new RegExp(p, 'i'); });` +
      `  var resp = ${JSON.stringify((this.config.response || []).join(', ') || null)};` +
      `  var els = document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"], [aria-live], [data-testid*="limit" i], [class*="limit" i], [class*="banner" i], [class*="toast" i], [class*="error" i], [class*="warning" i], [class*="upsell" i]');` +
      `  for (var i = 0; i < els.length; i++) {` +
      `    var el = els[i];` +
      `    if (resp && el.closest(resp)) continue;` +
      `    var t = (el.innerText || '').trim();` +
      `    if (!t || t.length > 600) continue;` +
      `    for (var j = 0; j < pats.length; j++) if (pats[j].test(t)) return t.replace(/\\s+/g, ' ').slice(0, 200);` +
      `  }` +
      `  return null;` +
      `})()`
    ).catch(() => null);
    return notice || null;
  }

  // ===== Modes (model / effort pickers) =====

  async getMode() {
    const picker = this.config.modes && this.config.modes.picker;
    if (!picker) return null;
    return this.webContents.executeJavaScript(
      `(function() {` +
      `  var sels = ${JSON.stringify(picker)};` +
      `  for (var i = 0; i < sels.length; i++) {` +
      `    var el = document.querySelector(sels[i]);` +
      // A narrow panel can hide the button's text; the aria-label then
      // reads "Model: Expert" / "Open mode picker, currently Gemini Flash"
      `    if (el) return (el.innerText || el.getAttribute('aria-label') || '').replace(/[\\uE000-\\uF8FF]/g, '').replace(/\\s+/g, ' ').trim()` +
      `      .replace(/^(?:Model:|Open mode picker, currently)\\s*/i, '');` +
      `  }` +
      `  return null;` +
      `})()`
    ).catch(() => null);
  }

  // Opens the picker; a plain click works on all three sites, pointer
  // events are the fallback for menus that only open on pointerdown.
  async _openModePicker() {
    await this.ensurePageVisible();
    const { picker, options } = this.config.modes;
    const script = (pointer) =>
      `(function() {` +
      `  var sels = ${JSON.stringify(picker)}, el = null;` +
      `  for (var i = 0; i < sels.length && !el; i++) el = document.querySelector(sels[i]);` +
      `  if (!el) return false;` +
      (pointer
        ? `  ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(function(t) {` +
          `    el.dispatchEvent(new (t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent)(t, { bubbles: true, button: 0, pointerType: 'mouse' }));` +
          `  });`
        : `  el.click();`) +
      `  return true;` +
      `})()`;
    for (const pointer of [false, true]) {
      const found = await this.webContents.executeJavaScript(script(pointer)).catch(() => false);
      if (!found) return false;
      // Options exist before the open animation renders them, and
      // innerText of an unrendered item is empty — wait for visible text
      for (let i = 0; i < 10; i++) {
        await this._wait(200);
        const ready = await this.webContents.executeJavaScript(
          `Array.from(document.querySelectorAll(${JSON.stringify(options)})).some(function(el) {` +
          `  return (el.innerText || '').trim().length > 0;` +
          `})`
        ).catch(() => false);
        if (ready) {
          await this._wait(200);
          return true;
        }
      }
    }
    return false;
  }

  async _closeModePicker() {
    const { options } = this.config.modes;
    for (let i = 0; i < 3; i++) {
      const open = await this.webContents.executeJavaScript(
        `document.querySelectorAll(${JSON.stringify(options)}).length > 0`
      ).catch(() => false);
      if (!open) return;
      this.webContents.focus();
      this.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      this.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await this._wait(300);
    }
  }

  _readModeOptions() {
    return this.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll(${JSON.stringify(this.config.modes.options)})).map(function(el) {` +
      `  return {` +
      // Icon-font glyphs (private-use code points) ride along in innerText
      `    text: (el.innerText || '').replace(/[\\uE000-\\uF8FF]/g, '').replace(/\\s+/g, ' ').trim(),` +
      `    checked: el.getAttribute('aria-checked') === 'true',` +
      `    disabled: el.getAttribute('aria-disabled') === 'true'` +
      `  };` +
      `}).filter(function(o) { return o.text; })`
    ).catch(() => []);
  }

  async listModes() {
    if (!this.config.modes) return [];
    if (!(await this._openModePicker())) return [];
    try {
      return await this._readModeOptions();
    } finally {
      await this._closeModePicker();
    }
  }

  // Pick the first option matching any of `patterns` (tried in order, so
  // later ones are fallbacks). Returns the picked option's text, or null.
  async selectMode(patterns) {
    if (!this.config.modes) return null;
    if (!(await this._openModePicker())) return null;
    try {
      const picked = await this.webContents.executeJavaScript(
        `(function() {` +
        `  var pats = ${JSON.stringify(patterns)};` +
        `  var els = Array.from(document.querySelectorAll(${JSON.stringify(this.config.modes.options)}));` +
        `  for (var p = 0; p < pats.length; p++) {` +
        `    var re = new RegExp(pats[p]);` +
        `    for (var i = 0; i < els.length; i++) {` +
        `      var t = (els[i].innerText || '').replace(/[\\uE000-\\uF8FF]/g, '').replace(/\\s+/g, ' ').trim();` +
        `      if (els[i].getAttribute('aria-disabled') === 'true' || !re.test(t)) continue;` +
        `      els[i].click();` +
        `      return t;` +
        `    }` +
        `  }` +
        `  return null;` +
        `})()`
      ).catch(() => null);
      if (!picked) {
        const seen = await this._readModeOptions();
        log('warn', `${this.aiName}: no mode option matched ${JSON.stringify(patterns)}; options: ${JSON.stringify(seen.map(o => o.text))}`);
      }
      await this._wait(600);
      return picked;
    } finally {
      await this._closeModePicker();
    }
  }

  // Global presets ('fast' / 'heavy') from the domain profile; each step is
  // a separate pick (Claude's model and effort live in one menu).
  async applyModePreset(preset) {
    const steps = this.config.modes && this.config.modes.presets && this.config.modes.presets[preset];
    if (!steps) return null;
    for (const patterns of steps) {
      const picked = await this.selectMode(patterns);
      if (!picked) throw new Error(`${this.aiName}: no ${preset} mode option matched`);
    }
    return this.getMode();
  }

  async getLastResponseText() {
    const selector = await this.findSelector(this.config.response);
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
    const selector = await this.findSelector(this.config.response);
    if (!selector) return 0;

    return this.webContents.executeJavaScript(
      `document.querySelectorAll(${this._safeStringify(selector)}).length`
    ).catch(() => 0);
  }
}

module.exports = BrowserController;
