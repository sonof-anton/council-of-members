'use strict';

let roundEl, phaseEl;

function init() {
  roundEl = document.getElementById('status-round');
  phaseEl = document.getElementById('status-phase');
}

function setRound(round) {
  roundEl.textContent = `ROUND ${String(round).padStart(2, '0')}`;
}

function setPhase(phase) {
  phaseEl.textContent = phase;

  const phaseColors = {
    IDLE: 'status-info',
    TRANSMITTING: 'status-waiting',
    WAITING: 'status-waiting',
    COLLECTING: 'status-waiting',
    COMBINING: 'status-waiting',
    CONSENSUS: 'status-responded',
    TIMEOUT: 'status-error',
    ABORTED: 'status-error'
  };

  phaseEl.className = '';
  phaseEl.classList.add(phaseColors[phase] || 'status-info');
}

function setAiStatus(name, status, vote) {
  const col = document.querySelector(`.ai-column[data-ai="${name}"]`);
  if (!col) return;

  const statusEl = col.querySelector('.ai-status');
  const voteEl = col.querySelector('.ai-vote');

  // Status
  const statusLabels = {
    STANDBY: 'STANDBY',
    TRANSMITTING: '.TX',
    WAITING: 'WAITING',
    RESPONDED: '.RX',
    ERROR: 'ERROR'
  };

  const statusClasses = {
    STANDBY: 'status-info',
    TRANSMITTING: 'status-waiting',
    WAITING: 'status-waiting',
    RESPONDED: 'status-responded',
    ERROR: 'status-error'
  };

  statusEl.textContent = statusLabels[status] || status;
  statusEl.className = 'ai-status';
  statusEl.classList.add(statusClasses[status] || 'status-info');

  // Vote
  if (vote === 'YES') {
    voteEl.textContent = 'ACK';
    voteEl.className = 'ai-vote vote-yes';
  } else if (vote === 'NO') {
    voteEl.textContent = 'NACK';
    voteEl.className = 'ai-vote vote-no';
  } else {
    voteEl.textContent = '--';
    voteEl.className = 'ai-vote vote-pending';
  }
}

function updateResponses(responses) {
  for (const [name, text] of Object.entries(responses)) {
    const col = document.querySelector(`.ai-column[data-ai="${name}"]`);
    if (!col) continue;
    const preview = col.querySelector('.ai-response-preview');
    if (preview && text) {
      preview.textContent = text.length > 500 ? text.substring(0, 500) + '...' : text;
    }
  }
}

module.exports = { init, setRound, setPhase, setAiStatus, updateResponses };
