'use strict';

let inputEl, sendBtn, abortBtn, statusEl, promptArea;
let busy = false;

function init() {
  inputEl = document.getElementById('prompt-input');
  sendBtn = document.getElementById('btn-send');
  abortBtn = document.getElementById('btn-abort');
  statusEl = document.getElementById('chancellor-status');
  promptArea = document.getElementById('prompt-area');

  sendBtn.addEventListener('click', handleSend);
  abortBtn.addEventListener('click', handleAbort);

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) {
      handleSend();
    }
  });
}

async function handleSend() {
  const prompt = inputEl.value.trim();
  if (!prompt || busy) return;

  busy = true;
  sendBtn.style.display = 'none';
  abortBtn.style.display = 'inline-block';
  inputEl.disabled = true;
  showStatus('.TX TRANSMITTING TO COUNCIL...', 'waiting');

  const result = await window.council.sendPrompt(prompt);

  if (!result.success) {
    showStatus(`NACK: ${result.reason}`, 'error');
  }

  busy = false;
  sendBtn.style.display = 'inline-block';
  abortBtn.style.display = 'none';
  inputEl.disabled = false;
}

async function handleAbort() {
  showStatus('.ABORT SIGNAL SENT', 'error');
  await window.council.abort();
}

function onPhaseChange(phase) {
  const phaseLabels = {
    IDLE: '',
    TRANSMITTING: '.TX IN PROGRESS',
    WAITING: 'WAITING FOR .RX',
    COLLECTING: 'COLLECTING .RX',
    COMBINING: 'COMBINING RESPONSES',
    CONSENSUS: '.RX CONSENSUS ACK',
    TIMEOUT: 'TIMEOUT - NO CONSENSUS',
    ABORTED: 'SESSION ABORTED'
  };

  const statusClass = {
    IDLE: 'info',
    TRANSMITTING: 'waiting',
    WAITING: 'waiting',
    COLLECTING: 'waiting',
    COMBINING: 'waiting',
    CONSENSUS: 'responded',
    TIMEOUT: 'error',
    ABORTED: 'error'
  };

  showStatus(phaseLabels[phase] || phase, statusClass[phase] || 'info');
}

function onConsensus() {
  const level1 = document.getElementById('level-1');
  level1.classList.add('has-consensus');
}

function showStatus(text, type) {
  statusEl.textContent = text;
  statusEl.className = '';
  if (type === 'waiting') statusEl.classList.add('status-waiting');
  else if (type === 'error') statusEl.classList.add('status-error');
  else if (type === 'responded') statusEl.classList.add('status-responded');
  else statusEl.classList.add('status-info');
}

module.exports = { init, onPhaseChange, onConsensus, showStatus };
