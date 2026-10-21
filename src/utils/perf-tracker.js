'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('./logger.js');

const PERF_FILE = path.join(process.cwd(), 'logs', 'perf-stats.json');

class PerfTracker {
  constructor() {
    this.stats = {};
  }

  load() {
    try {
      if (fs.existsSync(PERF_FILE)) {
        const data = JSON.parse(fs.readFileSync(PERF_FILE, 'utf-8'));
        this.stats = data;
        log('info', `PerfTracker: Loaded stats for ${Object.keys(data).length} members`);
      }
    } catch (err) {
      log('warn', `PerfTracker: Failed to load stats: ${err.message}`);
      this.stats = {};
    }
  }

  record(name, responseMs, charsReceived) {
    if (!this.stats[name]) {
      this.stats[name] = { totalMs: 0, totalChars: 0, samples: 0 };
    }
    const s = this.stats[name];
    s.totalMs += responseMs;
    s.totalChars += charsReceived;
    s.samples += 1;
    log('info', `PerfTracker: ${name} responded in ${responseMs}ms (${charsReceived} chars, avg ${this.getMetric(name).toFixed(1)} ms/char)`);
  }

  save() {
    try {
      const logDir = path.dirname(PERF_FILE);
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(PERF_FILE, JSON.stringify(this.stats, null, 2));
    } catch (err) {
      log('warn', `PerfTracker: Failed to save stats: ${err.message}`);
    }
  }

  getMetric(name) {
    const s = this.stats[name];
    if (!s || s.totalChars === 0) return 0;
    return s.totalMs / s.totalChars;
  }

  getRanking() {
    const entries = Object.entries(this.stats)
      .filter(([, s]) => s.samples > 0 && s.totalChars > 0)
      .map(([name, s]) => ({ name, msPerChar: s.totalMs / s.totalChars }))
      .sort((a, b) => a.msPerChar - b.msPerChar);
    return entries;
  }

  reorder(names) {
    const ranking = this.getRanking();
    if (ranking.length === 0) return names;

    const rankMap = {};
    ranking.forEach((entry, idx) => { rankMap[entry.name] = idx; });

    return [...names].sort((a, b) => {
      const ra = rankMap[a] !== undefined ? rankMap[a] : 999;
      const rb = rankMap[b] !== undefined ? rankMap[b] : 999;
      return ra - rb;
    });
  }
}

module.exports = PerfTracker;
