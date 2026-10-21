'use strict';

const BrowserController = require('../browser-controller.js');
const { log } = require('../../utils/logger.js');

class GeminiAdapter extends BrowserController {
  // Mirrors dom-monitor's MIN_RESPONSE_LENGTH — below this, a primary-selector
  // match is treated as possibly-a-stub and worth double-checking via the
  // deep scan rather than trusted outright.
  static MIN_TRUSTED_LENGTH = 500;

  constructor(webContents) {
    super('gemini', webContents);
    this._bodyTextAtSend = null; // snapshot of body text when message was sent
  }

  async getResponseCount() {
    // Try configured selectors first (top-level DOM)
    const count = await super.getResponseCount();
    if (count > 0) return count;

    // Fallback: scan top-level and iframes for response elements
    return this.webContents.executeJavaScript(
      `(function() {` +
      `  var selectors = ['model-response', 'message-content', '.model-response-text',` +
      `    '[data-message-id]', '.response-container',` +
      `    '[class*="response"]', '[class*="message"][class*="model"]',` +
      `    '[class*="assistant"]', 'turn-content'];` +
      `  function searchDoc(doc) {` +
      `    for (var s = 0; s < selectors.length; s++) {` +
      `      try {` +
      `        var els = doc.querySelectorAll(selectors[s]);` +
      `        if (els.length > 0) return els.length;` +
      `      } catch(e) {}` +
      `    }` +
      `    return 0;` +
      `  }` +
      `  var total = searchDoc(document);` +
      `  if (total > 0) return total;` +
      `  /* Search inside iframes */` +
      `  var iframes = document.querySelectorAll('iframe');` +
      `  for (var i = 0; i < iframes.length; i++) {` +
      `    try {` +
      `      var doc = iframes[i].contentDocument || iframes[i].contentWindow.document;` +
      `      if (doc) { total += searchDoc(doc); if (total > 0) return total; }` +
      `    } catch(e) {}` +
      `  }` +
      `  /* Shadow DOM scan */` +
      `  function deepCount(root) {` +
      `    var c = 0;` +
      `    var children = root.querySelectorAll('*');` +
      `    for (var j = 0; j < children.length; j++) {` +
      `      var el = children[j];` +
      `      var tag = el.tagName.toLowerCase();` +
      `      if (tag === 'model-response' || tag === 'message-content') c++;` +
      `      if (el.shadowRoot) c += deepCount(el.shadowRoot);` +
      `    }` +
      `    return c;` +
      `  }` +
      `  return deepCount(document);` +
      `})()`
    ).catch(() => 0);
  }

  async getLastResponseText() {
    // Try configured selectors first
    const text = await super.getLastResponseText();

    // Gemini's DOM sometimes matches `.model-response-text` (or similar) on
    // an accessibility node — e.g. a visually-hidden "Gemini said" label —
    // whose innerText never grows past a few characters while the real
    // streamed answer lives elsewhere (often behind a shadow root). Trusting
    // any non-empty match caused getLastResponseText to return that stub
    // for the entire generation instead of finding the real content. Only
    // skip the deep scan once the primary match looks like an actual answer.
    if (text && text.length >= GeminiAdapter.MIN_TRUSTED_LENGTH) return text;

    const deep = await this._deepScanResponseText();
    if (deep && (!text || deep.length > text.length)) return deep;
    return text;
  }

  // Shadow DOM / iframe scan for the response text — separated out so
  // getLastResponseText() can run it whenever the primary selector match
  // looks incomplete, not only when it found nothing at all.
  async _deepScanResponseText() {
    return this.webContents.executeJavaScript(
      `(function() {` +
      `  var selectors = ['model-response', 'message-content', '.model-response-text',` +
      `    '[data-message-id]', '.response-container',` +
      `    '[class*="response"]', '[class*="message"][class*="model"]',` +
      `    '[class*="assistant"]', 'turn-content'];` +
      `  function searchDoc(doc) {` +
      `    for (var s = 0; s < selectors.length; s++) {` +
      `      try {` +
      `        var els = doc.querySelectorAll(selectors[s]);` +
      `        if (els.length > 0) {` +
      `          var last = els[els.length - 1];` +
      `          var t = last.innerText || last.textContent;` +
      `          if (t && t.trim().length > 0) return t.trim();` +
      `        }` +
      `      } catch(e) {}` +
      `    }` +
      `    return null;` +
      `  }` +
      `  var result = searchDoc(document);` +
      `  if (result) return result;` +
      `  /* Search inside iframes */` +
      `  var iframes = document.querySelectorAll('iframe');` +
      `  for (var i = 0; i < iframes.length; i++) {` +
      `    try {` +
      `      var doc = iframes[i].contentDocument || iframes[i].contentWindow.document;` +
      `      if (doc) { result = searchDoc(doc); if (result) return result; }` +
      `    } catch(e) {}` +
      `  }` +
      `  /* Shadow DOM scan */` +
      `  function deepFind(root) {` +
      `    var found = [];` +
      `    var children = root.querySelectorAll('*');` +
      `    for (var j = 0; j < children.length; j++) {` +
      `      var el = children[j];` +
      `      var tag = el.tagName.toLowerCase();` +
      `      if (tag === 'model-response' || tag === 'message-content') {` +
      `        var t = el.innerText || el.textContent || '';` +
      `        if (t.trim().length > 0) found.push(el);` +
      `      }` +
      `      if (el.shadowRoot) found = found.concat(deepFind(el.shadowRoot));` +
      `    }` +
      `    return found;` +
      `  }` +
      `  var all = deepFind(document);` +
      `  if (all.length > 0) {` +
      `    var last = all[all.length - 1];` +
      `    return (last.innerText || last.textContent || '').trim();` +
      `  }` +
      `  return null;` +
      `})()`
    ).catch(() => null);
  }

