'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseResponse, extractVote, extractSections, extractConsensusAnswer } = require('../../src/protocol/message-parser.js');

describe('extractVote', () => {
  it('should detect YES vote', () => {
    assert.equal(extractVote('I agree. VOTE: YES\n**END**'), 'YES');
  });

  it('should detect NO vote', () => {
    assert.equal(extractVote('I disagree. VOTE: NO\nReason: ...\n**END**'), 'NO');
  });

  it('should use the last marker when an earlier one is quoted', () => {
    assert.equal(extractVote('FEEDBACK:\nMember 2 wrote AGREE: YES, but I see gaps.\n\nAGREE: NO\nNeeds work.'), 'NO');
    assert.equal(extractVote('Last round I said AGREE: NO.\n\n**AGREE: YES**'), 'YES');
  });

  it('should return null when no vote', () => {
    assert.equal(extractVote('Some text without a vote'), null);
  });
});

describe('parseResponse', () => {
  it('should parse a complete response with vote and sections', () => {
    const text = `RESULT:
The answer is 4.

VOTE: YES

**END**`;
    const parsed = parseResponse(text);
    assert.equal(parsed.vote, 'YES');
    assert.equal(parsed.complete, true);
    assert.ok(parsed.sections.RESULT.includes('The answer is 4'));
  });

  it('should handle incomplete response', () => {
    const parsed = parseResponse('Still thinking...');
    assert.equal(parsed.complete, false);
    assert.equal(parsed.vote, null);
  });

  it('should handle null input', () => {
    const parsed = parseResponse(null);
    assert.equal(parsed.vote, null);
    assert.equal(parsed.complete, false);
  });
});

describe('extractSections', () => {
  it('should read ANSWER content that starts on the header line', () => {
    const s = extractSections('ANSWER:Use Ollama.\nMore detail.\n\nFEEDBACK:\nGood points.\n\nAGREE: YES');
    assert.equal(s.ANSWER, 'Use Ollama.\nMore detail.');
    assert.equal(s.FEEDBACK, 'Good points.');
    assert.equal(s.RESULT, s.ANSWER);
  });

  it('should skip a repeated empty header', () => {
    const s = extractSections('ANSWER:\n\nANSWER:\n\nThe real answer.\n\nFEEDBACK:\nNone.\n\nAGREE: NO');
    assert.equal(s.ANSWER, 'The real answer.');
  });

  it('should not treat the word inside a sentence as a header', () => {
    const s = extractSections('ANSWER:\nYour ANSWER: must be complete, the guide says.\nSecond line.\n\nAGREE: YES');
    assert.equal(s.ANSWER, 'Your ANSWER: must be complete, the guide says.\nSecond line.');
  });

  it('should handle bold markdown headers', () => {
    const s = extractSections('**ANSWER:**\nBold answer.\n\n**FEEDBACK:**\nBold feedback.\n\n**AGREE: YES**');
    assert.equal(s.ANSWER, 'Bold answer.');
    assert.equal(s.FEEDBACK, 'Bold feedback.');
  });
});

describe('extractConsensusAnswer', () => {
  it('should prefer RESULT section', () => {
    const responses = {
      claude: { sections: { RESULT: 'The answer is 42' }, raw: 'full text claude' },
      grok: { sections: { PROPOSED: 'Maybe 42' }, raw: 'full text grok' },
      gemini: { sections: {}, raw: 'short' }
    };
    assert.equal(extractConsensusAnswer(responses), 'The answer is 42');
  });

  it('should fall back to longest PROPOSED or raw', () => {
    const responses = {
      claude: { sections: {}, raw: 'short' },
      grok: { sections: { PROPOSED: 'This is a longer proposed answer with detail' }, raw: 'x' },
      gemini: { sections: {}, raw: 'medium text' }
    };
    assert.equal(extractConsensusAnswer(responses), 'This is a longer proposed answer with detail');
  });
});
