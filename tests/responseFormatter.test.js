const test = require('node:test');
const assert = require('node:assert/strict');
const { standardizeHandbookAnswer, _test } = require('../src/services/responseFormatter');

test('formatter prompt defines the WhatsApp response standard', () => {
  const prompt = _test.buildFormatterPrompt({
    question: 'Give me game room rules',
    answer: '• Rule one (page 17).',
  });

  assert.match(prompt, /Preserve every factual claim/);
  assert.match(prompt, /Fix missing spaces and joined words/);
  assert.match(prompt, /Format Malaysian phone numbers internationally/);
  assert.match(prompt, /_Source: Handbook page 17_/);
});

test('uses the configured LLM formatter result', async () => {
  const calls = [];
  const result = await standardizeHandbookAnswer('Thehandbook number is 04-6462222.', {
    question: 'What is the number?',
    formatter: async (options) => {
      calls.push(options);
      return { content: 'The handbook number is +60 4-646 2222.' };
    },
  });

  assert.equal(result, 'The handbook number is +60 4-646 2222.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].temperature, 0);
});

test('keeps the original answer if Gemini formatting fails', async () => {
  const result = await standardizeHandbookAnswer('Original answer.', {
    formatter: async () => { throw new Error('quota exceeded'); },
  });

  assert.equal(result, 'Original answer.');
});