  /**
   * Snapshot the body text length right after sending, so we can detect
   * when new content appears even if response element selectors fail.
   */
  async snapshotBodyText() {
    this._bodyTextAtSend = await this.webContents.executeJavaScript(
      `(document.body.innerText || '').length`
    ).catch(() => 0);
    log('info', `gemini: Body text snapshot = ${this._bodyTextAtSend} chars`);
  }

  /**
   * Fallback response detection: if the body text has grown significantly
   * since we sent our message, extract the new text.
   */
  async getBodyTextResponse() {
    if (this._bodyTextAtSend === null) return null;
    return this.webContents.executeJavaScript(
      `(function() {` +
      `  var bodyText = document.body.innerText || '';` +
      `  return { len: bodyText.length, text: bodyText };` +
      `})()`
    ).catch(() => null);
  }

  // Diagnostic: dump DOM structure including iframes and shadow DOM
  async dumpResponseStructure() {
    return this.webContents.executeJavaScript(
      `(function() {` +
      `  var info = [];` +
      `  /* Top-level tag census */` +
      `  var tags = {};` +
      `  var customEls = [];` +
      `  var all = document.querySelectorAll('*');` +
      `  for (var i = 0; i < all.length; i++) {` +
      `    var tag = all[i].tagName.toLowerCase();` +
      `    tags[tag] = (tags[tag] || 0) + 1;` +
      `    if (tag.includes('-') && customEls.indexOf(tag) === -1) customEls.push(tag);` +
      `    if (all[i].shadowRoot) info.push('[shadowHost] ' + tag);` +
      `  }` +
      `  info.push('iframes: ' + document.querySelectorAll('iframe').length);` +
      `  info.push('custom elements: ' + customEls.join(', '));` +
      `  info.push('body text length: ' + (document.body.innerText || '').length);` +
      `  info.push('body text preview: ' + (document.body.innerText || '').substring(0, 300));` +
      `  /* Check iframes */` +
      `  var iframes = document.querySelectorAll('iframe');` +
      `  for (var f = 0; f < iframes.length; f++) {` +
      `    try {` +
      `      var fdoc = iframes[f].contentDocument;` +
      `      if (fdoc) {` +
      `        var ftext = (fdoc.body.innerText || '').length;` +
      `        info.push('[iframe ' + f + '] src=' + (iframes[f].src || '').substring(0, 80) + ' bodyLen=' + ftext);` +
      `      }` +
      `    } catch(e) { info.push('[iframe ' + f + '] cross-origin, cannot access'); }` +
      `  }` +
      `  return info.join('\\n');` +
      `})()`
    ).catch(() => 'DOM dump failed');
  }

  async sendMessage(text) {
    // 1. Focus
    this.webContents.focus();
    await this._wait(500);

    // 2. Find and prepare input — wait for it to be ready (Gemini can be slow between rounds)
    let selector = null;
    for (let retry = 0; retry < 3; retry++) {
      selector = await this.findSelector(this.config.inputSelectors);
      if (selector) break;
      log('warn', `gemini: Input not found, retrying (${retry + 1}/3)`);
      await this._wait(1000);
    }
    if (!selector) throw new Error('gemini: No input element found');

    // 3. Focus, click, and clear the input
    await this.webContents.executeJavaScript(
      `(function() {` +
      `  var el = document.querySelector(${this._safeStringify(selector)});` +
      `  el.focus();` +
      `  el.click();` +
      `  if (el.innerText && el.innerText.trim().length > 0) {` +
      `    document.execCommand('selectAll');` +
      `    document.execCommand('delete');` +
      `  }` +
      `})()`
    );
    await this._wait(500);

    // 4. Insert text at Chromium level
    await this.webContents.insertText(text);
    await this._wait(500);

    // 5. Poke via execCommand as belt-and-suspenders for Quill
    await this.webContents.executeJavaScript(
      `(function() {` +
      `  var el = document.querySelector(${this._safeStringify(selector)});` +
      `  if (!el) return;` +
      `  el.focus();` +
      `  document.execCommand('insertText', false, ' ');` +
      `})()`
    ).catch(() => {});
    await this._wait(1000);

    // 6. Send — with extra retries for Gemini's slow button enable
    await this.geminiSubmit();

    // 7. Snapshot body text for fallback response detection
    await this.snapshotBodyText();

    log('info', `gemini: Message sent (${text.length} chars)`);
  }

