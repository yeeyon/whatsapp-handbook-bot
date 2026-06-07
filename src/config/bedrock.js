const https = require('https');
const { AsyncLocalStorage } = require('async_hooks');
const { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
require('dotenv').config();
const { callOpenRouter } = require('./openrouter');
const { callGemini } = require('./gemini');


const region = process.env.BEDROCK_REGION || process.env.AWS_REGION || 'us-east-1';
const modelId = process.env.BEDROCK_MODEL_ID || 'anthropic.claude-3-haiku-20240307-v1:0';
const embeddingModelId = process.env.BEDROCK_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const bearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
const hasAwsCredentials = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
const providerTraceStorage = new AsyncLocalStorage();
const providerStats = {
  openrouterSuccesses: 0,
  openrouterFailures: 0,
  geminiSuccesses: 0,
  geminiFailures: 0,
  bedrockGenerationSuccesses: 0,
  bedrockGenerationFailures: 0,
  bedrockEmbeddingSuccesses: 0,
  bedrockEmbeddingFailures: 0,
  fallbacksToGemini: 0,
  fallbacksToBedrock: 0,
};

const recordProviderCall = (call) => {
  const trace = providerTraceStorage.getStore();
  if (trace) trace.calls.push({ ...call, timestamp: new Date().toISOString() });
};

const summarizeProviderTrace = (calls) => {
  const generationCalls = calls.filter((call) => call.operation === 'generation');
  const successfulGenerationCalls = generationCalls.filter((call) => call.status === 'success');
  const finalGeneration = successfulGenerationCalls[successfulGenerationCalls.length - 1] || null;
  const providersAttempted = [...new Set(generationCalls.map((call) => call.provider))];

  return {
    generationProvider: finalGeneration?.provider || 'none',
    generationModel: finalGeneration?.model || null,
    fallbackUsed: providersAttempted.length > 1,
    providersAttempted,
    calls,
  };
};

const runWithProviderTrace = async (operation) => providerTraceStorage.run({ calls: [] }, async () => {
  const result = await operation();
  return { result, aiProvider: summarizeProviderTrace(providerTraceStorage.getStore().calls) };
});

const getAIProviderStatus = () => ({
  configuredGenerationProvider: process.env.USE_OPENROUTER === 'true' ? 'openrouter' : 'bedrock',
  openrouter: {
    enabled: process.env.USE_OPENROUTER === 'true',
    configured: Boolean(process.env.OPENROUTER_API_KEY),
    configuredKeyCount: [
      process.env.OPENROUTER_API_KEY,
      process.env.OPENROUTER_API_KEY_2,
      process.env.OPENROUTER_API_KEY_3,
    ].filter(Boolean).length,
    model: process.env.OPENROUTER_MODEL || 'openrouter/free',
  },
  gemini: {
    configured: Boolean(process.env.GEMINI_API_KEY),
    configuredKeyCount: [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2].filter(Boolean).length,
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    fallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash-lite',
    role: 'generation-fallback',
  },
  bedrock: {
    configured: Boolean(bearerToken || hasAwsCredentials),
    generationModel: modelId,
    embeddingModel: embeddingModelId,
    role: process.env.USE_OPENROUTER === 'true' ? 'last-resort-generation-and-embeddings' : 'generation-and-embeddings',
  },
  processStats: { ...providerStats },
});

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
  let generationFallbackNeeded = false;
  if (process.env.USE_OPENROUTER === 'true' && !options.attachment) {
    const messages = [];
    if (options.systemText) {
      messages.push({ role: 'system', content: options.systemText });
    }
    messages.push({ role: 'user', content: options.userText });

    try {
      const openrouterResult = await callOpenRouter(messages);
      providerStats.openrouterSuccesses += 1;
      recordProviderCall({
        operation: 'generation',
        task: options.task || 'generation',
        provider: 'openrouter',
        model: process.env.OPENROUTER_MODEL || 'openrouter/free',
        status: 'success',
        keySlot: `key-${openrouterResult.keySlot}`,
      });
      return openrouterResult.content;
    } catch (error) {
      generationFallbackNeeded = true;
      providerStats.openrouterFailures += 1;
      recordProviderCall({
        operation: 'generation',
        task: options.task || 'generation',
        provider: 'openrouter',
        model: process.env.OPENROUTER_MODEL || 'openrouter/free',
        status: 'failed',
        error: error.message,
      });
      console.error('OpenRouter invocation failed, falling back to Gemini:', error.message);
    }
  }

  if (generationFallbackNeeded && process.env.GEMINI_API_KEY && !options.attachment) {
    const geminiModels = [...new Set([
      process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash-lite',
    ])];

    for (const geminiModel of geminiModels) {
      try {
        const geminiResult = await callGemini({ ...options, model: geminiModel });
        providerStats.geminiSuccesses += 1;
        providerStats.fallbacksToGemini += 1;
        recordProviderCall({
          operation: 'generation',
          task: options.task || 'generation',
          provider: 'gemini',
          model: geminiModel,
          status: 'success',
          keySlot: `key-${geminiResult.keySlot}`,
        });
        return geminiResult.content;
      } catch (error) {
        providerStats.geminiFailures += 1;
        recordProviderCall({
          operation: 'generation',
          task: options.task || 'generation',
          provider: 'gemini',
          model: geminiModel,
          status: 'failed',
          error: error.message,
        });
        console.error(`Gemini model ${geminiModel} failed:`, error.message);
      }
    }

    console.error('All Gemini models failed, falling back to Bedrock.');
  }

  if (generationFallbackNeeded) providerStats.fallbacksToBedrock += 1;

  if (bearerToken) {
    try {
      const answer = await invokeWithBearerToken(options);
      providerStats.bedrockGenerationSuccesses += 1;
      recordProviderCall({
        operation: 'generation',
        task: options.task || 'generation',
        provider: 'bedrock',
        model: modelId,
        status: 'success',
      });
      return answer;
    } catch (error) {
      providerStats.bedrockGenerationFailures += 1;
      recordProviderCall({
        operation: 'generation',
        task: options.task || 'generation',
        provider: 'bedrock',
        model: modelId,
        status: 'failed',
        error: error.message,
      });
      console.error('Bedrock bearer token invocation failed:', error.message);
      if (!hasAwsCredentials) throw error;
    }
  }
  try {
    const answer = await invokeWithAwsSdk(options);
    providerStats.bedrockGenerationSuccesses += 1;
    recordProviderCall({
      operation: 'generation',
      task: options.task || 'generation',
      provider: 'bedrock',
      model: modelId,
      status: 'success',
    });
    return answer;
  } catch (error) {
    providerStats.bedrockGenerationFailures += 1;
    recordProviderCall({
      operation: 'generation',
      task: options.task || 'generation',
      provider: 'bedrock',
      model: modelId,
      status: 'failed',
      error: error.message,
    });
    throw error;
  }
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
      const embedding = await invokeEmbeddingWithBearerToken(inputText);
      providerStats.bedrockEmbeddingSuccesses += 1;
      recordProviderCall({ operation: 'embedding', provider: 'bedrock', model: embeddingModelId, status: 'success' });
      return embedding;
    } catch (error) {
      providerStats.bedrockEmbeddingFailures += 1;
      recordProviderCall({
        operation: 'embedding', provider: 'bedrock', model: embeddingModelId, status: 'failed', error: error.message,
      });
      console.error('Bedrock embedding bearer token invocation failed:', error.message);
      if (!hasAwsCredentials) throw error;
    }
  }
  try {
    const embedding = await invokeEmbeddingWithAwsSdk(inputText);
    providerStats.bedrockEmbeddingSuccesses += 1;
    recordProviderCall({ operation: 'embedding', provider: 'bedrock', model: embeddingModelId, status: 'success' });
    return embedding;
  } catch (error) {
    providerStats.bedrockEmbeddingFailures += 1;
    recordProviderCall({
      operation: 'embedding', provider: 'bedrock', model: embeddingModelId, status: 'failed', error: error.message,
    });
    throw error;
  }
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

