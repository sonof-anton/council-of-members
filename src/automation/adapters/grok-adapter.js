'use strict';

const BrowserController = require('../browser-controller.js');

class GrokAdapter extends BrowserController {
  constructor(webContents) {
    super('grok', webContents);
  }

  async getLastResponseText() {
    // Grok includes "thinking" UI text like "Analyzing the sky's color" and
    // "Worked for 2m 57s" in the response element. Strip these.
    const raw = await super.getLastResponseText();
    if (!raw) return null;
    return GrokAdapter.cleanGrokResponse(raw);
  }

  static cleanGrokResponse(text) {
    if (!text) return text;
    let lines = text.split('\n');
    // Remove leading lines that are Grok's thinking/status UI:
    // - Short lines before the actual content (thinking summaries)
    // - "Worked for Xm Ys" or bare "Worked" lines
    // - Gerund-style thinking summaries ("Analyzing...", "Refining...", etc.)
    while (lines.length > 0) {
      const line = lines[0].trim();
      if (!line) { lines.shift(); continue; }
      if (/^Worked/i.test(line) && line.length < 80) { lines.shift(); continue; }
      // Strip any short leading line that starts with a gerund (thinking indicator)
      if (/^[A-Z][a-z]+ing\b/i.test(line) && line.length < 80) { lines.shift(); continue; }
      break;
    }
    return lines.join('\n').trim();
  }

  // sendMessage/submitMessage are inherited from BrowserController unchanged.
  // Grok's input turned out to be the same kind of contenteditable
  // ProseMirror editor Claude and Gemini use (confirmed via live devtools:
  // the actual input is `div.ProseMirror[contenteditable="true"]`, not a
  // `<textarea>` at all — that was the entire bug). The base class's plain
  // insertText() + submitMessage() already handles that correctly for the
  // other two, so all the textarea-specific React-state-poking, chunking,
  // and custom retry logic that used to live here was solving a problem
  // that didn't exist once pointed at the right element, and is removed.
}

module.exports = GrokAdapter;
