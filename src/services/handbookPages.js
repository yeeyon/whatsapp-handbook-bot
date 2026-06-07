const { pool } = require('../config/database');
const { loadPageImage } = require('./pageImages');

const parsePageMarker = (content) => {
  const match = String(content || '').match(/--- page (\d+) of \d+ ---/i);
  return match ? Number(match[1]) : null;
};

const parsePageMarkers = (content) => [...String(content || '').matchAll(/--- page (\d+) of \d+ ---/gi)]
  .map((match) => Number(match[1]))
  .filter((value, index, values) => Number.isFinite(value) && values.indexOf(value) === index);

const getPageNumbersFromContext = (context) => {
  const metadataPages = Array.isArray(context?.metadata?.pageNumbers)
    ? context.metadata.pageNumbers.map(Number).filter((value) => Number.isFinite(value))
    : [];

  if (metadataPages.length) return metadataPages;

  return parsePageMarkers(context?.content);
};

const insertHandbookPage = async (client, { sourceId, pageNumber, imagePath, ocrText }) => {
  await client.query(
    `INSERT INTO handbook_pages (source_id, page_number, image_path, ocr_text)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source_id, page_number)
     DO UPDATE SET
       image_path = EXCLUDED.image_path,
       ocr_text = COALESCE(EXCLUDED.ocr_text, handbook_pages.ocr_text)`,
    [sourceId, pageNumber, imagePath, ocrText || null]
  );
};

const getLatestHandbookPage = async (pageNumber) => {
  const result = await pool.query(
    `SELECT hp.page_number, hp.ocr_text,
            ks.id AS source_id, ks.title
     FROM handbook_pages hp
     JOIN knowledge_sources ks ON ks.id = hp.source_id
     WHERE hp.page_number = $1 AND ks.status = 'ready'
     ORDER BY ks.created_at DESC, ks.id DESC
     LIMIT 1`,
    [pageNumber]
  );
  return result.rows[0] || null;
};

const getLatestHandbookPageCount = async () => {
  const result = await pool.query(
    `SELECT COALESCE(MAX(hp.page_number), 0)::int AS page_count
     FROM handbook_pages hp
     JOIN knowledge_sources ks ON ks.id = hp.source_id
     WHERE ks.id = (
       SELECT id FROM knowledge_sources
       WHERE status = 'ready'
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     )`
  );
  return result.rows[0]?.page_count || 0;
};

const listHandbookPages = async (sourceId) => {
  const result = await pool.query(
    `SELECT page_number, image_path, LEFT(ocr_text, 180) AS preview
     FROM handbook_pages
     WHERE source_id = $1
     ORDER BY page_number ASC`,
    [sourceId]
  );
  return result.rows;
};

const getHandbookPageImages = async ({ sourceId, pageNumbers }) => {
  const images = [];

  for (const pageNumber of pageNumbers) {
    const buffer = await loadPageImage(sourceId, pageNumber);
    if (!buffer) continue;
    images.push({ pageNumber, buffer });
  }

  return images;
};

const pickReplyPageNumbers = (contexts, maxPages = 2, sourceId = null) => {
  const ranked = [];

  for (const context of contexts) {
    if (sourceId !== null && Number(context.source_id) !== Number(sourceId)) continue;
    for (const pageNumber of getPageNumbersFromContext(context)) {
      if (!ranked.some((item) => item.pageNumber === pageNumber)) {
        ranked.push({
          pageNumber,
          score: Number(context.score || 0),
          sourceId: context.source_id,
        });
      }
    }
  }

  return ranked
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPages)
    .map((item) => item.pageNumber);
};

module.exports = {
  getHandbookPageImages,
  getLatestHandbookPage,
  getLatestHandbookPageCount,
  getPageNumbersFromContext,
  insertHandbookPage,
  listHandbookPages,
  parsePageMarker,
  parsePageMarkers,
  pickReplyPageNumbers,
};
