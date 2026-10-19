(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameProgressStore = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const STORAGE_KEY = 'linglish_game_progress';
  const SCHEMA_VERSION = 1;

  const DEFAULT_PROGRESS = Object.freeze({
    version: SCHEMA_VERSION,
    currentChapter: 1,
    currentLevel: 1,
    stars: {},
    unlockedParts: [],
    wordStates: {},
    relearnQueue: [],
    lastDailyDate: '',
  });

  function cloneDefault() {
    return {
      version: SCHEMA_VERSION,
      currentChapter: 1,
      currentLevel: 1,
      stars: {},
      unlockedParts: [],
      wordStates: {},
      relearnQueue: [],
      lastDailyDate: '',
    };
  }

  function isValidProgress(value) {
    return Boolean(value)
      && typeof value === 'object'
      && !Array.isArray(value)
      && value.version === SCHEMA_VERSION
      && Number.isFinite(Number(value.currentChapter))
      && Number.isFinite(Number(value.currentLevel));
  }

  function normalize(value) {
    return {
      version: SCHEMA_VERSION,
      currentChapter: Number(value.currentChapter) || 1,
      currentLevel: Number(value.currentLevel) || 1,
      stars: value.stars && typeof value.stars === 'object' ? { ...value.stars } : {},
      unlockedParts: Array.isArray(value.unlockedParts) ? value.unlockedParts.slice() : [],
      wordStates: value.wordStates && typeof value.wordStates === 'object' ? { ...value.wordStates } : {},
      relearnQueue: Array.isArray(value.relearnQueue) ? value.relearnQueue.slice() : [],
      lastDailyDate: typeof value.lastDailyDate === 'string' ? value.lastDailyDate : '',
    };
  }

  function createProgressStore(storage) {
    function load() {
      let raw = null;
      try {
        raw = storage && storage.getItem(STORAGE_KEY);
      } catch (_) {
        return cloneDefault();
      }
      if (!raw) return cloneDefault();
      try {
        const parsed = JSON.parse(raw);
        if (!isValidProgress(parsed)) return cloneDefault();
        return normalize(parsed);
      } catch (_) {
        return cloneDefault();
      }
    }

    function save(progress) {
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(normalize(progress)));
        return true;
      } catch (_) {
        return false;
      }
    }

    function recordWordResult(progress, lemma, gameType, isCorrect) {
      const previous = progress.wordStates[lemma] || { correctIn: [], wrongCount: 0 };
      const correctIn = isCorrect && !previous.correctIn.includes(gameType)
        ? previous.correctIn.concat(gameType)
        : previous.correctIn.slice();
      return {
        ...progress,
        wordStates: {
          ...progress.wordStates,
          [lemma]: {
            correctIn,
            wrongCount: previous.wrongCount + (isCorrect ? 0 : 1),
          },
        },
      };
    }

    return { load, save, recordWordResult };
  }

  return { createProgressStore, DEFAULT_PROGRESS, SCHEMA_VERSION, STORAGE_KEY };
});
