'use strict';

const { END_MARKER, POLL_INTERVAL_MS, RESPONSE_TIMEOUT_MS, RESPONSE_TIMEOUT_PER_MEMBER } = require('../utils/constants.js');
const { log } = require('../utils/logger.js');

// Responses shorter than this are likely loading indicators/thinking text.
// 200 was too low: on a long, complex prompt, Claude's thinking-status line
// ("Uncovering timeout gaps and stale-data risks in single-run mode") got
// captured duplicated 2-3x back to back (~205 chars) and slipped past this
// gate as if it were a real, stable final answer.
const MIN_RESPONSE_LENGTH = 500;

// How often (in polls) to scan the page for a usage-limit notice
const LIMIT_CHECK_EVERY = 10;

function usageLimitError(aiName, notice) {
  const err = new Error(`${aiName}: usage limit reached: ${notice}`);
  err.code = 'USAGE_LIMIT';
  return err;
}

class DomMonitor {
  constructor(controller) {
    this.controller = controller;
    this.lastThought = '';
  }

  // Thoughts mirror the member's own window: short in-progress text
  // ("Analyzing the request...") shows while it is on screen and clears the
  // moment it is replaced by the real answer or disappears.
  setThought(text) {
    const lines = text ? text.split('\n').map(l => l.trim()).filter(Boolean) : [];
    const thought = (lines.pop() || '').substring(0, 80);
    if (thought === this.lastThought) return;
    this.lastThought = thought;
    if (this.controller.onThought) this.controller.onThought(thought);
  }

  // A short reply is a thought; once it reaches answer length, or the
  // answer itself has started streaming in, it is not.
  trackThought(text) {
    const isThought = text && text.length < MIN_RESPONSE_LENGTH && !text.startsWith('[Round ') &&
      !/^\W*(?:ANSWER|RESULT)\W*:/im.test(text);
    this.setThought(isThought ? text : '');
  }

  activity(text, ind) {
    if (this.controller.onActivity) this.controller.onActivity(text, ind);
  }

  // baselineBefore: last response text captured before the message was sent
  // (preferred); when omitted it is read now, which can be too late.
  async waitForResponse(countBefore, baselineBefore) {
    this.lastThought = '';
    try {
      return await this._waitForResponse(countBefore, baselineBefore);
    } finally {
      this.setThought('');
    }
  }

