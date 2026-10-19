const test = require('node:test');
const assert = require('node:assert/strict');
const { extractGloss, glossWords, mergeGlossItems } = require('../routes/dictionary-api');

test('gloss query keeps short english words', () => {
  assert.deepEqual(
    glossWords('Hi,time,see,no,Ben,123,not a word'),
    ['hi', 'time', 'see', 'no', 'ben']
  );
});

test('gloss extraction reads phonetic and the first chinese meaning', () => {
  const item = extractGloss({
    word_lowercase: 'time',
    phonetic: 'taɪm',
    part_of_speech: 'noun',
    definitions: { meanings: [{ definitions: [{ zh: '时间；次数' }] }] },
  });
  assert.equal(item.word, 'time');
  assert.equal(item.phonetic, '/taɪm/');
  assert.equal(item.pos, 'noun');
  assert.equal(item.zh, '时间；次数');
});

test('gloss merge prefers the database and fills gaps from the lexicon', () => {
  const items = mergeGlossItems(
    ['time', 'like', 'missing'],
    [{ word: 'time', phonetic: '/taɪm/', pos: 'noun', zh: '时间' }],
    { like: { ipa: '/laɪk/', pos: 'verb', zh: '喜欢' } }
  );
  assert.deepEqual(items, [
    { word: 'time', phonetic: '/taɪm/', pos: 'noun', zh: '时间' },
    { word: 'like', phonetic: '/laɪk/', pos: 'verb', zh: '喜欢' },
  ]);
});
