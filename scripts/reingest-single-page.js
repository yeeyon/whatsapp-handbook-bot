/**
 * reingest-single-page.js
 *
 * Re-OCRs a single page from the handbook PDF, updates the handbook_pages OCR text,
 * removes all knowledge_chunks that reference that page, and re-inserts fresh chunks
 * with new embeddings.
 *
 * Usage:
 *   node scripts/reingest-single-page.js --page <pageNumber> [--pdf <path-to-pdf>]
 *
 * Examples:
 *   node scripts/reingest-single-page.js --page 65
 *   node scripts/reingest-single-page.js --page 65 --pdf "C:\Users\User\Downloads\20260606152537803.pdf"
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { PDFDocument } = require('pdf-lib');
const { initDatabase, pool } = require('../src/config/database');
const { extractTextFromPdfDocument, generateEmbedding } = require('../src/config/bedrock');
const { renderPdfPageToJpeg, savePageImage } = require('../src/services/pageImages');
const { insertHandbookPage } = require('../src/services/handbookPages');

// ---------- helpers ----------

const normalizeWhitespace = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const estimateTokenCount = (value) => Math.ceil(normalizeWhitespace(value).length / 4);

const DEFAULT_CHUNK_SIZE = Number(process.env.RAG_CHUNK_SIZE || 1200);
const DEFAULT_CHUNK_OVERLAP = Number(process.env.RAG_CHUNK_OVERLAP || 160);

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

// ---------- argument parsing ----------

const parseArgs = () => {
  const args = process.argv.slice(2);
  const result = { page: null, pdf: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--page' && args[i + 1]) {
      result.page = Number(args[i + 1]);
      i++;
    } else if (args[i] === '--pdf' && args[i + 1]) {
      result.pdf = args[i + 1];
      i++;
    }
  }

  return result;
};

// ---------- main ----------

const main = async () => {
  const { page: targetPage, pdf: pdfArg } = parseArgs();

  if (!targetPage || !Number.isInteger(targetPage) || targetPage < 1) {
    console.error('Usage: node scripts/reingest-single-page.js --page <pageNumber> [--pdf <path>]');
    process.exit(1);
  }

  const handbookPath = pdfArg
    ? path.resolve(pdfArg)
    : path.resolve(process.env.HANDBOOK_PATH || path.join(__dirname, '../data/handbook.pdf'));

  if (!fs.existsSync(handbookPath)) {
    throw new Error(`Handbook PDF not found: ${handbookPath}`);
  }

  await initDatabase();

  // ── 1. Find the current (latest ready) knowledge source ──────────────────
  const sourceResult = await pool.query(
    `SELECT ks.id, ks.title,
            COUNT(DISTINCT hp.id)::int AS page_count
     FROM knowledge_sources ks
     LEFT JOIN handbook_pages hp ON hp.source_id = ks.id
     WHERE ks.status = 'ready'
     GROUP BY ks.id, ks.title
     ORDER BY ks.created_at DESC, ks.id DESC
     LIMIT 1`
  );
  if (!sourceResult.rows.length) throw new Error('No ready knowledge source found in database.');

  const source = sourceResult.rows[0];
  const sourceId = source.id;
  console.log(`\nKnowledge source: #${sourceId} – "${source.title}" (${source.page_count} pages)`);

  // ── 2. Show existing OCR for the page ────────────────────────────────────
  const existingResult = await pool.query(
    `SELECT page_number, ocr_text, image_path
     FROM handbook_pages
     WHERE source_id = $1 AND page_number = $2`,
    [sourceId, targetPage]
  );
  const existing = existingResult.rows[0];

  console.log(`\n── Current OCR for page ${targetPage} ──────────────────────────────────`);
  if (existing) {
    console.log(`Image path : ${existing.image_path || '(none)'}`);
    console.log(`OCR text   :\n${existing.ocr_text || '(empty)'}`);
  } else {
    console.log(`(No record found for page ${targetPage} in source #${sourceId})`);
  }
  console.log('─────────────────────────────────────────────────────────────────────\n');

  // ── 3. Read total page count from PDF ────────────────────────────────────
  const pdfBuffer = fs.readFileSync(handbookPath);
  const sourcePdf = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const pageCount = sourcePdf.getPageCount();

  if (targetPage > pageCount) {
    throw new Error(`Page ${targetPage} exceeds PDF page count of ${pageCount}.`);
  }

  // ── 4. Extract single-page sub-PDF ───────────────────────────────────────
  console.log(`Extracting page ${targetPage} of ${pageCount} from ${path.basename(handbookPath)}...`);
  const pageDoc = await PDFDocument.create();
  const [copiedPage] = await pageDoc.copyPages(sourcePdf, [targetPage - 1]);
  pageDoc.addPage(copiedPage);
  const pageBytes = await pageDoc.save();
  const pageLabel = `page ${targetPage} of ${pageCount}`;

  // ── 5. Run OCR + render image concurrently ────────────────────────────────
  console.log(`Running Bedrock OCR on ${pageLabel}...`);
  const [rawText, imageBuffer] = await Promise.all([
    extractTextFromPdfDocument(pageBytes, path.basename(handbookPath), pageLabel),
    renderPdfPageToJpeg(pdfBuffer, targetPage).catch((err) => {
      console.warn(`Page image render warning: ${err.message}`);
      return null;
    }),
  ]);

  const newOcrText = normalizeWhitespace(rawText);
  console.log(`\n── New OCR result for page ${targetPage} ───────────────────────────────`);
  console.log(newOcrText || '(OCR returned empty text)');
  console.log('─────────────────────────────────────────────────────────────────────\n');

  // ── 6. Build replacement chunk records for this page ─────────────────────
  const pagePrefix = `--- page ${targetPage} of ${pageCount} ---`;
  const chunkTexts = chunkText(newOcrText);
  const newChunkRecords = chunkTexts.map((chunk) => ({
    content: `${pagePrefix}\n${chunk}`,
    metadata: { pageNumbers: [targetPage] },
  }));

  if (!newChunkRecords.length) {
    console.warn(`⚠  OCR produced no text for page ${targetPage}. The database record will be updated but no chunks will be inserted.`);
  }

  // ── 7. Transactionally update DB ─────────────────────────────────────────
  console.log(`Updating database for page ${targetPage} (source #${sourceId})...`);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 7a. Remove old chunks that mention only this page
    //     (chunks whose metadata->pageNumbers contains ONLY this page)
    const deleteResult = await client.query(
      `DELETE FROM knowledge_chunks
       WHERE source_id = $1
         AND (metadata->'pageNumbers') @> $2::jsonb
         AND jsonb_array_length(metadata->'pageNumbers') = 1`,
      [sourceId, JSON.stringify([targetPage])]
    );
    console.log(`  Deleted ${deleteResult.rowCount} old chunk(s) referencing only page ${targetPage}.`);

    // 7b. Update / insert handbook_pages record
    let imagePath = existing?.image_path || null;
    if (imageBuffer) {
      imagePath = await savePageImage(sourceId, targetPage, imageBuffer);
      console.log(`  Page image saved: ${imagePath}`);
    }

    await insertHandbookPage(client, {
      sourceId,
      pageNumber: targetPage,
      imagePath,
      ocrText: newOcrText,
    });
    console.log(`  handbook_pages row upserted for page ${targetPage}.`);

    // 7c. Get current max chunk_index so we append without gaps
    const maxIdxResult = await client.query(
      `SELECT COALESCE(MAX(chunk_index), -1)::int AS max_idx FROM knowledge_chunks WHERE source_id = $1`,
      [sourceId]
    );
    let nextIndex = maxIdxResult.rows[0].max_idx + 1;

    // 7d. Insert new chunks with embeddings
    for (const record of newChunkRecords) {
      let embedding = null;
      try {
        embedding = await generateEmbedding(record.content);
      } catch (err) {
        console.warn(`  Embedding failed for chunk: ${err.message}`);
      }

      await client.query(
        `INSERT INTO knowledge_chunks (source_id, chunk_index, content, embedding, token_count, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          sourceId,
          nextIndex,
          record.content,
          embedding ? JSON.stringify(embedding) : null,
          estimateTokenCount(record.content),
          JSON.stringify(record.metadata),
        ]
      );
      nextIndex++;
    }
    console.log(`  Inserted ${newChunkRecords.length} new chunk(s) for page ${targetPage}.`);

    await client.query('COMMIT');
    console.log('\n✅  Page re-ingestion complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // ── 8. Final verification ─────────────────────────────────────────────────
  const verifyResult = await pool.query(
    `SELECT LEFT(ocr_text, 400) AS preview FROM handbook_pages WHERE source_id = $1 AND page_number = $2`,
    [sourceId, targetPage]
  );
  console.log(`\nDB preview of new OCR for page ${targetPage}:\n${verifyResult.rows[0]?.preview || '(empty)'}\n`);

  await pool.end();
};

main().catch(async (error) => {
  console.error('\n❌  Single-page re-ingestion failed:', error);
  await pool.end().catch(() => {});
  process.exit(1);
});
