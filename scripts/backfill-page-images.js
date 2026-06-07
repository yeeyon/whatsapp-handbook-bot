const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { pool, initDatabase } = require('../src/config/database');
const { renderPdfPageToJpeg, savePageImage } = require('../src/services/pageImages');
const { insertHandbookPage } = require('../src/services/handbookPages');

const resolveHandbookPath = () => {
  const cliPath = process.argv[2];
  const envPath = process.env.HANDBOOK_PATH;
  const defaultPath = path.join(__dirname, '../data/handbook.pdf');
  return path.resolve(cliPath || envPath || defaultPath);
};

const main = async () => {
  const handbookPath = resolveHandbookPath();
  if (!fs.existsSync(handbookPath)) {
    throw new Error(`Handbook PDF not found: ${handbookPath}`);
  }

  await initDatabase();
  const sourceResult = await pool.query(
    `SELECT id, title
     FROM knowledge_sources
     WHERE source_type = 'document'
     ORDER BY created_at DESC
     LIMIT 1`
  );

  if (!sourceResult.rows.length) {
    throw new Error('No ingested handbook source found. Run npm run ingest first.');
  }

  const source = sourceResult.rows[0];
  const pdfBuffer = fs.readFileSync(handbookPath);
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer), disableFontFace: true }).promise;
  const pageCount = pdf.numPages;

  console.log(`Backfilling ${pageCount} page image(s) for source #${source.id}...`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      console.log(`Rendering page ${pageNumber} of ${pageCount}...`);
      const imageBuffer = await renderPdfPageToJpeg(pdfBuffer, pageNumber);
      const imagePath = await savePageImage(source.id, pageNumber, imageBuffer);
      await insertHandbookPage(client, {
        sourceId: source.id,
        pageNumber,
        imagePath,
        ocrText: null,
        imageData: imageBuffer,
      });

      await client.query(
        `UPDATE knowledge_chunks
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{pageNumbers}', $1::jsonb, true)
         WHERE source_id = $2
           AND content ILIKE $3`,
        [JSON.stringify([pageNumber]), source.id, `--- page ${pageNumber} of %`]
      );
    }

    await client.query('COMMIT');
    console.log('Page image backfill complete');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

main().catch((error) => {
  console.error('Backfill failed:', error.message);
  process.exit(1);
});
