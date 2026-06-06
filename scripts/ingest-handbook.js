const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { initDatabase } = require('../src/config/database');
const { ingestDocument } = require('../src/services/knowledgeBase');

const resolveHandbookPath = () => {
  const cliPath = process.argv[2];
  const envPath = process.env.HANDBOOK_PATH;
  const defaultPath = path.join(__dirname, '../data/handbook.pdf');
  const chosen = cliPath || envPath || defaultPath;
  return path.resolve(chosen);
};

const main = async () => {
  const handbookPath = resolveHandbookPath();

  if (!fs.existsSync(handbookPath)) {
    throw new Error(`Handbook PDF not found: ${handbookPath}`);
  }

  console.log(`Ingesting handbook: ${handbookPath}`);
  await initDatabase();

  const buffer = fs.readFileSync(handbookPath);
  const source = await ingestDocument({
    buffer,
    fileName: path.basename(handbookPath),
    mimeType: 'application/pdf',
    title: process.env.HANDBOOK_TITLE || 'Employee Handbook',
  });

  console.log('Ingestion complete');
  console.log(JSON.stringify({
    id: source.id,
    title: source.title,
    file_name: source.file_name,
    chunk_count: source.chunk_count,
  }, null, 2));
};

main().catch((error) => {
  console.error('Ingestion failed:', error.message);
  process.exit(1);
});
