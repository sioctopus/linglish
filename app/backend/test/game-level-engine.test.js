const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const modulePath = path.resolve(__dirname, '../../frontend/js/game/level-engine.js');
const packPath = path.resolve(__dirname, '../../frontend/js/game/word-packs/pack-max.json');
const storePath = path.resolve(__dirname, '../../frontend/js/game/progress-store.js');

function loadModule() {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return {};
    throw error;
  }
}

const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));

function createStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function fakeApi(overrides) {
  const calls = { reviews: [], sessions: [], added: [] };
  return {
    calls,
    fetchReviewQueue: async () => (overrides && overrides.reviewQueue) || [],
    submitReview: async (lemma, quality) => { calls.reviews.push({ lemma, quality }); return true; },
    addWord: async (lemma) => { calls.added.push(lemma); return true; },
    logSession: async (s) => { calls.sessions.push(s); return { xp_earned: 20, current_streak: 2, unlocked: [] }; },
    flushRetryQueue: async () => 0,
  };
}

function build(overrides) {
  const { createLevelEngine } = loadModule();
  const { createProgressStore } = require(storePath);
  const progressStore = createProgressStore(createStorage());
  const apiClient = fakeApi(overrides);
  const engine = createLevelEngine({ pack, progressStore, apiClient });
  return { engine, progressStore, apiClient };
}

test('starting a level serves six new words from the current chapter', async () => {
  const { engine, progressStore } = build();
  const session = await engine.startLevel(progressStore.load());
  assert.equal(session.newWords.length, 6);
  assert.equal(session.chapter, 1);
});

test('a level starts in the learn phase', async () => {
  const { engine, progressStore } = build();
  assert.equal((await engine.startLevel(progressStore.load())).phase, 'learn');
});

test('the review words come from the server review queue', async () => {
  const { engine, progressStore } = build({ reviewQueue: [{ lemma: 'pen' }, { lemma: 'book' }] });
  const session = await engine.startLevel(progressStore.load());
  assert.deepEqual(session.reviewWords.map((w) => w.lemma), ['pen', 'book']);
});

test('review words get their chinese gloss filled in from the pack', async () => {
  const { engine, progressStore } = build({ reviewQueue: [{ lemma: 'pen', state: 'reviewing' }] });
  const session = await engine.startLevel(progressStore.load());
  assert.equal(session.reviewWords[0].zh, '钢笔');
  assert.equal(session.reviewWords[0].ipa, '/pen/');
  assert.equal(session.reviewWords[0].state, 'reviewing');
});

test('review words the pack does not know are dropped instead of served without a gloss', async () => {
  const { engine, progressStore } = build({ reviewQueue: [{ lemma: 'photosynthesis' }, { lemma: 'pen' }] });
  const session = await engine.startLevel(progressStore.load());
  assert.deepEqual(session.reviewWords.map((w) => w.lemma), ['pen']);
});

test('successive levels serve different new words', async () => {
  const { engine, progressStore } = build();
  const first = await engine.startLevel(progressStore.load());
  const second = await engine.startLevel({ ...progressStore.load(), currentLevel: 2 });
  const overlap = first.newWords.filter((w) => second.newWords.some((s) => s.lemma === w.lemma));
  assert.equal(overlap.length, 0);
});

test('recording a correct result submits a good review', async () => {
  const { engine, progressStore, apiClient } = build();
  const session = await engine.startLevel(progressStore.load());
  await engine.recordResult(session, { lemma: 'school', gameType: 'quiz', isCorrect: true });
  assert.deepEqual(apiClient.calls.reviews, [{ lemma: 'school', quality: 'good' }]);
});

test('recording a wrong result submits an again review', async () => {
  const { engine, progressStore, apiClient } = build();
  const session = await engine.startLevel(progressStore.load());
  await engine.recordResult(session, { lemma: 'school', gameType: 'quiz', isCorrect: false });
  assert.deepEqual(apiClient.calls.reviews, [{ lemma: 'school', quality: 'again' }]);
});