const improveHandbookQuestion = async (question, options = {}) => {
  const rawQuestion = String(question || '').trim();
  if (!rawQuestion) return improveHandbookQuestionFallback('');

  const history = Array.isArray(options.history) ? options.history.slice(-6) : [];
  const historyText = history.length
    ? history.map((turn) => `User: ${turn.user_message}\nAssistant: ${turn.assistant_answer}`).join('\n\n')
    : '(no previous conversation)';

  const systemText = 'You improve employee handbook questions for retrieval. Return only valid JSON.';
  const userText = `Rewrite this WhatsApp handbook question so it is clearer for search and answering.
Use recent conversation only to resolve references such as "that", "it", "how many", or follow-up questions.
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

Recent conversation:
${historyText}

User message: ${rawQuestion}`;

  try {
    const content = await invokeModel({ systemText, userText, maxTokens: 220, temperature: 0, task: 'question-rewrite' });
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
    const translated = await invokeModel({ systemText, userText, maxTokens: 700, temperature: 0.1, task: 'translation' });
    return String(translated || '').trim() || sourceText;
  } catch (error) {
    console.error('Localization failed:', error.message);
    return sourceText;
  }
};

const VISUAL_OBJECT_PATTERN = /\b(diagram|chart|table|form|map|image|picture|page|layout|organi[sz]ation chart|flowchart|figure|illustration|appendix|screenshot|drawing)\b/i;
const VISUAL_REQUEST_PATTERN = /\b(show|send|display|attach|share|see|view|look at|give me|provide)\b/i;

const hasExplicitVisualIntent = (question) => {
  const text = String(question || '').trim();
  return VISUAL_REQUEST_PATTERN.test(text) && VISUAL_OBJECT_PATTERN.test(text);
};

