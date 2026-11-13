'use strict';

const AI_NAMES = ['claude', 'grok', 'gemini'];

// Each member seat is a chat page on one domain of the domain library
// (src/automation/domain-library.json), which holds that page's selectors.
const MEMBER_DOMAINS = {
  claude: 'claude.ai',
  grok: 'grok.com',
  gemini: 'gemini.google.com'
};

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
// A lone member agreeing with itself is not a council consensus
const MIN_CONSENSUS_MEMBERS = 2;
const POLL_INTERVAL_MS = 500;
// Typing + clicking send into one member. A frozen tab never settles its
// executeJavaScript/insertText calls (seen on Gemini right after a 36 MB
// upload), which would otherwise stall the whole session.
const TX_TIMEOUT_MS = 120000;
// Plus this much per 1,000 chars sent: Gemini's typing time grows with the
// message (8.5k chars took 34s, 14k took 76s on 2026-11-10) and a flat 120s
// dropped it mid-unification.
const TX_TIMEOUT_PER_1K_MS = 10000;
// A member replying with its site's own "try again" error is re-sent the
// same message this many times before being dropped.
const SITE_ERROR_RETRIES = 2;
// Upload waits scale with file size up to 15 min (BrowserController)
const ATTACH_TIMEOUT_MS = 16 * 60000;

const RESPONSE_TIMEOUT_MS = 180000;

// Outside consultations: a chat service on another site that a majority of
// members ask the Chancellor to consult. Its replies are short, so the
// member-sized minimum answer length doesn't apply.
const CONSULT_TIMEOUT_MS = 180000;
const CONSULT_MIN_REPLY_LENGTH = 20;
const MAX_CONSULTS_PER_SESSION = 3;

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
  CONSULTING: 'CONSULTING',
  ABORTED: 'ABORTED'
};

module.exports = {
  AI_NAMES,
  AI_URLS,
  MEMBER_DOMAINS,
  AI_LABELS,
  AI_MEMBER_LABELS,
  PROTOCOL_VERSION,
  MAX_ROUNDS,
  MIN_CONSENSUS_MEMBERS,
  POLL_INTERVAL_MS,
  RESPONSE_TIMEOUT_MS,
  TX_TIMEOUT_MS,
  TX_TIMEOUT_PER_1K_MS,
  SITE_ERROR_RETRIES,
  ATTACH_TIMEOUT_MS,
  RESPONSE_TIMEOUT_PER_MEMBER,
  CONSULT_TIMEOUT_MS,
  CONSULT_MIN_REPLY_LENGTH,
  MAX_CONSULTS_PER_SESSION,
  END_MARKER,
  VOTE_YES,
  VOTE_NO,
  AGREE_YES,
  AGREE_NO,
  PHASES
};
