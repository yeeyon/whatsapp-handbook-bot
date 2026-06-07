const { pool } = require('../src/config/database');

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

async function main() {
  console.log('Fetching active memories and turns...');
  
  // Clean rag_memories
  const memoriesResult = await pool.query('SELECT id, answer FROM rag_memories');
  let updatedMemories = 0;
  for (const row of memoriesResult.rows) {
    const cleaned = cleanLeakedMetadata(row.answer);
    if (cleaned !== row.answer) {
      await pool.query('UPDATE rag_memories SET answer = $1 WHERE id = $2', [cleaned, row.id]);
      updatedMemories++;
    }
  }
  console.log(`Updated ${updatedMemories} rows in rag_memories.`);

  // Clean rag_turns
  const turnsResult = await pool.query('SELECT id, assistant_answer FROM rag_turns');
  let updatedTurns = 0;
  for (const row of turnsResult.rows) {
    const cleaned = cleanLeakedMetadata(row.assistant_answer);
    if (cleaned !== row.assistant_answer) {
      await pool.query('UPDATE rag_turns SET assistant_answer = $1 WHERE id = $2', [cleaned, row.id]);
      updatedTurns++;
    }
  }
  console.log(`Updated ${updatedTurns} rows in rag_turns.`);

  await pool.end();
  console.log('Database cleanup complete.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
