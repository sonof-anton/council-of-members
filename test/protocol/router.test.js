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
function makeRouter(scripts) {
  const controllers = {
    claude: fakeController('claude'),
    grok: fakeController('grok'),
    gemini: fakeController('gemini')
  };
  const router = new Router(controllers);
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
