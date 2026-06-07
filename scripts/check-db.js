require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const turns = await pool.query(
    'SELECT user_message, improved_question FROM rag_turns ORDER BY id LIMIT 60'
  );
  console.log('=== PAST QUESTIONS ===');
  turns.rows.forEach(r => console.log(`Q: ${r.user_message}\n   -> ${r.improved_question}\n`));
  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
