(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishSentenceAssist = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const BREAKS = new Set([
    'and', 'but', 'because', 'so', 'when', 'if', 'while',
    'although', 'though', 'after', 'before', 'until', 'unless',
  ]);

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function sentenceChunks(sentence) {
    const text = String(sentence || '').replace(/\s+/g, ' ').trim();
    if (!text) return [];
    const tokens = text.match(/[A-Za-z0-9']+|[^A-Za-z0-9'\s]+|\s+/g) || [];
    const chunks = [];
    let current = [];
    let words = 0;

    function flush() {
      const value = current.join('').replace(/\s+/g, ' ').trim().replace(/^[,;:.]+|[,;:.]+$/g, '').trim();
      if (value) chunks.push(value);
      current = [];
      words = 0;
    }

    tokens.forEach((token) => {
      if (/^\s+$/.test(token)) {
        current.push(' ');
        return;
      }
      const bare = token.toLowerCase().replace(/[^a-z']/g, '');
      if (BREAKS.has(bare) && words >= 3) flush();
      current.push(token);
      if (/[A-Za-z0-9']/.test(token)) words += 1;
      if (/^[,;:]$/.test(token) && words >= 3) flush();
    });
    flush();
    return chunks;
  }

  function shortGloss(entry) {
    const meanings = entry && Array.isArray(entry.meanings) ? entry.meanings : [];
    for (let i = 0; i < meanings.length; i += 1) {
      const defs = Array.isArray(meanings[i].definitions) ? meanings[i].definitions : [];
      const def = defs[0];
      if (!def) continue;
      const zh = String(def.zh || '').trim();
      if (zh) return zh;
      const en = String(def.definition || '').trim();
      if (en) return en;
    }
    return '';
  }

  function phoneticOf(entry) {
    if (!entry) return '';
    const direct = String(entry.phonetic || '').trim();
    if (direct) return direct;
    const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics : [];
    const found = phonetics.find((item) => item && (item.text || item.phonetic));
    return found ? String(found.text || found.phonetic || '').trim() : '';
  }

  function cardHTML(model) {
    const word = String((model && model.word) || '').trim();
    const phonetic = String((model && model.phonetic) || '').trim();
    const gloss = String((model && model.gloss) || '').trim() || '先看它在这句里怎么连。';
    const chunks = sentenceChunks(model && model.sentence);
    const chunkHTML = chunks.length
      ? `<div class="assist-chunks">${chunks.map((part) => `<span class="assist-chunk">${escapeHtml(part)}</span>`).join('')}</div>`
      : '';
    return `
      <div class="assist-head">
        <strong class="assist-word">${escapeHtml(word)}</strong>
        ${phonetic ? `<span class="assist-phon">${escapeHtml(phonetic)}</span>` : ''}
        <button type="button" data-assist="close">收起</button>
      </div>
      <p class="assist-gloss">${escapeHtml(gloss)}</p>
      ${chunkHTML}
      <div class="assist-actions">
        <button type="button" data-assist="say">接着说这句</button>
      </div>
    `;
  }

  return { sentenceChunks, shortGloss, phoneticOf, cardHTML, escapeHtml };
});
