const fs = require('fs');
const { initDatabase, pool } = require('../src/config/database');
const { answerKnowledgeQuestion } = require('../src/services/knowledgeBase');

const main = async () => {
  await initDatabase();
  const sourceResult = await pool.query(
    `SELECT ks.id, ks.title,
            (SELECT COUNT(*)::int FROM knowledge_sources) AS source_count,
            COUNT(DISTINCT hp.id)::int AS pages,
            COUNT(DISTINCT kc.id)::int AS chunks,
            COUNT(DISTINCT hp.id) FILTER (WHERE LENGTH(COALESCE(hp.ocr_text, '')) > 0)::int AS ocr_pages,
            COUNT(DISTINCT hp.id) FILTER (WHERE LENGTH(COALESCE(hp.image_path, '')) > 0)::int AS image_pages
     FROM knowledge_sources ks
     LEFT JOIN handbook_pages hp ON hp.source_id = ks.id
     LEFT JOIN knowledge_chunks kc ON kc.source_id = ks.id
     GROUP BY ks.id, ks.title
     ORDER BY ks.created_at DESC, ks.id DESC
     LIMIT 1`
  );
  const source = sourceResult.rows[0];
  const page64Result = await pool.query(
    `SELECT ocr_text, image_path FROM handbook_pages WHERE source_id = $1 AND page_number = 64`,
    [source?.id]
  );
  const page64 = page64Result.rows[0];
  const directPage = await answerKnowledgeQuestion('give me page 1');

  const checks = {
    oneSource: source?.source_count === 1,
    propertyTitle: /starlington|property/i.test(source?.title || ''),
    allPagesStored: source?.pages === 66 && source?.ocr_pages === 66 && source?.image_pages === 66,
    chunksCreated: Number(source?.chunks || 0) > 66,
    grilleDimensionStored: /1527\s*x\s*2400/i.test(page64?.ocr_text || ''),
    page64ImageExists: Boolean(page64?.image_path && fs.existsSync(page64.image_path)),
    directPageWorks: directPage.images.length === 1 && directPage.images[0].pageNumber === 1,
  };
  const passed = Object.values(checks).every(Boolean);
  console.log({ passed, source, checks });
  await pool.end();
  if (!passed) process.exit(1);
};

main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
