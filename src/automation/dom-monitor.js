'use strict';

const { END_MARKER, POLL_INTERVAL_MS, RESPONSE_TIMEOUT_MS, RESPONSE_TIMEOUT_PER_MEMBER } = require('../utils/constants.js');
const { log } = require('../utils/logger.js');

// Responses shorter than this are likely loading indicators/thinking text.
// 200 was too low: on a long, complex prompt, Claude's thinking-status line
// ("Uncovering timeout gaps and stale-data risks in single-run mode") got
// captured duplicated 2-3x back to back (~205 chars) and slipped past this
// gate as if it were a real, stable final answer.
const MIN_RESPONSE_LENGTH = 500;

class DomMonitor {
  constructor(controller) {
    this.controller = controller;
  }

  // baselineBefore: last response text captured before the message was sent
  // (preferred); when omitted it is read now, which can be too late.
  async waitForResponse(countBefore, baselineBefore) {
    const startTime = Date.now();
    const aiName = this.controller.aiName;
    const timeoutMs = (RESPONSE_TIMEOUT_PER_MEMBER && RESPONSE_TIMEOUT_PER_MEMBER[aiName]) || RESPONSE_TIMEOUT_MS;
    let lastText = '';
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
    let pollCount = 0;
    let lastLoggedAt = startTime;

    while (Date.now() - startTime < timeoutMs || (this.controller.isWaiting && this.controller.isWaiting())) {
      if (this.controller.isAborted && this.controller.isAborted()) {
        throw new Error(`${aiName}: aborted`);
      }
      const currentCount = await this.controller.getResponseCount();
      pollCount++;

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

      if (textFallbackActive && currentCount <= countBefore) {
        const currentText = await this.controller.getLastResponseText().catch(() => null);
        if (currentText && currentText.length >= MIN_RESPONSE_LENGTH && !currentText.startsWith('[Round ')) {
          // Check if text differs from baseline (new response appeared)
          if (currentText !== baselineText) {
            if (currentText === lastText) {
              textStableCount++;
              if (textStableCount >= STABLE_THRESHOLD) {
                log('info', `${aiName}: Response detected via text-change fallback (${currentText.length} chars)`);
                return currentText;
              }
            } else {
              textStableCount = 0;
              lastText = currentText;
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

          // Definitive completion: END marker found AND response is substantial
          if (text.includes(END_MARKER) && text.length >= MIN_RESPONSE_LENGTH) {
            log('info', `${aiName}: END marker found (${text.length} chars)`);
            return text;
          }

          // Check if text stopped changing (AI finished generating)
          if (text === lastText) {
            stableCount++;
            if (stableCount >= STABLE_THRESHOLD) {
              // Only accept if response is substantial enough
              if (text.length >= MIN_RESPONSE_LENGTH) {
                log('info', `${aiName}: Response stable (${text.length} chars)`);
                return text;
              } else {
                // Too short — likely an intermediate status or loading indicator.
                // Emit as a "thought" so the UI can display it, but keep waiting.
                log('warn', `${aiName}: Ignoring short stable text (${text.length} chars): ${text.substring(0, 80)}`);
                if (this.controller.onThought) {
                  this.controller.onThought(text.substring(0, 80));
                }
                stableCount = 0;
                // Don't reset lastText — if the same short text persists,
                // we'll eventually timeout and return it
              }
            }
          } else {
            stableCount = 0;
            lastText = text;
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