  async _waitForResponse(countBefore, baselineBefore) {
    const startTime = Date.now();
    const aiName = this.controller.aiName;
    const timeoutMs = (RESPONSE_TIMEOUT_PER_MEMBER && RESPONSE_TIMEOUT_PER_MEMBER[aiName]) || RESPONSE_TIMEOUT_MS;
    let lastText = '';
    let lastIgnoredText = null;
    let stableCount = 0;
    const STABLE_THRESHOLD = 8; // 4 seconds at 500ms intervals (was 6/3s — too aggressive)

    // For body-text fallback: track if element counting is failing
    let bodyFallbackActive = false;
    let lastBodyLen = 0;
    let bodyStableCount = 0;

    // Capture the initial text of the last response before polling starts.
    // This is the previous round's response — when text changes from this,
    // we know a new response has arrived even if the count is stuck.
    let baselineText = baselineBefore !== undefined
      ? baselineBefore
      : await this.controller.getLastResponseText().catch(() => null);
    let textFallbackActive = false;
    let textStableCount = 0;

    log('info', `${aiName}: Polling for new response (count before: ${countBefore})`);
    this.activity('Waiting for reply to start', 'wait');
    let pollCount = 0;
    let lastLoggedAt = startTime;

    while (Date.now() - startTime < timeoutMs || (this.controller.isWaiting && this.controller.isWaiting())) {
      if (this.controller.isAborted && this.controller.isAborted()) {
        throw new Error(`${aiName}: aborted`);
      }
      const currentCount = await this.controller.getResponseCount();
      pollCount++;

      // A member out of messages never answers; drop it now instead of
      // waiting out its full timeout.
      if (pollCount % LIMIT_CHECK_EVERY === 0 && this.controller.detectUsageLimit) {
        const notice = await this.controller.detectUsageLimit();
        if (notice) throw usageLimitError(aiName, notice);
      }

      // Log progress every 30 seconds so we can diagnose stuck polling
      const now = Date.now();
      const elapsedSec = Math.round((now - startTime) / 1000);
      if (now - lastLoggedAt >= 30000) {
        log('warn', `${aiName}: Still polling after ${elapsedSec}s (count: ${currentCount}, need: >${countBefore}, polls: ${pollCount})`);
        lastLoggedAt = now;

        // Diagnostic: if count is stuck at 0/same, dump DOM structure for debugging
        if (currentCount <= countBefore && this.controller.dumpResponseStructure) {
          const dump = await this.controller.dumpResponseStructure().catch(() => null);
          if (dump) log('warn', `${aiName}: DOM dump:\n${dump}`);
        }
      }

      // After 15s of stuck count, activate body-text fallback if available
      if (!bodyFallbackActive && elapsedSec >= 15 && currentCount <= countBefore && this.controller.getBodyTextResponse) {
        bodyFallbackActive = true;
        const bodyData = await this.controller.getBodyTextResponse().catch(() => null);
        if (bodyData) {
          lastBodyLen = bodyData.len;
          log('info', `${aiName}: Activating body-text fallback (current body len: ${lastBodyLen})`);
        }
      }

      // After 10s of stuck count, activate text-change fallback.
      // Compares getLastResponseText() against the baseline captured before send.
      // This catches cases where DOM virtualization prevents count from incrementing
      // (e.g. Claude.ai removes off-screen rows, keeping count flat even as new
      // responses arrive). 10s gives the normal count path a fair chance first.
      if (!textFallbackActive && elapsedSec >= 10 && currentCount <= countBefore) {
        textFallbackActive = true;
        log('info', `${aiName}: Activating text-change fallback (baseline: ${baselineText ? baselineText.length + ' chars' : 'null'})`);
      }

      if (currentCount <= countBefore) {
        this.activity(`Waiting for reply to start (${elapsedSec}s)${textFallbackActive ? ' · watching text' : ''}`, 'wait');
      }

      if (textFallbackActive && currentCount <= countBefore) {
        const currentText = await this.controller.getLastResponseText().catch(() => null);
        if (currentText && currentText !== baselineText) this.trackThought(currentText);
        if (currentText && currentText.length >= MIN_RESPONSE_LENGTH && !currentText.startsWith('[Round ')) {
          // Check if text differs from baseline (new response appeared)
          if (currentText !== baselineText) {
            if (currentText === lastText) {
              textStableCount++;
              this.activity(`Reply settling ${textStableCount}/${STABLE_THRESHOLD} (${currentText.length} chars)`, 'settle');
              if (textStableCount >= STABLE_THRESHOLD) {
                log('info', `${aiName}: Response detected via text-change fallback (${currentText.length} chars)`);
                return currentText;
              }
            } else {
              textStableCount = 0;
              lastText = currentText;
              this.activity(`Reply streaming (${currentText.length} chars)`, 'stream');
            }
          }
        }
      }

      // Wait for a NEW response element to appear
      if (currentCount > countBefore) {
        const text = await this.controller.getLastResponseText();

        if (text && text.length > 0) {
          // Safety check: if the text starts with our protocol header, we captured
          // our own sent message instead of the AI's response. Skip it.
          if (text.startsWith('[Round ')) {
            // This is our TX, not the AI's RX — keep waiting (still sleeping
            // between polls, or this spins executeJavaScript in a hot loop)
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
            continue;
          }

          // The new response element can exist before it has any text; a
          // fallback scan then returns the PREVIOUS reply (Gemini, round 5
          // of 2026-11-10 relayed round 4's answer verbatim). Never accept
          // text identical to the pre-send baseline: a 60s grace period was
          // tried and failed, since Gemini can think for over a minute on a
          // long unification prompt while the old answer sits on the page.
          if (baselineText && text === baselineText) {
            this.activity(`Reply not started yet (${elapsedSec}s)`, 'wait');
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
            continue;
          }

          this.trackThought(text);

          // Definitive completion: END marker found AND response is substantial
          if (text.includes(END_MARKER) && text.length >= MIN_RESPONSE_LENGTH) {
            log('info', `${aiName}: END marker found (${text.length} chars)`);
            return text;
          }

          // Check if text stopped changing (AI finished generating)
          if (text === lastText) {
            stableCount++;
            if (text.length >= MIN_RESPONSE_LENGTH) {
              this.activity(`Reply settling ${stableCount}/${STABLE_THRESHOLD} (${text.length} chars)`, 'settle');
            } else {
              this.activity(`Short status on screen (${text.length} chars)`, 'stream');
            }
            if (stableCount >= STABLE_THRESHOLD) {
              // Only accept if response is substantial enough
              if (text.length >= MIN_RESPONSE_LENGTH) {
                log('info', `${aiName}: Response stable (${text.length} chars)`);
                return text;
              } else {
                // The site's own failure reply ("I seem to be encountering an
                // error...") is short and stable too — waiting the full
                // timeout on it just stalls the round.
                const siteError = this.controller.detectSiteError && this.controller.detectSiteError(text);
                if (siteError) {
                  const err = new Error(`${aiName}: site returned an error: ${siteError}`);
                  err.code = 'SITE_ERROR';
                  throw err;
                }
                // So is an out-of-messages reply
                const limit = this.controller.matchUsageLimit && this.controller.matchUsageLimit(text);
                if (limit) throw usageLimitError(aiName, limit);
                // Too short — likely an intermediate status or loading indicator;
                // it shows as a thought (trackThought above). Keep waiting.
                // Once per distinct text — a member thinking for minutes
                // otherwise logs the same line every 4s.
                if (text !== lastIgnoredText) {
                  log('warn', `${aiName}: Ignoring short stable text (${text.length} chars): ${text.substring(0, 80)}`);
                  lastIgnoredText = text;
                }
                stableCount = 0;
                // Don't reset lastText — if the same short text persists,
                // we'll eventually timeout and return it
              }
            }
          } else {
            stableCount = 0;
            lastText = text;
            this.activity(`Reply streaming (${text.length} chars)`, 'stream');
          }
        }
      }

      // Body-text fallback: detect response via body text changes when
      // element counting fails (e.g. Gemini's DOM structure changes)
      if (bodyFallbackActive && currentCount <= countBefore && this.controller.getBodyTextResponse) {
        const bodyData = await this.controller.getBodyTextResponse().catch(() => null);
        if (bodyData && bodyData.len > lastBodyLen + MIN_RESPONSE_LENGTH) {
          // Body text grew significantly — try to get response text
          const text = await this.controller.getLastResponseText().catch(() => null);
          if (text && text.length >= MIN_RESPONSE_LENGTH && !text.startsWith('[Round ')) {
            if (text === lastText) {
              bodyStableCount++;
              if (bodyStableCount >= STABLE_THRESHOLD) {
                log('info', `${aiName}: Response detected via body-text fallback (${text.length} chars)`);
                return text;
              }
            } else {
              bodyStableCount = 0;
              lastText = text;
            }
          } else if (!text || text.length < MIN_RESPONSE_LENGTH) {
            // Selectors still failing — extract new text from body diff
            const newBodyText = bodyData.text;
            const snapshotLen = this.controller._bodyTextAtSend || 0;
            if (newBodyText && newBodyText.length > snapshotLen + MIN_RESPONSE_LENGTH) {
              // Extract the new portion of body text
              const newPortion = newBodyText.substring(snapshotLen).trim();
              if (newPortion.length >= MIN_RESPONSE_LENGTH) {
                if (newPortion === lastText) {
                  bodyStableCount++;
                  if (bodyStableCount >= STABLE_THRESHOLD) {
                    log('info', `${aiName}: Response extracted from body text (${newPortion.length} chars)`);
                    return newPortion;
                  }
                } else {
                  bodyStableCount = 0;
                  lastText = newPortion;
                }
              }
            }
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // Timeout — return what we captured only if it could be a real answer.
    // Anything shorter is UI chrome ("+2 more", a bare "ANSWER:" heading,
    // "Gemini said") that would otherwise be relayed to the other members
    // as this member's answer.
    if (lastText && lastText.length >= MIN_RESPONSE_LENGTH) {
      log('warn', `${aiName}: Timeout, returning partial (${lastText.length} chars)`);
      return lastText;
    }

    throw new Error(`${aiName}: Response timeout after ${timeoutMs}ms`);
  }
}

module.exports = DomMonitor;
module.exports.MIN_RESPONSE_LENGTH = MIN_RESPONSE_LENGTH;
