const { pool } = require('../config/database');
const { generateEmbedding } = require('../config/bedrock');

const POSITIVE_FEEDBACK = /^(yes|yes correct|correct|helpful|that helps|thanks|thank you|good answer|right|👍)$/i;
const NEGATIVE_FEEDBACK = /^(no|nope|wrong|incorrect|not helpful|bad answer|👎)$/i;
const CORRECTION_FEEDBACK = /^(?:correction|correct answer|actually)\s*[:\-]\s*(.+)$/i;

const parseFeedbackMessage = (message) => {
  const text = String(message || '').trim();
  const correction = text.match(CORRECTION_FEEDBACK);
  if (correction?.[1]?.trim()) return { type: 'correction', content: correction[1].trim() };
  if (POSITIVE_FEEDBACK.test(text)) return { type: 'positive', content: text };
  if (NEGATIVE_FEEDBACK.test(text)) return { type: 'negative', content: text };
  return null;
};

const getOrCreateConversation = async ({ channel, externalId }) => {
  const result = await pool.query(
    `INSERT INTO rag_conversations (channel, external_id)
     VALUES ($1, $2)
     ON CONFLICT (channel, external_id)
     DO UPDATE SET updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [channel, externalId]
  );
  return result.rows[0];
};

const getRecentTurns = async (conversationId, limit = 6) => {
  const result = await pool.query(
    `SELECT id, user_message, improved_question, assistant_answer, status, created_at
     FROM rag_turns
     WHERE conversation_id = $1 AND status = 'delivered'
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, limit]
  );
  return result.rows.reverse();
};

const createTurn = async ({ conversationId, question, improvedQuestion, answer, detectedLanguage, contexts }) => {
  const retrievalContext = contexts.map((context) => ({
    id: context.id,
    sourceId: context.source_id || null,
    title: context.title || null,
    score: context.score || 0,
    sourceType: context.source_type || null,
  }));
  const result = await pool.query(
    `INSERT INTO rag_turns
       (conversation_id, user_message, improved_question, assistant_answer, detected_language, retrieval_context)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [conversationId, question, improvedQuestion, answer, detectedLanguage, JSON.stringify(retrievalContext)]
  );
  return result.rows[0];
};

const buildMemoryEmbedding = async (question, answer) => {
  try {
    return await generateEmbedding(`Question: ${question}\nAnswer: ${answer}`);
  } catch (error) {
    console.error('RAG memory embedding failed:', error.message);
    return null;
  }
};

const markTurnDelivered = async (turnId) => {
  const turnResult = await pool.query(
    `UPDATE rag_turns
     SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [turnId]
  );
  const turn = turnResult.rows[0];
  if (!turn) return null;

  const hasGroundedContext = Array.isArray(turn.retrieval_context) && turn.retrieval_context.length > 0;
  if (hasGroundedContext) {
    const embedding = await buildMemoryEmbedding(turn.improved_question || turn.user_message, turn.assistant_answer);
    await pool.query(
      `INSERT INTO rag_memories (turn_id, question, answer, embedding)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (turn_id) DO UPDATE SET
         question = EXCLUDED.question,
         answer = EXCLUDED.answer,
         embedding = EXCLUDED.embedding,
         active = TRUE,
         updated_at = CURRENT_TIMESTAMP`,
      [turn.id, turn.improved_question || turn.user_message, turn.assistant_answer, embedding ? JSON.stringify(embedding) : null]
    );
  }
  return turn;
};

const getLatestDeliveredTurn = async (conversationId) => {
  const result = await pool.query(
    `SELECT * FROM rag_turns
     WHERE conversation_id = $1 AND status = 'delivered'
     ORDER BY delivered_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [conversationId]
  );
  return result.rows[0] || null;
};

const recordFeedback = async ({ conversationId, feedback }) => {
  const turn = await getLatestDeliveredTurn(conversationId);
  if (!turn) return null;

  await pool.query(
    `INSERT INTO rag_feedback (turn_id, feedback_type, content) VALUES ($1, $2, $3)`,
    [turn.id, feedback.type, feedback.content || null]
  );

  if (feedback.type === 'negative') {
    await pool.query(
      `UPDATE rag_memories SET active = FALSE, confidence = 0, updated_at = CURRENT_TIMESTAMP
       WHERE turn_id = $1`,
      [turn.id]
    );
  } else if (feedback.type === 'correction' || (Array.isArray(turn.retrieval_context) && turn.retrieval_context.length > 0)) {
    const answer = feedback.type === 'correction' ? feedback.content : turn.assistant_answer;
    const memoryType = feedback.type === 'correction' ? 'user_correction' : 'confirmed_answer';
    const confidence = feedback.type === 'correction' ? 1 : 0.85;
    const embedding = await buildMemoryEmbedding(turn.improved_question || turn.user_message, answer);
    await pool.query(
      `INSERT INTO rag_memories (turn_id, memory_type, question, answer, embedding, confidence, active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       ON CONFLICT (turn_id) DO UPDATE SET
         memory_type = EXCLUDED.memory_type,
         question = EXCLUDED.question,
         answer = EXCLUDED.answer,
         embedding = EXCLUDED.embedding,
         confidence = EXCLUDED.confidence,
         active = TRUE,
         updated_at = CURRENT_TIMESTAMP`,
      [turn.id, memoryType, turn.improved_question || turn.user_message, answer, embedding ? JSON.stringify(embedding) : null, confidence]
    );
  }

  return { turn, feedback };
};

const listActiveMemories = async (limit = 500) => {
  const result = await pool.query(
    `SELECT rm.*, rt.conversation_id
     FROM rag_memories rm
     JOIN rag_turns rt ON rt.id = rm.turn_id
     WHERE rm.active = TRUE
     ORDER BY rm.updated_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
};

module.exports = {
  parseFeedbackMessage,
  getOrCreateConversation,
  getRecentTurns,
  createTurn,
  markTurnDelivered,
  recordFeedback,
  listActiveMemories,
};
