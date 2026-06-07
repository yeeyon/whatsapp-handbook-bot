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

test('retrieval rejects weak embedding-only noise', () => {
  assert.equal(_test.isKnowledgeMatch({ embeddingScore: 0.13, keywordScore: 0 }), false);
  assert.equal(_test.isKnowledgeMatch({ embeddingScore: 0.4, keywordScore: 0 }), true);
  assert.equal(_test.isKnowledgeMatch({ embeddingScore: 0.1, keywordScore: 0.6 }), true);
});

test('retrieval score uses the stronger semantic or lexical signal', () => {
  assert.equal(_test.calculateRetrievalScore(0, 0.8), 0.68);
  assert.ok(Math.abs(_test.calculateRetrievalScore(0.7, 0.2) - 0.55) < 1e-12);
});

test('lexical scoring ignores generic request and image words', () => {
  assert.equal(_test.lexicalScore('Show me the handbook page', 'This handbook page is available'), 0);
  assert.equal(_test.lexicalScore('Show me the basketball court page', 'Street basketball court rules'), 1);
});

test('vague generic handbook prompts require clarification', () => {
  assert.equal(_test.isUnderspecifiedQuestion('What does the schedule say?'), true);
  assert.equal(_test.isUnderspecifiedQuestion('Show me the form'), true);
  assert.equal(_test.isUnderspecifiedQuestion('What is the leave policy?'), false);
  assert.equal(_test.isUnderspecifiedQuestion('Can I keep pets?'), false);
});

test('direct page requests bypass semantic retrieval', () => {
  assert.equal(_test.parseDirectPageRequest('give me page 1'), 1);
  assert.equal(_test.parseDirectPageRequest('Show page #64 please'), 64);
  assert.equal(_test.parseDirectPageRequest('What is on page 12?'), 12);
  assert.equal(_test.parseDirectPageRequest('Which page mentions the pool?'), null);
});

test('clear standalone questions skip model-based rewriting', () => {
  assert.equal(_test.requiresQuestionImprovement('What are the opening hours for the game room?'), false);
  assert.equal(_test.requiresQuestionImprovement('Give me emergency contact numbers'), false);
  assert.equal(_test.requiresQuestionImprovement('Game room opening hour'), true);
  assert.equal(_test.requiresQuestionImprovement('How about that?', [{ id: 1 }]), true);
});
