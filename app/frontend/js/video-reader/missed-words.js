(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishMissedWords = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const STORAGE_KEY = 'linglish.missedSentenceWords.v1';

  function tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  function sentenceKey(videoId, segmentKey) {
    return `${videoId == null ? '' : videoId}:${segmentKey == null ? '' : segmentKey}`;
  }

  function readMap(storage) {
    try {
      const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeMap(storage, map) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch (_) { }
  }

  function missingWords(referenceText, recognizedText) {
    const reference = tokenize(referenceText);
    const heard = new Map();
    tokenize(recognizedText).forEach((token) => {
      heard.set(token, (heard.get(token) || 0) + 1);
    });
    const missing = [];
    reference.forEach((token) => {
      const left = heard.get(token) || 0;
      if (left > 0) heard.set(token, left - 1);
      else if (!missing.includes(token)) missing.push(token);
    });
    return missing;
  }

  function wordsFor(storage, videoId, segmentKey) {
    const saved = readMap(storage)[sentenceKey(videoId, segmentKey)];
    return Array.isArray(saved) ? saved.filter((word) => typeof word === 'string' && word) : [];
  }

  function remember(storage, videoId, segmentKey, referenceText, recognizedText) {
    const key = sentenceKey(videoId, segmentKey);
    const map = readMap(storage);
    const heard = new Set(tokenize(recognizedText));
    const kept = wordsFor(storage, videoId, segmentKey).filter((word) => !heard.has(word));
    missingWords(referenceText, recognizedText).forEach((word) => {
      if (!kept.includes(word)) kept.push(word);
    });
    if (kept.length) map[key] = kept.slice(0, 24);
    else delete map[key];
    writeMap(storage, map);
    return kept;
  }

  return { tokenize, missingWords, wordsFor, remember, sentenceKey };
});