test('recordResult returns a new session and leaves the old one alone', async () => {
  const { engine, progressStore } = build();
  const session = await engine.startLevel(progressStore.load());
  const next = await engine.recordResult(session, { lemma: 'school', gameType: 'quiz', isCorrect: true });
  assert.equal(session.results.length, 0);
  assert.equal(next.results.length, 1);
});

test('finishing a level advances to the next level', async () => {
  const { engine, progressStore } = build();
  const session = await engine.startLevel(progressStore.load());
  const outcome = await engine.finishLevel(session, progressStore.load());
  assert.equal(outcome.progress.currentLevel, 2);
});

test('finishing a level logs the session for xp and streak', async () => {
  const { engine, progressStore, apiClient } = build();
  const session = await engine.startLevel(progressStore.load());
  await engine.finishLevel(session, progressStore.load());
  assert.equal(apiClient.calls.sessions.length, 1);
  assert.equal(apiClient.calls.sessions[0].wordsLearned, 6);
});

test('clearing the boss level unlocks the chapter part and moves to the next chapter', async () => {
  const { engine, progressStore } = build();
  const atBoss = { ...progressStore.load(), currentLevel: 6 };
  const session = await engine.startLevel(atBoss);
  const graded = { ...session, results: session.newWords.map((w) => ({ lemma: w.lemma, gameType: 'quiz', isCorrect: true })) };
  const outcome = await engine.finishLevel(graded, atBoss);
  assert.equal(outcome.unlockedPart, 'head');
  assert.equal(outcome.progress.currentChapter, 2);
  assert.equal(outcome.progress.currentLevel, 1);
  assert.deepEqual(outcome.progress.unlockedParts, ['head']);
});

test('the boss level carries a boss state with one hit point per chapter word', async () => {
  const { engine, progressStore } = build();
  const session = await engine.startLevel({ ...progressStore.load(), currentLevel: 6 });
  assert.equal(session.boss.hp, 30);
  assert.equal(session.boss.shields, 3);
});

test('leaving the boss with hit points left keeps the chapter locked even at full accuracy', async () => {
  const { engine, progressStore } = build();
  const atBoss = { ...progressStore.load(), currentLevel: 6 };
  const session = await engine.startLevel(atBoss);
  const half = session.newWords.slice(0, 20).map((w) => ({ lemma: w.lemma, gameType: 'quiz', isCorrect: true }));
  const outcome = await engine.finishLevel({ ...session, results: half }, atBoss);
  assert.equal(outcome.accuracy, 1);
  assert.equal(outcome.bossStatus, 'ongoing');
  assert.equal(outcome.unlockedPart, null);
});

test('running the shields out loses the boss fight', async () => {
  const { engine, progressStore } = build();
  const atBoss = { ...progressStore.load(), currentLevel: 6 };
  const session = await engine.startLevel(atBoss);
  const results = session.newWords.map((w, i) => ({ lemma: w.lemma, gameType: 'quiz', isCorrect: i >= 4 }));
  const outcome = await engine.finishLevel({ ...session, results }, atBoss);
  assert.equal(outcome.bossStatus, 'lost');
  assert.equal(outcome.unlockedPart, null);
});

test('the boss re-asks the words the player just got wrong', async () => {
  const { engine, progressStore } = build();
  const session = await engine.startLevel({ ...progressStore.load(), currentLevel: 6 });
  const missed = session.newWords[7].lemma;
  const after = await engine.recordResult(session, { lemma: missed, gameType: 'quiz', isCorrect: false });
  assert.equal(engine.bossQuestionWords(after, 3)[0].lemma, missed);
});

