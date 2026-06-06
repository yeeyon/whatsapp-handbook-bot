const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');
const { pool } = require('../config/database');
const {
  answerWithKnowledgeContext,
  generateEmbedding,
  extractTextFromPdfDocument,
  improveHandbookQuestion,
  localizeText,
} = require('../config/bedrock');

const DEFAULT_CHUNK_SIZE = Number(process.env.RAG_CHUNK_SIZE || 1200);
const DEFAULT_CHUNK_OVERLAP = Number(process.env.RAG_CHUNK_OVERLAP || 160);
const DEFAULT_MATCH_LIMIT = Number(process.env.RAG_MATCH_LIMIT || 5);

const normalizeWhitespace = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const normalizeForSearch = (value) => normalizeWhitespace(value)
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ');

const estimateTokenCount = (value) => Math.ceil(normalizeWhitespace(value).length / 4);

const chunkText = (text, options = {}) => {
  const clean = normalizeWhitespace(text);
  const chunkSize = Math.max(Number(options.chunkSize || DEFAULT_CHUNK_SIZE), 200);
  const overlap = Math.max(Math.min(Number(options.overlap || DEFAULT_CHUNK_OVERLAP), Math.floor(chunkSize / 2)), 0);

  if (!clean) return [];
  if (clean.length <= chunkSize) return [clean];

  const chunks = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);
    if (end < clean.length) {
      const boundary = clean.lastIndexOf(' ', end);
      if (boundary > start + Math.floor(chunkSize * 0.6)) end = boundary;
    }

    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks.filter(Boolean);
};

const cosineSimilarity = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

const lexicalScore = (question, content) => {
  const questionTerms = new Set(normalizeForSearch(question).split(' ').filter((term) => term.length > 2));
  if (!questionTerms.size) return 0;

  const contentTerms = new Set(normalizeForSearch(content).split(' ').filter((term) => term.length > 2));
  let score = 0;
  for (const term of questionTerms) {
    if (contentTerms.has(term)) score += 1;
  }

  return score / questionTerms.size;
};

const extractScannedPdfText = async (buffer, fileName) => {
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pageCount = source.getPageCount();
  const parts = [];

  console.log(`PDF has no embedded text. Running Bedrock OCR on ${pageCount} page(s)...`);

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageDoc = await PDFDocument.create();
    const [copiedPage] = await pageDoc.copyPages(source, [pageIndex]);
    pageDoc.addPage(copiedPage);
    const pageBytes = await pageDoc.save();
    const pageLabel = `page ${pageIndex + 1} of ${pageCount}`;

    console.log(`OCR ${pageLabel}...`);
    const pageText = await extractTextFromPdfDocument(pageBytes, fileName, pageLabel);
    if (normalizeWhitespace(pageText)) {
      parts.push(`--- ${pageLabel} ---\n${normalizeWhitespace(pageText)}`);
    }
  }

  return normalizeWhitespace(parts.join('\n\n'));
};

const extractDocumentText = async (buffer, fileName, mimeType) => {
  const normalizedMime = String(mimeType || '').toLowerCase();
  const normalizedName = String(fileName || '').toLowerCase();

  if (normalizedMime.includes('pdf') || normalizedName.endsWith('.pdf')) {
    const parsed = await pdfParse(buffer);
    const parsedText = normalizeWhitespace(parsed.text);
    if (parsedText) return parsedText;

    return extractScannedPdfText(buffer, fileName);
  }

  if (
    normalizedMime.startsWith('text/') ||
    normalizedMime.includes('json') ||
    normalizedName.endsWith('.txt') ||
    normalizedName.endsWith('.md') ||
    normalizedName.endsWith('.csv') ||
    normalizedName.endsWith('.json')
  ) {
    return normalizeWhitespace(buffer.toString('utf8'));
  }

  throw new Error('Unsupported document type. Upload PDF, TXT, Markdown, CSV, or JSON.');
};

const insertChunks = async (client, sourceId, chunks) => {
  for (let index = 0; index < chunks.length; index += 1) {
    const content = chunks[index];
    let embedding = null;

    try {
      embedding = await generateEmbedding(content);
    } catch (error) {
      console.error('Knowledge chunk embedding failed:', error.message);
    }

    await client.query(
      `INSERT INTO knowledge_chunks (source_id, chunk_index, content, embedding, token_count)
       VALUES ($1, $2, $3, $4, $5)`,
      [sourceId, index, content, embedding ? JSON.stringify(embedding) : null, estimateTokenCount(content)]
    );
  }
};

