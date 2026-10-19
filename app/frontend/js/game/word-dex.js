(function (root, factory) {
  const mastery = typeof module === 'object' && module.exports
    ? require('./mastery.js')
    : (root && root.GameMastery);
  const api = factory(mastery);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameWordDex = api;
})(typeof window !== 'undefined' ? window : null, function (mastery) {
  'use strict';

  function allPackWords(pack) {
    if (!pack || !Array.isArray(pack.chapters)) return [];
    return pack.chapters.reduce(function (all, chapter) {
      const words = Array.isArray(chapter.words) ? chapter.words : [];
      return all.concat(words.map(function (word) {
        return { ...word, chapter: chapter.chapter, theme: chapter.theme || '' };
      }));
    }, []);
  }

  function classifyWord(word, state) {
    if (!state) return 'unseen';
    if (mastery.isWordMastered(state)) return 'mastered';
    if (Number(state.wrongCount) >= 2) return 'weak';
    return 'learning';
  }

  function buildDex(pack, progress) {
    const states = (progress && progress.wordStates) || {};
    const buckets = {
      mastered: [],
      learning: [],
      weak: [],
      unseen: [],
    };

    allPackWords(pack).forEach(function (word) {
      const state = states[word.lemma];
      const bucket = classifyWord(word, state);
      buckets[bucket].push({
        ...word,
        wrongCount: state ? Number(state.wrongCount) || 0 : 0,
        correctIn: state && Array.isArray(state.correctIn) ? state.correctIn.slice() : [],
        bucket,
      });
    });

    ['mastered', 'learning', 'weak', 'unseen'].forEach(function (key) {
      buckets[key].sort(function (a, b) {
        if (a.chapter !== b.chapter) return a.chapter - b.chapter;
        return a.lemma.localeCompare(b.lemma);
      });
    });

    return {
      buckets,
      counts: {
        mastered: buckets.mastered.length,
        learning: buckets.learning.length,
        weak: buckets.weak.length,
        unseen: buckets.unseen.length,
        total: buckets.mastered.length
          + buckets.learning.length
          + buckets.weak.length
          + buckets.unseen.length,
      },
    };
  }

  return { buildDex, classifyWord, allPackWords };
});
