'use strict';

// Looks up the chat-page profile for a domain. Every profile carries the
// standard attributes promptEntry, sendButton, response and loggedIn; a
// domain not in the library gets the '_generic' profile.

const library = require('./domain-library.json');

// Phrases any chat service uses when an account runs out of messages.
// Domain profiles add their own wording on top.
const GENERIC_USAGE_LIMIT = [
  "(?:you've|you have) (?:reached|hit|exceeded) (?:your|the) (?:\\w+ )?limit",
  'usage limit (?:reached|exceeded)',
  'message limit (?:reached|exceeded)',
  'out of (?:free )?messages'
];

function hostOf(urlOrDomain) {
  try {
    return new URL(urlOrDomain).hostname.replace(/^www\./, '');
  } catch {
    return String(urlOrDomain || '').replace(/^www\./, '');
  }
}

function getProfile(urlOrDomain) {
  const host = hostOf(urlOrDomain);
  // Exact domain first, then a parent domain (e.g. chat.example.com → example.com)
  let domain = Object.keys(library).find(d => !d.startsWith('_') && (host === d || host.endsWith('.' + d)));
  const profile = domain ? library[domain] : library._generic;
  return {
    domain: domain || host,
    known: !!domain,
    ...profile,
    usageLimit: [...(profile.usageLimit || []), ...GENERIC_USAGE_LIMIT]
  };
}

module.exports = { getProfile, hostOf, library, GENERIC_USAGE_LIMIT };
