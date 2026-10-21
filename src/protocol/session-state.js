'use strict';

const { AI_NAMES, PHASES } = require('../utils/constants.js');

class SessionState {
  constructor() {
    this.reset();
  }

  reset() {
    this.round = 0;
    this.phase = PHASES.IDLE;
    this.prompt = null;
    this.aborted = false;
    this.rounds = [];
    this.currentResponses = {};
    this.currentParsed = {};
    this.consensusAnswer = null;

    for (const name of AI_NAMES) {
      this.currentResponses[name] = null;
      this.currentParsed[name] = null;
    }
  }

  startRound() {
    this.round++;
    this.currentResponses = {};
    this.currentParsed = {};
    for (const name of AI_NAMES) {
      this.currentResponses[name] = null;
      this.currentParsed[name] = null;
    }
  }

  setResponse(aiName, rawText, parsed) {
    this.currentResponses[aiName] = rawText;
    this.currentParsed[aiName] = parsed;
  }

  saveRound() {
    this.rounds.push({
      round: this.round,
      responses: { ...this.currentResponses },
      parsed: { ...this.currentParsed }
    });
  }

  getVotes() {
    const votes = {};
    for (const name of AI_NAMES) {
      const parsed = this.currentParsed[name];
      votes[name] = parsed ? (parsed.vote || null) : null;
    }
    return votes;
  }

  allResponded() {
    return AI_NAMES.every(name => this.currentResponses[name] !== null);
  }
}

module.exports = SessionState;
