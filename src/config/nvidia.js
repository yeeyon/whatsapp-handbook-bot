const https = require('https');
require('dotenv').config();

const getNvidiaKeys = () => [
  process.env.NVIDIA_API_KEY,
  process.env.NVIDIA_API_KEY_2,
  process.env.NVIDIA_API_KEY_3,
].filter(Boolean);

const callNvidiaWithKey = async (messages, apiKey) => {
  const model = process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct';

  const body = JSON.stringify({
    model,
    messages
  });

  const options = {
    hostname: 'integrate.api.nvidia.com',
    port: 443,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(body)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400 || json.error) {
            const errDetail = json.error?.message || `Status: ${res.statusCode}`;
            reject(new Error(`Nvidia API error: ${errDetail}`));
            return;
          }
          const reply = json.choices?.[0]?.message?.content;
          if (reply === undefined || reply === null) {
            reject(new Error('Nvidia response choices were empty.'));
          } else {
            resolve(reply);
          }
        } catch (err) {
          reject(new Error(`Failed to parse Nvidia response: ${err.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Nvidia network error: ${err.message}`));
    });

    req.write(body);
    req.end();
  });
};

const callNvidia = async (messages) => {
  const apiKeys = getNvidiaKeys();
  if (!apiKeys.length) {
    throw new Error('NVIDIA_API_KEY is not configured in environment variables.');
  }

  const failures = [];
  for (let index = 0; index < apiKeys.length; index += 1) {
    try {
      const content = await callNvidiaWithKey(messages, apiKeys[index]);
      return { content, keySlot: index + 1 };
    } catch (error) {
      failures.push(`key-${index + 1}: ${error.message}`);
    }
  }

  throw new Error(`All Nvidia keys failed (${failures.join('; ')})`);
};

module.exports = {
  callNvidia,
  getNvidiaKeys,
};
