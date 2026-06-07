const fs = require('fs');
const path = require('path');
const { initDatabase, pool } = require('../src/config/database');

// Let's resolve the path relative to __dirname to find the files
const HANDBOOK_PAGES_DIR = path.join(__dirname, '../data/handbook-pages');

async function main() {
  await initDatabase();

  console.log('Fetching all handbook pages from database...');
  const res = await pool.query('SELECT source_id, page_number FROM handbook_pages ORDER BY source_id, page_number');
  console.log(`Found ${res.rows.length} page records.`);

  let updated = 0;
  for (const row of res.rows) {
    const filePath = path.join(HANDBOOK_PAGES_DIR, String(row.source_id), `page-${String(row.page_number).padStart(3, '0')}.jpg`);
    
    if (fs.existsSync(filePath)) {
      console.log(`Reading and uploading page ${row.page_number} for source ${row.source_id}...`);
      const buffer = fs.readFileSync(filePath);
      await pool.query(
        'UPDATE handbook_pages SET image_data = $1 WHERE source_id = $2 AND page_number = $3',
        [buffer, row.source_id, row.page_number]
      );
      updated++;
    } else {
      console.log(`Image not found on disk at: ${filePath}`);
    }
  }

  console.log(`Successfully backfilled ${updated} page images directly into the database!`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('Backfill failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
