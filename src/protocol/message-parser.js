'use strict';

const { END_MARKER } = require('../utils/constants.js');

function parseResponse(text) {
  if (!text) return { vote: null, sections: {}, complete: false, raw: '' };

  const complete = text.includes(END_MARKER);
  const vote = extractVote(text);
  const sections = extractSections(text);
  const consult = extractConsult(text);

  return { vote, sections, complete, raw: text, consult };
}

const VOTE_WORDS = {
  YES: 'YES', Y: 'YES', TRUE: 'YES', YAY: 'YES', AYE: 'YES', '✅': 'YES', '✔': 'YES', '👍': 'YES',
  NO: 'NO', N: 'NO', FALSE: 'NO', NAY: 'NO', '❌': 'NO', '✖': 'NO', '👎': 'NO'
};

// Wide syntax range for vote detection to avoid missed votes.
// Matches variations like:
//   AGREE: YES, AGREE:YES, Agree: Yes, **AGREE: YES**, AGREE - YES
//   VOTE: YES, Vote: Yes, **VOTE: YES**
//   I agree, I agree with this, I'm in agreement
//   Agree: yes — ..., AGREE: YES!, etc.
//   AGREEMENT: YES, AGREED: NO, CONSENSUS: YES
//   AGREE: Y / TRUE / YAY / AYE / ✅ (and the NO forms)
function extractVote(text) {
  // Normalize: strip markdown bold/italic markers and underscores for matching
  const normalized = text.replace(/[*_~`]+/g, '');

  // Explicit AGREE/VOTE markers — flexible spacing and punctuation
  // Separator is optional: handles "AGREE: YES", "AGREE YES", "AGREE:YES", "AGREE - YES", etc.
  // Use the LAST marker: the member's own vote closes the response, while
  // earlier markers are usually quotes ("Member 2 said AGREE: YES, but...").
  const markers = [...normalized.matchAll(/\b(?:AGREE(?:MENT|D)?|VOTE|CONSENSUS)\s*[:\s=\-–—[(]*\s*(YES|NO|Y|N|TRUE|FALSE|YAY|NAY|AYE|✅|✔|👍|❌|✖|👎)(?![\p{L}\p{N}_])/giu)];
  if (markers.length > 0) return VOTE_WORDS[markers[markers.length - 1][1].toUpperCase()];

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

  // A header is the name at the start of a line (optionally bold/heading
  // marked) followed by a colon or a line break. Content may start on the
  // same line — Gemini writes "ANSWER:To replicate..." — which the old
  // newline-required pattern missed, so the whole raw response (FEEDBACK,
  // AGREE and all) became the "answer".
  const names = sectionNames.join('|');
  const header = (n) => `(?:^|\\n)[ \\t*#]*(?:${n})[ \\t*]*(?::|(?=\\n))[ \\t*]*`;
  const end = `(?=${header(names)}|\\n[ \\t*]*(?:VOTE|AGREE|CONSULT)\\s*[:\\-]|\\*\\*END\\*\\*|$)`;

  for (const name of sectionNames) {
    const pattern = new RegExp(`${header(name)}([\\s\\S]*?)${end}`, 'gi');
    // Take the longest match: Claude's DOM often repeats the header
    // ("ANSWER:\n\nANSWER:\n\n..."), leaving an empty first match.
    let best = '';
    for (const match of text.matchAll(pattern)) {
      const content = match[1].trim();
      if (content.length > best.length) best = content;
    }
    if (best) {
      sections[name] = best;
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

// "CONSULT: <website> | <question>" — a member asking the Chancellor to
// consult an outside chat service. The separator may also be a dash; a bare
// domain gets https://. Returns { url, host, question } or null.
function extractConsult(text) {
  if (!text) return null;
  const normalized = text.replace(/[*_`]+/g, '');
  const matches = [...normalized.matchAll(/^[ \t>#-]*CONSULT[ \t]*:[ \t]*<?([^\s|<>]+?)>?[ \t]*(?:\||—|–|\s-\s)[ \t]*(.+)$/gim)];
  if (matches.length === 0) return null;
  const [, rawUrl, question] = matches[matches.length - 1];
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }
  if (!/\./.test(url.hostname) && url.hostname !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) return null;
  return { url: url.href, host: url.hostname.replace(/^www\./, ''), question: question.trim() };
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

module.exports = { parseResponse, extractVote, extractSections, extractConsult, extractConsensusAnswer };
