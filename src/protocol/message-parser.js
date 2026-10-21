'use strict';

const { END_MARKER } = require('../utils/constants.js');

function parseResponse(text) {
  if (!text) return { vote: null, sections: {}, complete: false, raw: '' };

  const complete = text.includes(END_MARKER);
  const vote = extractVote(text);
  const sections = extractSections(text);

  return { vote, sections, complete, raw: text };
}

// Wide syntax range for vote detection to avoid missed votes.
// Matches variations like:
//   AGREE: YES, AGREE:YES, Agree: Yes, **AGREE: YES**, AGREE - YES
//   VOTE: YES, Vote: Yes, **VOTE: YES**
//   I agree, I agree with this, I'm in agreement
//   Agree: yes — ..., AGREE: YES!, etc.
function extractVote(text) {
  // Normalize: strip markdown bold/italic markers and underscores for matching
  const normalized = text.replace(/[*_~`]+/g, '');

  // Explicit AGREE/VOTE markers — flexible spacing and punctuation
  // Separator is optional: handles "AGREE: YES", "AGREE YES", "AGREE:YES", "AGREE - YES", etc.
  // Use the LAST marker: the member's own vote closes the response, while
  // earlier markers are usually quotes ("Member 2 said AGREE: YES, but...").
  const markers = [...normalized.matchAll(/\b(?:AGREE|VOTE)\s*[:\s=\-–—]*\s*(YES|NO)\b/gi)];
  if (markers.length > 0) return markers[markers.length - 1][1].toUpperCase();

  // "Agree" or "Agreed" followed by context clues
  if (/\bI\s+agree\b/i.test(normalized)) return 'YES';
  if (/\bI('m| am)\s+in\s+agreement\b/i.test(normalized)) return 'YES';
  if (/\bagreed\b/i.test(normalized) && /\b(final|consensus|ready|satisfied|comprehensive)\b/i.test(normalized)) return 'YES';

  // "I disagree" / "I don't agree" / "I do not agree"
  if (/\bI\s+(disagree|don'?t\s+agree|do\s+not\s+agree)\b/i.test(normalized)) return 'NO';

  // Check for AGREE/VOTE header anywhere in text, then look for YES/NO nearby
  const agreeMatch = normalized.match(/\b(AGREE|VOTE)\b[^\n]*/i);
  if (agreeMatch) {
    const line = agreeMatch[0];
    if (/\bYES\b/i.test(line)) return 'YES';
    if (/\bNO\b/i.test(line)) return 'NO';
  }

  return null;
}

function extractSections(text) {
  const sections = {};
  const sectionNames = ['ANSWER', 'RESULT', 'FEEDBACK', 'REVIEW', 'PROPOSED', 'QUESTION', 'REASONING'];

  for (const name of sectionNames) {
    const pattern = new RegExp(`${name}[:\\s]*\\n([\\s\\S]*?)(?=\\n(?:${sectionNames.join('|')}|VOTE:|AGREE:|\\*\\*END\\*\\*)|$)`, 'i');
    const match = text.match(pattern);
    if (match) {
      sections[name] = match[1].trim();
    }
  }

  // Normalize: if ANSWER present but not RESULT, copy ANSWER to RESULT for downstream compat
  if (sections.ANSWER && !sections.RESULT) {
    sections.RESULT = sections.ANSWER;
  }
  // Same for FEEDBACK -> REVIEW
  if (sections.FEEDBACK && !sections.REVIEW) {
    sections.REVIEW = sections.FEEDBACK;
  }

  return sections;
}

function extractConsensusAnswer(responses) {
  for (const [, parsed] of Object.entries(responses)) {
    if (parsed && parsed.sections && parsed.sections.RESULT) {
      return parsed.sections.RESULT;
    }
  }

  let longest = '';
  for (const [, parsed] of Object.entries(responses)) {
    if (!parsed) continue;
    const text = (parsed.sections && parsed.sections.PROPOSED) || parsed.raw || '';
    if (text.length > longest.length) {
      longest = text;
    }
  }

  return longest || 'Consensus reached but no structured answer extracted.';
}

module.exports = { parseResponse, extractVote, extractSections, extractConsensusAnswer };
