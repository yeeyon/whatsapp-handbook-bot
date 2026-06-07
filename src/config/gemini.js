const https = require('https');

const callGemini = async ({ systemText, userText, maxTokens = 500, temperature = 0.2 }) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment variables.');
  }

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
    path: `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
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

module.exports = { callGemini };
