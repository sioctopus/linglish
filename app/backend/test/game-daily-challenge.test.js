const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const daily = require(path.resolve(__dirname, '../../frontend/js/game/daily-challenge.js'));

const pack = {
  chapters: [
    {
      chapter: 1,
      words: [
        { lemma: 'school', zh: '学校' },
        { lemma: 'desk', zh: '课桌' },
        { lemma: 'book', zh: '书' },
        { lemma: 'pen', zh: '笔' },
        { lemma: 'bag', zh: '包' },
      ],
    },
  ],
};

test('isDailyDone compares the stored date with today', () => {
  const now = new Date('2026-10-16T08:00:00');
  assert.equal(daily.isDailyDone({ lastDailyDate: '2026-10-16' }, now), true);
  assert.equal(daily.isDailyDone({ lastDailyDate: '2026-10-15' }, now), false);
});

test('pickDailyWords prefers weak words before chapter fillers', () => {
  const progress = {
    currentChapter: 1,
    wordStates: {
      bag: { correctIn: [], wrongCount: 5 },
      pen: { correctIn: [], wrongCount: 3 },
    },
    relearnQueue: [],
  };
  const words = daily.pickDailyWords(pack, progress, 2, new Date('2026-10-16'));
  assert.equal(words.length, 2);
  assert.deepEqual(words.map((word) => word.lemma).sort(), ['bag', 'pen']);
});

test('pickDailyWords always returns up to the requested count', () => {
  const words = daily.pickDailyWords(pack, { currentChapter: 1, wordStates: {} }, 4, new Date('2026-10-16'));
  assert.equal(words.length, 4);
});
