(function (root, factory) {
  const mastery = typeof module === 'object' && module.exports
    ? require('./mastery.js')
    : (root && root.GameMastery);
  const api = factory(mastery);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameDailyChallenge = api;
})(typeof window !== 'undefined' ? window : null, function (mastery) {
  'use strict';

  const DAILY_WORD_COUNT = 4;

  function todayKey(now) {
    const date = now instanceof Date ? now : new Date(now || Date.now());
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  function isDailyDone(progress, now) {
    return Boolean(progress && progress.lastDailyDate === todayKey(now));
  }

  function packWords(pack) {
    if (!pack || !Array.isArray(pack.chapters)) return [];
    return pack.chapters.reduce(function (all, chapter) {
      return all.concat(Array.isArray(chapter.words) ? chapter.words : []);
    }, []);
  }

  function chapterWords(pack, chapter) {
    if (!pack || !Array.isArray(pack.chapters)) return [];
    const entry = pack.chapters.find(function (item) { return item.chapter === chapter; });
    return entry && Array.isArray(entry.words) ? entry.words.slice() : [];
  }

  // 优先易错/待复习,不够再用当前章新词补齐,保证每天都能开一局。
  function pickDailyWords(pack, progress, count, now) {
    const limit = Math.max(1, Number(count) || DAILY_WORD_COUNT);
    const states = (progress && progress.wordStates) || {};
    const all = packWords(pack);
    const byLemma = new Map(all.map(function (word) { return [word.lemma, word]; }));
    const picked = [];
    const seen = new Set();

    function pushLemma(lemma) {
      if (!lemma || seen.has(lemma) || picked.length >= limit) return;
      const word = byLemma.get(lemma);
      if (!word) return;
      seen.add(lemma);
      picked.push(word);
    }

    const weak = Object.keys(states)
      .filter(function (lemma) {
        const state = states[lemma];
        return state && Number(state.wrongCount) > 0 && !mastery.isWordMastered(state);
      })
      .sort(function (a, b) {
        return Number(states[b].wrongCount || 0) - Number(states[a].wrongCount || 0);
      });
    weak.forEach(pushLemma);

    const relearn = Array.isArray(progress && progress.relearnQueue)
      ? progress.relearnQueue.map(function (entry) { return entry.lemma; })
      : [];
    relearn.forEach(pushLemma);

    chapterWords(pack, (progress && progress.currentChapter) || 1).forEach(function (word) {
      pushLemma(word.lemma);
    });

    all.forEach(function (word) { pushLemma(word.lemma); });

    // 打乱顺序,避免每天同一前几个词;用日期做稳定种子方便测。
    const seed = todayKey(now).split('').reduce(function (sum, ch) {
      return sum + ch.charCodeAt(0);
    }, 0);
    return picked.slice(0, limit).sort(function (a, b) {
      const ha = (a.lemma.charCodeAt(0) + seed) % 97;
      const hb = (b.lemma.charCodeAt(0) + seed) % 97;
      return ha - hb;
    });
  }

  return {
    DAILY_WORD_COUNT,
    todayKey,
    isDailyDone,
    pickDailyWords,
  };
});
