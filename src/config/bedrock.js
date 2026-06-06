const https = require('https');
const { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
require('dotenv').config();

const region = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
const modelId = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0';
const embeddingModelId = process.env.BEDROCK_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const bearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
const hasAwsCredentials = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

const client = hasAwsCredentials ? new BedrockRuntimeClient({
  region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
}) : null;

const parseModelText = (payload) => {
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload?.content)) {
    return payload.content.map((item) => item.text || '').join('\n').trim();
  }
  if (Array.isArray(payload?.output?.message?.content)) {
    return payload.output.message.content.map((item) => item.text || '').join('\n').trim();
  }
  return '';
};

const sanitizeDocumentName = (value) => {
  const normalized = String(value || 'handbook')
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9\s\-\(\)\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || 'handbook';
};

const buildUserContent = ({ userText, attachment, encodeBytes = (bytes) => bytes }) => {
  const content = [];
  if (userText) content.push({ text: userText });
  if (attachment?.kind === 'document') {
    content.push({
      document: {
        format: attachment.format,
        name: sanitizeDocumentName(attachment.name),
        source: { bytes: encodeBytes(attachment.bytes) },
      },
    });
  }
  return content;
};

const invokeWithBearerToken = async ({ systemText, userText, attachment, maxTokens = 500, temperature = 0.2 }) => {
  const body = JSON.stringify({
    messages: [{
      role: 'user',
      content: buildUserContent({
        userText,
        attachment,
        encodeBytes: (bytes) => Buffer.from(bytes).toString('base64'),
      }),
    }],
    system: systemText ? [{ text: systemText }] : undefined,
    inferenceConfig: { maxTokens, temperature },
  });

  const options = {
    hostname: `bedrock-runtime.${region}.amazonaws.com`,
    port: 443,
    path: `/model/${encodeURIComponent(modelId)}/converse`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerToken}`,
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(responseData);
          const errorMessage = json.message || json.error?.message;
          if ((res.statusCode && res.statusCode >= 400) || errorMessage) {
            reject(new Error(errorMessage || `Bedrock bearer request failed (${res.statusCode})`));
            return;
          }
          const text = parseModelText(json);
          if (!text) reject(new Error('Empty Bedrock bearer response'));
          else resolve(text);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
};

const invokeWithAwsSdk = async ({ systemText, userText, attachment, maxTokens = 500, temperature = 0.2 }) => {
  if (!client) throw new Error('AWS credentials are not configured');
  const command = new ConverseCommand({
    modelId,
    system: systemText ? [{ text: systemText }] : undefined,
    messages: [{ role: 'user', content: buildUserContent({ userText, attachment }) }],
    inferenceConfig: { maxTokens, temperature },
  });
  const response = await client.send(command);
  const text = parseModelText(response);
  if (!text) throw new Error('Empty Bedrock SDK response');
  return text;
};

const invokeModel = async (options) => {
  if (bearerToken) {
    try {
      return await invokeWithBearerToken(options);
    } catch (error) {
      console.error('Bedrock bearer token invocation failed:', error.message);
      if (!hasAwsCredentials) throw error;
    }
  }
  return invokeWithAwsSdk(options);
};

const parseEmbedding = (payload) => {
  if (Array.isArray(payload?.embedding)) return payload.embedding;
  if (Array.isArray(payload?.embeddingsByType?.float)) return payload.embeddingsByType.float;
  if (Array.isArray(payload?.vector)) return payload.vector;
  return [];
};

const invokeEmbeddingWithAwsSdk = async (text) => {
  if (!client) throw new Error('AWS credentials are not configured');
  const command = new InvokeModelCommand({
    modelId: embeddingModelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ inputText: text }),
  });
  const response = await client.send(command);
  const embedding = parseEmbedding(JSON.parse(Buffer.from(response.body).toString('utf8')));
  if (!embedding.length) throw new Error('Empty Bedrock embedding SDK response');
  return embedding;
};

const invokeEmbeddingWithBearerToken = async (text) => {
  const body = JSON.stringify({ inputText: text });
  const options = {
    hostname: `bedrock-runtime.${region}.amazonaws.com`,
    port: 443,
    path: `/model/${encodeURIComponent(embeddingModelId)}/invoke`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerToken}`,
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(responseData);
          const errorMessage = json.message || json.error?.message;
          if ((res.statusCode && res.statusCode >= 400) || errorMessage) {
            reject(new Error(errorMessage || `Bedrock embedding bearer request failed (${res.statusCode})`));
            return;
          }
          const embedding = parseEmbedding(json);
          if (!embedding.length) reject(new Error('Empty Bedrock embedding bearer response'));
          else resolve(embedding);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
};

