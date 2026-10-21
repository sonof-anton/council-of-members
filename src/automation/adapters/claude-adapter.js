'use strict';

const BrowserController = require('../browser-controller.js');
const { log } = require('../../utils/logger.js');

class ClaudeAdapter extends BrowserController {
  constructor(webContents) {
    super('claude', webContents);
  }

  async getResponseCount() {
    // Claude's transcript-row contains both user and assistant messages.
    // Assistant messages contain [role="article"] elements; user messages don't.
    // Using structural detection instead of index-parity (i%2) which breaks if
    // Claude.ai inserts any non-alternating elements (system messages, typing
    // indicators, welcome rows, etc.).
    return this.webContents.executeJavaScript(
      `(function() {` +
      `  var rows = document.querySelectorAll('[data-testid="transcript-row"]');` +
      `  var count = 0;` +
      `  for (var i = 0; i < rows.length; i++) {` +
      `    if (rows[i].querySelector('[role="article"]')) count++;` +
      `  }` +
      `  return count;` +
      `})()`
    ).catch(() => 0);
  }

  async getLastResponseText() {
    // Find the last transcript row that contains [role="article"] (assistant message).
    // Extract text specifically from the .font-claude-response container, which holds
    // the actual response content — excluding toolbar buttons, timestamps, screen
    // reader labels, and citation elements that are siblings outside this container.
    return this.webContents.executeJavaScript(
      `(function() {` +
      `  var rows = document.querySelectorAll('[data-testid="transcript-row"]');` +
      `  var lastAssistant = null;` +
      `  for (var i = 0; i < rows.length; i++) {` +
      `    if (rows[i].querySelector('[role="article"]')) lastAssistant = rows[i];` +
      `  }` +
      `  if (!lastAssistant) return null;` +
      `  var article = lastAssistant.querySelector('[role="article"]');` +
      // Try to extract from the response content container specifically
      `  var responseDiv = article.querySelector('[class*="font-claude-response"]');` +
      `  if (responseDiv) {` +
      `    var clone = responseDiv.cloneNode(true);` +
      // Strip any citation/source elements that may be inside the response
      `    var removes = clone.querySelectorAll('[class*="source"], [class*="citation"], [class*="footnote"], [data-testid*="source"], [data-testid*="citation"]');` +
      `    for (var i = 0; i < removes.length; i++) removes[i].remove();` +
      `    return clone.innerText.trim();` +
      `  }` +
      // Fallback: use the whole article with aggressive stripping
      `  var clone = article.cloneNode(true);` +
      // group/status holds the collapsed thinking summary ("Verifying claims
      // about...") that otherwise gets glued onto the front of "ANSWER:"
      `  var removes = clone.querySelectorAll('button, [role="toolbar"], [data-testid*="action"], time, [class*="timestamp"], [class*="reaction"], [class*="avatar"], [class*="sr-only"], [class*="source"], [class*="citation"], [class*="footnote"], [class*="group/status"]');` +
      `  for (var i = 0; i < removes.length; i++) removes[i].remove();` +
      `  return clone.innerText.trim();` +
      `})()`
    ).catch(() => null);
  }
  async dumpResponseStructure() {
    // Diagnostic: dump the DOM structure of the last assistant response
    // to help debug what elements contain citation/source content
    return this.webContents.executeJavaScript(
      `(function() {` +
      `  var rows = document.querySelectorAll('[data-testid="transcript-row"]');` +
      `  var lastAssistant = null;` +
      `  for (var i = 0; i < rows.length; i++) {` +
      `    if (rows[i].querySelector('[role="article"]')) lastAssistant = rows[i];` +
      `  }` +
      `  if (!lastAssistant) return 'No assistant row found';` +
      `  var article = lastAssistant.querySelector('[role="article"]');` +
      `  function dump(el, depth) {` +
      `    var indent = '  '.repeat(depth);` +
      `    var tag = el.tagName ? el.tagName.toLowerCase() : '#text';` +
      `    var attrs = '';` +
      `    if (el.attributes) {` +
      `      for (var i = 0; i < el.attributes.length && i < 5; i++) {` +
      `        var a = el.attributes[i];` +
      `        if (['class','data-testid','role','href'].includes(a.name)) {` +
      `          attrs += ' ' + a.name + '="' + a.value.substring(0,60) + '"';` +
      `        }` +
      `      }` +
      `    }` +
      `    var text = '';` +
      `    if (el.childNodes && el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {` +
      `      text = ' → "' + el.childNodes[0].textContent.substring(0,50) + '"';` +
      `    }` +
      `    var line = indent + '<' + tag + attrs + '>' + text;` +
      `    var lines = [line];` +
      `    if (el.children && depth < 6) {` +
      `      for (var i = 0; i < el.children.length && i < 30; i++) {` +
      `        lines = lines.concat(dump(el.children[i], depth + 1));` +
      `      }` +
      `    }` +
      `    return lines;` +
      `  }` +
      `  return dump(article, 0).join('\\n');` +
      `})()`
    ).catch((e) => 'Dump error: ' + e.message);
  }
}

module.exports = ClaudeAdapter;
