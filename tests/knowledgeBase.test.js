const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/services/knowledgeBase');

test('chunking creates overlapping searchable chunks', () => {
  const text = 'A'.repeat(100) + ' handbook leave policy ' + 'B'.repeat(100);
  const chunks = _test.chunkText(text, { chunkSize: 200, overlap: 20 });

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 200));
  assert.match(chunks.join(' '), /leave policy/);
});

test('cosine similarity ranks identical vectors higher than unrelated vectors', () => {
  assert.equal(_test.cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  assert.equal(_test.cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
});

test('lexical score matches question terms in content', () => {
  const score = _test.lexicalScore('What is the leave policy?', 'The leave policy allows 14 days annual leave.');
  assert.ok(score > 0);
  assert.equal(_test.lexicalScore('parking', 'hotel reimbursement'), 0);
});
