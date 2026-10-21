'use strict';

let logEl;

function init() {
  logEl = document.getElementById('message-log');
}

function addEntry(timestamp, source, content) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const ts = timestamp.replace('T', ' ').substring(11, 19);

  entry.innerHTML =
    `<span class="log-timestamp">[${ts}]</span> ` +
    `<span class="log-source">[${source.toUpperCase()}]</span> ` +
    `<span class="log-content">${escapeHtml(content)}</span>`;

  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

module.exports = { init, addEntry };
