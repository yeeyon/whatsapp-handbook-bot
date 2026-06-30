const https = require('https');
require('dotenv').config();

const getGroqKeys = () => [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean);

const RATE_LIMIT_STATUSES = new Set([429, 408, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseRetryAfter = (headerValue) => {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(headerValue);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
};

const callGroqWithKey = async (messages, apiKey, { timeoutMs = 15000 } = {}) => {
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const temperature = Number(process.env.GROQ_TEMPERATURE);
  const maxTokens = Number(process.env.GROQ_MAX_TOKENS);

  const payload = { model, messages };
  if (Number.isFinite(temperature)) payload.temperature = temperature;
  if (Number.isFinite(maxTokens) && maxTokens > 0) payload.max_tokens = maxTokens;

  const body = JSON.stringify(payload);

  const options = {
    hostname: 'api.groq.com',
    port: 443,
    path: '/openai/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400 || json.error) {
            const errDetail = json.error?.message || `Status: ${res.statusCode}`;
            const err = new Error(`Groq API error: ${errDetail}`);
            err.statusCode = res.statusCode;
            err.retryAfterMs = parseRetryAfter(res.headers['retry-after']);
            err.isRateLimit = RATE_LIMIT_STATUSES.has(res.statusCode);
            reject(err);
            return;
          }
          const reply = json.choices?.[0]?.message?.content;
          if (reply === undefined || reply === null) {
            reject(new Error('Groq response choices were empty.'));
          } else {
            resolve(reply);
          }
        } catch (err) {
          reject(new Error(`Failed to parse Groq response: ${err.message}`));
        }
      });
    });

    req.on('error', (err) => {
      const wrapped = new Error(`Groq network error: ${err.message}`);
      wrapped.isRateLimit = false;
      reject(wrapped);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Groq request timed out after ${timeoutMs}ms`));
    });

    req.write(body);
    req.end();
  });
};

const callGroq = async (messages, { maxRetriesPerKey = 1, rateLimitBackoffMs = 800 } = {}) => {
  const apiKeys = getGroqKeys();
  if (!apiKeys.length) {
    throw new Error('GROQ_API_KEY is not configured in environment variables.');
  }

  const failures = [];

  for (let index = 0; index < apiKeys.length; index += 1) {
    let attempt = 0;
    while (attempt <= maxRetriesPerKey) {
      try {
        const content = await callGroqWithKey(messages, apiKeys[index]);
        return { content, keySlot: index + 1 };
      } catch (error) {
        const tag = `key-${index + 1}${attempt > 0 ? `/retry-${attempt}` : ''}`;
        failures.push(`${tag}: ${error.message}`);

        if (error.isRateLimit && attempt < maxRetriesPerKey) {
          const wait = error.retryAfterMs != null
            ? Math.min(error.retryAfterMs, 2000)
            : rateLimitBackoffMs;
          await sleep(wait);
          attempt += 1;
          continue;
        }
        break;
      }
    }
  }

  throw new Error(`All Groq keys failed (${failures.join('; ')})`);
};

module.exports = {
  callGroq,
  getGroqKeys,
};
