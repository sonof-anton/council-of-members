'use strict';

const AI_NAMES = ['claude', 'grok', 'gemini'];

const AI_URLS = {
  claude: 'https://claude.ai/new',
  grok: 'https://grok.com/',
  gemini: 'https://gemini.google.com/app'
};

const AI_LABELS = {
  claude: 'MEMBER 1',
  grok: 'MEMBER 2',
  gemini: 'MEMBER 3'
};

// Anonymous labels used in protocol messages sent to the AIs
const AI_MEMBER_LABELS = {
  claude: 'Member 1',
  grok: 'Member 2',
  gemini: 'Member 3'
};

const PROTOCOL_VERSION = 'v1.3';
const MAX_ROUNDS = 10;
const POLL_INTERVAL_MS = 500;
const RESPONSE_TIMEOUT_MS = 180000;

// Per-member timeouts — Gemini's deep-thinking mode regularly exceeds 180s
const RESPONSE_TIMEOUT_PER_MEMBER = {
  claude: 180000,
  grok: 180000,
  // 15 minutes — Gemini deep-thinks for 2-3 min on typical prompts, but a
  // heavy prompt (e.g. a code review carrying full source files, ~25k
  // chars) has been observed running right up against a 5, then 10-minute
  // ceiling without finishing. Unclear yet whether it's genuinely still
  // working that whole time or something server-side silently resets the
  // conversation on this large a payload — giving it more headroom to tell
  // those apart before concluding it's a hard failure rather than latency.
  gemini: 900000
};
const END_MARKER = '**END**'; // Optional — stability detection works without it
const VOTE_YES = 'VOTE: YES';
const VOTE_NO = 'VOTE: NO';
const AGREE_YES = 'AGREE: YES';
const AGREE_NO = 'AGREE: NO';

const PHASES = {
  IDLE: 'IDLE',
  TRANSMITTING: 'TRANSMITTING',
  WAITING: 'WAITING',
  COLLECTING: 'COLLECTING',
  COMBINING: 'COMBINING',
  CONSENSUS: 'CONSENSUS',
  UNIFYING: 'UNIFYING',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED'
};

module.exports = {
  AI_NAMES,
  AI_URLS,
  AI_LABELS,
  AI_MEMBER_LABELS,
  PROTOCOL_VERSION,
  MAX_ROUNDS,
  POLL_INTERVAL_MS,
  RESPONSE_TIMEOUT_MS,
  RESPONSE_TIMEOUT_PER_MEMBER,
  END_MARKER,
  VOTE_YES,
  VOTE_NO,
  AGREE_YES,
  AGREE_NO,
  PHASES
};
