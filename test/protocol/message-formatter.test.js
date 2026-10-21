'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatInitialMessage, formatRelayMessage } = require('../../src/protocol/message-formatter.js');

describe('formatInitialMessage', () => {
  it('should include round number', () => {
    const msg = formatInitialMessage('What is 2+2?', 1);
    assert.ok(msg.includes('Round 1'));
  });

  it('should include the user prompt', () => {
    const msg = formatInitialMessage('Test question here', 1);
    assert.ok(msg.includes('Test question here'));
  });

  it('should include format rules and principles', () => {
    const msg = formatInitialMessage('test', 1);
    assert.ok(msg.includes('**END**'));
    assert.ok(msg.includes('VOTE: YES'));
    assert.ok(msg.includes('VOTE: NO'));
    assert.ok(msg.includes('RESULT'));
    assert.ok(msg.includes('REVIEW'));
    assert.ok(msg.includes('CONSTITUTION'));
    assert.ok(msg.includes('scientific method'));
  });

  it('should use anonymous member labels and not reveal AI names', () => {
    const msg = formatInitialMessage('test', 1);
    assert.ok(msg.includes('Member 1, Member 2, or Member 3'));
    assert.ok(!msg.includes('Claude'));
    assert.ok(!msg.includes('Grok'));
    assert.ok(!msg.includes('Gemini'));
  });
});

describe('formatRelayMessage', () => {
  it('should include all three member responses with anonymous labels', () => {
    const responses = {
      claude: 'First AI says hello',
      grok: 'Second AI says hi',
      gemini: 'Third AI says hey'
    };
    const msg = formatRelayMessage(responses, 2);

    assert.ok(msg.includes("Member 1's Answer"));
    assert.ok(msg.includes('First AI says hello'));
    assert.ok(msg.includes("Member 2's Answer"));
    assert.ok(msg.includes('Second AI says hi'));
    assert.ok(msg.includes("Member 3's Answer"));
    assert.ok(msg.includes('Third AI says hey'));
    // Should NOT contain real AI names
    assert.ok(!msg.includes('CLAUDE'));
    assert.ok(!msg.includes('GROK'));
    assert.ok(!msg.includes('GEMINI'));
  });

  it('should reference previous round', () => {
    const msg = formatRelayMessage({ claude: 'a', grok: 'b', gemini: 'c' }, 3);
    assert.ok(msg.includes('Round 2'));
    assert.ok(msg.includes('Round 3'));
  });

  it('should include peer review instructions', () => {
    const msg = formatRelayMessage({ claude: 'a', grok: 'b', gemini: 'c' }, 2);
    assert.ok(msg.includes('REVIEW'));
    assert.ok(msg.includes('critique'));
  });
});