const createKnowledgeSource = async ({
  sourceType,
  title,
  text,
  url = null,
  fileName = null,
  mimeType = null,
  metadata = {},
}) => {
  const cleanText = normalizeWhitespace(text);
  if (!cleanText) {
    throw new Error('Knowledge source text is empty');
  }

  const chunks = chunkText(cleanText);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const sourceResult = await client.query(
      `INSERT INTO knowledge_sources (source_type, title, url, file_name, mime_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [sourceType, title, url, fileName, mimeType, JSON.stringify(metadata)]
    );

    await insertChunks(client, sourceResult.rows[0].id, chunks);
    await client.query('COMMIT');
    return { ...sourceResult.rows[0], chunk_count: chunks.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const ingestDocument = async ({ buffer, fileName, mimeType, title }) => {
  const text = await extractDocumentText(buffer, fileName, mimeType);
  return createKnowledgeSource({
    sourceType: 'document',
    title: title || fileName || 'Uploaded document',
    text,
    fileName,
    mimeType,
  });
};

const listKnowledgeSources = async () => {
  const result = await pool.query(
    `SELECT ks.*, COUNT(kc.id)::int AS chunk_count
     FROM knowledge_sources ks
     LEFT JOIN knowledge_chunks kc ON kc.source_id = ks.id
     GROUP BY ks.id
     ORDER BY ks.created_at DESC`
  );
  return result.rows;
};

const searchKnowledge = async (question, options = {}) => {
  const limit = Number(options.limit || DEFAULT_MATCH_LIMIT);
  const chunksResult = await pool.query(
    `SELECT kc.id, kc.content, kc.embedding, kc.token_count, ks.id AS source_id,
            ks.source_type, ks.title, ks.url, ks.file_name
     FROM knowledge_chunks kc
     JOIN knowledge_sources ks ON ks.id = kc.source_id
     ORDER BY kc.created_at DESC
     LIMIT 1000`
  );

  let questionEmbedding = null;
  try {
    questionEmbedding = await generateEmbedding(question);
  } catch (error) {
    console.error('Knowledge question embedding failed:', error.message);
  }

  return chunksResult.rows
    .map((row) => {
      const embeddingScore = questionEmbedding && Array.isArray(row.embedding)
        ? cosineSimilarity(questionEmbedding, row.embedding)
        : 0;
      const keywordScore = lexicalScore(question, `${row.title} ${row.content}`);

      return {
        ...row,
        score: embeddingScore || keywordScore,
        lexical_score: keywordScore,
        embedding_score: embeddingScore,
      };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

const mergeContexts = (contextLists) => {
  const seen = new Set();
  const merged = [];

  for (const contexts of contextLists) {
    for (const context of contexts) {
      const key = String(context.id);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(context);
    }
  }

  return merged.sort((a, b) => b.score - a.score);
};

const answerKnowledgeQuestion = async (question) => {
  const refined = await improveHandbookQuestion(question);
  const searchTerms = [...new Set([
    refined.improvedQuestion,
    refined.originalQuestion,
    ...refined.searchQueries,
  ].filter(Boolean))];

  const contextLists = await Promise.all(searchTerms.map((term) => searchKnowledge(term)));
  const contexts = mergeContexts(contextLists).slice(0, DEFAULT_MATCH_LIMIT);

  if (!contexts.length) {
    return {
      answer: 'I do not have information about that in the handbook yet. Try asking about a specific policy or procedure.',
      matches: [],
      refined,
    };
  }

  try {
    const result = await answerWithKnowledgeContext({
      question: refined.originalQuestion,
      improvedQuestion: refined.improvedQuestion,
      contexts,
    });

    const localizedAnswer = await localizeText(result.answer, refined.detectedLanguage);
    return {
      ...result,
      answer: localizedAnswer,
      refined,
    };
  } catch (error) {
    console.error('Knowledge answer generation failed:', error.message);
    return {
      answer: contexts[0].content,
      matches: contexts,
      refined,
    };
  }
};

module.exports = {
  answerKnowledgeQuestion,
  ingestDocument,
  listKnowledgeSources,
  searchKnowledge,
  _test: { chunkText, cosineSimilarity, lexicalScore },
};
