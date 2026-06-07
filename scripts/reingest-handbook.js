const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { initDatabase, pool } = require('../src/config/database');
const { ingestDocument } = require('../src/services/knowledgeBase');
const { HANDBOOK_PAGES_DIR } = require('../src/services/pageImages');

const main = async () => {
  const handbookPath = path.resolve(
    process.env.HANDBOOK_PATH || path.join(__dirname, '../data/handbook.pdf')
  );
  if (!fs.existsSync(handbookPath)) throw new Error(`Handbook PDF not found: ${handbookPath}`);

  await initDatabase();
  const oldSources = await pool.query('SELECT id FROM knowledge_sources ORDER BY id');
  console.log(`OCR model: ${process.env.BEDROCK_MODEL_ID}`);
  console.log(`Staging full page-by-page reingestion from ${handbookPath}...`);

  const source = await ingestDocument({
    buffer: fs.readFileSync(handbookPath),
    fileName: path.basename(handbookPath),
    mimeType: 'application/pdf',
    title: process.env.HANDBOOK_TITLE || "D'Starlington Property Handbook",
  });

  const oldSourceIds = oldSources.rows.map((row) => row.id).filter((id) => id !== source.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM rag_conversations');
    if (oldSourceIds.length) {
      await client.query('DELETE FROM knowledge_sources WHERE id = ANY($1)', [oldSourceIds]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  for (const sourceId of oldSourceIds) {
    fs.rmSync(path.join(HANDBOOK_PAGES_DIR, String(sourceId)), { recursive: true, force: true });
  }

  console.log({
    sourceId: source.id,
    title: source.title,
    pages: source.page_count,
    chunks: source.chunk_count,
    images: source.image_count,
    removedSourceIds: oldSourceIds,
    clearedConversationLearning: true,
  });
  await pool.end();
};

main().catch(async (error) => {
  console.error('Clean reingestion failed:', error);
  await pool.end().catch(() => {});
  process.exit(1);
});
