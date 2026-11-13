'use strict';

const { EventEmitter } = require('events');
const { logDir: getLogDir } = require('../utils/paths.js');
const fs = require('fs');
const path = require('path');
const { AI_NAMES, AI_LABELS, MAX_ROUNDS, MIN_CONSENSUS_MEMBERS, MAX_CONSULTS_PER_SESSION, PHASES, RESPONSE_TIMEOUT_MS, RESPONSE_TIMEOUT_PER_MEMBER, TX_TIMEOUT_MS, TX_TIMEOUT_PER_1K_MS, SITE_ERROR_RETRIES, ATTACH_TIMEOUT_MS } = require('../utils/constants.js');
const { formatInitialMessage, formatRelayMessage, formatUnificationMessage } = require('./message-formatter.js');
const { parseResponse } = require('./message-parser.js');
const { checkConsensus } = require('./consensus-detector.js');
const SessionState = require('./session-state.js');
const ResponseExtractor = require('../automation/response-extractor.js');
const PerfTracker = require('../utils/perf-tracker.js');

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms); })
  ]).finally(() => clearTimeout(timer));
}
const { log } = require('../utils/logger.js');

const label = (name) => AI_LABELS[name] || name;

class Router extends EventEmitter {
  // options.consult(url, question, { onActivity }) → reply text: opens an
  // outside chat service when a majority of members ask for it.
  constructor(controllers, options = {}) {
    super();
    this.controllers = controllers;
    this.consult = options.consult || null;
    this.consultsDone = [];
    this.pendingConsultation = null;
    this.extractors = {};
    this.state = new SessionState();
    this.disabledAIs = new Set(); // AIs that failed and should be skipped
    this.txTimeoutMs = TX_TIMEOUT_MS;
    this.txTimeoutPer1kMs = TX_TIMEOUT_PER_1K_MS;
    this.siteErrorRetries = SITE_ERROR_RETRIES;
    this.unificationRounds = 0;
    this.waitingMembers = new Set(); // Members with extended/indefinite timeout
    this.skipResolvers = new Map(); // resolve functions for skip support
    this.forceResolvers = new Map(); // resolve functions for FORCE (take reply now)
    this.collecting = null; // { countsBefore, message, active, tasks } while a round collects
    this.transmittingTo = null; // member currently being typed into
    this.tickInterval = null;
    this.perfTracker = new PerfTracker();
    this.perfTracker.load();
    this.txTimes = {}; // Track when TX completed per member
    this.unifying = false;

    for (const name of AI_NAMES) {
      this.extractors[name] = new ResponseExtractor(controllers[name]);
      controllers[name].isAborted = () => this.state.aborted;
      // Wire up thought callback for sub-status display
      controllers[name].onThought = (thought) => {
        this.emit('ai-thought', { name, thought });
      };
      controllers[name].onActivity = (text, ind) => this.emitActivity(name, text, ind);
    }
  }

  get activeAIs() {
    return AI_NAMES.filter(name => !this.disabledAIs.has(name));
  }

