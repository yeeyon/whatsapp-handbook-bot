const https = require('https');

const getGeminiKeys = () => [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
].filter(Boolean);

const callGeminiWithKey = async ({ systemText, userText, maxTokens = 500, temperature = 0.2, model }, apiKey) => {
  const selectedModel = model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const body = JSON.stringify({
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    port: 443,
    path: `/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400 || json.error) {
            reject(new Error(json.error?.message || `Gemini API error (${res.statusCode})`));
            return;
          }

          const text = json.candidates?.[0]?.content?.parts
            ?.map((part) => part.text || '')
            .join('')
            .trim();
          if (!text) {
            reject(new Error(`Gemini returned no text (${json.candidates?.[0]?.finishReason || 'unknown reason'})`));
            return;
          }
          resolve(text);
        } catch (error) {
          reject(new Error(`Failed to parse Gemini response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => reject(new Error(`Gemini network error: ${error.message}`)));
    req.write(body);
    req.end();
  });
};

const callGemini = async (options) => {
  const apiKeys = getGeminiKeys();
  if (!apiKeys.length) {
    throw new Error('GEMINI_API_KEY is not configured in environment variables.');
  }

  const failures = [];
  for (let index = 0; index < apiKeys.length; index += 1) {
    try {
      const content = await callGeminiWithKey(options, apiKeys[index]);
      return { content, keySlot: index + 1 };
    } catch (error) {
      failures.push(`key-${index + 1}: ${error.message}`);
    }
  }

  throw new Error(`All Gemini keys failed (${failures.join('; ')})`);
};

module.exports = { callGemini, getGeminiKeys };
