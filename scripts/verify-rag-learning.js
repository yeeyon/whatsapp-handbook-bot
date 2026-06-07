const { initDatabase, pool } = require('../src/config/database');
const {
  getOrCreateConversation,
  getRecentTurns,
  createTurn,
  markTurnDelivered,
  recordFeedback,
} = require('../src/services/conversationMemory');
const { searchLearnedMemories } = require('../src/services/knowledgeBase');

const main = async () => {
  await initDatabase();
  const externalId = `verification-${Date.now()}`;
  const conversation = await getOrCreateConversation({ channel: 'verification', externalId });

  try {
    const turn = await createTurn({
      conversationId: conversation.id,
      question: 'How many annual leave days are provided?',
      improvedQuestion: 'What is the annual leave entitlement?',
      answer: 'The handbook provides annual leave according to the stated entitlement.',
      detectedLanguage: 'en',
      contexts: [{ id: 1, source_id: 1, title: 'Verification handbook', score: 0.9, source_type: 'document' }],
    });
    await markTurnDelivered(turn.id);
    await recordFeedback({
      conversationId: conversation.id,
      feedback: { type: 'correction', content: 'Annual leave entitlement is 14 days.' },
    });

    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM rag_conversations WHERE id = $1) AS conversations,
         (SELECT COUNT(*)::int FROM rag_turns WHERE conversation_id = $1 AND status = 'delivered') AS delivered_turns,
         (SELECT COUNT(*)::int FROM rag_feedback rf JOIN rag_turns rt ON rt.id = rf.turn_id WHERE rt.conversation_id = $1) AS feedback,
         (SELECT COUNT(*)::int FROM rag_memories rm JOIN rag_turns rt ON rt.id = rm.turn_id
           WHERE rt.conversation_id = $1 AND rm.memory_type = 'user_correction' AND rm.active = TRUE) AS corrections`,
      [conversation.id]
    );
    const counts = result.rows[0];
    const recentTurns = await getRecentTurns(conversation.id);
    const learned = await searchLearnedMemories('What is the annual leave entitlement?', {
      conversationId: conversation.id,
    });
    const passed = Object.values(counts).every((count) => count === 1)
      && recentTurns.length === 1
      && learned.some((memory) => (
        memory.metadata?.memoryType === 'user_correction'
        && memory.content.includes('14 days')
      ));
    console.log({
      passed,
      counts,
      historyTurns: recentTurns.length,
      learnedMemoryTypes: learned.map((memory) => memory.metadata?.memoryType),
    });
    if (!passed) process.exitCode = 1;
  } finally {
    await pool.query('DELETE FROM rag_conversations WHERE id = $1', [conversation.id]);
    await pool.end();
  }
};

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
