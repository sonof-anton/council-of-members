'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseResponse, extractVote, extractSections, extractConsult, extractConsensusAnswer } = require('../../src/protocol/message-parser.js');

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

  it('should accept the wider vote syntax', () => {
    assert.equal(extractVote('**AGREEMENT: no**'), 'NO');
    assert.equal(extractVote('AGREED: YES'), 'YES');
    assert.equal(extractVote('Consensus: ✅'), 'YES');
    assert.equal(extractVote('AGREE: ❌ — needs work'), 'NO');
    assert.equal(extractVote('AGREE: Y'), 'YES');
    assert.equal(extractVote('VOTE = TRUE'), 'YES');
    assert.equal(extractVote('AGREE: NAY'), 'NO');
    assert.equal(extractVote('AGREE [YES]'), 'YES');
  });

  it('should not read a vote out of a longer word', () => {
    assert.equal(extractVote('AGREE: Yesterday was fine'), null);
    assert.equal(extractVote('AGREE: NOT YET'), null);
  });
});

describe('extractConsult', () => {
  it('should read a CONSULT line with a bare domain', () => {
    assert.deepEqual(extractConsult('ANSWER:\nx\n\nCONSULT: homedepot.com | Is the DCD800 in stock?\n\nAGREE: NO'),
      { url: 'https://homedepot.com/', host: 'homedepot.com', question: 'Is the DCD800 in stock?' });
  });

  it('should accept markdown, a full URL and a dash separator', () => {
    assert.deepEqual(extractConsult('- **CONSULT:** https://www.bosch.com/support - what torque?'),
      { url: 'https://www.bosch.com/support', host: 'bosch.com', question: 'what torque?' });
  });

  it('should ignore lines without a website and a question', () => {
    assert.equal(extractConsult('CONSULT: none'), null);
    assert.equal(extractConsult('CONSULT: nothing | needed'), null);
    assert.equal(extractConsult('We could CONSULT: acme.com | q mid-sentence'), null);
    assert.equal(extractConsult('ANSWER: no consult here'), null);
  });

  it('should keep the CONSULT line out of the ANSWER section', () => {
    const parsed = parseResponse('ANSWER: hello\nCONSULT: acme.com | q\nAGREE: NO');
    assert.equal(parsed.sections.ANSWER, 'hello');
    assert.equal(parsed.consult.host, 'acme.com');
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