  // A DOM-level btn.click() can report success (fires the handler, returns
  // true) without Gemini actually starting a response — observed with very
  // long prompts, where the auto-growing input pushes the send button
  // outside the visible viewport. Confirm a real turn actually started
  // (a user-query element appears) rather than trusting the click alone.
  async verifySubmitted() {
    return this.webContents.executeJavaScript(
      `document.querySelectorAll('user-query').length > 0`
    ).catch(() => false);
  }

  // Fallback for when the button exists and isn't disabled but a plain
  // .click() didn't result in a real submission — dispatch a real,
  // coordinate-based mouse click instead, after scrolling the button into
  // view. This is the click a real user would make, which matters if
  // Angular's submit handling (or some visibility guard) behaves
  // differently for an off-screen element than element.click() does.
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
      log('warn', `gemini: send button off-screen even after scrollIntoView (y=${rect && rect.y}, viewport=${rect && rect.vh})`);
      return false;
    }
    this.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
    this.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await this._wait(50);
    this.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    return true;
  }

  async geminiSubmit() {
    // Try up to 4 times with increasing waits for the send button to appear
    const waits = [500, 1000, 1500, 2000];

    for (let attempt = 0; attempt < waits.length; attempt++) {
      await this._wait(waits[attempt]);

      const btnSelector = await this.findSelector(this.config.sendSelectors);
      if (btnSelector) {
        const clicked = await this.webContents.executeJavaScript(
          `(function() {` +
          `  var btn = document.querySelector(${this._safeStringify(btnSelector)});` +
          `  if (btn && !btn.disabled) { btn.click(); return true; }` +
          `  return false;` +
          `})()`
        ).catch(() => false);

        if (clicked) {
          await this._wait(800);
          if (await this.verifySubmitted()) {
            log('info', `gemini: Clicked send button (attempt ${attempt + 1})`);
            return;
          }
          log('warn', `gemini: .click() fired but no user-query appeared — trying a real mouse click`);
          if (await this.realClickSubmit(btnSelector)) {
            await this._wait(800);
            if (await this.verifySubmitted()) {
              log('info', `gemini: Real mouse click confirmed submission (attempt ${attempt + 1})`);
              return;
            }
          }
        }
      }

      // Also scan all buttons
      const scanned = await this.webContents.executeJavaScript(
        `(function() {` +
        `  var btns = document.querySelectorAll('button');` +
        `  for (var i = 0; i < btns.length; i++) {` +
        `    var b = btns[i];` +
        `    var label = (b.getAttribute('aria-label') || '').toLowerCase();` +
        `    if ((label.includes('send') || label.includes('submit')) && !b.disabled) {` +
        `      b.click(); return label;` +
        `    }` +
        `  }` +
        `  return false;` +
        `})()`
      ).catch(() => false);

      if (scanned) {
        log('info', `gemini: Clicked send via scan (attempt ${attempt + 1}): ${scanned}`);
        return;
      }

      log('warn', `gemini: Send button not found (attempt ${attempt + 1}/${waits.length})`);

      // The button existing-but-disabled usually means Angular's change
      // detection never registered the pasted text (a paste/insertText race),
      // not that the button is slow to appear — waiting longer alone won't
      // fix that. Re-poke the input so it gets another chance, same recovery
      // grok's submit loop already relies on.
      if (attempt < waits.length - 1) {
        const selector = await this.findSelector(this.config.inputSelectors);
        if (selector) {
          await this.webContents.executeJavaScript(
            `(function() {` +
            `  var el = document.querySelector(${this._safeStringify(selector)});` +
            `  if (!el) return;` +
            `  el.focus();` +
            `  document.execCommand('insertText', false, ' ');` +
            `  el.dispatchEvent(new Event('input', { bubbles: true }));` +
            `  el.dispatchEvent(new Event('change', { bubbles: true }));` +
            `})()`
          ).catch(() => {});
        }
      }
    }

    throw new Error('gemini: Send button not available after 4 attempts');
  }
}

module.exports = GeminiAdapter;
