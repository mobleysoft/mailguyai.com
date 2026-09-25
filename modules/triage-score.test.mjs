import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEmailPriority } from './triage-score.js';

test('scoreEmailPriority: real behavior flags urgency phrases and a direct question as high priority', () => {
  const result = scoreEmailPriority({
    sender: 'boss@company.com',
    subject: 'Re: contract renewal — need your sign-off today',
    body: 'Can you review and approve by EOD?',
  });
  assert.equal(result.band, 'High priority');
  assert.ok(result.score >= 70);
  assert.ok(result.reasons.some((r) => r.includes('urgency phrase "today"')));
  assert.ok(result.reasons.some((r) => r.includes('direct question')));
  assert.ok(result.reasons.some((r) => r.includes('existing thread')));
});

test('scoreEmailPriority: real behavior penalizes an automated no-reply sender', () => {
  const result = scoreEmailPriority({
    sender: 'noreply@service.com',
    subject: 'Your receipt',
    body: 'Thanks for your purchase.',
  });
  assert.ok(result.reasons.some((r) => r.includes('Automated/no-reply sender')));
  assert.ok(result.score < 40);
});

test('scoreEmailPriority: real behavior penalizes newsletter/bulk content', () => {
  const result = scoreEmailPriority({
    sender: 'digest@newsletter.com',
    subject: 'Weekly newsletter',
    body: 'Click here to unsubscribe at any time.',
  });
  assert.ok(result.reasons.some((r) => r.includes('bulk/newsletter content')));
  assert.equal(result.band, 'Low priority / can wait');
});

test('scoreEmailPriority: real behavior scores a plain message with no signals at baseline, not a crash', () => {
  const result = scoreEmailPriority({ sender: '', subject: '', body: '' });
  assert.equal(result.score, 40);
  assert.equal(result.band, 'Low priority / can wait');
  assert.ok(result.reasons.some((r) => r.includes('No sender provided')));
});

test('scoreEmailPriority: real behavior clamps score into 0-100, never negative or over 100', () => {
  const low = scoreEmailPriority({ sender: 'noreply@x.com', subject: 'newsletter unsubscribe', body: '' });
  assert.ok(low.score >= 0);
  const high = scoreEmailPriority({
    sender: 'a@b.com',
    subject: 'Re: urgent asap deadline immediately action required eod',
    body: 'today? today?',
  });
  assert.ok(high.score <= 100);
});

test('scoreEmailPriority: real behavior handles a missing body (list-view messages have no body loaded)', () => {
  const result = scoreEmailPriority({ sender: 'client@example.com', subject: 'Question about invoice?' });
  assert.ok(result.reasons.some((r) => r.includes('direct question')));
  assert.equal(typeof result.score, 'number');
});