const generateEmbedding = async (text) => {
  const inputText = String(text || '').replace(/\s+/g, ' ').trim();
  if (!inputText) return null;
  if (bearerToken) {
    try {
      return await invokeEmbeddingWithBearerToken(inputText);
    } catch (error) {
      console.error('Bedrock embedding bearer token invocation failed:', error.message);
      if (!hasAwsCredentials) throw error;
    }
  }
  return invokeEmbeddingWithAwsSdk(inputText);
};

const extractJsonObject = (text) => {
  const jsonMatch = String(text || '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse JSON from model response');
  return JSON.parse(jsonMatch[0]);
};

const improveHandbookQuestionFallback = (question) => ({
  originalQuestion: question,
  improvedQuestion: question,
  searchQueries: [question],
  detectedLanguage: 'en',
});

const improveHandbookQuestion = async (question) => {
  const rawQuestion = String(question || '').trim();
  if (!rawQuestion) return improveHandbookQuestionFallback('');

  const systemText = 'You improve employee handbook questions for retrieval. Return only valid JSON.';
  const userText = `Rewrite this WhatsApp handbook question so it is clearer for search and answering.
Return ONLY JSON with keys:
- originalQuestion: the user message unchanged
- improvedQuestion: a clear, complete English handbook question
- searchQueries: array of 1 to 3 short search phrases to find relevant handbook sections
- detectedLanguage: short language tag like en, ms, zh

Rules:
- Fix typos, slang, and incomplete phrasing
- Expand shorthand into explicit policy/procedure wording
- Keep the same intent; do not invent facts
- If already clear, lightly polish it

User message: ${rawQuestion}`;

  try {
    const content = await invokeModel({ systemText, userText, maxTokens: 220, temperature: 0 });
    const parsed = extractJsonObject(content);
    const improvedQuestion = String(parsed.improvedQuestion || rawQuestion).trim() || rawQuestion;
    const searchQueries = Array.isArray(parsed.searchQueries)
      ? parsed.searchQueries.map((item) => String(item || '').trim()).filter(Boolean)
      : [];

    return {
      originalQuestion: rawQuestion,
      improvedQuestion,
      searchQueries: searchQueries.length ? searchQueries.slice(0, 3) : [improvedQuestion, rawQuestion],
      detectedLanguage: String(parsed.detectedLanguage || 'en').trim().toLowerCase() || 'en',
    };
  } catch (error) {
    console.error('Question improvement failed:', error.message);
    return improveHandbookQuestionFallback(rawQuestion);
  }
};

const localizeText = async (text, targetLanguage = 'en') => {
  const sourceText = String(text || '');
  const language = String(targetLanguage || 'en').trim().toLowerCase();
  if (!sourceText || !language || language.startsWith('en')) return sourceText;

  const systemText = 'You translate assistant replies for employees. Return only plain text with the same meaning and formatting.';
  const userText = `Translate this assistant message to language code "${language}".
Preserve line breaks, numbering, and policy terms.
Return ONLY translated text.

Message:
${sourceText}`;

  try {
    const translated = await invokeModel({ systemText, userText, maxTokens: 700, temperature: 0.1 });
    return String(translated || '').trim() || sourceText;
  } catch (error) {
    console.error('Localization failed:', error.message);
    return sourceText;
  }
};

const answerWithKnowledgeContext = async ({ question, improvedQuestion, contexts }) => {
  const contextText = contexts
    .map((context, index) => `[${index + 1}] ${context.title || context.source_type || 'Knowledge'}\n${context.content}`)
    .join('\n\n');

  const systemText = 'You are a helpful handbook assistant on WhatsApp. Answer using only the provided handbook context. If the context does not contain the answer, say you do not have that information in the handbook. Be concise, practical, and easy to read on mobile.';
  const userText = `Handbook context:\n${contextText || '(no context)'}\n\nOriginal user question: ${question}\nImproved handbook question: ${improvedQuestion || question}\n\nProvide a helpful answer grounded in the handbook.`;

  const answer = await invokeModel({ systemText, userText, maxTokens: 700, temperature: 0.3 });
  return { answer, matches: contexts };
};

const extractTextFromPdfDocument = async (documentBuffer, documentName = 'handbook', pageLabel = '') => {
  const systemText = 'You extract readable text from PDF documents. Return plain text only.';
  const userText = pageLabel
    ? `Transcribe all visible text from this handbook PDF page (${pageLabel}). Preserve headings, lists, and section order. Return plain text only.`
    : 'Transcribe all visible text from this handbook PDF. Preserve headings, lists, and section order. Return plain text only.';

  return invokeModel({
    systemText,
    userText,
    attachment: {
      kind: 'document',
      format: 'pdf',
      name: documentName,
      bytes: documentBuffer,
    },
    maxTokens: 4000,
    temperature: 0,
  });
};

module.exports = {
  generateEmbedding,
  improveHandbookQuestion,
  localizeText,
  answerWithKnowledgeContext,
  extractTextFromPdfDocument,
};
