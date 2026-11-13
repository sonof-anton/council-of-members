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

    // No user turn yet means no responses — the broad fallback selectors
    // below ([class*="response"] etc.) match page chrome on an empty chat,
    // which set the "before" baseline to 1 and hid the first real response.
    const hasUserTurn = await this.webContents.executeJavaScript(
      `document.querySelectorAll('user-query').length > 0`
    ).catch(() => true);
    if (!hasUserTurn) return 0;

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

  // Gemini's canned failure replies — returned in place of an answer when its
  // backend errors out. Returns the matched message, or null.
  detectSiteError(text) {
    // Wording varies: "I seem to be encountering an error...",
    // "I encountered an error doing what you asked. Could you try again?"
    const m = (text || '').match(/I (?:seem to be )?encounter(?:ed|ing) an error[^\n]*|Something went wrong[^\n]*|I'm having a hard time fulfilling your request[^\n]*/i);
    return m ? m[0].trim() : null;
  }

  async getLastResponseText() {
    // Try configured selectors first
    const text = await this._primaryResponseText();

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

  // Like the base implementation, but strips inline source chips: Gemini
  // renders citations as <sources-carousel-inline>/<source-inline-chip>
  // buttons inside the answer, whose labels ("SSD Nodes", "GitHub", "+ 1")
  // otherwise land mid-sentence in the captured text. Also drops KaTeX's
  // hidden MathML copy of each formula (see BrowserController).
  async _primaryResponseText() {
    const selector = await this.findSelector(this.config.response);
    if (!selector) return null;
    return this.webContents.executeJavaScript(
      `(function() {` +
      `  var els = document.querySelectorAll(${this._safeStringify(selector)});` +
      `  if (els.length === 0) return null;` +
      `  var clone = els[els.length - 1].cloneNode(true);` +
      `  var chips = clone.querySelectorAll('sources-carousel-inline, source-inline-chip, [class*="source-inline-chip"], .katex-mathml');` +
      `  for (var i = 0; i < chips.length; i++) chips[i].remove();` +
      // innerText needs layout; a detached clone falls back to textContent
      // semantics, so attach it off-screen while reading.
      `  clone.style.position = 'fixed'; clone.style.left = '-99999px';` +
      `  document.body.appendChild(clone);` +
      `  var t = clone.innerText;` +
      `  clone.remove();` +
      `  return t;` +
      `})()`
    ).catch(() => null);
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
    // A hidden tab ignores the send click entirely
    await this.ensurePageVisible();

    // 1. Focus
    this.activity('Focusing chat tab', 'tx');
    this.webContents.focus();
    await this._wait(500);

    // 2. Find and prepare input — wait for it to be ready (Gemini can be slow between rounds)
    let selector = null;
    for (let retry = 0; retry < 3; retry++) {
      selector = await this.findSelector(this.config.promptEntry.selectors);
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

    // 4. Insert the whole message in one in-page operation. Chromium-level
    // insertText slowed down as the conversation grew (14k chars took ~76s
    // on a long page), so try a single execCommand first, verify it landed,
    // and only fall back to insertText if it didn't.
    this.activity(`Typing ${text.length} chars`, 'tx');
    const t0 = Date.now();
    const inserted = await this.webContents.executeJavaScript(
      `(function() {` +
      `  var el = document.querySelector(${this._safeStringify(selector)});` +
      `  if (!el) return -1;` +
      `  el.focus();` +
      `  document.execCommand('insertText', false, ${this._safeStringify(text)});` +
      `  return (el.innerText || '').length;` +
      `})()`
    ).catch(() => -1);
    let method = 'execCommand';
    if (inserted < text.length * 0.9) {
      method = 'insertText';
      log('warn', `gemini: single-shot insert gave ${inserted}/${text.length} chars — falling back to insertText`);
      await this.webContents.executeJavaScript(
        `(function() {` +
        `  var el = document.querySelector(${this._safeStringify(selector)});` +
        `  if (!el) return;` +
        `  el.focus();` +
        `  document.execCommand('selectAll');` +
        `  document.execCommand('delete');` +
        `})()`
      ).catch(() => {});
      await this.webContents.insertText(text);
    }
    log('info', `gemini: text entered via ${method} in ${Date.now() - t0}ms (${text.length} chars)`);
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
    this.activity('Clicking send', 'tx');
    const t1 = Date.now();
    await this.geminiSubmit();
    log('info', `gemini: submit took ${Date.now() - t1}ms`);

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
    // A new user-query (vs. the count before this send) or a Stop button
    // means the turn started. Checking for "any user-query" passed instantly
    // from round 2 on, since round 1's query is still on the page.
    const before = this._userQueriesBefore || 0;
    return this.webContents.executeJavaScript(
      `(document.querySelectorAll('user-query').length > ${before}) || ` +
      `!!document.querySelector('button[aria-label*="Stop" i]')`
    ).catch(() => false);
  }

  // Gemini can take well over 800ms to render the new user-query. Clicking
  // again too early lands on the Stop button that replaced Send in the same
  // spot and cancels the response that had in fact started.
  async waitForSubmitted(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.verifySubmitted()) return true;
      await this._wait(250);
    }
    return false;
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
      `  if (document.querySelector('button[aria-label*="Stop" i]')) return {generating: true};` +
      `  var btn = document.querySelector(${this._safeStringify(btnSelector)});` +
      `  if (!btn) return null;` +
      `  btn.scrollIntoView({block: 'center'});` +
      `  var r = btn.getBoundingClientRect();` +
      `  return {x: r.left + r.width / 2, y: r.top + r.height / 2, vh: window.innerHeight};` +
      `})()`
    ).catch(() => null);
    if (rect && rect.generating) {
      // Send already went through — a click here would hit Stop
      log('info', 'gemini: response already generating, skipping real mouse click');
      return true;
    }
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
    this._userQueriesBefore = await this.webContents.executeJavaScript(
      `document.querySelectorAll('user-query').length`
    ).catch(() => 0);

    for (let attempt = 0; attempt < waits.length; attempt++) {
      await this._wait(waits[attempt]);

      const btnSelector = await this.findSelector(this.config.sendButton);
      if (btnSelector) {
        const clicked = await this.webContents.executeJavaScript(
          `(function() {` +
          `  var btn = document.querySelector(${this._safeStringify(btnSelector)});` +
          `  if (btn && !btn.disabled) { btn.click(); return true; }` +
          `  return false;` +
          `})()`
        ).catch(() => false);

        if (clicked) {
          if (await this.waitForSubmitted()) {
            log('info', `gemini: Clicked send button (attempt ${attempt + 1})`);
            return;
          }
          log('warn', `gemini: .click() fired but no user-query appeared — trying a real mouse click`);
          if (await this.realClickSubmit(btnSelector)) {
            if (await this.waitForSubmitted()) {
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
        if (await this.waitForSubmitted()) {
          log('info', `gemini: Clicked send via scan (attempt ${attempt + 1}): ${scanned}`);
          return;
        }
        log('warn', `gemini: scan-click (${scanned}) fired but no user-query appeared (attempt ${attempt + 1})`);
      }

      log('warn', `gemini: Send button not found (attempt ${attempt + 1}/${waits.length})`);
      this.activity(`Send not confirmed, retrying (${attempt + 1}/${waits.length})`, 'tx');

      // The button existing-but-disabled usually means Angular's change
      // detection never registered the pasted text (a paste/insertText race),
      // not that the button is slow to appear — waiting longer alone won't
      // fix that. Re-poke the input so it gets another chance, same recovery
      // grok's submit loop already relies on.
      if (attempt < waits.length - 1) {
        const selector = await this.findSelector(this.config.promptEntry.selectors);
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
