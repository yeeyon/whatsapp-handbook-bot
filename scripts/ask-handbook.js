const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { initDatabase } = require('../src/config/database');
const { answerKnowledgeQuestion } = require('../src/services/knowledgeBase');

const question = process.argv.slice(2).join(' ').trim();

const main = async () => {
  if (!question) {
    throw new Error('Usage: npm run ask -- "your question here"');
  }

  await initDatabase();
  const result = await answerKnowledgeQuestion(question);
  console.log(result.answer);
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
