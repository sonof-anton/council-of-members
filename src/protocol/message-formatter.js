'use strict';

const { AI_MEMBER_LABELS } = require('../utils/constants.js');

function timestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19) + 'Z';
}

const CONSTITUTION = `GUIDELINES:
1. This process follows the scientific method: propose, review, critique, refine.
2. All three members have equal standing. The human user asked the question and will receive the final answer.
3. Use the structured format described below.
4. Productive disagreement is expected and valuable. Different perspectives lead to better answers.`;

const PROTOCOL_RULES = `HOW THIS WORKS:
You are one of three members of a council answering the same question. The Chancellor of the council coordinates this process. The Chancellor sends the question to all three of you, collects your answers, then shares what the others wrote so you can refine your response. You are identified only as Member 1, Member 2, or Member 3.

Your task: answer the user's question thoroughly, then refine your answer after seeing what the other two members wrote.

FORMAT:
- Start with ANSWER: followed by your complete, detailed answer to the question.
- After your ANSWER, include a FEEDBACK: section where you critique and peer-review the other members' responses. Point out strengths, weaknesses, factual errors, missing information, or areas of agreement.
- After your FEEDBACK, indicate whether you agree the answer is ready: AGREE: NO (first round, since you haven't seen others' answers yet) or AGREE: YES (later rounds, if you think the answer is finalized).
- When you write AGREE: NO, explain what you'd change or what needs discussion.
- Your ANSWER must be a complete, standalone answer — not a summary or reference to someone else's answer.
- Your ANSWER should be complete, not long. Once a point is settled across members, state it once rather than re-explaining it each round — spend your length on genuine additions, corrections, or unresolved disagreements. Growing every round for its own sake makes the transcript unreadable and slows the whole council down.
- If your own answer is concise and you feel it is complete, use your FEEDBACK section extensively — critique, fact-check, and provide detailed feedback. Every member must contribute substantively every round.
- This runs for up to 10 rounds. Each round is a chance to improve the answer. Participate fully every round.
- Even if you disagree with the others, provide your own complete detailed answer.

EXAMPLE:
ANSWER:
[Your thorough answer to the question]

FEEDBACK:
[Your critique and feedback on the other members' answers]

AGREE: NO
[What you'd like to discuss or refine]`;

function formatInitialMessage(prompt, round) {
  return `[Round ${round}] [${timestamp()}]

${PROTOCOL_RULES}

${CONSTITUTION}

USER'S QUESTION:
${prompt}

Please provide your ANSWER now. Write AGREE: NO on this first round since you haven't seen the other members' answers yet.`;
}

// Members that dropped out or were skipped have null / "[ERROR: ...]" /
// "[SKIPPED ...]" placeholders — relaying those just shows the others
// "null" or an internal error string as if it were an answer.
function usableResponses(responses) {
  return Object.entries(responses).filter(([, text]) =>
    text && !text.startsWith('[ERROR:') && !text.startsWith('[SKIPPED')
  );
}

function formatRelayMessage(responses, round) {
  const prevRound = round - 1;
  let body = `[Round ${round}] [${timestamp()}]

Here are the member responses from Round ${prevRound}:
`;

  for (const [aiName, responseText] of usableResponses(responses)) {
    const label = AI_MEMBER_LABELS[aiName] || aiName;
    body += `
=== ${label}'s Answer ===
${responseText}
`;
  }

  body += `
Now review the other members' answers above and refine your own ANSWER. Incorporate the best points from all responses.

Your ANSWER must remain complete and standalone — but do not simply re-state points that are already settled across all members. Trim what's agreed, and spend the length on what's new: corrections, additions, or points still under disagreement. A shorter answer that's tightened up round over round is better than a longer one that repeats itself. Use your FEEDBACK section to critique and provide feedback on the other members' work.

AGREE: YES if you're satisfied this is the best possible answer. AGREE: NO with what you'd change. Either way, include your complete ANSWER and FEEDBACK.`;

  return body;
}

function formatUnificationMessage(responses, round) {
  let body = `[Round ${round}] [${timestamp()}]

All members agree on the substance. Now collaborate to produce one shared final answer.

Here are the member answers:
`;

  for (const [aiName, responseText] of usableResponses(responses)) {
    const label = AI_MEMBER_LABELS[aiName] || aiName;
    body += `
=== ${label}'s Answer ===
${responseText}
`;
  }

  body += `
Write a single ANSWER that combines the best elements from all the responses into one comprehensive, unified answer. This should be the best possible version incorporating all members' insights.

AGREE: YES if you're satisfied with the unified version. AGREE: NO if you think it still needs work.`;

  return body;
}

module.exports = { formatInitialMessage, formatRelayMessage, formatUnificationMessage, timestamp };
