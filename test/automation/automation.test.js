'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getProfile } = require('../../src/automation/domain-library.js');
const ConsultController = require('../../src/automation/consult-controller.js');
const GrokAdapter = require('../../src/automation/adapters/grok-adapter.js');
const BrowserController = require('../../src/automation/browser-controller.js');

describe('domain library', () => {
  it('gives every member domain the four standard attributes', () => {
    for (const domain of ['claude.ai', 'grok.com', 'gemini.google.com']) {
      const p = getProfile(domain);
      assert.equal(p.known, true);
      assert.ok(p.promptEntry.selectors.length > 0, `${domain} promptEntry`);
      assert.ok(p.sendButton.length > 0, `${domain} sendButton`);
      assert.ok(p.response.length > 0, `${domain} response`);
      assert.ok(p.loggedIn.length > 0, `${domain} loggedIn`);
    }
  });

  it('matches a URL or subdomain, and falls back to the generic profile', () => {
    assert.equal(getProfile('https://claude.ai/new').domain, 'claude.ai');
    assert.equal(getProfile('https://www.homedepot.com/help').known, false);
    assert.equal(getProfile('https://www.homedepot.com/help').domain, 'homedepot.com');
    assert.ok(getProfile('https://example.com').promptEntry.selectors.includes('textarea:not([disabled])'));
  });
});

describe('usage limit text', () => {
  const c = new BrowserController('grok', { executeJavaScript: async () => null });

  it('recognizes limit notices', () => {
    assert.ok(c.matchUsageLimit("You've reached your limit of 25 messages. Upgrade for more."));
    assert.ok(c.matchUsageLimit('Too many requests. Please slow down.'));
    assert.ok(c.matchUsageLimit('You are out of free messages until 4 PM'));
  });

  it('ignores ordinary answers', () => {
    assert.equal(c.matchUsageLimit('ANSWER: The torque limit of the drill is 65 Nm.'), null);
    assert.equal(c.matchUsageLimit(''), null);
  });
});

describe('GrokAdapter.cleanGrokResponse', () => {
  it('strips the collapsed step list above the answer', () => {
    const raw = '+2 more\nRefining the review based on member feedback\nRan 3 searches\nLoaded 1 skill\nWorked for 3m 12s\n\nANSWER:\nBlue.';
    assert.equal(GrokAdapter.cleanGrokResponse(raw), 'ANSWER:\nBlue.');
  });

  it('strips agent status lines before ANSWER but keeps a real preface', () => {
    const agent = "I'll review both files in detail and check the HUD palette.\nRan command\nFind project files and hud.css\n\nANSWER:\nDone.";
    assert.equal(GrokAdapter.cleanGrokResponse(agent), 'ANSWER:\nDone.');
    const preface = 'Other members still have not produced a usable review, so this is the same complete answer, tightened only where the last pass already settled the facts and nothing else changed since then.\n\nANSWER:\nDone.';
    assert.equal(GrokAdapter.cleanGrokResponse(preface), preface);
  });
});

describe('ConsultController.replyAfter', () => {
  const q = 'What is the max torque of the Acme X200 drill?';

  it('returns the text after the question minus the page footer', () => {
    const footer = ConsultController.replyAfter(`Help\n${q}\n...\nSend\nAcme © 2026 · Privacy`, q, null);
    const body = `Help\n${q}\nThe X200 has 65 Nm. Anything else?\nSend\nAcme © 2026 · Privacy`;
    assert.equal(ConsultController.replyAfter(body, q, footer), 'The X200 has 65 Nm. Anything else?');
  });

  it('uses the last time the question appears and handles a missing question', () => {
    assert.equal(ConsultController.replyAfter(`${q} old reply ${q} new reply`, q, ''), 'new reply');
    assert.equal(ConsultController.replyAfter('nothing here', q, ''), null);
  });
});

describe('DomMonitor thoughts', () => {
  const DomMonitor = require('../../src/automation/dom-monitor.js');

  function monitor() {
    const seen = [];
    const m = new DomMonitor({ aiName: 'x', onThought: (t) => seen.push(t) });
    return { m, seen };
  }

  it('shows the latest short status line and clears it once the answer arrives', () => {
    const { m, seen } = monitor();
    m.trackThought('Analyzing the request');
    m.trackThought('Analyzing the request\nChecking sources');
    m.trackThought('x'.repeat(600));
    assert.deepEqual(seen, ['Analyzing the request', 'Checking sources', '']);
  });

  it('does not treat the start of a streaming answer as a thought', () => {
    const { m, seen } = monitor();
    m.trackThought('Thinking about it');
    m.trackThought('ANSWER:\nSunlight looks white, but it is actually');
    assert.deepEqual(seen, ['Thinking about it', '']);
  });

  it('only reports changes', () => {
    const { m, seen } = monitor();
    m.trackThought('Same');
    m.trackThought('Same');
    m.setThought('');
    m.setThought('');
    assert.deepEqual(seen, ['Same', '']);
  });
});
