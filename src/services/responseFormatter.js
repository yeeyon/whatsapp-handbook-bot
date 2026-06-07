const PAGE_REFERENCE_PATTERN = /\s*\((?:handbook\s+)?pages?\s+(\d{1,4})\)\s*\.?/gi;
const SOURCE_LINE_PATTERN = /^\s*(?:-\s*)?(?:_?source:?\s*)?(?:D['’]Starlington Property )?Handbook pages?\s+(\d{1,4}(?:\s*[-–—]\s*\d{1,4})?(?:\s*,\s*\d{1,4}(?:\s*[-–—]\s*\d{1,4})?)*)_?\s*\.?\s*$/gim;

const formatMalaysianPhoneNumber = (value) => {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `60${digits.slice(1)}`;
  if (!digits.startsWith('60')) return value;

  const national = digits.slice(2);
  if (/^1\d{8,9}$/.test(national)) {
    const prefix = national.slice(0, 2);
    const subscriber = national.slice(2);
    const splitAt = subscriber.length - 4;
    return `+60 ${prefix}-${subscriber.slice(0, splitAt)} ${subscriber.slice(splitAt)}`;
  }

  if (/^3\d{8}$/.test(national)) {
    return `+60 3-${national.slice(1, 5)} ${national.slice(5)}`;
  }

  if (/^[4-9]\d{7}$/.test(national)) {
    return `+60 ${national[0]}-${national.slice(1, 4)} ${national.slice(4)}`;
  }

  return value;
};

const normalizeMalaysianPhoneNumbers = (text) => String(text || '').replace(
  /(?<!\d)(?:\+?60|0)[\s\u00a0\u202f-]?(?:1\d|[3-9])(?:[\s\u00a0\u202f\-\u2010-\u2015]?\d){7,8}(?!\d)/g,
  formatMalaysianPhoneNumber
);

const repairCommonWordCollisions = (text) => String(text || '').replace(
  /\b(The|An|A)(emergency|handbook|contact|number|police|management|office|game|games|room|rules)\b/gi,
  '$1 $2'
).replace(
  /\b(for|of|to|in|at|from)(?=[A-Z])/g,
  '$1 '
).replace(
  /\b(Game|Games|Emergency|Police|Handbook)(Room|Rules|Number|Contact|Station)\b/g,
  '$1 $2'
);

const standardizeHandbookAnswer = (answer) => {
  const pages = new Set();
  let text = String(answer || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*[•·▪◦]\s*/gm, '- ')
    .replace(/^\s*\*\s+(?=\S)/gm, '- ')
    .replace(PAGE_REFERENCE_PATTERN, (_match, page) => {
      pages.add(Number(page));
      return '';
    })
    .replace(SOURCE_LINE_PATTERN, (_match, pageList) => {
      pageList.split(',').forEach((part) => {
        const bounds = part.trim().split(/\s*[-–—]\s*/).map(Number);
        if (bounds.length === 1) {
          pages.add(bounds[0]);
          return;
        }
        for (let page = bounds[0]; page <= bounds[1]; page += 1) pages.add(page);
      });
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  text = repairCommonWordCollisions(normalizeMalaysianPhoneNumbers(text));

  if (pages.size) {
    const sortedPages = [...pages].sort((left, right) => left - right);
    const label = sortedPages.length === 1 ? 'page' : 'pages';
    text += `\n\n_Source: Handbook ${label} ${sortedPages.join(', ')}_`;
  }

  return text;
};

module.exports = {
  standardizeHandbookAnswer,
  _test: { formatMalaysianPhoneNumber, normalizeMalaysianPhoneNumbers, repairCommonWordCollisions },
};
