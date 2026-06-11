const test = require('node:test');
const assert = require('node:assert/strict');
const { callNvidia } = require('../src/config/nvidia');
require('dotenv').config();

test('callNvidia returns response from real Nvidia API', async () => {
  if (!process.env.NVIDIA_API_KEY) {
    console.log('Skipping real API test: NVIDIA_API_KEY is not configured');
    return;
  }

  const messages = [
    { role: 'user', content: 'Say hello in exactly 3 words' }
  ];

  try {
    const response = await callNvidia(messages);
    console.log('Nvidia Real Response:', response);
    assert.ok(response.content);
    assert.equal(typeof response.content, 'string');
    assert.ok(response.content.trim().length > 0);
    assert.ok(response.keySlot >= 1);
  } catch (error) {
    console.error('Nvidia real API call failed:', error.message);
    throw error;
  }
});

test('callNvidia throws error if API key is missing', async () => {
  const originalKeys = [
    process.env.NVIDIA_API_KEY,
    process.env.NVIDIA_API_KEY_2,
    process.env.NVIDIA_API_KEY_3,
  ];
  delete process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEY_2;
  delete process.env.NVIDIA_API_KEY_3;
  try {
    await callNvidia([{ role: 'user', content: 'hello' }]);
    assert.fail('Should have thrown an error when API key is missing');
  } catch (error) {
    assert.match(error.message, /NVIDIA_API_KEY is not configured/);
  } finally {
    const names = ['NVIDIA_API_KEY', 'NVIDIA_API_KEY_2', 'NVIDIA_API_KEY_3'];
    names.forEach((name, index) => {
      if (originalKeys[index] === undefined) delete process.env[name];
      else process.env[name] = originalKeys[index];
    });
  }
});
