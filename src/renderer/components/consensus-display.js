'use strict';

let areaEl, bodyEl, metaEl;

function init() {
  areaEl = document.getElementById('consensus-area');
  bodyEl = document.getElementById('consensus-body');
  metaEl = document.getElementById('consensus-meta');
}

function show(answer, rounds) {
  bodyEl.textContent = answer;
  metaEl.textContent = `ROUNDS: ${rounds} | TIMESTAMP: ${new Date().toISOString()}`;
  areaEl.classList.add('visible');
}

function hide() {
  areaEl.classList.remove('visible');
  bodyEl.textContent = '';
  metaEl.textContent = '';
}

module.exports = { init, show, hide };
