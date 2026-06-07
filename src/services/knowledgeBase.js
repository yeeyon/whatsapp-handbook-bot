const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');
const { pool } = require('../config/database');
const {
  answerWithKnowledgeContext,
  generateEmbedding,
  extractTextFromPdfDocument,
  improveHandbookQuestion,
  localizeText,
  decideReplyImages,
} = require('../config/bedrock');
const {
  getHandbookPageImages,
  getLatestHandbookPage,
  getLatestHandbookPageCount,
  insertHandbookPage,
  pickReplyPageNumbers,
} = require('./handbookPages');
const { renderPdfPageToJpeg, savePageImage } = require('./pageImages');
const {
  getOrCreateConversation,
  getRecentTurns,
  createTurn,
  listActiveMemories,
} = require('./conversationMemory');

const DEFAULT_CHUNK_SIZE = Number(process.env.RAG_CHUNK_SIZE || 1200);
const DEFAULT_CHUNK_OVERLAP = Number(process.env.RAG_CHUNK_OVERLAP || 160);
const DEFAULT_MATCH_LIMIT = Number(process.env.RAG_MATCH_LIMIT || 5);
const DEFAULT_HISTORY_LIMIT = Number(process.env.RAG_HISTORY_LIMIT || 6);
const DEFAULT_MIN_EMBEDDING_SCORE = Number(process.env.RAG_MIN_EMBEDDING_SCORE || 0.28);
const DEFAULT_MIN_LEXICAL_SCORE = Number(process.env.RAG_MIN_LEXICAL_SCORE || 0.5);
const SEARCH_STOP_WORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'why', 'how', 'can', 'could', 'would',
  'should', 'does', 'tell', 'show', 'send', 'give', 'provide', 'please', 'about',
  'with', 'from', 'into', 'that', 'this', 'these', 'those', 'your', 'handbook',
  'page', 'image', 'picture', 'look', 'view', 'have', 'need', 'want', 'there',
  'say', 'says', 'information', 'details',
  'the', 'and', 'for', 'are', 'was', 'were', 'has', 'had', 'not',
]);
const AMBIGUOUS_SINGLE_TERMS = new Set(['schedule', 'policy', 'procedure', 'rules', 'form', 'section', 'document']);
const DIRECT_PAGE_REQUEST_PATTERN = /(?:^|\b(?:show|send|give|open|view|see|display|share|what(?:'s| is)?(?: on| in)?|contents? of)\b[\s\S]{0,35}\b)(?:page|pg)\s*#?\s*(\d{1,4})\b/i;

const normalizeWhitespace = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const cleanLeakedMetadata = (text) => {
  if (typeof text !== 'string') return text;
  
  let clean = text;
  
  // If there are "Learned answer:" occurrences, get the last one
  if (clean.includes('Learned answer:')) {
    const parts = clean.split('Learned answer:');
    clean = parts[parts.length - 1];
  }
  
  // Clean any leading/trailing tags
  clean = clean.replace(/^(Previously asked:|Learned answer:|User Question:|Answer:)\s*/gim, '').trim();
  
  return clean;
};

const normalizeForSearch = (value) => normalizeWhitespace(value)
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ');

const getSearchTerms = (value) => normalizeForSearch(value).split(' ')
  .filter((term) => term.length > 2 && !SEARCH_STOP_WORDS.has(term));

const isUnderspecifiedQuestion = (question) => {
  const terms = [...new Set(getSearchTerms(question))];
  return terms.length === 1 && AMBIGUOUS_SINGLE_TERMS.has(terms[0]);
};

const parseDirectPageRequest = (question) => {
  const match = String(question || '').match(DIRECT_PAGE_REQUEST_PATTERN);
  return match ? Number(match[1]) : null;
};

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
  const questionTerms = new Set(getSearchTerms(question));
  if (!questionTerms.size) return 0;

  const contentTerms = new Set(normalizeForSearch(content).split(' ').filter((term) => term.length > 2));
  let score = 0;
  for (const term of questionTerms) {
    if (contentTerms.has(term)) score += 1;
  }

  return score / questionTerms.size;
};

const calculateRetrievalScore = (embeddingScore, keywordScore) => {
  const semantic = Number(embeddingScore || 0);
  const lexical = Number(keywordScore || 0);
  if (!semantic) return lexical * 0.85;
  if (!lexical) return semantic;
  return (semantic * 0.7) + (lexical * 0.3);
};

const isKnowledgeMatch = ({ embeddingScore, keywordScore }) => (
  Number(embeddingScore || 0) >= DEFAULT_MIN_EMBEDDING_SCORE
  || Number(keywordScore || 0) >= DEFAULT_MIN_LEXICAL_SCORE
);

const buildChunkRecords = (pages) => {
  const records = [];

  for (const page of pages) {
    const pagePrefix = `--- page ${page.pageNumber} of ${page.pageCount} ---`;
    const chunks = chunkText(page.text);
    for (const chunk of chunks) {
      records.push({
        content: `${pagePrefix}\n${chunk}`,
        metadata: { pageNumbers: [page.pageNumber] },
      });
    }
  }

  return records;
};

const extractScannedPdfPages = async (buffer, fileName) => {
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pageCount = source.getPageCount();
  const pages = [];

  console.log(`PDF has no embedded text. Running Bedrock OCR and page image capture on ${pageCount} page(s)...`);

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageNumber = pageIndex + 1;
    const pageDoc = await PDFDocument.create();
    const [copiedPage] = await pageDoc.copyPages(source, [pageIndex]);
    pageDoc.addPage(copiedPage);
    const pageBytes = await pageDoc.save();
    const pageLabel = `page ${pageNumber} of ${pageCount}`;

    console.log(`Processing ${pageLabel}...`);
    const [pageText, imageBuffer] = await Promise.all([
      extractTextFromPdfDocument(pageBytes, fileName, pageLabel),
      renderPdfPageToJpeg(buffer, pageNumber).catch((error) => {
        console.error(`Page image render failed for ${pageLabel}:`, error.message);
        return null;
      }),
    ]);

    pages.push({
      pageNumber,
      pageCount,
      text: normalizeWhitespace(pageText),
      imageBuffer,
    });
  }

  return pages;
};

const extractDocumentPages = async (buffer, fileName, mimeType) => {
  const normalizedMime = String(mimeType || '').toLowerCase();
  const normalizedName = String(fileName || '').toLowerCase();

  if (normalizedMime.includes('pdf') || normalizedName.endsWith('.pdf')) {
    const parsed = await pdfParse(buffer);
    const parsedText = normalizeWhitespace(parsed.text);

    if (parsedText) {
      return [{
        pageNumber: 1,
        pageCount: 1,
        text: parsedText,
        imageBuffer: await renderPdfPageToJpeg(buffer, 1).catch(() => null),
      }];
    }

    return extractScannedPdfPages(buffer, fileName);
  }

  if (
    normalizedMime.startsWith('text/') ||
    normalizedMime.includes('json') ||
    normalizedName.endsWith('.txt') ||
    normalizedName.endsWith('.md') ||
    normalizedName.endsWith('.csv') ||
    normalizedName.endsWith('.json')
  ) {
    return [{
      pageNumber: 1,
      pageCount: 1,
      text: normalizeWhitespace(buffer.toString('utf8')),
      imageBuffer: null,
    }];
  }

  throw new Error('Unsupported document type. Upload PDF, TXT, Markdown, CSV, or JSON.');
};

const insertChunks = async (client, sourceId, chunkRecords) => {
  for (let index = 0; index < chunkRecords.length; index += 1) {
    const { content, metadata } = chunkRecords[index];
    let embedding = null;

    try {
      embedding = await generateEmbedding(content);
    } catch (error) {
      console.error('Knowledge chunk embedding failed:', error.message);
    }

    await client.query(
      `INSERT INTO knowledge_chunks (source_id, chunk_index, content, embedding, token_count, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        sourceId,
        index,
        content,
        embedding ? JSON.stringify(embedding) : null,
        estimateTokenCount(content),
        JSON.stringify(metadata || {}),
      ]
    );
  }
};

const createKnowledgeSourceFromPages = async ({
  sourceType,
  title,
  pages,
  url = null,
  fileName = null,
  mimeType = null,
  metadata = {},
}) => {
  const chunkRecords = buildChunkRecords(pages.filter((page) => page.text));
  if (!chunkRecords.length) {
    throw new Error('Knowledge source text is empty');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const sourceResult = await client.query(
      `INSERT INTO knowledge_sources (source_type, title, url, file_name, mime_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [sourceType, title, url, fileName, mimeType, JSON.stringify({ ...metadata, pageCount: pages.length })]
    );

    const sourceId = sourceResult.rows[0].id;

    for (const page of pages) {
      if (!page.imageBuffer) continue;
      const imagePath = await savePageImage(sourceId, page.pageNumber, page.imageBuffer);
      await insertHandbookPage(client, {
        sourceId,
        pageNumber: page.pageNumber,
        imagePath,
        ocrText: page.text,
        imageData: page.imageBuffer,
      });
    }

    await insertChunks(client, sourceId, chunkRecords);
    await client.query('COMMIT');

    return {
      ...sourceResult.rows[0],
      chunk_count: chunkRecords.length,
      page_count: pages.length,
      image_count: pages.filter((page) => page.imageBuffer).length,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const ingestDocument = async ({ buffer, fileName, mimeType, title }) => {
  const pages = await extractDocumentPages(buffer, fileName, mimeType);
  return createKnowledgeSourceFromPages({
    sourceType: 'document',
    title: title || fileName || 'Uploaded document',
    pages,
    fileName,
    mimeType,
  });
};

const listKnowledgeSources = async () => {
  const result = await pool.query(
    `SELECT ks.*,
            COUNT(DISTINCT kc.id)::int AS chunk_count,
            COUNT(DISTINCT hp.id)::int AS page_image_count
     FROM knowledge_sources ks
     LEFT JOIN knowledge_chunks kc ON kc.source_id = ks.id
     LEFT JOIN handbook_pages hp ON hp.source_id = ks.id
     GROUP BY ks.id
     ORDER BY ks.created_at DESC`
  );
  return result.rows;
};

const searchKnowledge = async (question, options = {}) => {
  const limit = Number(options.limit || DEFAULT_MATCH_LIMIT);
  const chunksResult = await pool.query(
    `SELECT kc.id, kc.content, kc.embedding, kc.token_count, kc.metadata,
            ks.id AS source_id, ks.source_type, ks.title, ks.url, ks.file_name
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
        score: calculateRetrievalScore(embeddingScore, keywordScore),
        lexical_score: keywordScore,
        embedding_score: embeddingScore,
        is_relevant: isKnowledgeMatch({ embeddingScore, keywordScore }),
      };
    })
    .filter((row) => row.is_relevant)
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

const searchLearnedMemories = async (question, options = {}) => {
  const memories = await listActiveMemories();
  if (!memories.length) return [];

  let questionEmbedding = null;
  try {
    questionEmbedding = await generateEmbedding(question);
  } catch (error) {
    console.error('Learned memory question embedding failed:', error.message);
  }

  return memories
    .map((memory) => {
      const embeddingScore = questionEmbedding && Array.isArray(memory.embedding)
        ? cosineSimilarity(questionEmbedding, memory.embedding)
        : 0;
      const keywordScore = lexicalScore(question, `${memory.question} ${memory.answer}`);
      const relevance = Math.max(embeddingScore, keywordScore);
      const sameConversationBoost = Number(memory.conversation_id) === Number(options.conversationId) ? 0.08 : 0;
      const confidence = Number(memory.confidence || 0.35);
      return {
        id: `memory-${memory.id}`,
        content: `Fact: For the question "${memory.question}", the correct answer is: ${memory.answer}`,
        title: memory.memory_type === 'user_correction' ? 'User correction' : 'Learned conversation answer',
        source_type: 'learned_memory',
        source_id: null,
        metadata: { turnId: memory.turn_id, memoryType: memory.memory_type },
        score: (relevance * confidence * 0.9) + sameConversationBoost,
        lexical_score: keywordScore,
        embedding_score: embeddingScore,
      };
    })
    .filter((memory) => memory.score > 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, Number(options.limit || 3));
};

const answerKnowledgeQuestion = async (question, options = {}) => {
  const conversation = options.conversationId
    ? { id: options.conversationId }
    : options.conversationKey
      ? await getOrCreateConversation({
        channel: options.channel || 'api',
        externalId: options.conversationKey,
      })
      : null;
  const history = conversation ? await getRecentTurns(conversation.id, DEFAULT_HISTORY_LIMIT) : [];
  const requestedPage = parseDirectPageRequest(question);
  if (requestedPage) {
    const [page, pageCount] = await Promise.all([
      getLatestHandbookPage(requestedPage),
      getLatestHandbookPageCount(),
    ]);
    let answer = page
      ? `Here is page ${requestedPage} of ${pageCount || 'the handbook'}.`
      : `Page ${requestedPage} is not available. The current handbook has ${pageCount} page${pageCount === 1 ? '' : 's'}.`;
    if (page && process.env.PUBLIC_URL) {
      answer += `\n\nView PDF: ${process.env.PUBLIC_URL}/handbook.pdf#page=${requestedPage}`;
    }
    const images = page
      ? await getHandbookPageImages({ sourceId: page.source_id, pageNumbers: [requestedPage] })
      : [];
    const contexts = page ? [{
      id: `page-${page.source_id}-${requestedPage}`,
      source_id: page.source_id,
      source_type: 'document_page',
      title: page.title,
      content: page.ocr_text || `Handbook page ${requestedPage}`,
      score: 1,
      metadata: { pageNumbers: [requestedPage], pageCount, directPageRequest: true },
    }] : [];
    const turn = conversation ? await createTurn({
      conversationId: conversation.id,
      question,
      improvedQuestion: question,
      answer,
      detectedLanguage: 'en',
      contexts,
    }) : null;
    return {
      answer,
      matches: contexts,
      refined: {
        originalQuestion: question,
        improvedQuestion: question,
        searchQueries: [question],
        detectedLanguage: 'en',
      },
      images,
      imageDecision: {
        sendImages: images.length > 0,
        pageNumbers: images.length ? [requestedPage] : [],
        pageCount,
        reason: page ? 'Exact handbook page requested' : 'Requested page is unavailable',
      },
      conversationId: conversation?.id || null,
      turnId: turn?.id || null,
    };
  }
  const refined = await improveHandbookQuestion(question, { history });
  if (isUnderspecifiedQuestion(refined.originalQuestion) || isUnderspecifiedQuestion(refined.improvedQuestion)) {
    const answer = 'Please specify which policy, schedule, form, procedure, or handbook topic you mean.';
    const turn = conversation ? await createTurn({
      conversationId: conversation.id,
      question: refined.originalQuestion,
      improvedQuestion: refined.improvedQuestion,
      answer,
      detectedLanguage: refined.detectedLanguage,
      contexts: [],
    }) : null;
    return {
      answer,
      matches: [],
      refined,
      images: [],
      imageDecision: { sendImages: false, pageNumbers: [], reason: 'Question needs clarification' },
      conversationId: conversation?.id || null,
      turnId: turn?.id || null,
    };
  }
  const searchTerms = [...new Set([
    refined.improvedQuestion,
    refined.originalQuestion,
    ...refined.searchQueries,
  ].filter(Boolean))];

  const [contextLists, learnedLists] = await Promise.all([
    Promise.all(searchTerms.map((term) => searchKnowledge(term))),
    Promise.all(searchTerms.map((term) => searchLearnedMemories(term, { conversationId: conversation?.id }))),
  ]);
  const handbookContexts = mergeContexts(contextLists);
  const learnedContexts = mergeContexts(learnedLists);
  const contexts = [...handbookContexts.slice(0, DEFAULT_MATCH_LIMIT), ...learnedContexts.slice(0, 2)]
    .sort((a, b) => b.score - a.score)
    .slice(0, DEFAULT_MATCH_LIMIT + 2);

  if (!contexts.length) {
    const answer = 'I do not have information about that in the handbook yet. Try asking about a specific policy or procedure.';
    const turn = conversation ? await createTurn({
      conversationId: conversation.id,
      question: refined.originalQuestion,
      improvedQuestion: refined.improvedQuestion,
      answer,
      detectedLanguage: refined.detectedLanguage,
      contexts: [],
    }) : null;
    return {
      answer,
      matches: [],
      refined,
      images: [],
      conversationId: conversation?.id || null,
      turnId: turn?.id || null,
    };
  }

  const sourceId = handbookContexts[0]?.source_id;
  const sourceContexts = sourceId
    ? handbookContexts.filter((context) => Number(context.source_id) === Number(sourceId))
    : [];
  const candidatePages = pickReplyPageNumbers(sourceContexts, 3, sourceId);
  const imageDecision = await decideReplyImages({
    question: refined.originalQuestion,
    contexts: sourceContexts,
    pageNumbers: candidatePages,
  });

  let result;
  try {
    result = await answerWithKnowledgeContext({
      question: refined.originalQuestion,
      improvedQuestion: refined.improvedQuestion,
      contexts,
    });
  } catch (error) {
    console.error('Knowledge answer generation failed:', error.message);
    result = {
      answer: contexts[0].content,
      matches: contexts,
    };
  }

  // Clean RAG responses from any leaked metadata tags
  const cleanAnswer = cleanLeakedMetadata(result.answer);
  let localizedAnswer = cleanLeakedMetadata(await localizeText(cleanAnswer, refined.detectedLanguage));

  // If PUBLIC_URL is configured and we have candidate pages, append direct PDF page reference links
  if (process.env.PUBLIC_URL && candidatePages.length > 0) {
    const links = candidatePages.map((p) => `${process.env.PUBLIC_URL}/handbook.pdf#page=${p}`).join('\n');
    localizedAnswer += `\n\nPDF Page Reference(s):\n${links}`;
  }

  const images = imageDecision.sendImages && sourceId
    ? await getHandbookPageImages({ sourceId, pageNumbers: imageDecision.pageNumbers })
    : [];

  const turn = conversation ? await createTurn({
    conversationId: conversation.id,
    question: refined.originalQuestion,
    improvedQuestion: refined.improvedQuestion,
    answer: localizedAnswer,
    detectedLanguage: refined.detectedLanguage,
    contexts,
  }) : null;

  return {
    ...result,
    answer: localizedAnswer,
    refined,
    images,
    imageDecision,
    conversationId: conversation?.id || null,
    turnId: turn?.id || null,
  };
};

module.exports = {
  answerKnowledgeQuestion,
  ingestDocument,
  listKnowledgeSources,
  searchKnowledge,
  searchLearnedMemories,
  _test: {
    chunkText,
    cosineSimilarity,
    lexicalScore,
    calculateRetrievalScore,
    isKnowledgeMatch,
    isUnderspecifiedQuestion,
    parseDirectPageRequest,
    buildChunkRecords,
  },
};
