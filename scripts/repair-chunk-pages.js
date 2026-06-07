const { initDatabase, pool } = require('../src/config/database');
const { parsePageMarkers } = require('../src/services/handbookPages');

const repairSource = async (client, sourceId) => {
  const result = await client.query(
    `SELECT id, content
     FROM knowledge_chunks
     WHERE source_id = $1
     ORDER BY chunk_index ASC`,
    [sourceId]
  );

  let currentPage = null;
  let updated = 0;
  for (const chunk of result.rows) {
    const markers = parsePageMarkers(chunk.content);
    const pageNumbers = [...new Set([
      ...(currentPage ? [currentPage] : []),
      ...markers,
    ])];
    if (markers.length) currentPage = markers[markers.length - 1];
    if (!pageNumbers.length && currentPage) pageNumbers.push(currentPage);
    if (!pageNumbers.length) continue;

    await client.query(
      `UPDATE knowledge_chunks
       SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{pageNumbers}', $1::jsonb, true)
       WHERE id = $2`,
      [JSON.stringify(pageNumbers), chunk.id]
    );
    updated += 1;
  }
  return { sourceId, chunks: result.rows.length, updated };
};

const main = async () => {
  await initDatabase();
  const sources = await pool.query(
    `SELECT DISTINCT ks.id
     FROM knowledge_sources ks
     JOIN knowledge_chunks kc ON kc.source_id = ks.id
     WHERE kc.content ~* '--- page [0-9]+ of [0-9]+ ---'
     ORDER BY ks.id`
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const repaired = [];
    for (const source of sources.rows) repaired.push(await repairSource(client, source.id));
    await client.query('COMMIT');
    console.log({ repaired });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