const decideReplyImagesFallback = (question, contexts, pageNumbers) => {
  const sendImages = hasExplicitVisualIntent(question) && contexts.length > 0 && pageNumbers.length > 0;

  return {
    sendImages,
    pageNumbers: sendImages ? pageNumbers.slice(0, 1) : [],
    reason: sendImages ? 'Explicit visual request with a matching handbook page' : 'No explicit visual request',
  };
};

const decideReplyImages = async ({ question, contexts, pageNumbers }) => {
  if (!hasExplicitVisualIntent(question)) {
    return { sendImages: false, pageNumbers: [], reason: 'No explicit visual request' };
  }

  const availablePages = pageNumbers.slice(0, 5);
  if (!contexts.length || !availablePages.length) {
    return { sendImages: false, pageNumbers: [], reason: 'No relevant handbook page available' };
  }

  const previews = contexts.slice(0, 3).map((context, index) => (
    `[${index + 1}] pages=${JSON.stringify(context.metadata?.pageNumbers || [])} ${String(context.content || '').slice(0, 220)}`
  )).join('\n');

  const systemText = 'You select a handbook page only for an explicit visual request. Return only valid JSON. When uncertain, do not send an image.';
  const userText = `Question: ${question}
Candidate page numbers: ${availablePages.join(', ')}
Matching chunk previews:
${previews}

Return ONLY JSON:
{
  "sendImages": boolean,
  "pageNumbers": [one number from candidate list, or empty],
  "reason": "short reason"
}

Select a page only when its matching text clearly refers to the requested visual object. Do not send a generic page, a loosely related page, or an image merely because the retrieved text contains visual words.`;

  try {
    const content = await invokeModel({ systemText, userText, maxTokens: 180, temperature: 0, task: 'image-selection' });
    const parsed = extractJsonObject(content);
    const selected = Array.isArray(parsed.pageNumbers)
      ? parsed.pageNumbers.map(Number).filter((value) => availablePages.includes(value)).slice(0, 1)
      : [];

    return {
      sendImages: Boolean(parsed.sendImages) && selected.length > 0,
      pageNumbers: selected,
      reason: String(parsed.reason || '').trim() || 'Selected by model',
    };
  } catch (error) {
    console.error('Reply image decision failed:', error.message);
    return decideReplyImagesFallback(question, contexts, availablePages);
  }
};

const answerWithKnowledgeContext = async ({ question, improvedQuestion, contexts }) => {
  const contextText = contexts
    .map((context, index) => `[${index + 1}] ${context.title || context.source_type || 'Knowledge'}\n${context.content}`)
    .join('\n\n');

  const systemText = 'You are a careful property handbook assistant on WhatsApp. Answer using only the provided context. Prefer handbook sources. Distinguish exact labels and locations: never present a yard grille measurement as a master-bedroom window measurement. Cite handbook page numbers when they appear in context. If the requested detail is absent but a related drawing exists, state exactly what the drawing covers and what it does not prove. A context explicitly labeled User correction is trusted user-provided knowledge and may clarify or override an earlier learned answer. Do not include conversational labels, prefixes, or metadata tags (such as "Previously asked:", "Learned answer:", "Question:", "Answer:", or "Prior Answer:") in your output. Go straight to the answer. Be concise, practical, and easy to read on mobile.';
  const userText = `Handbook context:\n${contextText || '(no context)'}\n\nOriginal user question: ${question}\nImproved handbook question: ${improvedQuestion || question}\n\nProvide a helpful answer grounded in the handbook.`;

  const answer = await invokeModel({ systemText, userText, maxTokens: 700, temperature: 0.3, task: 'handbook-answer' });
  return { answer, matches: contexts };
};

const extractTextFromPdfDocument = async (documentBuffer, documentName = 'handbook', pageLabel = '') => {
  const systemText = 'You perform faithful OCR and visual document analysis for a scanned property handbook. Return plain text only. Never guess unreadable values.';
  const userText = pageLabel
    ? `Study this scanned handbook page (${pageLabel}) and produce a retrieval-ready transcription.

Include every readable heading, paragraph, list, note, table cell, drawing label, room name, location, measurement, and unit. Preserve width x height dimensions exactly as printed. If the page contains a plan, drawing, table, or diagram, add a short "Visual summary:" describing what it actually shows and which labels or locations each measurement belongs to.

Do not infer measurements or room associations that are not explicitly shown. Write [unreadable] for a value that cannot be read reliably. Return plain text only.`
    : 'Study this scanned property handbook and produce a faithful retrieval-ready transcription. Include all readable text, measurements, units, tables, diagram labels, room names, locations, and visual meaning. Do not guess unreadable values. Return plain text only.';

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
    task: 'document-ocr',
  });
};

module.exports = {
  getAIProviderStatus,
  runWithProviderTrace,
  generateEmbedding,
  improveHandbookQuestion,
  localizeText,
  decideReplyImages,
  answerWithKnowledgeContext,
  extractTextFromPdfDocument,
  _test: { hasExplicitVisualIntent, decideReplyImagesFallback },
};
