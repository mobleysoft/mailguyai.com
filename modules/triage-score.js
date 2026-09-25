/**
 * MailguyAI — rule-based email priority scoring.
 *
 * The exact logic that used to live only inline in index.html's landing-page
 * demo. Extracted here so the real inbox (inbox.html, real stored messages)
 * can show the same transparent priority score the demo advertises, instead
 * of the scorer being a disconnected marketing toy - this venture's own spec
 * names "filtering, prioritizing" as the core feature, and until now nothing
 * that actually reads a stored message applied it.
 *
 * Deliberately still a transparent rules engine, not a trained model or an
 * LLM call - matches the landing page's own honesty about what this is.
 */

const URGENT_WORDS = ['urgent', 'asap', 'today', 'deadline', 'action required', 'immediately', 'eod'];

/**
 * Score a message's priority from its sender/subject/body.
 * @param {{sender?: string, subject?: string, body?: string}} input
 * @returns {{score: number, band: string, reasons: string[]}}
 */
export function scoreEmailPriority({ sender = '', subject = '', body = '' } = {}) {
  const s = (sender || '').toLowerCase();
  const subj = (subject || '').toLowerCase();
  const b = (body || '').toLowerCase();
  const text = `${subj} ${b}`;

  let score = 0;
  const reasons = [];

  URGENT_WORDS.forEach((w) => {
    if (text.indexOf(w) !== -1) {
      score += 15;
      reasons.push(`Contains urgency phrase "${w}" (+15)`);
    }
  });

  if (text.indexOf('?') !== -1) {
    score += 10;
    reasons.push('Contains a direct question (+10)');
  }

  if (subj.indexOf('re:') !== -1) {
    score += 10;
    reasons.push('Part of an existing thread ("Re:") (+10)');
  }

  const noReply = s.indexOf('noreply') !== -1 || s.indexOf('no-reply') !== -1 || s.indexOf('notifications@') !== -1;
  if (noReply) {
    score -= 30;
    reasons.push('Automated/no-reply sender (-30)');
  }

  const newsletter = text.indexOf('unsubscribe') !== -1 || text.indexOf('newsletter') !== -1;
  if (newsletter) {
    score -= 20;
    reasons.push('Looks like bulk/newsletter content (-20)');
  }

  if (!s) {
    reasons.push('No sender provided — scoring subject/body only');
  }

  score = Math.max(0, Math.min(100, score + 40));

  let band;
  if (score >= 70) band = 'High priority';
  else if (score >= 45) band = 'Normal priority';
  else band = 'Low priority / can wait';

  if (reasons.length === 0) {
    reasons.push('No strong signals found — scored at baseline.');
  }

  return { score, band, reasons };
}
