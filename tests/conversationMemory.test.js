const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeedbackMessage } = require('../src/services/conversationMemory');

test('parses explicit positive and negative feedback', () => {
  assert.deepEqual(parseFeedbackMessage('helpful'), { type: 'positive', content: 'helpful' });
  assert.deepEqual(parseFeedbackMessage('wrong'), { type: 'negative', content: 'wrong' });
});

test('parses a correction and preserves its content', () => {
  assert.deepEqual(parseFeedbackMessage('correction: Annual leave is 14 days'), {
    type: 'correction',
    content: 'Annual leave is 14 days',
  });
});

test('does not consume ordinary questions as feedback', () => {
  assert.equal(parseFeedbackMessage('Is annual leave 14 days?'), null);
  assert.equal(parseFeedbackMessage('No leave during probation?'), null);
});
