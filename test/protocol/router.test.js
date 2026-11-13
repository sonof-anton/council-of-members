'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Router, logger and PerfTracker write under process.cwd()/logs — keep test
// runs out of the real logs/perf-stats.json. Must happen before require.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'council-router-test-')));
const Router = require('../../src/protocol/router.js');

const GOOD = (vote) => `ANSWER:\nA complete answer.\n\nFEEDBACK:\nLooks fine.\n\nAGREE: ${vote}`;

function fakeController(name) {
  return {
    aiName: name,
    sent: [],
    async sendMessage(text) { this.sent.push(text); },
    async getResponseCount() { return 0; },
    async getLastResponseText() { return null; }
  };
}

// Each member gets a script: one entry per round, either response text or
// an Error to throw (a timeout), or 'hang' to never resolve.
function makeRouter(scripts, options) {
  const controllers = {
    claude: fakeController('claude'),
    grok: fakeController('grok'),
    gemini: fakeController('gemini')
  };
  const router = new Router(controllers, options);
  router.on('error', () => {}); // ipc-handlers always listens; EventEmitter throws otherwise
  for (const name of Object.keys(controllers)) {
    let round = 0;
    router.extractors[name].monitor.waitForResponse = async () => {
      const step = scripts[name][round++];
      if (step === 'hang') return new Promise(() => {});
      if (step instanceof Error) throw step;
      return step;
    };
  }
  return { router, controllers };
}

