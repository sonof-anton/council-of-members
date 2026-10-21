'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { AI_NAMES, MAX_ROUNDS, PHASES, RESPONSE_TIMEOUT_MS, RESPONSE_TIMEOUT_PER_MEMBER } = require('../utils/constants.js');
const { formatInitialMessage, formatRelayMessage, formatUnificationMessage } = require('./message-formatter.js');
const { parseResponse } = require('./message-parser.js');
const { checkConsensus } = require('./consensus-detector.js');
const SessionState = require('./session-state.js');
const ResponseExtractor = require('../automation/response-extractor.js');
const PerfTracker = require('../utils/perf-tracker.js');
const { log } = require('../utils/logger.js');

class Router extends EventEmitter {
  constructor(controllers) {
    super();
    this.controllers = controllers;
    this.extractors = {};
    this.state = new SessionState();
    this.disabledAIs = new Set(); // AIs that failed and should be skipped
    this.waitingMembers = new Set(); // Members with extended/indefinite timeout
    this.skipResolvers = new Map(); // resolve functions for skip support
    this.tickInterval = null;
    this.perfTracker = new PerfTracker();
    this.perfTracker.load();
    this.txTimes = {}; // Track when TX completed per member
    this.unifying = false;

    for (const name of AI_NAMES) {
      this.extractors[name] = new ResponseExtractor(controllers[name]);
      // Wire up thought callback for sub-status display
      controllers[name].onThought = (thought) => {
        this.emit('ai-thought', { name, thought });
      };
    }
  }

  get activeAIs() {
    return AI_NAMES.filter(name => !this.disabledAIs.has(name));
  }

  initTranscript(prompt) {
    try {
      const logDir = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      this.transcriptFile = path.join(logDir, `transcript-${ts}.log`);
      this.writeTranscript(`=== COUNCIL SESSION ===\nTimestamp: ${new Date().toISOString()}\nPrompt: ${prompt}\n${'='.repeat(60)}\n`);
    } catch {
      this.transcriptFile = null;
    }
  }

  writeTranscript(text) {
    if (!this.transcriptFile) return;
    try {
      fs.appendFileSync(this.transcriptFile, text + '\n');
    } catch { /* silent */ }
  }

  logTx(aiName, round, message) {
    this.writeTranscript(`\n--- .TX → ${aiName.toUpperCase()} (Round ${round}) ---\n${message}\n`);
  }

  logRx(aiName, round, response) {
    this.writeTranscript(`\n--- .RX ← ${aiName.toUpperCase()} (Round ${round}) ---\n${response}\n`);
  }

