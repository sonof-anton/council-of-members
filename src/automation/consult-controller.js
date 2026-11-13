'use strict';

const { getProfile, hostOf } = require('./domain-library.js');
const { log } = require('../utils/logger.js');

// Drives a chat page the council doesn't sit at — e.g. a retailer's or a
// manufacturer's website chat — using its domain profile, or the generic
// one when the domain isn't in the library. Website chat widgets usually
// live in a cross-origin iframe, so every frame on the page is searched for
// the prompt entry. The reply is read as the text that appears after the
// question in that frame, which needs no per-site response selector.
class ConsultController {
  constructor(webContents, url) {
    this.webContents = webContents;
    this.url = url;
    this.host = hostOf(url);
    this.profile = getProfile(url);
    this.frame = null;
  }

  activity(text) {
    if (this.onActivity) this.onActivity(text);
  }

  _wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  frames() {
    const main = this.webContents.mainFrame;
    return [main, ...main.framesInSubtree.filter(f => f !== main)];
  }

  _eval(frame, js) {
    return frame.executeJavaScript(js).catch(() => null);
  }

  // Visible, enabled prompt entry in this frame → its selector, else null
  _findEntryScript() {
    return `(function() {` +
      `  var sels = ${JSON.stringify(this.profile.promptEntry.selectors)};` +
      `  for (var i = 0; i < sels.length; i++) {` +
      `    var els = document.querySelectorAll(sels[i]);` +
      `    for (var j = 0; j < els.length; j++) {` +
      `      var r = els[j].getBoundingClientRect();` +
      `      if (r.width > 0 && r.height > 0 && !els[j].disabled && !els[j].readOnly) {` +
      `        document.querySelectorAll('[data-council-entry]').forEach(function(e) { e.removeAttribute('data-council-entry'); });` +
      `        els[j].setAttribute('data-council-entry', '1');` +
      `        return sels[i];` +
      `      }` +
      `    }` +
      `  }` +
      `  return null;` +
      `})()`;
  }

  async findEntry() {
    for (const frame of this.frames()) {
      if (await this._eval(frame, this._findEntryScript())) return frame;
    }
    return null;
  }

  // Many site chats sit behind a "Chat with us" button
  async openLauncher() {
    const sels = this.profile.launcher || [];
    for (const frame of this.frames()) {
      const clicked = await this._eval(frame,
        `(function() {` +
        `  var sels = ${JSON.stringify(sels)};` +
        `  for (var i = 0; i < sels.length; i++) {` +
        `    var el = document.querySelector(sels[i]);` +
        `    if (el && el.getBoundingClientRect().width > 0) { el.click(); return sels[i]; }` +
        `  }` +
        `  var btns = document.querySelectorAll('button, [role="button"], a');` +
        `  for (var k = 0; k < btns.length; k++) {` +
        `    var t = (btns[k].innerText || btns[k].getAttribute('aria-label') || '').trim();` +
        `    if (t.length < 40 && /\\b(chat|ask|message us|assistant|help me)\\b/i.test(t) && btns[k].getBoundingClientRect().width > 0) {` +
        `      btns[k].click(); return t;` +
        `    }` +
        `  }` +
        `  return null;` +
        `})()`);
      if (clicked) {
        log('info', `consult ${this.host}: opened chat launcher (${clicked})`);
        return true;
      }
    }
    return false;
  }

  async waitForEntry(timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    let launcherTried = 0;
    const started = Date.now();
    while (Date.now() < deadline) {
      const frame = await this.findEntry();
      if (frame) return frame;
      const elapsed = Date.now() - started;
      if ((launcherTried === 0 && elapsed > 3000) || (launcherTried === 1 && elapsed > 12000)) {
        launcherTried++;
        this.activity('Opening the site\'s chat');
        await this.openLauncher();
      }
      this.activity(`Looking for the chat's prompt entry (${Math.round(elapsed / 1000)}s)`);
      await this._wait(1000);
    }
    throw new Error(`consult ${this.host}: no chat prompt entry found`);
  }

  _bodyText(frame) {
    return this._eval(frame, `(document.body && document.body.innerText) || ''`).then(t => t || '');
  }

  _entryText() {
    return this._eval(this.frame,
      `(function() { var el = document.querySelector('[data-council-entry]');` +
      `  return el ? (el.isContentEditable ? el.innerText : el.value || '').trim() : ''; })()`).then(t => t || '');
  }

