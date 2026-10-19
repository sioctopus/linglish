(function () {
  'use strict';

  const POS = {
    noun: '名词',
    verb: '动词',
    adjective: '形容词',
    adverb: '副词',
    pronoun: '代词',
    preposition: '介词',
    conjunction: '连词',
    determiner: '限定词',
    interjection: '感叹',
    modal: '情态',
    particle: '助词',
    number: '数词',
  };
  const GROUP_START = new Set([
    'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her',
    'our', 'their', 'in', 'on', 'at', 'for', 'with', 'from', 'to', 'of', 'into',
  ]);
  const cache = new Map();
  const state = {
    armed: false,
    method: 'gloss',
    text: '',
    translation: '',
    revealed: false,
    onListen: null,
    token: 0,
    root: null,
  };

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function wordsOf(text) {
    return String(text || '').match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || [];
  }

  function keyOf(word) {
    return String(word || '').toLowerCase().replace(/[^a-z']/g, '');
  }

  function posKey(raw) {
    const value = String(raw || '').toLowerCase();
    if (value.includes('modal')) return 'modal';
    if (value.includes('verb')) return 'verb';
    if (value.includes('noun')) return 'noun';
    if (value.includes('adj')) return 'adjective';
    if (value.includes('adv')) return 'adverb';
    if (value.includes('pron')) return 'pronoun';
    if (value.includes('prep')) return 'preposition';
    if (value.includes('conj')) return 'conjunction';
    if (value.includes('det') || value.includes('article')) return 'determiner';
    if (value.includes('interj')) return 'interjection';
    if (value.includes('num')) return 'number';
    if (value.includes('part')) return 'particle';
    return '';
  }

  function shortZh(value) {
    const text = String(value || '').split(/[；;。]/)[0].split(/[，,]/)[0].trim();
    return text.length > 6 ? text.slice(0, 6) : text;
  }

  function phonetic(value) {
    const text = String(value || '').replace(/[\[\]]/g, '').trim();
    if (!text) return '';
    return text.startsWith('/') ? text : `/${text}/`;
  }

  function chunkIds(words) {
    let id = 0;
    return words.map((word, index) => {
      const key = keyOf(word);
      if (index > 0 && (GROUP_START.has(key) || index % 6 === 0)) id += 1;
      return id;
    });
  }

  function ensureRoot() {
    if (state.root && state.root.isConnected) return state.root;
    const host = document.getElementById('subtitle-study-host');
    if (!host) return null;
    const root = document.createElement('section');
    root.className = 'subtitle-study';
    root.id = 'subtitle-study';
    root.hidden = true;
    root.innerHTML = [
      '<div class="subtitle-study-methods" role="tablist">',
      '<button type="button" data-method="listen">先听再跟</button>',
      '<button type="button" data-method="speak">先说再看</button>',
      '<button type="button" data-method="gloss">实景五段</button>',
      '</div>',
      '<p class="subtitle-study-hint">在右侧点一段字幕，这里生成这一句。</p>',
      '<p class="subtitle-study-zh" hidden></p>',
      '<div class="subtitle-study-gloss" hidden></div>',
      '<p class="subtitle-study-en" hidden></p>',
      '<button type="button" class="subtitle-study-reveal" hidden>看原句</button>',
      '<button type="button" class="subtitle-study-mic" hidden aria-label="听这一句">🎤</button>',
    ].join('');
    host.appendChild(root);
    root.querySelector('.subtitle-study-methods').addEventListener('click', onMethod);
    root.querySelector('.subtitle-study-reveal').addEventListener('click', () => {
      state.revealed = true;
      paint();
    });
    root.querySelector('.subtitle-study-mic').addEventListener('click', playLine);
    state.root = root;
    return root;
  }

  function onMethod(event) {
    const button = event.target.closest('[data-method]');
    if (!button) return;
    state.method = button.dataset.method;
    state.revealed = state.method !== 'speak';
    paint();
  }

  function playLine() {
    if (typeof state.onListen === 'function') {
      state.onListen();
      return;
    }
    if (!state.text || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(state.text));
  }

  function paint() {
    const root = ensureRoot();
    if (!root) return;
    root.hidden = !state.armed;
    document.body.classList.toggle('subtitle-study-on', state.armed);
    document.body.classList.toggle('subtitle-study-live', state.armed && Boolean(state.text));
    root.querySelectorAll('[data-method]').forEach((button) => {
      button.classList.toggle('is-on', button.dataset.method === state.method);
    });
    const hint = root.querySelector('.subtitle-study-hint');
    const zh = root.querySelector('.subtitle-study-zh');
    const en = root.querySelector('.subtitle-study-en');
    const gloss = root.querySelector('.subtitle-study-gloss');
    const reveal = root.querySelector('.subtitle-study-reveal');
    const mic = root.querySelector('.subtitle-study-mic');
    const hasLine = Boolean(state.text);
    hint.hidden = hasLine;
    hint.textContent = '在右侧点一段字幕，这里生成这一句。';
    zh.hidden = !hasLine || !state.translation;
    zh.textContent = state.translation || '';
    const showEnglish = hasLine && (state.method === 'listen' || (state.method === 'speak' && state.revealed));
    en.hidden = !showEnglish;
    en.textContent = state.text;
    gloss.hidden = !(hasLine && state.method === 'gloss');
    reveal.hidden = !(hasLine && state.method === 'speak' && !state.revealed);
    mic.hidden = !hasLine;
    document.querySelectorAll('#subtitle-study-toggle, #practice-study-toggle').forEach((button) => {
      button.classList.toggle('is-on', state.armed);
      button.setAttribute('aria-pressed', state.armed ? 'true' : 'false');
    });
  }

  function paintGloss(words) {
    const root = ensureRoot();
    if (!root) return;
    const gloss = root.querySelector('.subtitle-study-gloss');
    const ids = chunkIds(words);
    const html = words.map((word, index) => {
      const id = ids[index];
      const prev = index > 0 ? ids[index - 1] : -1;
      const next = index + 1 < words.length ? ids[index + 1] : -1;
      const edge = id !== prev && id !== next ? 'is-only' : id !== prev ? 'is-start' : id !== next ? 'is-end' : 'is-mid';
      const info = cache.get(keyOf(word)) || {};
      const open = id !== prev ? `<span class="subtitle-study-chunk is-c${id % 4}">` : '';
      const close = id !== next ? '</span>' : '';
      return `${open}<span class="subtitle-study-word ${edge}"><span class="subtitle-study-ipa">${escapeHtml(phonetic(info.ipa))}</span><span class="subtitle-study-token">${escapeHtml(word)}</span><span class="subtitle-study-pos">${escapeHtml(POS[info.pos] || '')}</span><span class="subtitle-study-gloss-zh">${escapeHtml(info.zh || '')}</span></span>${close}`;
    }).join('');
    gloss.innerHTML = html;
  }

  function loadGloss(words) {
    const keys = [...new Set(words.map(keyOf).filter((key) => key && !cache.has(key)))];
    if (!keys.length) {
      paintGloss(words);
      return;
    }
    const token = state.token;
    fetch(`/dictionary/gloss?words=${encodeURIComponent(keys.join(','))}`)
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((data) => {
        if (token !== state.token) return;
        const found = new Map((data.items || []).map((item) => [String(item.word || '').toLowerCase(), item]));
        keys.forEach((key) => {
          const item = found.get(key) || {};
          cache.set(key, {
            ipa: item.phonetic || '',
            pos: posKey(item.pos),
            zh: shortZh(item.zh),
          });
        });
        if (state.method === 'gloss') paintGloss(words);
      })
      .catch(() => {
        keys.forEach((key) => {
          if (!cache.has(key)) cache.set(key, { ipa: '', pos: '', zh: '' });
        });
        if (token === state.token && state.method === 'gloss') paintGloss(words);
      });
    paintGloss(words);
  }

  function show(detail) {
    const next = detail || {};
    state.text = String(next.text || '').replace(/\s+/g, ' ').trim();
    state.translation = String(next.translation || '').trim();
    state.onListen = typeof next.onListen === 'function' ? next.onListen : null;
    state.revealed = state.method !== 'speak';
    state.token += 1;
    state.armed = true;
    paint();
    const words = wordsOf(state.text);
    if (words.length) loadGloss(words);
  }

  function setArmed(next) {
    state.armed = Boolean(next);
    if (!state.armed) {
      state.text = '';
      state.translation = '';
    }
    paint();
  }

  function lineFrom(node, textSelector, translationSelector) {
    const textNode = node.querySelector(textSelector);
    const translationNode = node.querySelector(translationSelector);
    const text = textNode ? textNode.innerText : '';
    const translation = translationNode ? translationNode.innerText : '';
    const start = Number(node.dataset.start);
    return {
      text,
      translation,
      onListen() {
        if (!Number.isFinite(start)) return;
        const player = document.getElementById('player') || document.getElementById('practice-video');
        if (player && typeof player.currentTime === 'number') {
          player.currentTime = Math.max(0, start + 0.01);
          const play = player.play();
          if (play && typeof play.catch === 'function') play.catch(() => {});
        }
      },
    };
  }

  function bind() {
    ensureRoot();
    paint();
    document.querySelectorAll('#subtitle-study-toggle, #practice-study-toggle').forEach((button) => {
      button.addEventListener('click', () => setArmed(!state.armed));
    });
    const transcript = document.getElementById('transcript-list');
    if (transcript) {
      transcript.addEventListener('click', (event) => {
        if (!state.armed) return;
        const seg = event.target.closest('.seg');
        if (!seg || !transcript.contains(seg)) return;
        show(lineFrom(seg, '.text', '.translation'));
      }, true);
    }
    const lines = document.getElementById('practice-line-list');
    if (lines) {
      lines.addEventListener('click', (event) => {
        if (!state.armed) return;
        if (event.target.closest('button')) return;
        const line = event.target.closest('.line-item');
        if (!line || !lines.contains(line)) return;
        show(lineFrom(line, '.line-text', '.line-translation'));
      }, true);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  window.LinglishSubtitleStudy = { show, setArmed, isArmed: () => state.armed };
})();