  async run(prompt) {
    this.state.reset();
    this.disabledAIs.clear();
    this.waitingMembers.clear();
    this.unifying = false;
    this.initTranscript(prompt);
    this.state.prompt = prompt;
    this.state.phase = PHASES.TRANSMITTING;
    this.emitPhase();

    try {
      // Round 1: send initial message to all 3
      this.state.startRound();
      const initialMsg = formatInitialMessage(prompt, this.state.round);
      this.emitLog('Chancellor', `Sending prompt to Members: ${prompt.substring(0, 80)}...`);

      // Capture response counts BEFORE sending so we know the baseline
      const countsBefore = await this.captureResponseCounts();
      const sent1 = await this.sendToAll(initialMsg);
      await this.collectAll(countsBefore, sent1);

      // Round 1: NEVER accept consensus — members haven't seen each other yet
      this.state.saveRound();
      this.emitRound();
      this.emitLog('CouncilOfMembers', 'Round 1 complete — relaying responses so all members can review each other');

      // Subsequent rounds
      while (this.state.round < MAX_ROUNDS && !this.state.aborted) {
        this.state.startRound();

        let message;
        if (this.unifying) {
          message = formatUnificationMessage(
            this.state.rounds[this.state.rounds.length - 1].responses,
            this.state.round
          );
          this.emitLog('CouncilOfMembers', `Round ${this.state.round}: Unification round`);
        } else {
          message = formatRelayMessage(
            this.state.rounds[this.state.rounds.length - 1].responses,
            this.state.round
          );
          this.emitLog('CouncilOfMembers', `Round ${this.state.round}: Relaying combined responses`);
        }

        const countsBefore2 = await this.captureResponseCounts();
        const sent2 = await this.sendToAll(message);
        await this.collectAll(countsBefore2, sent2);

        const consensus = checkConsensus(this.state.currentParsed, this.activeAIs);
        this.state.saveRound();
        this.emitRound();

        if (consensus.reached) {
          // Before declaring initial consensus, check if any disabled member
          // last voted NO — they disagree but can't participate anymore.
          // In unification phase, disabled members already had their individual
          // answer captured, so we proceed without them.
          if (!this.unifying && this.hasDisabledNoVoters()) {
            this.emitLog('CouncilOfMembers', 'Active members agree, but a disabled member last voted NO — continuing rounds');
            continue;
          }

          if (this.unifying) {
            // Unification consensus — finalize with the unified answer
            return this.finalize();
          }

          // Initial consensus — emit individual answers, then start unification
          const individualAnswers = this.buildIndividualAnswersMap();
          this.emit('individual-consensus', {
            answers: individualAnswers,
            round: this.state.round,
            votes: this.state.getVotes()
          });

          this.unifying = true;
          this.state.phase = PHASES.UNIFYING;
          this.emitPhase();
          this.emitLog('CouncilOfMembers', 'Members agree — entering unification phase');
          // Continue the loop — next iteration will use formatUnificationMessage
        }
      }

      // Max rounds or aborted
      if (this.state.aborted) {
        this.state.phase = PHASES.ABORTED;
        this.emitPhase();
        return { success: false, reason: 'ABORTED' };
      }

      // No consensus — deliver individual answers from the last round
      this.state.phase = PHASES.TIMEOUT;
      this.emitPhase();

      const individualAnswers = this.buildIndividualAnswers();
      this.writeTranscript(`\n${'='.repeat(60)}\n=== NO CONSENSUS AFTER ${MAX_ROUNDS} ROUNDS ===\n${individualAnswers}\n${'='.repeat(60)}\n`);

      this.emit('consensus', {
        answer: individualAnswers,
        rounds: this.state.round,
        votes: this.state.getVotes(),
        noConsensus: true
      });

      return { success: true, answer: individualAnswers, rounds: this.state.round, noConsensus: true };

    } catch (err) {
      log('error', `Router error: ${err.message}`);
      this.state.phase = PHASES.IDLE;
      this.emitPhase();
      this.emit('error', err.message);
      return { success: false, reason: err.message };
    }
  }

  async sendToAll(message) {
    this.state.phase = this.unifying ? PHASES.UNIFYING : PHASES.TRANSMITTING;
    this.emitPhase();

    // Reorder by speed ranking (fastest first) for better cycle time
    const active = this.perfTracker.reorder(this.activeAIs);
    const sent = []; // AIs that successfully received the message

    // Sequential: focus tab, type message, hit send, move to next
    for (const name of active) {
      this.emitAiStatus(name, 'TRANSMITTING', null);
      this.emitLog(name, '.TX typing...');
      try {
        await this.extractors[name].controller.sendMessage(message);
        this.txTimes[name] = Date.now();
        this.logTx(name, this.state.round, message);
        this.emitAiStatus(name, 'WAITING', null);
        this.emitLog(name, '.TX sent');
        sent.push(name);
      } catch (err) {
        this.disabledAIs.add(name);
        this.emitAiStatus(name, 'ERROR', null);
        this.emitLog(name, `.TX FAILED: ${err.message} — disabling for remaining rounds`);
      }
    }

    if (sent.length === 0) {
      throw new Error('All active members failed to receive message');
    }

    // Emit current perf metrics
    this.emitPerfUpdate();

    this.emitLog('CouncilOfMembers', `All .TX complete (${sent.length}/${active.length} succeeded)`);
    this.state.phase = PHASES.WAITING;
    this.emitPhase();
    return sent;
  }

  async captureResponseCounts() {
    const counts = {};
    for (const name of this.activeAIs) {
      counts[name] = await this.controllers[name].getResponseCount();
      log('info', `${name}: Response count before send = ${counts[name]}`);
    }
    return counts;
  }

