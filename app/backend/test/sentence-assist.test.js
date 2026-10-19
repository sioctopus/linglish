const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const assist = require(path.resolve(__dirname, '../../frontend/js/video-reader/sentence-assist.js'));

test('a long sentence splits at a comma or a joining word', () => {
  assert.deepEqual(
    assist.sentenceChunks('I was responsible for the meeting, but the client arrived early'),
    ['I was responsible for the meeting', 'but the client arrived early']
  );
  assert.deepEqual(
    assist.sentenceChunks('I was responsible for the meeting because the client arrived early'),
    ['I was responsible for the meeting', 'because the client arrived early']
  );
});

test('the short gloss prefers the Chinese definition and the card stays in the sentence', () => {
  const entry = {
    phonetic: '/rɪˈspɒnsəbl/',
    meanings: [{ definitions: [{ definition: 'having a duty', zh: '负责的' }] }],
  };
  assert.equal(assist.shortGloss(entry), '负责的');
  const html = assist.cardHTML({
    word: '<responsible>',
    phonetic: assist.phoneticOf(entry),
    gloss: assist.shortGloss(entry),
    sentence: 'I was responsible for the meeting',
  });
  assert.match(html, /负责的/);
  assert.match(html, /\/rɪˈspɒnsəbl\//);
  assert.match(html, /&lt;responsible&gt;/);
  assert.match(html, /data-assist="say"/);
  assert.doesNotMatch(html, /<responsible>/);
});
