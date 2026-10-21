'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { checkConsensus } = require('../../src/protocol/consensus-detector.js');

describe('checkConsensus', () => {
  it('should return reached=true when all vote YES', () => {
    const parsed = {
      claude: { vote: 'YES' },
      grok: { vote: 'YES' },
      gemini: { vote: 'YES' }
    };
    const result = checkConsensus(parsed);
    assert.equal(result.reached, true);
    assert.deepEqual(result.votes, { claude: 'YES', grok: 'YES', gemini: 'YES' });
  });

  it('should return reached=false when one votes NO', () => {
    const parsed = {
      claude: { vote: 'YES' },
      grok: { vote: 'NO' },
      gemini: { vote: 'YES' }
    };
    const result = checkConsensus(parsed);
    assert.equal(result.reached, false);
    assert.equal(result.votes.grok, 'NO');
  });

  it('should return reached=false when a vote is missing', () => {
    const parsed = {
      claude: { vote: 'YES' },
      grok: { vote: null },
      gemini: { vote: 'YES' }
    };
    const result = checkConsensus(parsed);
    assert.equal(result.reached, false);
    assert.equal(result.votes.grok, 'PENDING');
  });

  it('should handle missing AI entirely', () => {
    const parsed = {
      claude: { vote: 'YES' },
      grok: null,
      gemini: { vote: 'YES' }
    };
    const result = checkConsensus(parsed);
    assert.equal(result.reached, false);
    assert.equal(result.votes.grok, 'MISSING');
  });

  it('should return reached=false when all vote NO', () => {
    const parsed = {
      claude: { vote: 'NO' },
      grok: { vote: 'NO' },
      gemini: { vote: 'NO' }
    };
    const result = checkConsensus(parsed);
    assert.equal(result.reached, false);
  });
});
