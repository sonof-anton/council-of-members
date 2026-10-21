'use strict';

const { AI_NAMES } = require('../utils/constants.js');

function checkConsensus(parsedResponses, activeAIs) {
  const names = activeAIs || AI_NAMES;
  const votes = {};
  let allVotedYes = true;

  for (const name of names) {
    const parsed = parsedResponses[name];
    if (!parsed || parsed.vote !== 'YES') {
      allVotedYes = false;
      votes[name] = parsed ? (parsed.vote || 'PENDING') : 'MISSING';
    } else {
      votes[name] = 'YES';
    }
  }

  // Need at least 1 active member who responded
  if (names.length < 1) {
    allVotedYes = false;
  }

  return {
    reached: allVotedYes,
    votes
  };
}

module.exports = { checkConsensus };
