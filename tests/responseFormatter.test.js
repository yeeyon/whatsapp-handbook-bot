const test = require('node:test');
const assert = require('node:assert/strict');
const { standardizeHandbookAnswer } = require('../src/services/responseFormatter');

test('standardizes bullets and consolidates repeated handbook page citations', () => {
  const answer = [
    '· Games Room is open 8:00 am-10:00 pm daily (page 17).',
    '• No smoking or alcohol (page 17).',
    '* Leave the room clean and tidy (page 17).',
  ].join('\n');

  assert.equal(
    standardizeHandbookAnswer(answer),
    '- Games Room is open 8:00 am-10:00 pm daily\n'
      + '- No smoking or alcohol\n'
      + '- Leave the room clean and tidy\n\n'
      + '_Source: Handbook page 17_'
  );
});

test('formats Malaysian landline and mobile numbers consistently', () => {
  assert.equal(
    standardizeHandbookAnswer('Call 04-6462222 or 011-7414 6255.'),
    'Call +60 4-646 2222 or +60 11-7414 6255.'
  );
});

test('keeps already international Malaysian numbers stable', () => {
  assert.equal(
    standardizeHandbookAnswer('Emergency: +60 11-7414 6255'),
    'Emergency: +60 11-7414 6255'
  );
});

test('normalizes Unicode phone separators and a model-generated source line', () => {
  assert.equal(
    standardizeHandbookAnswer([
      'Call 04‑646 2222.',
      '',
      "Source: D'Starlington Property Handbook page 17",
    ].join('\n')),
    'Call +60 4-646 2222.\n\n_Source: Handbook page 17_'
  );
});

test('repairs common model word collisions at the start of an answer', () => {
  assert.equal(
    standardizeHandbookAnswer('Theemergency contact is 04-6462222.'),
    'The emergency contact is +60 4-646 2222.'
  );
});

test('repairs common heading and preposition collisions', () => {
  assert.equal(
    standardizeHandbookAnswer('*GamesRoom Rules*\nThe number forBayan Baru is 04-6462222.'),
    '*Games Room Rules*\nThe number for Bayan Baru is +60 4-646 2222.'
  );
});

test('consolidates a bulleted source line', () => {
  assert.equal(
    standardizeHandbookAnswer("- Rule one.\n\n- Source: D'Starlington Property Handbook page 17"),
    '- Rule one.\n\n_Source: Handbook page 17_'
  );
});

test('expands and consolidates handbook page ranges', () => {
  assert.equal(
    standardizeHandbookAnswer("Rules.\n\nSource: D'Starlington Property Handbook pages 17-18"),
    'Rules.\n\n_Source: Handbook pages 17, 18_'
  );
});

test('repairs common phrase and text-to-number collisions', () => {
  assert.equal(
    standardizeHandbookAnswer('The emergency numberof Bayan Baru is not listed. Open from8:00 am.'),
    'The emergency number of Bayan Baru is not listed. Open from 8:00 am.'
  );
});
