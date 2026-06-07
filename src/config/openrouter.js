const https = require('https');
require('dotenv').config();

const callOpenRouter = async (messages) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL || 'openrouter/free';

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured in environment variables.');
  }

  const body = JSON.stringify({
    model,
    messages
  });

  const options = {
    hostname: 'openrouter.ai',
    port: 443,
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/yeeyon/whatsapp-handbook-bot',
      'X-Title': 'WhatsApp Handbook Bot',
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
            reject(new Error(`OpenRouter API error: ${errDetail}`));
            return;
          }
          const reply = json.choices?.[0]?.message?.content;
          if (reply === undefined || reply === null) {
            reject(new Error('OpenRouter response choices were empty.'));
          } else {
            resolve(reply);
          }
        } catch (err) {
          reject(new Error(`Failed to parse OpenRouter response: ${err.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`OpenRouter network error: ${err.message}`));
    });

    req.write(body);
    req.end();
  });
};

module.exports = {
  callOpenRouter
};
