(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameSpeaking = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const GAME_TYPE = 'speaking';
  const MAX_DISTANCE = 2;

  function normalizeSpoken(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const rows = a.length + 1;
    const cols = b.length + 1;
    const matrix = new Array(rows);
    for (let i = 0; i < rows; i += 1) {
      matrix[i] = new Array(cols);
      matrix[i][0] = i;
    }
    for (let j = 0; j < cols; j += 1) matrix[0][j] = j;
    for (let i = 1; i < rows; i += 1) {
      for (let j = 1; j < cols; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }
    return matrix[a.length][b.length];
  }

  // 识别结果常带整句或冠词:只要命中目标词,或与目标编辑距离够近,就算对。
  function gradeTranscript(lemma, transcript) {
    const target = normalizeSpoken(lemma);
    const heard = normalizeSpoken(transcript);
    if (!target) return { isCorrect: false, heard, tier: 'empty' };
    if (!heard) return { isCorrect: false, heard, tier: 'empty' };
    if (heard === target) return { isCorrect: true, heard, tier: 'exact' };
    const tokens = heard.split(' ');
    if (tokens.includes(target)) return { isCorrect: true, heard, tier: 'contains' };
    const distance = levenshtein(heard, target);
    const limit = Math.min(MAX_DISTANCE, Math.max(1, Math.floor(target.length / 4)));
    if (distance <= limit) return { isCorrect: true, heard, tier: 'close' };
    return { isCorrect: false, heard, tier: 'miss', distance };
  }

  function getSpeechRecognition(globalObject) {
    const root = globalObject || (typeof window !== 'undefined' ? window : null);
    if (!root) return null;
    return root.SpeechRecognition || root.webkitSpeechRecognition || null;
  }

  return {
    GAME_TYPE,
    normalizeSpoken,
    gradeTranscript,
    getSpeechRecognition,
    MAX_DISTANCE,
  };
});