test('failing the boss accuracy gate leaves the chapter locked', async () => {
  const { engine, progressStore } = build();
  const atBoss = { ...progressStore.load(), currentLevel: 6 };
  const session = await engine.startLevel(atBoss);
  const graded = { ...session, results: session.newWords.map((w, i) => ({ lemma: w.lemma, gameType: 'quiz', isCorrect: i === 0 })) };
  const outcome = await engine.finishLevel(graded, atBoss);
  assert.equal(outcome.unlockedPart, null);
  assert.equal(outcome.progress.currentChapter, 1);
  assert.deepEqual(outcome.progress.unlockedParts, []);
});

test('the boss stays locked until the chapter has eight stars', () => {
  const { chapterStars } = loadModule();
  const { engine } = build();
  const progress = { currentChapter: 1, currentLevel: 6, stars: { c1l1: 2, c1l2: 2, c1l3: 1, c1l4: 1, c1l5: 1 } };
  assert.equal(chapterStars(progress, 1), 7);
  assert.equal(engine.canEnterBoss(progress), false);
});

test('the boss opens once the chapter reaches eight stars', () => {
  const { engine } = build();
  const progress = { currentChapter: 1, currentLevel: 6, stars: { c1l1: 2, c1l2: 2, c1l3: 2, c1l4: 1, c1l5: 1 } };
  assert.equal(engine.canEnterBoss(progress), true);
});

test('stars from other chapters do not open this chapter boss', () => {
  const { chapterStars } = loadModule();
  const progress = { currentChapter: 2, stars: { c1l1: 3, c1l2: 3, c1l3: 3, c2l1: 2 } };
  assert.equal(chapterStars(progress, 2), 2);
});

test('replaying a level keeps its best star rating', async () => {
  const { engine, progressStore } = build();
  const played = { ...progressStore.load(), stars: { c1l1: 3 } };
  const session = await engine.startLevel(played);
  const graded = { ...session, results: session.newWords.map((w) => ({ lemma: w.lemma, gameType: 'quiz', isCorrect: false })) };
  const outcome = await engine.finishLevel(graded, played);
  assert.equal(outcome.progress.stars.c1l1, 3);
});

test('a fast perfect run earns three stars', () => {
  const { computeStars } = loadModule();
  assert.equal(computeStars({ accuracy: 1, elapsedMs: 100000, targetMs: 300000 }), 3);
});

test('a slow low-accuracy run earns one star', () => {
  const { computeStars } = loadModule();
  assert.equal(computeStars({ accuracy: 0.5, elapsedMs: 600000, targetMs: 300000 }), 1);
});

test('replaying an early level does not pull currentLevel backwards', async () => {
  const { engine, progressStore } = build();
  const ahead = { ...progressStore.load(), currentLevel: 5 };
  const session = await engine.startLevel({ ...ahead, currentLevel: 2 });
  const graded = { ...session, results: session.newWords.map((w) => ({ lemma: w.lemma, gameType: 'quiz', isCorrect: true })) };
  const outcome = await engine.finishLevel(graded, ahead);
  assert.equal(outcome.progress.currentLevel, 5);
});

test('daily challenge finish stamps the date without advancing levels', async () => {
  const daily = require(path.resolve(__dirname, '../../frontend/js/game/daily-challenge.js'));
  const { engine, progressStore } = build();
  const base = { ...progressStore.load(), currentLevel: 3 };
  const session = {
    levelId: 'daily',
    chapter: 1,
    level: 3,
    isBoss: false,
    isDaily: true,
    newWords: [{ lemma: 'school' }, { lemma: 'desk' }],
    reviewWords: [],
    results: [
      { lemma: 'school', gameType: 'speaking', isCorrect: true },
      { lemma: 'desk', gameType: 'quiz', isCorrect: true },
    ],
    boss: null,
    startedAt: Date.now(),
  };
  const outcome = await engine.finishLevel(session, base);
  assert.equal(outcome.isDaily, true);
  assert.equal(outcome.progress.currentLevel, 3);
  assert.equal(outcome.unlockedPart, null);
  assert.equal(outcome.progress.lastDailyDate, daily.todayKey());
  assert.equal(outcome.stars, 0);
});