  async collectAll(countsBefore, sentTo) {
    this.state.phase = PHASES.COLLECTING;
    this.emitPhase();

    // Only poll AIs that actually received the message
    const active = sentTo || this.activeAIs;
    this.emitLog('CouncilOfMembers', `Waiting for ${active.length} member responses...`);

    // Set isWaiting function on each controller so DomMonitor can bypass timeout
    for (const name of active) {
      this.controllers[name].isWaiting = () => this.waitingMembers.has(name);
    }

    // Start timeout tick timer
    this.startTickTimer(active);

    // Collect in parallel — no focus needed for reading DOM
    await Promise.allSettled(active.map(async (name) => {
      try {
        this.emitAiStatus(name, 'WAITING', null);
        const countBefore = countsBefore[name];
        const monitor = this.extractors[name].monitor;

        // Race between normal response and skip signal
        const skipPromise = new Promise((resolve) => {
          this.skipResolvers.set(name, resolve);
        });

        const rawText = await Promise.race([
          monitor.waitForResponse(countBefore),
          skipPromise
        ]);

        // Clean up skip resolver
        this.skipResolvers.delete(name);

        if (rawText === '[SKIPPED BY CHANCELLOR]') {
          this.state.setResponse(name, rawText, parseResponse(null));
          this.logRx(name, this.state.round, rawText);
          return;
        }

        const rxTime = Date.now();
        const cleaned = this.extractors[name].cleanResponse(rawText);
        const parsed = parseResponse(cleaned);

        // Record response time for perf tracking
        if (this.txTimes[name]) {
          const responseMs = rxTime - this.txTimes[name];
          this.perfTracker.record(name, responseMs, cleaned.length);
        }

        this.state.setResponse(name, cleaned, parsed);
        this.logRx(name, this.state.round, cleaned);
        this.emit('ai-thought', { name, thought: '' }); // Clear thought on response
        this.emitAiStatus(name, 'RESPONDED', parsed.vote);
        this.emitSingleResponse(name, cleaned, parsed.vote);
        this.emitLog(name, `.RX received (${cleaned.length} chars, vote: ${parsed.vote || 'NONE'})`);
      } catch (err) {
        // Clean up skip resolver
        this.skipResolvers.delete(name);
        // Disable this AI for future rounds — don't waste time on it
        this.disabledAIs.add(name);
        this.emitAiStatus(name, 'ERROR', null);
        this.emitLog(name, `.RX FAILED: ${err.message} — disabling for remaining rounds`);
        this.state.setResponse(name, `[ERROR: ${err.message}]`, parseResponse(null));
      }
    }));

    // Stop timeout tick timer
    this.stopTickTimer();

    const responded = active.filter(name => {
      const r = this.state.currentResponses[name];
      return r && !r.startsWith('[ERROR:');
    });

    this.emitLog('CouncilOfMembers', `Collected ${responded.length}/${active.length} responses`);

    if (responded.length === 0) {
      throw new Error('All members failed to respond');
    }

    // Save perf data and emit updated metrics
    this.perfTracker.save();
    this.emitPerfUpdate();

    this.state.phase = PHASES.COMBINING;
    this.emitPhase();
  }

  finalize() {
    const answersMap = this.buildIndividualAnswersMap();
    const memberNames = Object.keys(answersMap);

    // Build a combined answer showing all members' results
    const parts = [];
    for (const name of memberNames) {
      parts.push(`=== ${name.toUpperCase()} ===`);
      parts.push(answersMap[name]);
      parts.push('');
    }
    const answer = parts.join('\n').trim();

    this.state.consensusAnswer = answer;
    this.writeTranscript(`\n${'='.repeat(60)}\n=== CONSENSUS REACHED (Round ${this.state.round}) ===\n${answer}\n${'='.repeat(60)}\n`);
    this.emitLog('CouncilOfMembers', `CONSENSUS REACHED in Round ${this.state.round} (${answer.length} chars, ${memberNames.length} members)`);
    this.state.phase = PHASES.CONSENSUS;
    this.emitPhase();
    this.emit('consensus', {
      answer,
      answers: answersMap,
      rounds: this.state.round,
      votes: this.state.getVotes()
    });
    return { success: true, answer, rounds: this.state.round };
  }

  hasDisabledNoVoters() {
    // Check if any disabled member's last known vote was NO.
    // Only consider votes from the last 2 rounds — if a member has been
    // disabled longer than that, the active members have had time to
    // deliberate without them and their stale NO shouldn't block forever.
    const currentRound = this.state.round;
    for (const name of this.disabledAIs) {
      // Check current round first
      if (this.state.currentParsed[name]) {
        const vote = this.state.currentParsed[name].vote;
        if (vote === 'NO') return true;
        if (vote === 'YES') continue;
      }
      // Search recent saved rounds only (last 2)
      const allRounds = [...this.state.rounds];
      for (let i = allRounds.length - 1; i >= 0 && i >= allRounds.length - 2; i--) {
        const parsed = allRounds[i].parsed[name];
        if (parsed && parsed.vote) {
          if (parsed.vote === 'NO') return true;
          break;
        }
      }
    }
    return false;
  }

