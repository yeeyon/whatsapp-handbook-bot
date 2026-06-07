const test = require('node:test');
const assert = require('node:assert/strict');
const { callOpenRouter } = require('../src/config/openrouter');
require('dotenv').config();

test('callOpenRouter returns response from real OpenRouter API', async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    console.log('Skipping real API test: OPENROUTER_API_KEY is not configured');
    return;
  }

  const messages = [
    { role: 'user', content: 'Say hello in exactly 3 words' }
  ];

  try {
    const response = await callOpenRouter(messages);
    console.log('OpenRouter Real Response:', response);
    assert.ok(response.content);
    assert.equal(typeof response.content, 'string');
    assert.ok(response.content.trim().length > 0);
    assert.ok(response.keySlot >= 1);
  } catch (error) {
    console.error('OpenRouter real API call failed:', error.message);
    throw error;
  }
});

test('callOpenRouter throws error if API key is missing', async () => {
  const originalKeys = [
    process.env.OPENROUTER_API_KEY,
    process.env.OPENROUTER_API_KEY_2,
    process.env.OPENROUTER_API_KEY_3,
  ];
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY_2;
  delete process.env.OPENROUTER_API_KEY_3;
  try {
    await callOpenRouter([{ role: 'user', content: 'hello' }]);
    assert.fail('Should have thrown an error when API key is missing');
  } catch (error) {
    assert.match(error.message, /OPENROUTER_API_KEY is not configured/);
  } finally {
    const names = ['OPENROUTER_API_KEY', 'OPENROUTER_API_KEY_2', 'OPENROUTER_API_KEY_3'];
    names.forEach((name, index) => {
      if (originalKeys[index] === undefined) delete process.env[name];
      else process.env[name] = originalKeys[index];
    });
  }
});