describe('Router', () => {
  it('delivers each member\'s last good answer when a later round fails entirely', async () => {
    const timeout = new Error('Response timeout');
    const { router } = makeRouter({
      claude: [GOOD('NO'), timeout],
      grok: [GOOD('NO'), timeout],
      gemini: [GOOD('NO'), timeout]
    });
    let consensus = null;
    router.on('consensus', (d) => { consensus = d; });

    const result = await router.run('test question');

    assert.equal(result.success, true);
    assert.equal(result.noConsensus, true);
    assert.ok(result.answer.startsWith('SESSION ENDED EARLY'));
    assert.ok(result.answer.includes('A complete answer.'));
    assert.deepEqual(Object.keys(consensus.answers).sort(), ['claude', 'gemini', 'grok']);
  });

  it('does not relay a dropped member as "null" to the others', async () => {
    const { router, controllers } = makeRouter({
      claude: [GOOD('NO'), GOOD('NO'), GOOD('YES'), GOOD('YES')],
      grok: [GOOD('NO'), new Error('Response timeout')],
      gemini: [GOOD('NO'), GOOD('NO'), GOOD('YES'), GOOD('YES')]
    });
    await router.run('test question');

    // Round 3 relay is built from round 2, where grok failed
    const round3 = controllers.claude.sent[2];
    assert.ok(round3.includes("Member 1's Answer"));
    assert.ok(!round3.includes("Member 2's Answer"));
    assert.ok(!round3.includes('null'));
    assert.ok(!round3.includes('[ERROR'));
  });

  it('ends with individual answers once fewer than two members remain', async () => {
    const timeout = new Error('Response timeout');
    const { router, controllers } = makeRouter({
      claude: [GOOD('NO'), GOOD('YES'), GOOD('YES'), GOOD('YES')],
      grok: [GOOD('NO'), timeout],
      gemini: [GOOD('NO'), timeout]
    });
    const result = await router.run('test question');

    assert.equal(result.noConsensus, true);
    assert.equal(result.rounds, 2); // stopped, instead of claude agreeing with itself for 8 more rounds
    assert.equal(controllers.claude.sent.length, 2);
    assert.ok(result.answer.includes('A complete answer.'));
  });

  it('drops a member whose tab hangs while typing instead of stalling the session', async () => {
    const { router, controllers } = makeRouter({
      claude: [GOOD('NO'), GOOD('YES'), GOOD('YES')],
      grok: [GOOD('NO'), GOOD('YES'), GOOD('YES')],
      gemini: [GOOD('NO')]
    });
    router.txTimeoutMs = 50;
    router.txTimeoutPer1kMs = 0;
    let geminiSends = 0;
    controllers.gemini.sendMessage = async () => {
      if (++geminiSends > 1) return new Promise(() => {}); // frozen tab from round 2 on
    };
    const result = await Promise.race([
      router.run('test question'),
      new Promise((resolve) => setTimeout(() => resolve('still running'), 3000))
    ]);
    assert.notEqual(result, 'still running');
    assert.ok(router.disabledAIs.has('gemini'));
    assert.equal(result.success, true);
  });

  it('consults an outside site when a majority asks, and relays the reply to everyone', async () => {
    const WANTS = (vote) => GOOD(vote).replace('FEEDBACK:', 'CONSULT: acme.example | What is the X200 torque?\n\nFEEDBACK:');
    const asked = [];
    const { router, controllers } = makeRouter({
      claude: [WANTS('NO'), GOOD('YES'), GOOD('YES')],
      grok: [WANTS('NO'), GOOD('YES'), GOOD('YES')],
      gemini: [GOOD('NO'), GOOD('YES'), GOOD('YES')]
    }, {
      consult: async (url, question) => { asked.push({ url, question }); return 'The X200 has 65 Nm of torque.'; }
    });
    await router.run('test question');

    assert.deepEqual(asked, [{ url: 'https://acme.example/', question: 'What is the X200 torque?' }]);
    for (const name of ['claude', 'grok', 'gemini']) {
      assert.ok(controllers[name].sent[1].includes('=== Outside consultation: acme.example ==='));
      assert.ok(controllers[name].sent[1].includes('The X200 has 65 Nm of torque.'));
      // Only the round right after the consultation carries it
      assert.ok(!controllers[name].sent[2].includes('Outside consultation'));
    }
  });

  it('does not consult when only a minority asks', async () => {
    const WANTS = (vote) => GOOD(vote) + '\nCONSULT: acme.example | torque?';
    let asked = 0;
    const { router, controllers } = makeRouter({
      claude: [WANTS('NO'), GOOD('YES'), GOOD('YES')],
      grok: [GOOD('NO'), GOOD('YES'), GOOD('YES')],
      gemini: [GOOD('NO'), GOOD('YES'), GOOD('YES')]
    }, { consult: async () => { asked++; return 'reply'; } });
    await router.run('test question');

    assert.equal(asked, 0);
    assert.ok(!controllers.claude.sent[1].includes('Outside consultation'));
  });

  it('tells the members when a consultation fails instead of stalling', async () => {
    const WANTS = (vote) => GOOD(vote) + '\nCONSULT: acme.example | torque?';
    const { router, controllers } = makeRouter({
      claude: [WANTS('NO'), GOOD('YES'), GOOD('YES')],
      grok: [WANTS('NO'), GOOD('YES'), GOOD('YES')],
      gemini: [WANTS('NO'), GOOD('YES'), GOOD('YES')]
    }, { consult: async () => { throw new Error('no chat prompt entry found'); } });
    const result = await router.run('test question');

    assert.equal(result.success, true);
    assert.ok(controllers.gemini.sent[1].includes('could not get a reply (no chat prompt entry found)'));
  });

  it('drops a member that hits its usage limit and carries on with the rest', async () => {
    const limit = new Error('grok: usage limit reached: You have reached your message limit');
    limit.code = 'USAGE_LIMIT';
    // A dropped member's last NO holds off consensus for two rounds
    const yes = Array(6).fill(GOOD('YES'));
    const { router } = makeRouter({
      claude: [GOOD('NO'), ...yes],
      grok: [GOOD('NO'), limit],
      gemini: [GOOD('NO'), ...yes]
    });
    const statuses = [];
    router.on('ai-status', (d) => { if (d.name === 'grok') statuses.push(d.status); });
    const result = await router.run('test question');

    assert.ok(statuses.includes('LIMIT'));
    assert.ok(router.disabledAIs.has('grok'));
    assert.equal(result.success, true);
    assert.ok(!result.noConsensus); // the remaining two still reached consensus
  });

  it('skips a member whose page already shows a usage-limit notice before sending', async () => {
    const { router, controllers } = makeRouter({
      claude: [GOOD('NO'), GOOD('YES'), GOOD('YES')],
      grok: [GOOD('NO'), GOOD('YES'), GOOD('YES')],
      gemini: [GOOD('NO'), GOOD('YES'), GOOD('YES')]
    });
    controllers.gemini.detectUsageLimit = async () => "You've reached your limit for today";
    await router.run('test question');

    assert.equal(controllers.gemini.sent.length, 0);
    assert.ok(router.disabledAIs.has('gemini'));
  });

  it('advanceRound stops waiting on pending members', async () => {
    const { router } = makeRouter({
      claude: [GOOD('NO'), GOOD('YES'), GOOD('YES')],
      grok: [GOOD('NO'), GOOD('YES'), GOOD('YES')],
      gemini: ['hang']
    });
    const run = router.run('test question');
    setTimeout(() => assert.equal(router.advanceRound(), true), 50);
    const result = await Promise.race([
      run,
      new Promise((resolve) => setTimeout(() => resolve('still running'), 3000))
    ]);
    assert.notEqual(result, 'still running');
    assert.ok(router.disabledAIs.has('gemini'));
    assert.equal(router.advanceRound(), false); // nothing pending any more
  });

  it('re-sends to a member whose site replies "try again" instead of dropping it', async () => {
    const siteErr = () => Object.assign(new Error('gemini: site returned an error: I encountered an error'), { code: 'SITE_ERROR' });
    const { router, controllers } = makeRouter({
      claude: [GOOD('NO'), GOOD('YES'), GOOD('YES')],
      grok: [GOOD('NO'), GOOD('YES'), GOOD('YES')],
      gemini: [GOOD('NO'), siteErr(), GOOD('YES'), GOOD('YES')]
    });
    const result = await router.run('test question');

    assert.ok(!router.disabledAIs.has('gemini'));
    assert.ok(!result.noConsensus);
    // Round 2's message went to gemini twice: the original and the retry
    assert.equal(controllers.gemini.sent[1], controllers.gemini.sent[2]);
  });

  it('drops a member that keeps returning site errors after the retries', async () => {
    const siteErr = () => Object.assign(new Error('gemini: site returned an error'), { code: 'SITE_ERROR' });
    const { router, controllers } = makeRouter({
      claude: [GOOD('NO'), ...Array(6).fill(GOOD('YES'))],
      grok: [GOOD('NO'), ...Array(6).fill(GOOD('YES'))],
      gemini: [GOOD('NO'), siteErr(), siteErr(), siteErr()]
    });
    await router.run('test question');

    assert.ok(router.disabledAIs.has('gemini'));
    assert.equal(controllers.gemini.sent.length, 1 + 1 + router.siteErrorRetries);
  });

  it('gives longer messages more time to type', () => {
    const { router } = makeRouter({ claude: [], grok: [], gemini: [] });
    assert.equal(router.txTimeoutFor('x'.repeat(14000)), router.txTimeoutMs + 14 * router.txTimeoutPer1kMs);
  });

  it('relays one current draft after the first unification round', async () => {
    const DRAFT = (vote) => `ANSWER:\nUnified draft text.\n\nAGREE: ${vote}`;
    const { router, controllers } = makeRouter({
      claude: [GOOD('NO'), GOOD('YES'), DRAFT('YES'), GOOD('YES')],
      grok: [GOOD('NO'), GOOD('YES'), DRAFT('YES'), GOOD('YES')],
      gemini: [GOOD('NO'), GOOD('YES'), 'ANSWER:\nGemini version without a vote.', GOOD('YES')]
    });
    await router.run('test question');

    const firstUnify = controllers.claude.sent[2];
    assert.ok(firstUnify.includes("Member 1's Answer"));
    const second = controllers.claude.sent[3];
    assert.ok(second.includes('=== Current Draft ==='));
    assert.ok(second.includes('Unified draft text.'));
    assert.ok(!second.includes("Member 1's Answer"));
    // The member that didn't vote YES is still heard
    assert.ok(second.includes('Gemini version without a vote.'));
    assert.ok(second.includes('did not vote YES'));
  });

  it('abort ends a round that is still waiting on members', async () => {
    const { router } = makeRouter({
      claude: ['hang'],
      grok: ['hang'],
      gemini: ['hang']
    });
    const run = router.run('test question');
    setTimeout(() => router.abort(), 20);

    const result = await Promise.race([
      run,
      new Promise((resolve) => setTimeout(() => resolve('still running'), 2000))
    ]);
    assert.deepEqual(result, { success: false, reason: 'ABORTED' });
  });
});
