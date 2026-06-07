const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../src/config/bedrock');
const { parsePageMarkers, pickReplyPageNumbers } = require('../src/services/handbookPages');

test('image sending requires an explicit visual request', () => {
  assert.equal(_test.hasExplicitVisualIntent('What are the pool opening hours?'), false);
  assert.equal(_test.hasExplicitVisualIntent('What does the form say?'), false);
  assert.equal(_test.hasExplicitVisualIntent('Show me the organisation chart'), true);
  assert.equal(_test.hasExplicitVisualIntent('Send the handbook page'), true);
  assert.equal(_test.hasExplicitVisualIntent('Show me the page with basketball rules'), true);
});

test('image fallback does not infer intent from visual words in retrieved text', () => {
  const contexts = [{ content: 'This section contains a table and schedule.' }];
  assert.deepEqual(_test.decideReplyImagesFallback('What are the opening hours?', contexts, [12]), {
    sendImages: false,
    pageNumbers: [],
    reason: 'No explicit visual request',
  });
});

test('page candidates stay within the selected source', () => {
  const contexts = [
    { source_id: 1, score: 0.9, metadata: { pageNumbers: [8] } },
    { source_id: 2, score: 1, metadata: { pageNumbers: [40] } },
  ];
  assert.deepEqual(pickReplyPageNumbers(contexts, 2, 1), [8]);
});

test('all page markers are extracted from legacy chunks', () => {
  assert.deepEqual(parsePageMarkers('--- page 4 of 66 --- text --- page 5 of 66 ---'), [4, 5]);
});