  buildIndividualAnswersMap() {
    const answers = {};
    for (const name of AI_NAMES) {
      // Try current round first
      const parsed = this.state.currentParsed[name];
      if (parsed && parsed.raw && !parsed.raw.startsWith('[ERROR:') && !parsed.raw.startsWith('[SKIPPED')) {
        answers[name] = parsed.sections.RESULT || parsed.raw;
        continue;
      }
      // Fall back to last valid answer from previous rounds (for disabled/skipped members)
      for (let i = this.state.rounds.length - 1; i >= 0; i--) {
        const prev = this.state.rounds[i].parsed[name];
        if (prev && prev.raw && !prev.raw.startsWith('[ERROR:') && !prev.raw.startsWith('[SKIPPED')) {
          answers[name] = prev.sections.RESULT || prev.raw;
          break;
        }
      }
    }
    return answers;
  }

  buildIndividualAnswers() {
    const parts = ['NO CONSENSUS REACHED — INDIVIDUAL MEMBER ANSWERS:\n'];

    for (const name of AI_NAMES) {
      const parsed = this.state.currentParsed[name];
      if (!parsed || !parsed.raw || parsed.raw.startsWith('[ERROR:')) continue;

      const result = parsed.sections.RESULT || parsed.raw;
      const vote = parsed.vote || 'NONE';
      parts.push(`=== ${name.toUpperCase()} (VOTE: ${vote}) ===`);
      parts.push(result);
      parts.push('');
    }

    return parts.join('\n');
  }

  skipMember(name) {
    const resolver = this.skipResolvers.get(name);
    if (resolver) {
      this.emitLog('Chancellor', `Skipping ${name} by chancellor command`);
      resolver('[SKIPPED BY CHANCELLOR]');
      this.skipResolvers.delete(name);
      this.disabledAIs.add(name);
      this.waitingMembers.delete(name);
      this.emitAiStatus(name, 'SKIPPED', null);
    }
  }

  waitMember(name) {
    this.waitingMembers.add(name);
    this.emitLog('Chancellor', `Extending timeout for ${name} — waiting indefinitely`);
    this.emit('member-waiting', { name });
  }

  startTickTimer(active) {
    const startTime = Date.now();
    // Each member has its own timeout (Gemini gets longer for deep-thinking) — track
    // remaining time per member instead of a single shared countdown, otherwise the
    // UI freezes at the shortest member's timeout while longer-budget members are
    // still legitimately polling.
    const members = active || this.activeAIs;
    const timeouts = {};
    for (const name of members) {
      timeouts[name] = (RESPONSE_TIMEOUT_PER_MEMBER && RESPONSE_TIMEOUT_PER_MEMBER[name]) || RESPONSE_TIMEOUT_MS;
    }
    const maxTimeoutMs = Math.max(...Object.values(timeouts), RESPONSE_TIMEOUT_MS);

    this.tickInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = {};
      for (const name of members) {
        remaining[name] = Math.max(0, Math.ceil((timeouts[name] - elapsed) / 1000));
      }
      this.emit('timeout-tick', { remaining, elapsed: Math.floor(elapsed / 1000) });
      if (elapsed >= maxTimeoutMs) {
        this.stopTickTimer();
      }
    }, 1000);
  }

  stopTickTimer() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  emitPerfUpdate() {
    const metrics = {};
    for (const name of AI_NAMES) {
      metrics[name] = this.perfTracker.getMetric(name);
    }
    this.emit('perf-update', metrics);
  }

  abort() {
    this.state.aborted = true;
    this.stopTickTimer();
  }

  emitPhase() {
    this.emit('phase-change', { phase: this.state.phase, round: this.state.round });
  }

  emitAiStatus(name, status, vote) {
    this.emit('ai-status', { name, status, vote });
  }

  emitRound() {
    this.emit('round-update', {
      round: this.state.round,
      responses: { ...this.state.currentResponses },
      votes: this.state.getVotes()
    });
  }

  emitSingleResponse(name, text, vote) {
    this.emit('round-update', {
      round: this.state.round,
      responses: { [name]: text },
      votes: { [name]: vote || null }
    });
  }

  emitLog(source, content) {
    log('info', `[${source}] ${content}`);
    this.emit('log-message', {
      timestamp: new Date().toISOString(),
      source,
      content
    });
  }
}

module.exports = Router;
