(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishStarterSentence = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const STORAGE_KEY = 'linglish.starterSentence.v1';
  const SENTENCES = [
    'I was responsible for the meeting.',
    'The client arrived early.',
    'Can we start with the plan?',
    'I will send the notes today.',
    'Let us talk again tomorrow.',
  ];

  function dayKey(now) {
    const date = now instanceof Date ? now : new Date(now || Date.now());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function read(storage, now) {
    const date = dayKey(now);
    let saved = null;
    try { saved = JSON.parse(storage.getItem(STORAGE_KEY) || 'null'); } catch (_) { saved = null; }
    if (!saved || saved.date !== date) return { date, index: 0, spoken: 0 };
    const index = Math.min(SENTENCES.length - 1, Math.max(0, Number(saved.index) || 0));
    const spoken = Math.min(SENTENCES.length, Math.max(0, Number(saved.spoken) || 0));
    return { date, index, spoken };
  }

  function write(storage, record) {
    try { storage.setItem(STORAGE_KEY, JSON.stringify(record)); } catch (_) { }
    return record;
  }

  function current(storage, now) {
    const record = read(storage, now);
    return {
      sentence: SENTENCES[record.index],
      index: record.index,
      spoken: record.spoken,
      total: SENTENCES.length,
      finished: record.spoken >= SENTENCES.length,
    };
  }

  function markSpoken(storage, now) {
    const record = read(storage, now);
    const spoken = Math.min(SENTENCES.length, record.spoken + 1);
    const index = Math.min(SENTENCES.length - 1, record.index + (spoken >= SENTENCES.length ? 0 : 1));
    return write(storage, { date: record.date, index, spoken });
  }

  function lineHTML(sentence, missed) {
    const missing = new Set((Array.isArray(missed) ? missed : []).map((word) => String(word).toLowerCase()));
    return String(sentence || '').replace(/[A-Za-z']+/g, (word) => {
      const cls = missing.has(word.toLowerCase()) ? 'starter-word starter-missing' : 'starter-word';
      return `<span class="${cls}">${escapeHtml(word)}</span>`;
    });
  }

  function speak(sentence, synth, Utterance) {
    if (!synth || typeof synth.speak !== 'function' || typeof Utterance !== 'function') return false;
    try { if (typeof synth.cancel === 'function') synth.cancel(); } catch (_) { }
    const utter = new Utterance(String(sentence || ''));
    utter.lang = 'en-US';
    utter.rate = 0.9;
    synth.speak(utter);
    return true;
  }

  return { SENTENCES, dayKey, read, current, markSpoken, lineHTML, speak };
});
