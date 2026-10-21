'use strict';

const { session } = require('electron');

const partitions = {
  claude: 'persist:claude',
  grok: 'persist:grok',
  gemini: 'persist:gemini'
};

function getSession(aiName) {
  const partition = partitions[aiName];
  if (!partition) throw new Error(`Unknown AI: ${aiName}`);
  return session.fromPartition(partition);
}

function getAllSessions() {
  return Object.fromEntries(
    Object.entries(partitions).map(([name, part]) => [name, session.fromPartition(part)])
  );
}

module.exports = { getSession, getAllSessions, partitions };
