'use strict';

const DomMonitor = require('./dom-monitor.js');
const { END_MARKER } = require('../utils/constants.js');
const { log } = require('../utils/logger.js');

class ResponseExtractor {
  constructor(controller) {
    this.controller = controller;
    this.monitor = new DomMonitor(controller);
  }

  async sendAndWaitForResponse(text) {
    const countBefore = await this.controller.getResponseCount();

    await this.monitor.installMutationObserver();
    await this.controller.sendMessage(text);

    const response = await this.monitor.waitForResponse(countBefore);
    return this.cleanResponse(response);
  }

  cleanResponse(text) {
    if (!text) return '';
    const rawLen = text.length;
    let cleaned = text.trim();

    // Strip member-specific DOM artifacts:
    // Claude.ai: "Claude responded:" label, "Searched the web" prefix, duplicate "ANSWER:"
    cleaned = cleaned.replace(/^Claude responded:\s*/i, '');
    cleaned = cleaned.replace(/^(?:ANSWER:\s*)?Searched the web\s*/i, '');
    // Gemini: "Gemini said" label that sometimes gets captured
    cleaned = cleaned.replace(/^Gemini said\s*/i, '');

    // Strip Claude.ai trailing search citation blocks:
    // These appear at the end of the response as concatenated "TitleText\nurl.com\n" pairs
    // when Claude cites web sources. Only strip from the END to avoid removing
    // legitimate domain mentions in the actual answer text.
    // Match a trailing block of 3+ lines where each line is either a bare URL or short title.
    cleaned = cleaned.replace(/(?:\n[^\n]{0,80}(?:(?:https?:\/\/)?(?:www\.)?[a-z0-9][-a-z0-9]*\.(?:com|org|net|ca|io|co|edu|gov|uk|de|fr|au|us|info|biz))[^\n]*){3,}\s*$/gi, '');

    // Strip trailing UI chrome that gets captured from the DOM:
    // - Timestamp lines like "3 minutes ago", "just now", etc.
    // - Reaction/action button text
    // - Unicode garbage from icon fonts
    cleaned = cleaned.replace(/\n\d+ (minutes?|hours?|seconds?|days?) ago\s*$/i, '');
    cleaned = cleaned.replace(/\njust now\s*$/i, '');
    // Remove trailing lines that are only non-alphanumeric chars (icon font garbage)
    cleaned = cleaned.replace(/(\n[^\w\n]{1,10})+\s*$/, '');
    // Remove trailing timestamp patterns
    cleaned = cleaned.replace(/\n\d+ (minutes?|hours?|seconds?|days?) ago\s*$/i, '');

    // Strip "N sources" lines from Claude.ai web search (can appear trailing or mid-text)
    cleaned = cleaned.replace(/\n\d+ sources?\s*$/i, '');
    cleaned = cleaned.replace(/\n\d+ sources?\s*\n/gi, '\n');

    // Only trim trailing content after END_MARKER if present (marker is optional)
    const endIdx = cleaned.lastIndexOf(END_MARKER);
    if (endIdx !== -1) {
      cleaned = cleaned.substring(0, endIdx).trim();
    }
    cleaned = cleaned.trim();

    // Debug: log when cleaning removes significant content
    if (rawLen > 100 && cleaned.length < rawLen * 0.5) {
      log('warn', `cleanResponse: ${rawLen} chars → ${cleaned.length} chars (${Math.round((1 - cleaned.length / rawLen) * 100)}% removed). Raw preview: ${text.substring(0, 200).replace(/\n/g, '\\n')}`);
    }

    return cleaned;
  }
}

module.exports = ResponseExtractor;
