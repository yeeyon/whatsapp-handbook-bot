const { callGemini } = require('../config/gemini');

const buildFormatterPrompt = ({ answer, question }) => `Rewrite the draft answer into a clean WhatsApp message.

User question:
${question || '(not provided)'}

Draft answer:
${answer}

Rules:
- Preserve every factual claim. Do not add, remove, reinterpret, or correct handbook facts.
- Fix missing spaces and joined words such as "Thehandbook", "numberof", "GamesRoom", and "from8:00".
- Give a direct answer first. Do not add filler or labels such as "Answer:".
- For one fact, use one or two short paragraphs without bullets.
- For multiple facts or rules, use one short "- " bullet per fact.
- Do not use dot bullets, Markdown headings, or tables.
- Consolidate repeated page citations into one final line in this exact style: _Source: Handbook page 17_ or _Source: Handbook pages 17, 18_.
- Format Malaysian phone numbers internationally, for example +60 4-646 2222 and +60 11-7414 6255.
- Keep exact place, facility, and contact names unchanged.
- Return only the final WhatsApp message.`;

const standardizeHandbookAnswer = async (answer, options = {}) => {
  const source = String(answer || '').trim();
  if (!source) return source;

  const formatter = options.formatter || callGemini;
  const model = process.env.GEMINI_FORMATTER_MODEL
    || process.env.GEMINI_FALLBACK_MODEL
    || 'gemini-2.5-flash-lite';

  try {
    const result = await formatter({
      systemText: 'You are a precise WhatsApp copy editor. Preserve facts and return only the edited message.',
      userText: buildFormatterPrompt({ answer: source, question: options.question }),
      maxTokens: 700,
      temperature: 0,
      model,
    });
    return String(result?.content || '').trim() || source;
  } catch (error) {
    console.error('Gemini response formatting failed:', error.message);
    return source;
  }
};

module.exports = {
  standardizeHandbookAnswer,
  _test: { buildFormatterPrompt },
};
