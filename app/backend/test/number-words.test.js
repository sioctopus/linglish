'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

require('../../frontend/js/game/number-words.js');

const words = globalThis.GameNumberWords;

test('english place values from one to one trillion', () => {
  assert.equal(words.spell(15), 'fifteen');
  assert.equal(words.spell(21), 'twenty-one');
  assert.equal(words.spell(100), 'one hundred');
  assert.equal(words.spell(101), 'one hundred and one');
  assert.equal(words.spell(1000), 'one thousand');
  assert.equal(words.spell(1001), 'one thousand and one');
  assert.equal(words.spell(1111), 'one thousand one hundred and eleven');
  assert.equal(words.spell(10000), 'ten thousand');
  assert.equal(words.spell(100000), 'one hundred thousand');
  assert.equal(words.spell(1000000), 'one million');
  assert.equal(words.spell(1000001), 'one million and one');
  assert.equal(words.spell(10000000), 'ten million');
  assert.equal(words.spell(100000000), 'one hundred million');
  assert.equal(words.spell(1000000000), 'one billion');
  assert.equal(words.spell(1000000000000), 'one trillion');
});

test('chinese place values keep the zero between groups', () => {
  assert.equal(words.chinese(15), '十五');
  assert.equal(words.chinese(10), '十');
  assert.equal(words.chinese(101), '一百零一');
  assert.equal(words.chinese(110), '一百一十');
  assert.equal(words.chinese(10001), '一万零一');
  assert.equal(words.chinese(1000000), '一百万');
  assert.equal(words.chinese(1001000), '一百万零一千');
  assert.equal(words.chinese(1000000000000), '一万亿');
});

test('shortcuts and typed numbers share one reading', () => {
  const million = words.read(1000000);
  assert.equal(million.lemma, 'one million');
  assert.equal(million.emoji, '1000000');
  assert.equal(million.zh, '1,000,000 · 一百万');
  assert.deepEqual(words.places.map((place) => place.zh), [
    '个', '十', '百', '千', '万', '十万', '百万', '千万', '亿', '十亿', '百亿', '千亿', '万亿',
  ]);
  assert.equal(words.read('1,001,000').lemma, words.spell(1001000));
  assert.equal(words.parse('1234567890123456'), null);
  assert.equal(words.parse(''), null);
});
