'use strict';

const { AI_NAMES, MIN_CONSENSUS_MEMBERS } = require('../utils/constants.js');

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

  if (names.length < MIN_CONSENSUS_MEMBERS) {
    allVotedYes = false;
  }

  return {
    reached: allVotedYes,
    votes
  };
}

module.exports = { checkConsensus };
