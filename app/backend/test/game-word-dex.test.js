const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const dex = require(path.resolve(__dirname, '../../frontend/js/game/word-dex.js'));

const pack = {
  chapters: [
    {
      chapter: 1,
      theme: '学校',
      words: [
        { lemma: 'school', zh: '学校' },
        { lemma: 'desk', zh: '课桌' },
        { lemma: 'book', zh: '书' },
      ],
    },
  ],
};

test('buildDex buckets words by mastery and wrong count', () => {
  const progress = {
    wordStates: {
      school: { correctIn: ['lianliankan', 'quiz'], wrongCount: 0 },
      desk: { correctIn: ['quiz'], wrongCount: 3 },
      book: { correctIn: ['quiz'], wrongCount: 0 },
    },
  };
  const built = dex.buildDex(pack, progress);
  assert.equal(built.counts.mastered, 1);
  assert.equal(built.counts.weak, 1);
  assert.equal(built.counts.learning, 1);
  assert.equal(built.buckets.mastered[0].lemma, 'school');
  assert.equal(built.buckets.weak[0].lemma, 'desk');
  assert.equal(built.buckets.learning[0].lemma, 'book');
});

test('unseen pack words stay in the unseen bucket', () => {
  const built = dex.buildDex(pack, { wordStates: {} });
  assert.equal(built.counts.unseen, 3);
  assert.equal(built.counts.total, 3);
});