  async send(question) {
    this.frame = await this.waitForEntry();
    this.activity('Typing the question');
    // Type from inside the frame: keyboard input from outside doesn't reach
    // an entry in a cross-origin chat iframe. The native value setter keeps
    // React-style inputs in sync; execCommand fires real input events.
    await this._eval(this.frame,
      `(function(q) {` +
      `  var el = document.querySelector('[data-council-entry]'); if (!el) return;` +
      `  window.focus(); el.focus(); el.click();` +
      `  if (el.isContentEditable) {` +
      `    document.execCommand('selectAll'); document.execCommand('insertText', false, q);` +
      `  } else {` +
      `    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;` +
      `    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, q);` +
      `    el.dispatchEvent(new Event('input', { bubbles: true }));` +
      `    el.dispatchEvent(new Event('change', { bubbles: true }));` +
      `  }` +
      `})(${JSON.stringify(question)})`);
    await this._wait(300);
    if (!(await this._entryText())) {
      this.webContents.focus();
      this.webContents.insertText(question);
    }
    await this._wait(700);

    this.activity('Sending the question');
    const clicked = await this._eval(this.frame,
      `(function() {` +
      `  var sels = ${JSON.stringify(this.profile.sendButton)};` +
      `  for (var i = 0; i < sels.length; i++) {` +
      `    var els = document.querySelectorAll(sels[i]);` +
      `    for (var j = 0; j < els.length; j++) {` +
      `      if (!els[j].disabled && els[j].getBoundingClientRect().width > 0) { els[j].click(); return true; }` +
      `    }` +
      `  }` +
      `  return false;` +
      `})()`);
    let how = 'send button';
    if (!clicked) {
      // No recognizable send button: Enter submits almost every chat box.
      // Dispatched inside the frame first (reaches cross-origin iframes),
      // then as a real key press if the question is still in the entry.
      how = 'Enter';
      await this._eval(this.frame,
        `(function() { var el = document.querySelector('[data-council-entry]'); if (!el) return;` +
        `  ['keydown', 'keypress', 'keyup'].forEach(function(t) {` +
        `    el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));` +
        `  }); })()`);
      await this._wait(1000);
      if (await this._entryText()) {
        how = 'Enter key press';
        this.webContents.focus();
        this.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        this.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        this.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      }
    }
    log('info', `consult ${this.host}: question sent (${question.length} chars, ${how})`);
  }

  // The reply is whatever text shows up after the question, minus the
  // trailing text that was already below it when it was sent (the widget's
  // send button, footer, "Powered by ..." line).
  static replyAfter(body, question, footer) {
    const flat = (s) => s.replace(/\s+/g, ' ').trim();
    const text = flat(body);
    const head = flat(question).slice(0, 40);
    const at = text.lastIndexOf(head);
    if (at === -1) return null;
    let after = text.slice(at + head.length);
    const rest = flat(question).slice(head.length);
    if (rest && after.startsWith(rest)) after = after.slice(rest.length);
    after = after.trim();
    if (footer) {
      // Longest common trailing text, cut back to a word boundary
      let n = 0;
      while (n < after.length && n < footer.length && after[after.length - 1 - n] === footer[footer.length - 1 - n]) n++;
      let suffix = after.slice(after.length - n);
      // A match that starts mid-word ("...else? Send" vs "... Send") would
      // clip the reply's last word; start the cut at the next space instead
      if (n < after.length && suffix && !suffix.startsWith(' ')) {
        const space = suffix.indexOf(' ');
        suffix = space === -1 ? '' : suffix.slice(space);
      }
      if (suffix.trim().length > 0) after = after.slice(0, after.length - suffix.length).trim();
    }
    return after;
  }

  async waitForReply(question, { timeoutMs, minLength }) {
    const deadline = Date.now() + timeoutMs;
    // Text below the question right after sending is page chrome, not reply
    await this._wait(800);
    const footer = ConsultController.replyAfter(await this._bodyText(this.frame), question, null) || '';
    let last = '';
    let stable = 0;
    while (Date.now() < deadline) {
      await this._wait(1000);
      const reply = ConsultController.replyAfter(await this._bodyText(this.frame), question, footer);
      if (!reply || reply.length < minLength) {
        this.activity('Waiting for the reply');
        continue;
      }
      if (reply === last) {
        stable++;
        this.activity(`Reply settling ${stable}/5 (${reply.length} chars)`);
        if (stable >= 5) return reply;
      } else {
        stable = 0;
        last = reply;
        this.activity(`Reply streaming (${reply.length} chars)`);
      }
    }
    if (last.length >= minLength) return last;
    throw new Error(`consult ${this.host}: no reply within ${Math.round(timeoutMs / 1000)}s`);
  }
}

module.exports = ConsultController;