  initTranscript(prompt) {
    try {
      const logDir = getLogDir();
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

  // options.files: local paths uploaded to each member with the round 1
  // message only — later rounds are in the same chat, so they still see it.
  async run(prompt, options = {}) {
    this.state.reset();
    this.disabledAIs.clear();
    this.waitingMembers.clear();
    this.unifying = false;
    this.unificationRounds = 0;
    this.consultsDone = [];
    this.pendingConsultation = null;
    this.abortPromise = new Promise((resolve) => { this.resolveAbort = resolve; });
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
      const sent1 = await this.sendToAll(initialMsg, options.files || []);
      await this.collectAll(countsBefore, sent1, initialMsg);

      // Round 1: NEVER accept consensus — members haven't seen each other yet
      this.state.saveRound();
      this.emitRound();
      this.emitLog('CouncilOfMembers', 'Round 1 complete — relaying responses so all members can review each other');
      this.pendingConsultation = await this.maybeConsult();

      // Subsequent rounds
      while (this.state.round < MAX_ROUNDS && !this.state.aborted && this.activeAIs.length >= MIN_CONSENSUS_MEMBERS) {
        this.state.startRound();

        let message;
        if (this.unifying) {
          const prev = this.state.rounds[this.state.rounds.length - 1];
          // First unification round merges everyone's answers; after that,
          // relay one current draft (plus any dissent) instead of all three
          // full answers again — that grew the message to 14k chars and
          // pushed Gemini's typing past its timeout.
          const draft = this.unificationRounds > 0 ? this.buildUnificationDraft(prev) : null;
          message = formatUnificationMessage(prev.responses, this.state.round, draft);
          this.unificationRounds++;
          this.emitLog('CouncilOfMembers', `Round ${this.state.round}: Unification round${draft ? ' (relaying current draft)' : ''}`);
        } else {
          message = formatRelayMessage(
            this.state.rounds[this.state.rounds.length - 1].responses,
            this.state.round,
            this.pendingConsultation
          );
          this.pendingConsultation = null;
          this.emitLog('CouncilOfMembers', `Round ${this.state.round}: Relaying combined responses`);
        }

        const countsBefore2 = await this.captureResponseCounts();
        const sent2 = await this.sendToAll(message);
        await this.collectAll(countsBefore2, sent2, message);
        if (this.state.aborted) break;

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
        } else {
          this.pendingConsultation = await this.maybeConsult();
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

      // Either rounds ran out, or too few members are left to deliberate
      // (continuing alone would just burn the remaining rounds).
      const reason = this.activeAIs.length < MIN_CONSENSUS_MEMBERS
        ? `ONLY ${this.activeAIs.length} MEMBER(S) STILL ACTIVE AFTER ROUND ${this.state.round}`
        : `NO CONSENSUS AFTER ${MAX_ROUNDS} ROUNDS`;
      this.emitLog('CouncilOfMembers', reason);

      const individualAnswers = this.buildIndividualAnswers();
      this.writeTranscript(`\n${'='.repeat(60)}\n=== ${reason} ===\n${individualAnswers}\n${'='.repeat(60)}\n`);

      this.emit('consensus', {
        answer: individualAnswers,
        answers: this.buildIndividualAnswersMap(),
        rounds: this.state.round,
        votes: this.state.getVotes(),
        noConsensus: true
      });

      return { success: true, answer: individualAnswers, rounds: this.state.round, noConsensus: true };

    } catch (err) {
      log('error', `Router error: ${err.message}`);
      this.stopTickTimer();

      // Earlier rounds may still hold good answers — deliver those instead of
      // throwing away the whole session because the latest round failed.
      if (Object.keys(this.buildIndividualAnswersMap()).length > 0) {
        this.state.phase = PHASES.TIMEOUT;
        this.emitPhase();
        const answer = `SESSION ENDED EARLY (${err.message}) — LAST ANSWER FROM EACH MEMBER:\n\n` +
          this.buildIndividualAnswers().replace(/^NO CONSENSUS REACHED — INDIVIDUAL MEMBER ANSWERS:\n\n?/, '');
        this.writeTranscript(`\n${'='.repeat(60)}\n${answer}\n${'='.repeat(60)}\n`);
        this.emit('error', err.message);
        this.emit('consensus', {
          answer,
          answers: this.buildIndividualAnswersMap(),
          rounds: this.state.round,
          votes: this.state.getVotes(),
          noConsensus: true
        });
        return { success: true, answer, rounds: this.state.round, noConsensus: true, reason: err.message };
      }

      this.state.phase = PHASES.IDLE;
      this.emitPhase();
      this.emit('error', err.message);
      return { success: false, reason: err.message };
    }
  }

  async sendToAll(message, files = []) {
    this.state.phase = this.unifying ? PHASES.UNIFYING : PHASES.TRANSMITTING;
    this.emitPhase();

    // Reorder by speed ranking (fastest first) for better cycle time
    const active = this.perfTracker.reorder(this.activeAIs);
    const sent = []; // AIs that successfully received the message

    // Sequential: focus tab, type message, hit send, move to next
    for (const name of active) {
      if (this.state.aborted) return sent;
      // Out of messages: typing into it would only get the limit notice back
      if (typeof this.controllers[name].detectUsageLimit === 'function') {
        this.emitActivity(name, 'Checking for a usage-limit notice', 'tx');
        const notice = await this.controllers[name].detectUsageLimit().catch(() => null);
        if (notice) {
          this.disableForUsageLimit(name, notice);
          continue;
        }
      }
      this.emitAiStatus(name, 'TRANSMITTING', null);
      this.emitLog(name, '.TX typing...');
      this.transmittingTo = name;
      this.controllers[name].forceProceed = false;
      try {
        if (files.length > 0) {
          this.emitLog(name, `.TX attaching ${files.length} file(s)...`);
          await withTimeout(this.extractors[name].controller.attachFiles(files), ATTACH_TIMEOUT_MS, 'upload');
        }
        await withTimeout(this.extractors[name].controller.sendMessage(message), this.txTimeoutFor(message), 'typing/sending');
        this.txTimes[name] = Date.now();
        this.logTx(name, this.state.round, message);
        this.emitAiStatus(name, 'WAITING', null);
        this.emitActivity(name, 'Message sent', 'wait');
        this.emitLog(name, '.TX sent');
        sent.push(name);
      } catch (err) {
        this.disabledAIs.add(name);
        this.emitAiStatus(name, 'ERROR', null);
        this.emitActivity(name, err.message, 'error');
        this.emitLog(name, `.TX FAILED: ${err.message} — disabling for remaining rounds (use .RETRY / .FORCE to bring it back)`);
      } finally {
        this.transmittingTo = null;
        this.controllers[name].forceProceed = false;
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

  txTimeoutFor(message) {
    return this.txTimeoutMs + Math.ceil((message || '').length / 1000) * this.txTimeoutPer1kMs;
  }

  // The longest ANSWER among last round's YES voters becomes the draft;
  // everyone who didn't vote YES is relayed in full so their objections
  // still reach the others. Null when nobody voted YES.
  buildUnificationDraft(prev) {
    let draft = null;
    const notes = [];
    for (const name of AI_NAMES) {
      const text = prev.responses[name];
      if (!text || text.startsWith('[ERROR:') || text.startsWith('[SKIPPED')) continue;
      const parsed = prev.parsed && prev.parsed[name];
      if (parsed && parsed.vote === 'YES') {
        const answer = (parsed.sections && parsed.sections.ANSWER) || text;
        if (!draft || answer.length > draft.length) draft = answer;
      } else {
        notes.push([name, text]);
      }
    }
    return draft ? { text: draft, notes } : null;
  }

  async captureResponseCounts() {
    const counts = {};
    // Also snapshot each member's last response text BEFORE sending. The
    // text-change fallback compares against it; captured later (once all
    // sends finish), a fast member's new answer was already complete, became
    // the baseline itself, and was never detected (Claude's virtualized
    // transcript keeps the count flat, so only that fallback can catch it).
    this.baselineTexts = {};
    for (const name of this.activeAIs) {
      counts[name] = await this.controllers[name].getResponseCount();
      this.baselineTexts[name] = await this.controllers[name].getLastResponseText().catch(() => null);
      log('info', `${name}: Response count before send = ${counts[name]}`);
    }
    return counts;
  }

  // message: what was sent this round, re-sent if a member's site replies
  // with its own "try again" error.
  async collectAll(countsBefore, sentTo, message) {
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

    // Collect in parallel — no focus needed for reading DOM. RETRY / FORCE
    // can add watchers mid-round, so keep settling until no new ones appear.
    this.collecting = { countsBefore, message, active: [...active], tasks: [] };
    for (const name of active) {
      this.collecting.tasks.push(this._watchMember(name, countsBefore[name], this.baselineTexts && this.baselineTexts[name], message));
    }
    let settled = 0;
    while (settled < this.collecting.tasks.length) {
      settled = this.collecting.tasks.length;
      await Promise.allSettled(this.collecting.tasks);
    }
    const collected = this.collecting.active;
    this.collecting = null;

    // Stop timeout tick timer
    this.stopTickTimer();
    this.skipResolvers.clear();
    this.forceResolvers.clear();
    if (this.state.aborted) return;

    const responded = collected.filter(name => {
      const r = this.state.currentResponses[name];
      return r && !r.startsWith('[ERROR:') && !r.startsWith('[SKIPPED');
    });

    this.emitLog('CouncilOfMembers', `Collected ${responded.length}/${collected.length} responses`);

    if (responded.length === 0) {
      throw new Error('All members failed to respond');
    }

    // Save perf data and emit updated metrics
    this.perfTracker.save();
    this.emitPerfUpdate();

    this.state.phase = PHASES.COMBINING;
    this.emitPhase();
  }

  // Watch one member until it replies, is skipped/forced, or fails.
  async _watchMember(name, countBefore, baseline, message) {
    try {
      this.emitAiStatus(name, 'WAITING', null);
      const monitor = this.extractors[name].monitor;
      const controller = this.controllers[name];

      // Race between normal response, skip signal and FORCE (take reply now)
      const skipPromise = new Promise((resolve) => {
        this.skipResolvers.set(name, resolve);
      });
      const forcePromise = new Promise((resolve) => {
        this.forceResolvers.set(name, resolve);
      });

      let rawText;
      for (let retry = 0; ; retry++) {
        try {
          rawText = await Promise.race([
            countBefore === null ? new Promise(() => {}) : monitor.waitForResponse(countBefore, baseline),
            skipPromise,
            forcePromise,
            this.abortPromise
          ]);
          break;
        } catch (err) {
          // Gemini's "I encountered an error... try again" is usually a
          // one-off — resend instead of dropping the member for good.
          if (err.code !== 'SITE_ERROR' || !message || retry >= this.siteErrorRetries || this.state.aborted) throw err;
          this.emitLog(name, `.RX site error — re-sending (retry ${retry + 1}/${this.siteErrorRetries})`);
          this.emitActivity(name, 'Site error — re-sending', 'tx');
          countBefore = await controller.getResponseCount();
          baseline = await controller.getLastResponseText().catch(() => null);
          await withTimeout(controller.sendMessage(message), this.txTimeoutFor(message), 'typing/sending');
          this.txTimes[name] = Date.now();
          this.emitAiStatus(name, 'WAITING', null);
        }
      }
      if (this.state.aborted) return;

      // Clean up skip / force resolvers
      this.skipResolvers.delete(name);
      this.forceResolvers.delete(name);

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
      this.emitActivity(name, `Reply captured (${cleaned.length} chars)`, 'done');
      this.emitSingleResponse(name, cleaned, parsed.vote);
      this.emitLog(name, `.RX received (${cleaned.length} chars, vote: ${parsed.vote || 'NONE'})`);
    } catch (err) {
      // Clean up skip / force resolvers
      this.skipResolvers.delete(name);
      this.forceResolvers.delete(name);
      if (this.state.aborted) return;
      // Disable this member for future rounds — don't waste time on it
      if (err.code === 'USAGE_LIMIT') {
        this.disableForUsageLimit(name, err.message);
      } else {
        this.disabledAIs.add(name);
        this.emitAiStatus(name, 'ERROR', null);
        this.emitActivity(name, err.message, 'error');
        this.emitLog(name, `.RX FAILED: ${err.message} — disabling for remaining rounds (use .RETRY / .FORCE to bring it back)`);
      }
      this.state.setResponse(name, `[ERROR: ${err.message}]`, parseResponse(null));
    }
  }

  finalize() {
    const answersMap = this.buildIndividualAnswersMap();
    const memberNames = Object.keys(answersMap);

    // Build a combined answer showing all members' results
    const parts = [];
    for (const name of memberNames) {
      parts.push(`=== ${label(name)} ===`);
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

  // Current round first, then the last valid answer from previous rounds
  // (for members that were disabled, skipped, or failed this round).
  lastValidParsed(name) {
    const isValid = (p) => p && p.raw && !p.raw.startsWith('[ERROR:') && !p.raw.startsWith('[SKIPPED');
    if (isValid(this.state.currentParsed[name])) return this.state.currentParsed[name];
    for (let i = this.state.rounds.length - 1; i >= 0; i--) {
      const prev = this.state.rounds[i].parsed[name];
      if (isValid(prev)) return prev;
    }
    return null;
  }

  buildIndividualAnswersMap() {
    const answers = {};
    for (const name of AI_NAMES) {
      const parsed = this.lastValidParsed(name);
      if (parsed) answers[name] = parsed.sections.RESULT || parsed.raw;
    }
    return answers;
  }

  buildIndividualAnswers() {
    const parts = ['NO CONSENSUS REACHED — INDIVIDUAL MEMBER ANSWERS:\n'];

    for (const name of AI_NAMES) {
      const parsed = this.lastValidParsed(name);
      if (!parsed) continue;

      const result = parsed.sections.RESULT || parsed.raw;
      const vote = parsed.vote || 'NONE';
      parts.push(`=== ${label(name)} (VOTE: ${vote}) ===`);
      parts.push(result);
      parts.push('');
    }

    return parts.join('\n');
  }

  skipMember(name) {
    const resolver = this.skipResolvers.get(name);
    if (resolver) {
      this.emitLog('Chancellor', `Skipping ${label(name)} by chancellor command`);
      resolver('[SKIPPED BY CHANCELLOR]');
      this.skipResolvers.delete(name);
      this.disabledAIs.add(name);
      this.waitingMembers.delete(name);
      this.emitAiStatus(name, 'SKIPPED', null);
    }
  }

  // Chancellor's RETRY: bring a failed / skipped member back. Mid-collect it
  // is watched again this round (against the count taken before this
  // round's send when there is one); otherwise it rejoins next round.
  async retryMember(name) {
    if (!this.controllers[name]) return { success: false, reason: `Unknown member: ${name}` };
    if (this.skipResolvers.has(name)) return { success: false, reason: `${label(name)} is already being watched` };
    this.disabledAIs.delete(name);
    if (this.collecting) {
      const c = this.collecting;
      let countBefore = c.countsBefore[name];
      let baseline = this.baselineTexts && this.baselineTexts[name];
      if (countBefore === undefined) {
        countBefore = await this.controllers[name].getResponseCount();
        baseline = await this.controllers[name].getLastResponseText().catch(() => null);
      }
      this.controllers[name].isWaiting = () => this.waitingMembers.has(name);
      if (!c.active.includes(name)) c.active.push(name);
      this.emitLog('Chancellor', `RETRY: watching ${label(name)} again for a reply this round`);
      c.tasks.push(this._watchMember(name, countBefore, baseline, c.message));
      return { success: true, watching: true };
    }
    this.emitAiStatus(name, 'STANDBY', null);
    this.emitActivity(name, 'Reinstated — rejoins next round', 'wait');
    this.emitLog('Chancellor', `RETRY: ${label(name)} reinstated — rejoins next round`);
    return { success: true, watching: false };
  }

  // Chancellor's FORCE: push a member past whatever it is stuck on.
  //  - being typed into (e.g. stuck waiting on an upload): stop waiting, send
  //  - waiting on a reply: take the reply currently on screen
  //  - failed / skipped while a round collects: reinstate and take the
  //    reply on screen (e.g. the Chancellor pasted the prompt by hand)
  async forceMember(name) {
    const controller = this.controllers[name];
    if (!controller) return { success: false, reason: `Unknown member: ${name}` };
    if (this.transmittingTo === name) {
      controller.forceProceed = true;
      this.emitLog('Chancellor', `FORCE: ${label(name)} — skipping the wait and sending`);
      return { success: true, action: 'send' };
    }
    const text = await controller.getLastResponseText().catch(() => null);
    if (!text || !text.trim()) {
      return { success: false, reason: `${label(name)}: no reply on screen to take` };
    }
    const resolver = this.forceResolvers.get(name);
    if (resolver) {
      this.emitLog('Chancellor', `FORCE: taking ${label(name)}'s reply on screen now (${text.length} chars)`);
      resolver(text);
      return { success: true, action: 'take' };
    }
    if (this.collecting) {
      this.disabledAIs.delete(name);
      const c = this.collecting;
      if (!c.active.includes(name)) c.active.push(name);
      this.emitLog('Chancellor', `FORCE: reinstating ${label(name)} and taking its reply on screen (${text.length} chars)`);
      const forced = this._watchMember(name, null, null, null);
      c.tasks.push(forced);
      const r = this.forceResolvers.get(name);
      if (r) r(text);
      return { success: true, action: 'take' };
    }
    return this.retryMember(name);
  }

  waitMember(name) {
    this.waitingMembers.add(name);
    this.emitLog('Chancellor', `Extending timeout for ${label(name)} — waiting indefinitely`);
    this.emit('member-waiting', { name });
  }

  // Chancellor's "advance round": stop waiting on every member still
  // pending and carry on with the answers already in.
  advanceRound() {
    const pending = [...this.skipResolvers.keys()];
    if (pending.length === 0) return false;
    this.emitLog('Chancellor', `Advancing the round without ${pending.map(label).join(', ')}`);
    for (const name of pending) this.skipMember(name);
    return true;
  }

  disableForUsageLimit(name, notice) {
    this.disabledAIs.add(name);
    this.waitingMembers.delete(name);
    this.emitAiStatus(name, 'LIMIT', null);
    this.emitActivity(name, notice, 'limit');
    this.emitLog(name, `USAGE LIMIT: ${notice} — continuing without this member`);
  }

  // A majority of active members asking to consult the same website (a
  // "CONSULT: <site> | <question>" line) opens it in a new window; the
  // reply is relayed to everyone with the next round's message.
  async maybeConsult() {
    if (!this.consult || this.state.aborted || this.unifying) return null;
    const requests = {};
    for (const name of this.activeAIs) {
      const c = this.state.currentParsed[name] && this.state.currentParsed[name].consult;
      if (c) (requests[c.host] = requests[c.host] || []).push({ name, ...c });
    }
    const ranked = Object.entries(requests).sort((a, b) => b[1].length - a[1].length);
    if (ranked.length === 0) return null;
    const [host, reqs] = ranked[0];
    const needed = Math.floor(this.activeAIs.length / 2) + 1;
    const who = reqs.map(r => label(r.name)).join(', ');
    if (reqs.length < needed) {
      this.emitLog('Chancellor', `${who} asked to consult ${host} — not a majority (${reqs.length}/${needed}), not consulting`);
      return null;
    }
    if (this.consultsDone.length >= MAX_CONSULTS_PER_SESSION) {
      this.emitLog('Chancellor', `Consultation limit reached (${MAX_CONSULTS_PER_SESSION} per session) — not consulting ${host}`);
      return null;
    }
    const question = [...new Set(reqs.map(r => r.question).filter(Boolean))].join('\n');
    const key = `${host}|${question}`;
    if (this.consultsDone.includes(key)) {
      this.emitLog('Chancellor', `${host} was already asked this — not consulting again`);
      return null;
    }
    this.consultsDone.push(key);

    this.state.phase = PHASES.CONSULTING;
    this.emitPhase();
    this.emitLog('Chancellor', `${who} agree to consult ${host} — asking: ${question}`);
    this.emit('consult-status', { host, question, status: 'ASKING' });
    this.writeTranscript(`\n--- .TX → OUTSIDE CONSULTATION ${host} ---\n${question}\n`);
    try {
      const reply = await Promise.race([
        this.consult(reqs[0].url, question, {
          onActivity: (text) => this.emit('consult-status', { host, question, status: 'ASKING', activity: text })
        }),
        this.abortPromise
      ]);
      if (this.state.aborted) return null;
      this.writeTranscript(`\n--- .RX ← OUTSIDE CONSULTATION ${host} ---\n${reply}\n`);
      this.emitLog('Chancellor', `Reply from ${host} (${reply.length} chars) will be shared with all members`);
      this.emit('consult-status', { host, question, status: 'REPLIED', reply });
      return { host, question, reply };
    } catch (err) {
      this.writeTranscript(`\n--- OUTSIDE CONSULTATION ${host} FAILED: ${err.message} ---\n`);
      this.emitLog('Chancellor', `Consulting ${host} failed: ${err.message}`);
      this.emit('consult-status', { host, question, status: 'FAILED', error: err.message });
      return { host, question, error: err.message };
    }
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
    if (this.resolveAbort) this.resolveAbort('[ABORTED]');
  }

  emitPhase() {
    this.emit('phase-change', { phase: this.state.phase, round: this.state.round });
  }

  emitAiStatus(name, status, vote) {
    this.emit('ai-status', { name, status, vote });
  }

  emitActivity(name, text, ind) {
    this.emit('member-activity', { name, text, ind: ind || null });
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
      source: label(source),
      content
    });
  }
}

module.exports = Router;
