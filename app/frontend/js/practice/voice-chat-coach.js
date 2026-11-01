/**
 * X-style DM shadowing chat: left = original line, right = your voice take.
 * Hold-to-talk on all surfaces (mouse / touch / pointer).
 */
(function (root) {
  'use strict';

  const MIN_HOLD_MS = 350;

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function clockMs(ms) {
    const sec = Math.max(1, Math.round((Number(ms) || 0) / 1000));
    return sec + '"';
  }

  /** X DM voice clock: 0:02 */
  function clockX(ms) {
    const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function voiceWaveMarkup(seed, bars) {
    const n = Math.max(18, Math.min(36, Number(bars) || 28));
    const parts = [];
    const base = Math.abs(Number(seed) || 1);
    for (let i = 0; i < n; i += 1) {
      if (i < 6) {
        parts.push('<i class="x-voice-dot"></i>');
        continue;
      }
      const h = 28 + ((base * (i + 3) * 17) % 72);
      parts.push('<i class="x-voice-bar" style="--h:' + h + '%"></i>');
    }
    return '<span class="x-voice-wave" aria-hidden="true">' + parts.join('') + '</span>';
  }

  function normToken(word) {
    return String(word || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9']+/g, '');
  }

  function splitCueWords(text) {
    const raw = String(text || '');
    const words = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(raw))) {
      words.push({ raw: m[0], norm: normToken(m[0]) });
    }
    return words;
  }

  function tokenizeHeard(text) {
    return String(text || '')
      .split(/\s+/)
      .map(normToken)
      .filter(Boolean);
  }

  /** Sequential match: how many cue words the learner has hit + partial fill on current. */
  function matchCueProgress(cueWords, heardText) {
    const heard = tokenizeHeard(heardText);
    let ti = 0;
    let hi = 0;
    let partial = 0;
    while (ti < cueWords.length && hi < heard.length) {
      const tw = cueWords[ti].norm;
      const hw = heard[hi];
      if (!tw) {
        ti += 1;
        continue;
      }
      if (hw === tw) {
        ti += 1;
        hi += 1;
        partial = 0;
        continue;
      }
      if (tw.startsWith(hw) && hw.length >= 2) {
        partial = Math.min(0.92, hw.length / Math.max(1, tw.length));
        break;
      }
      if (hw.startsWith(tw) && tw.length >= 2) {
        ti += 1;
        hi += 1;
        partial = 0;
        continue;
      }
      // Skip one stray ASR token (uh / the) then retry same cue word.
      hi += 1;
    }
    if (ti < cueWords.length && heard.length) {
      const last = heard[heard.length - 1];
      const tw = cueWords[ti].norm;
      if (last && tw && tw.startsWith(last) && last !== tw && last.length >= 2) {
        partial = Math.min(0.92, last.length / Math.max(1, tw.length));
      }
    }
    return { hitCount: ti, partial: partial };
  }

  function karaokeEnHtml(text, hitCount, partial) {
    const words = splitCueWords(text);
    if (!words.length) return esc(text || '');
    const parts = [];
    words.forEach((w, i) => {
      if (i) parts.push(' ');
      let cls = 'vc-kword';
      let style = '';
      if (i < hitCount) {
        cls += ' is-hit';
      } else if (i === hitCount && partial > 0.05) {
        cls += ' is-partial';
        style = ' style="--p:' + Math.max(0.08, Math.min(0.95, partial)).toFixed(2) + '"';
      }
      parts.push('<span class="' + cls + '"' + style + '>' + esc(w.raw) + '</span>');
    });
    return parts.join('');
  }

  function getSpeechRecognitionCtor() {
    try {
      return root.SpeechRecognition || root.webkitSpeechRecognition || null;
    } catch (_) {
      return null;
    }
  }

  function create(options) {
    const opts = options || {};
    const host = opts.host;
    if (!host) throw new Error('voice-chat host required');

    const state = {
      turns: [],
      index: 0,
      holding: false,
      holdPointerDown: false,
      holdEpoch: 0,
      holdStartedAt: 0,
      recordHandle: null,
      recordPromise: null,
      stream: null,
      busy: false,
      previewAudio: null,
      pickerOpen: false,
      liveMatch: null,
    };

    const xUi = opts.xUi === true || opts.wechatUi === true || opts.silent === true;
    if (xUi) host.classList.add('is-xdm');
    host.classList.add('voice-chat');
    host.innerHTML = xUi ? [
      '<div class="voice-chat-head" hidden aria-hidden="true">',
      '  <div class="voice-chat-progress" data-vc-progress></div>',
      '  <div class="voice-chat-nav">',
      '    <button type="button" class="voice-chat-nav-btn" data-vc-prev hidden>上一句</button>',
      '    <button type="button" class="voice-chat-nav-btn" data-vc-next hidden>下一句</button>',
      '    <button type="button" class="voice-chat-nav-btn" data-vc-pick hidden>字幕列表</button>',
      '  </div>',
      '</div>',
      '<div class="voice-chat-stream" data-vc-stream></div>',
      '<div class="voice-chat-picker" data-vc-picker hidden></div>',
      // Pure X DM voice compose: one Hold pill. Tap left bubble = original; tap blue = mine.
      '<div class="voice-chat-focus is-x-compose" data-vc-focus hidden aria-hidden="true">',
      '  <span data-vc-focus-idx hidden></span>',
      '  <span data-vc-focus-en hidden></span>',
      '  <span data-vc-focus-zh hidden></span>',
      '</div>',
      '<div class="voice-chat-dock x-dm-compose" data-vc-compose>',
      '  <button type="button" class="voice-chat-hold x-dm-hold" data-vc-hold aria-label="按住跟读当前句">Hold to record</button>',
      '  <p class="voice-chat-hint" data-vc-hint hidden></p>',
      '</div>',
    ].join('') : [
      '<div class="voice-chat-head">',
      '  <div class="voice-chat-progress" data-vc-progress>第 0 / 0 句</div>',
      '  <div class="voice-chat-nav" role="group" aria-label="句子导航">',
      '    <button type="button" class="voice-chat-nav-btn" data-vc-prev>上一句</button>',
      '    <button type="button" class="voice-chat-nav-btn" data-vc-next>下一句</button>',
      '    <button type="button" class="voice-chat-nav-btn is-primary" data-vc-pick>字幕列表</button>',
      '  </div>',
      '</div>',
      '<div class="voice-chat-stream" data-vc-stream></div>',
      '<div class="voice-chat-picker" data-vc-picker hidden></div>',
      '<div class="voice-chat-dock">',
      '  <button type="button" class="voice-chat-hold" data-vc-hold>Hold to record</button>',
      '  <p class="voice-chat-hint" data-vc-hint></p>',
      '</div>',
    ].join('');

    const streamEl = host.querySelector('[data-vc-stream]');
    const holdBtn = host.querySelector('[data-vc-hold]');
    const hintEl = host.querySelector('[data-vc-hint]');
    const progressEl = host.querySelector('[data-vc-progress]');
    const pickerEl = host.querySelector('[data-vc-picker]');
    const prevBtns = Array.from(host.querySelectorAll('[data-vc-prev]'));
    const nextBtns = Array.from(host.querySelectorAll('[data-vc-next]'));
    const prevBtn = prevBtns[0] || null;
    const nextBtn = nextBtns[0] || null;
    const pickBtns = Array.from(host.querySelectorAll('[data-vc-pick]'));
    const pickBtn = pickBtns[pickBtns.length - 1] || null;
    const micToolBtn = host.querySelector('[data-vc-mic]');
    const focusEl = host.querySelector('[data-vc-focus]');
    const focusEnEl = host.querySelector('[data-vc-focus-en]');
    const focusZhEl = host.querySelector('[data-vc-focus-zh]');
    const focusIdxEl = host.querySelector('[data-vc-focus-idx]');
    const lockLabelEl = null;
    const focusPlayBtn = null;
    const focusMineBtn = null;

    function setHint(text, kind) {
      if (opts.silent || xUi) return;
      if (!hintEl) return;
      hintEl.textContent = text || '';
      hintEl.classList.toggle('is-warn', kind === 'warn');
    }

    const HOLD_IDLE = xUi ? 'Hold to record' : '🎙 按住跟读';
    const HOLD_ACTIVE = xUi ? 'Release to send' : '松开结束';

    function hostAvatarUrl() {
      if (typeof opts.getHostAvatarUrl === 'function') {
        try {
          const url = opts.getHostAvatarUrl();
          if (url) return String(url);
        } catch (_) {}
      }
      return '';
    }

    /** Grok-bot SVG face (used for self-uploads / "me"). */
    function grokBotSvg(fillBody, fillHi, gid) {
      return [
        '<svg class="bot-avatar-svg" viewBox="0 0 128 128" width="88" height="88" focusable="false"',
        ' shape-rendering="geometricPrecision" xmlns="http://www.w3.org/2000/svg">',
        '<defs>',
        '<linearGradient id="' + gid + '" x1="28" y1="18" x2="96" y2="112" gradientUnits="userSpaceOnUse">',
        '<stop offset="0%" stop-color="' + fillHi + '"/>',
        '<stop offset="55%" stop-color="' + fillBody + '"/>',
        '<stop offset="100%" stop-color="' + fillBody + '"/>',
        '</linearGradient>',
        '</defs>',
        '<path class="bot-body" fill="url(#' + gid + ')"',
        ' d="M22.5 71.2c1.2-28.6 23.8-51.4 52.6-48.2 24.8 2.8 41.6 25.4 38.2 49.6-3 21.6-23.4 38.2-45.4 36.8C40.2 107.6 21.4 93.2 22.5 71.2z"/>',
        '<g class="bot-eyes" fill="#ffffff" transform="rotate(-18 64 58)">',
        '<rect class="bot-eye bot-eye-l" x="44" y="46" width="12" height="28" rx="6"/>',
        '<rect class="bot-eye bot-eye-r" x="72" y="46" width="12" height="28" rx="6"/>',
        '</g>',
        '</svg>',
      ].join('');
    }

    /**
     * Left cue avatar:
     * - channel / podcast / video → host or show photo + sentence badge
     * - fallback → Grok bot + sentence badge
     * Photo must stay 44px via CSS (cover art is often 600px).
     */
    function cueNumberAvatar(sentenceIndex) {
      const n = Math.max(1, (Number(sentenceIndex) || 0) + 1);
      const photo = hostAvatarUrl();
      const gid = 'botg-them-' + n + '-' + Math.random().toString(36).slice(2, 7);
      if (photo) {
        return [
          '<span class="voice-chat-avatar is-them is-host-photo" aria-label="第 ' + n + ' 句">',
          '<img class="voice-chat-host-img" src="' + esc(photo) + '" alt="" width="44" height="44" loading="lazy" decoding="async" referrerpolicy="no-referrer" />',
          '<span class="voice-chat-cue-badge">' + n + '</span>',
          '</span>',
        ].join('');
      }
      return [
        '<span class="voice-chat-avatar is-them is-live-bot is-cue-bot" aria-label="第 ' + n + ' 句" style="--bot-delay:0s">',
        grokBotSvg('#0f172a', '#334155', gid),
        '<span class="voice-chat-cue-badge">' + n + '</span>',
        '</span>',
      ].join('');
    }

    /** HD animated Fluent/Grok blob for "me". */
    function botAvatarMarkup(side) {
      const isMe = side === 'me';
      const body = isMe ? '#0f766e' : '#0f172a';
      const bodyHi = isMe ? '#14b8a6' : '#334155';
      const delay = isMe ? '0.7s' : '0s';
      const gid = 'botg-' + side + '-' + Math.random().toString(36).slice(2, 8);
      return [
        '<span class="voice-chat-avatar is-' + (isMe ? 'me' : 'them') + ' is-live-bot" aria-hidden="true" style="--bot-delay:' + delay + '">',
        grokBotSvg(body, bodyHi, gid),
        '</span>',
      ].join('');
    }

    function sentences() {
      return typeof opts.getSentences === 'function' ? (opts.getSentences() || []) : [];
    }

    function currentIndex() {
      if (typeof opts.getIndex === 'function') return Number(opts.getIndex()) || 0;
      return state.index;
    }

    function setIndex(index, options) {
      const next = Math.max(0, Number(index) || 0);
      const changed = state.index !== next;
      state.index = next;
      if (changed && !(options && options.silent) && typeof opts.setIndex === 'function') {
        opts.setIndex(next);
      }
      updateChrome();
    }

    function mineUrlForIndex(index) {
      const hit = [...state.turns].reverse().find((t) => t.side === 'me' && t.index === index && t.url);
      return hit ? hit.url : '';
    }

    function emitLiveMatch(cleared) {
      if (typeof opts.onLiveMatch !== 'function') return;
      try {
        if (cleared || !state.liveMatch) {
          opts.onLiveMatch({ holding: false });
          return;
        }
        const live = state.liveMatch;
        opts.onLiveMatch({
          holding: !!state.holding,
          index: live.index,
          text: live.text,
          hitCount: live.hitCount,
          partial: live.partial,
          html: karaokeEnHtml(live.text, live.hitCount, live.partial),
        });
      } catch (_) {}
    }

    function paintLiveMatch() {
      const live = state.liveMatch;
      if (!live) return;
      if (streamEl) {
        const row = streamEl.querySelector(
          '.voice-chat-row.is-them[data-sentence-index="' + live.index + '"] .voice-chat-en'
        );
        if (row) {
          row.classList.add('is-karaoke');
          row.innerHTML = karaokeEnHtml(live.text, live.hitCount, live.partial);
        }
      }
      emitLiveMatch(false);
    }

    function applyHeardToLiveMatch(heardText) {
      const live = state.liveMatch;
      if (!live || !state.holding) return;
      const progress = matchCueProgress(live.words, heardText);
      if (progress.hitCount < live.hitCount) return;
      if (
        progress.hitCount === live.hitCount
        && progress.partial <= live.partial + 0.02
      ) return;
      live.hitCount = progress.hitCount;
      live.partial = progress.partial;
      live.heard = heardText;
      live.gotAsr = true;
      paintLiveMatch();
    }

    function stopLiveMatch() {
      const live = state.liveMatch;
      if (!live) return;
      if (live.raf) {
        try { cancelAnimationFrame(live.raf); } catch (_) {}
        live.raf = 0;
      }
      if (live.fallbackTimer) {
        try { clearTimeout(live.fallbackTimer); } catch (_) {}
        live.fallbackTimer = 0;
      }
      if (live.recognition) {
        const rec = live.recognition;
        live.recognition = null;
        try { rec.onresult = null; } catch (_) {}
        try { rec.onerror = null; } catch (_) {}
        try { rec.onend = null; } catch (_) {}
        try { rec.abort(); } catch (_) {
          try { rec.stop(); } catch (_) {}
        }
      }
      state.liveMatch = null;
      emitLiveMatch(true);
    }

    function startLiveMatch(index, seg) {
      stopLiveMatch();
      const text = String((seg && seg.text) || '').trim();
      if (!text) return;
      const words = splitCueWords(text);
      const durMs = Math.max(
        1600,
        Math.min(
          14000,
          (
            Number(seg && seg.end) - Number(seg && seg.start) > 0.2
              ? (Number(seg.end) - Number(seg.start)) * 1000
              : Math.max(2.2, words.length * 0.42) * 1000
          )
        )
      );
      const live = {
        index,
        text,
        words,
        hitCount: 0,
        partial: 0,
        heard: '',
        finalBuffer: '',
        gotAsr: false,
        startedAt: Date.now(),
        durMs,
        recognition: null,
        raf: 0,
        fallbackTimer: 0,
        restarts: 0,
      };
      state.liveMatch = live;
      // Real ASR only — no timed fake karaoke while silent.
      paintLiveMatch();

      const Recognition = getSpeechRecognitionCtor();
      if (!Recognition) return;
      const recognition = new Recognition();
      live.recognition = recognition;
      recognition.lang = 'en-US';
      recognition.continuous = true;
      recognition.interimResults = true;
      try { recognition.maxAlternatives = 3; } catch (_) {}
      recognition.onresult = (event) => {
        if (state.liveMatch !== live || !state.holding) return;
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const row = event.results[i];
          const piece = row && row[0] && row[0].transcript ? row[0].transcript : '';
          if (!piece) continue;
          if (row.isFinal) live.finalBuffer = (live.finalBuffer + ' ' + piece).replace(/\s+/g, ' ').trim();
          else interim += ' ' + piece;
        }
        const combined = (live.finalBuffer + ' ' + interim).replace(/\s+/g, ' ').trim();
        if (combined) applyHeardToLiveMatch(combined);
      };
      recognition.onerror = () => {
        /* keep MediaRecorder; karaoke stays until real speech matches */
      };
      recognition.onend = () => {
        if (state.liveMatch !== live || !state.holding || live.recognition !== recognition) return;
        if (live.restarts >= 12) return;
        live.restarts += 1;
        window.setTimeout(() => {
          if (state.liveMatch !== live || !state.holding) return;
          try { recognition.start(); } catch (_) {}
        }, 160);
      };
      try {
        recognition.start();
      } catch (_) {
        live.recognition = null;
      }
    }

    function tappableCueHtml(text) {
      const words = splitCueWords(text);
      if (!words.length) return esc(text || '');
      return words.map((w, i) => {
        const gap = i ? ' ' : '';
        const lemma = String(w.norm || w.raw || '').replace(/[^a-z0-9']/gi, '');
        if (!lemma) return gap + esc(w.raw);
        return gap + '<button type="button" class="vc-tap-word" data-vc-word="' + esc(lemma) + '">' + esc(w.raw) + '</button>';
      }).join('');
    }

    function themEnHtml(turn) {
      const live = state.liveMatch;
      if (live && live.index === turn.index && (state.holding || live.hitCount > 0)) {
        return karaokeEnHtml(turn.text || live.text, live.hitCount, live.partial);
      }
      return tappableCueHtml(turn.text || '');
    }

    let vcWordLookupSeq = 0;

    function hideVcWordCard() {
      const card = host.querySelector('[data-vc-word-card]');
      if (card) card.hidden = true;
      vcWordLookupSeq += 1;
    }

    function bindVcWordCardActions(card) {
      if (!card) return;
      const closeBtn = card.querySelector('[data-assist="close"]');
      if (closeBtn) {
        closeBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          hideVcWordCard();
        });
      }
      const sayBtn = card.querySelector('[data-assist="say"]');
      if (sayBtn) {
        sayBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          hideVcWordCard();
          if (holdBtn && typeof holdBtn.focus === 'function') {
            try { holdBtn.focus(); } catch (_) {}
          }
        });
      }
    }

    function paintVcWordCard(card, model) {
      const assist = root.LinglishSentenceAssist;
      if (assist && typeof assist.cardHTML === 'function') {
        card.innerHTML = assist.cardHTML(model);
      } else {
        card.innerHTML = '<strong>' + esc(model.word || '') + '</strong>'
          + '<p>' + esc(model.gloss || '') + '</p>'
          + '<button type="button" data-assist="close">收起</button>';
      }
      bindVcWordCardActions(card);
    }

    function dictAuthHeaders() {
      const headers = {};
      let token = null;
      try {
        if (root.DictionaryUtil && typeof root.DictionaryUtil.resolveToken === 'function') {
          token = root.DictionaryUtil.resolveToken();
        } else {
          token = localStorage.getItem('linglish_token')
            || localStorage.getItem('authToken')
            || sessionStorage.getItem('linglish_token')
            || sessionStorage.getItem('authToken');
        }
      } catch (_) {}
      if (token) headers.Authorization = 'Bearer ' + token;
      return headers;
    }

    async function fetchVcDictionary(lemma) {
      const dict = root.DictionaryLookup;
      if (dict && typeof dict.lookupWord === 'function') {
        const lookupPromise = dict.lookupWord(lemma);
        // Swallow late rejection after timeout so it does not surface as unhandled.
        lookupPromise.catch(() => {});
        const result = await Promise.race([
          lookupPromise,
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('DICT_TIMEOUT')), 2500);
          }),
        ]);
        return {
          entry: result && result.entry ? result.entry : null,
          zh: result && result.wordTranslation ? String(result.wordTranslation) : '',
        };
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => {
        try { if (controller) controller.abort(); } catch (_) {}
      }, 2500);
      try {
        const response = await fetch('/dictionary/' + encodeURIComponent(lemma), {
          credentials: 'same-origin',
          headers: dictAuthHeaders(),
          signal: controller ? controller.signal : undefined,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok && response.status !== 404) {
          throw new Error('DICT_HTTP_' + response.status);
        }
        return {
          entry: payload.entry || null,
          zh: String(payload.zh || payload.wordTranslation || ''),
        };
      } finally {
        clearTimeout(timer);
      }
    }

    async function showVcWordCard(word, sentence) {
      const lemma = String(word || '').trim().toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
      if (!lemma) return;
      let card = host.querySelector('[data-vc-word-card]');
      if (!card) {
        card = document.createElement('div');
        card.className = 'voice-chat-word-card';
        card.setAttribute('data-vc-word-card', '');
        host.appendChild(card);
      }
      const assist = root.LinglishSentenceAssist;
      const sentenceText = String(sentence || '').trim();
      const seq = ++vcWordLookupSeq;
      card.hidden = false;
      paintVcWordCard(card, { word: lemma, gloss: '正在查这个词…', sentence: sentenceText });
      // Prefer shared desktop subtitle card when present.
      if (typeof root.linglishShowSubtitleWordCard === 'function') {
        try {
          root.linglishShowSubtitleWordCard(lemma, { sentence: sentenceText });
          card.hidden = true;
          return;
        } catch (_) {}
      }
      try {
        const payload = await fetchVcDictionary(lemma);
        if (seq !== vcWordLookupSeq || card.hidden) return;
        const entry = payload.entry || null;
        const fromEntry = assist && typeof assist.shortGloss === 'function' ? assist.shortGloss(entry) : '';
        const gloss = fromEntry || payload.zh || '';
        const phonetic = assist && typeof assist.phoneticOf === 'function' ? assist.phoneticOf(entry) : '';
        paintVcWordCard(card, {
          word: lemma,
          phonetic,
          gloss: gloss || '词典里暂时没有这词的简短释义。',
          sentence: sentenceText,
        });
      } catch (_) {
        if (seq !== vcWordLookupSeq || card.hidden) return;
        paintVcWordCard(card, {
          word: lemma,
          gloss: '查词失败，请再试一次',
          sentence: sentenceText,
        });
      }
    }

    function updateFocusPad() {
      const list = sentences();
      const idx = currentIndex();
      const seg = list[idx];
      const label = !seg
        ? '选一句'
        : ('句 ' + (idx + 1) + '/' + list.length);
      if (focusIdxEl) focusIdxEl.textContent = label;
      if (lockLabelEl) lockLabelEl.textContent = label;
      if (focusEnEl) focusEnEl.textContent = seg ? (seg.text || '') : '';
      if (focusZhEl) {
        const zh = seg ? (seg.translation || seg.zh || '') : '';
        focusZhEl.textContent = zh;
        focusZhEl.hidden = !zh;
      }
      if (holdBtn) holdBtn.disabled = !seg;
      if (focusPlayBtn) focusPlayBtn.disabled = !seg;
      if (focusMineBtn) focusMineBtn.disabled = !(seg && mineUrlForIndex(idx));
      if (focusEl) focusEl.classList.toggle('is-ready', !!seg);
      if (holdBtn && !holdBtn.classList.contains('is-holding')) {
        setHoldLabel(HOLD_IDLE);
      }
    }

    function updateChrome() {
      const list = sentences();
      const idx = currentIndex();
      const total = list.length;
      if (progressEl) {
        if (xUi) {
          // Decorative handle unused — head stays hidden in X session chrome.
          progressEl.textContent = '';
        } else {
          progressEl.textContent = total
            ? ('第 ' + (idx + 1) + ' / ' + total + ' 句')
            : '还没有字幕';
        }
      }
      prevBtns.forEach((btn) => { btn.disabled = !total || idx <= 0; });
      nextBtns.forEach((btn) => { btn.disabled = !total || idx >= total - 1; });
      if (holdBtn) holdBtn.disabled = !total;
      pickBtns.forEach((btn) => { btn.disabled = !total; });
      updateFocusPad();
    }

    function cueInStream(index) {
      return state.turns.some((t) => t.side === 'them' && t.index === index);
    }

    /** Toggle active cue classes in place — no DOM rebuild, no scroll jump. */
    function applyActiveInStream(index) {
      if (!streamEl) return;
      state.turns.forEach((t) => {
        if (t.side === 'them') t.active = t.index === index;
      });
      streamEl.querySelectorAll('.voice-chat-row.is-them').forEach((row) => {
        const idx = Number(row.getAttribute('data-sentence-index'));
        const on = idx === index;
        row.classList.toggle('is-focus-row', on);
        row.classList.toggle('is-dim', !!(xUi && !on));
        const bubble = row.querySelector('.voice-chat-bubble');
        if (bubble) bubble.classList.toggle('is-active', on);
      });
    }

    /** Lock practice target to one sentence — all record/hear-me bind here. */
    function lockPracticeTarget(index, options) {
      const list = sentences();
      if (!list.length) return -1;
      const next = Math.max(0, Math.min(list.length - 1, Number(index) || 0));
      state.practiceLocked = true;
      state.index = next;
      if (!(options && options.silent) && typeof opts.setIndex === 'function') {
        try { opts.setIndex(next); } catch (_) {}
      }
      // Hold / closed session: don't dump the full episode into the chat stream.
      if (options && options.skipSeed) {
        updateChrome();
        updateFocusPad();
        return next;
      }
      // Cue already on screen — just focus it. Never reseed (that jumps to bottom then back).
      if (cueInStream(next) && !(options && options.forceSeed)) {
        applyActiveInStream(next);
        updateChrome();
        updateFocusPad();
        scrollActiveIntoView({ force: false });
        return next;
      }
      const themCount = state.turns.filter((t) => t.side === 'them').length;
      const windowed = Boolean(options && options.windowed) || themCount < list.length;
      if (windowed) {
        // Keep a local window — never expand to hundreds of red host-art avatars.
        seedAround(next, (options && options.radius) || 14);
      } else {
        state.turns.forEach((t) => {
          t.active = t.side === 'them' && t.index === next;
        });
        render();
        scrollActiveIntoView({ force: true });
      }
      updateFocusPad();
      return next;
    }

    function scrollBottom() {
      if (!streamEl) return;
      streamEl.scrollTop = streamEl.scrollHeight;
    }

    function scrollActiveIntoView(options) {
      if (!streamEl) return;
      const active = streamEl.querySelector('.voice-chat-bubble.is-active');
      if (!active || typeof active.scrollIntoView !== 'function') return;
      const cr = streamEl.getBoundingClientRect();
      const er = active.getBoundingClientRect();
      const inView = er.top >= cr.top + 2 && er.bottom <= cr.bottom - 2;
      if (inView && !(options && options.force)) return;
      // Instant — smooth scroll made it look like “jump to bottom then climb back”.
      active.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }

    function stopPreview() {
      if (!state.previewAudio) return;
      try { state.previewAudio.pause(); } catch (_) {}
      state.previewAudio = null;
      clearVoicePlayingUi();
    }

    function clearVoicePlayingUi() {
      if (!streamEl) return;
      streamEl.querySelectorAll('.voice-chat-bubble.is-voice.is-playing').forEach((el) => {
        el.classList.remove('is-playing');
        el.style.removeProperty('--x-voice-progress');
      });
    }

    function markMineHeard(turnDomIndex) {
      const turn = state.turns[turnDomIndex];
      if (!turn || turn.side !== 'me') return;
      turn.heard = true;
      if (!streamEl) return;
      const row = streamEl.querySelector('.voice-chat-row.is-me[data-turn="' + turnDomIndex + '"] .voice-chat-read-receipt');
      if (row) row.textContent = '已读';
    }

    function playUrl(url, turnDomIndex) {
      stopPreview();
      clearVoicePlayingUi();
      return new Promise((resolve) => {
        if (!url) { resolve(false); return; }
        const audio = new Audio(url);
        state.previewAudio = audio;
        const bubble = Number.isFinite(turnDomIndex)
          ? streamEl.querySelector('.voice-chat-bubble.is-voice[data-play-me-wrap="' + turnDomIndex + '"]')
          : null;
        if (bubble) bubble.classList.add('is-playing');
        const tick = () => {
          if (!bubble || state.previewAudio !== audio) return;
          const dur = audio.duration;
          if (Number.isFinite(dur) && dur > 0) {
            bubble.style.setProperty('--x-voice-progress', String(Math.min(1, audio.currentTime / dur)));
          }
        };
        audio.ontimeupdate = tick;
        audio.onended = () => {
          if (state.previewAudio === audio) state.previewAudio = null;
          clearVoicePlayingUi();
          if (Number.isFinite(turnDomIndex)) markMineHeard(turnDomIndex);
          resolve(true);
        };
        audio.onerror = () => {
          if (state.previewAudio === audio) state.previewAudio = null;
          clearVoicePlayingUi();
          resolve(false);
        };
        audio.play().catch(() => {
          if (state.previewAudio === audio) state.previewAudio = null;
          clearVoicePlayingUi();
          resolve(false);
        });
      });
    }

    function practicedSet() {
      const set = new Set();
      state.turns.forEach((t) => {
        if (t.side === 'me' && t.url) set.add(Number(t.index));
      });
      return set;
    }

    function renderPicker() {
      if (!pickerEl) return;
      const list = sentences();
      const idx = currentIndex();
      const done = practicedSet();
      if (!state.pickerOpen) {
        pickerEl.hidden = true;
        pickerEl.innerHTML = '';
        pickBtns.forEach((btn) => btn.classList.remove('is-on'));
        return;
      }
      pickBtns.forEach((btn) => btn.classList.add('is-on'));
      pickerEl.hidden = false;
      const start = Math.max(0, idx - 8);
      const end = Math.min(list.length, idx + 12);
      const rows = [];
      for (let i = start; i < end; i += 1) {
        const seg = list[i];
        const active = i === idx ? ' is-active' : '';
        const mark = done.has(i) ? ' · 已练' : '';
        rows.push(
          '<button type="button" class="voice-chat-pick-item' + active + '" data-pick-index="' + i + '">'
          + '<span class="voice-chat-pick-idx">' + (i + 1) + mark + '</span>'
          + '<span class="voice-chat-pick-text">' + esc(seg.text || '') + '</span>'
          + '</button>'
        );
      }
      pickerEl.innerHTML = [
        '<div class="voice-chat-picker-head">',
        '  <strong>从字幕继续陪练</strong>',
        '  <button type="button" class="voice-chat-picker-close" data-vc-picker-close>收起</button>',
        '</div>',
        '<div class="voice-chat-picker-list">' + rows.join('') + '</div>',
      ].join('');
      const activeItem = pickerEl.querySelector('.voice-chat-pick-item.is-active');
      if (activeItem && activeItem.scrollIntoView) {
        activeItem.scrollIntoView({ block: 'center' });
      }
    }

    function setPickerOpen(open) {
      state.pickerOpen = !!open;
      renderPicker();
      if (state.pickerOpen && typeof opts.onOpenSubtitleList === 'function') {
        try { opts.onOpenSubtitleList(currentIndex()); } catch (_) {}
      }
    }

    function render() {
      const list = sentences();
      updateChrome();
      if (!list.length) {
        streamEl.innerHTML = '<div class="voice-chat-empty"></div>';
        renderPicker();
        return;
      }
      if (!state.turns.length) {
        streamEl.innerHTML = '<div class="voice-chat-empty"></div>';
        renderPicker();
        return;
      }
      // X DM — left caption bubble; right voice only when recorded. No action row.
      const hideMeta = xUi
        || (typeof document !== 'undefined' && document.body && document.body.classList.contains('video-reader-mobile-focus'));
      streamEl.innerHTML = state.turns.map((turn, i) => {
        if (turn.side === 'them') {
          const zh = turn.zh
            ? `<span class="voice-chat-zh">${esc(turn.zh)}</span>`
            : '';
          const meta = hideMeta ? '' : [
            `<div class="voice-chat-meta">`,
            `<button type="button" class="voice-chat-play" data-play-them="${i}">听原声</button>`,
            `<button type="button" class="voice-chat-play" data-continue-them="${turn.index}">练这句</button>`,
            `</div>`,
          ].join('');
          const themAvatar = xUi
            ? cueNumberAvatar(turn.index)
            : '<span class="voice-chat-avatar is-them" aria-hidden="true">' + (turn.index + 1) + '</span>';
          const rowState = turn.active ? ' is-focus-row' : (xUi ? ' is-dim' : '');
          return [
            `<div class="voice-chat-row is-them${rowState}" data-turn="${i}" data-sentence-index="${turn.index}">`,
            themAvatar,
            `<div class="voice-chat-bubble is-text${turn.active ? ' is-active' : ''}" data-focus-them="${i}" data-play-them="${i}" data-sentence-index="${turn.index}">`,
            `<span class="voice-chat-en${state.liveMatch && state.liveMatch.index === turn.index ? ' is-karaoke' : ''}">${themEnHtml(turn)}</span>${zh}`,
            meta,
            `</div></div>`,
          ].join('');
        }
        const score = (!xUi && turn.score != null)
          ? `<div class="voice-chat-score">评分 ${esc(String(turn.score))}</div>`
          : '';
        const ms = Number(turn.durationMs);
        const label = turn.recording
          ? (xUi ? '0:00' : '…')
          : (xUi
            ? (turn.durationLabelX || clockX(Number.isFinite(ms) ? ms : 2000))
            : (turn.durationLabel || '1"'));
        const secs = xUi
          ? Math.max(1, Math.round((Number.isFinite(ms) ? ms : 2000) / 1000))
          : Math.max(1, parseInt(String(label), 10) || 1);
        const widthStyle = turn.recording
          ? ''
          : ` style="--vc-voice-w:${Math.max(xUi ? 168 : 88, Math.min(xUi ? 280 : 220, (xUi ? 140 : 72) + secs * (xUi ? 14 : 8)))}px"`;
        // Me side always uses the same Grok bot as mobile browser.
        const meAvatar = botAvatarMarkup('me');
        if (xUi) {
          const canHear = !!(turn.url && !turn.recording);
          const heard = !!turn.heard;
          return [
            `<div class="voice-chat-row is-me" data-turn="${i}" data-sentence-index="${turn.index}">`,
            `<div class="voice-chat-me-stack">`,
            `<div class="voice-chat-bubble is-voice is-x-dm${turn.active ? ' is-active' : ''}${turn.recording ? ' is-recording' : ''}${canHear ? ' is-ready' : ''}" data-play-me-wrap="${i}"${widthStyle}>`,
            `<button type="button" class="voice-chat-voice x-voice-btn" data-play-me="${i}" ${canHear ? '' : 'disabled'} aria-label="${canHear ? '播放跟读录音 ' + esc(label) : '录音中'}">`,
            `<span class="x-voice-play" aria-hidden="true"></span>`,
            voiceWaveMarkup(turn.index * 13 + i, 26 + Math.min(10, secs)),
            `<span class="voice-chat-dur x-voice-dur">${esc(label)}</span>`,
            `</button>`,
            `</div>`,
            canHear ? `<span class="voice-chat-read-receipt">${heard ? '已读' : '可回听'}</span>` : '',
            `</div>`,
            meAvatar,
            `</div>`,
          ].join('');
        }
        return [
          `<div class="voice-chat-row is-me" data-turn="${i}" data-sentence-index="${turn.index}">`,
          `<div class="voice-chat-bubble is-voice${turn.active ? ' is-active' : ''}${turn.recording ? ' is-recording' : ''}"${widthStyle}>`,
          `<button type="button" class="voice-chat-voice" data-play-me="${i}" ${turn.url ? '' : 'disabled'}>`,
          `<span class="voice-chat-dur">${esc(label)}</span>`,
          `<span class="voice-chat-wave" aria-hidden="true"></span>`,
          `</button>${score}`,
          `</div>`,
          meAvatar,
          `</div>`,
        ].join('');
      }).join('');
      scrollActiveIntoView();
      renderPicker();
    }

    function ensureThemBubble(index) {
      const list = sentences();
      const seg = list[index];
      if (!seg) return null;
      const existing = state.turns.find((t) => t.side === 'them' && t.index === index);
      if (existing) {
        state.turns.forEach((t) => { t.active = false; });
        existing.active = true;
        existing.text = seg.text || existing.text;
        existing.zh = seg.translation || seg.zh || existing.zh;
        setIndex(index);
        render();
        return existing;
      }
      state.turns.forEach((t) => { t.active = false; });
      const turn = {
        side: 'them',
        index,
        text: seg.text || '',
        zh: seg.translation || seg.zh || '',
        active: true,
      };
      state.turns.push(turn);
      setIndex(index);
      render();
      return turn;
    }

    /**
     * Full-episode chat: every subtitle on the left; voice bubbles only where
     * the user actually recorded (e.g. 180 lines → 180 left bubbles, 0–180 right).
     */
    function seedRange(centerIndex, from, to) {
      const list = sentences();
      updateChrome();
      if (!list.length) {
        state.turns = [];
        render();
        return;
      }
      const center = Math.max(0, Math.min(list.length - 1, Number(centerIndex) || 0));
      const lo = Math.max(0, Math.min(list.length - 1, Number(from)));
      const hi = Math.max(lo, Math.min(list.length - 1, Number(to)));

      // Keep recorded takes; one latest voice per sentence index.
      const mineByIndex = new Map();
      state.turns.forEach((turn) => {
        if (turn.side !== 'me' || (!turn.url && !turn.recording)) return;
        const idx = Number(turn.index);
        if (!Number.isFinite(idx) || idx < 0 || idx >= list.length) return;
        const prev = mineByIndex.get(idx);
        if (!prev || turn.recording || (turn.url && !prev.recording)) {
          mineByIndex.set(idx, turn);
        }
      });

      const next = [];
      for (let i = lo; i <= hi; i += 1) {
        const seg = list[i];
        next.push({
          side: 'them',
          index: i,
          text: seg.text || '',
          zh: seg.translation || seg.zh || '',
          active: i === center,
        });
        const mine = mineByIndex.get(i);
        if (mine && (mine.url || mine.recording)) {
          next.push(Object.assign({}, mine, {
            active: !!mine.recording || !!mine.active,
            recording: !!mine.recording,
          }));
        }
      }
      state.turns = next;
      state.index = center;
      render();
      // Fresh window — force scroll once (instant), not a smooth climb from the bottom.
      scrollActiveIntoView({ force: true });
    }

    function seedAll(centerIndex) {
      const list = sentences();
      seedRange(centerIndex, 0, Math.max(0, list.length - 1));
    }

    /** Windowed seed — keeps session height sane on long videos. */
    function seedAround(centerIndex, radius) {
      const list = sentences();
      if (!list.length) {
        state.turns = [];
        updateChrome();
        render();
        return;
      }
      const center = Math.max(0, Math.min(list.length - 1, Number(centerIndex) || 0));
      const r = Math.max(4, Number(radius) || 14);
      seedRange(center, center - r, center + r);
    }

    function appendMineRecording(payload) {
      const data = payload || {};
      const index = Number.isFinite(Number(data.index)) ? Number(data.index) : currentIndex();
      const list = sentences();
      if (!state.turns.some((t) => t.side === 'them' && t.index === index)) {
        seedAround(index, 14);
      }
      state.turns.forEach((t) => { t.active = false; });
      // Replace any previous take for this sentence (one voice slot per line).
      state.turns = state.turns.filter((t) => !(t.side === 'me' && t.index === index));
      const turn = {
        side: 'me',
        index,
        recording: false,
        active: true,
        url: data.url || (data.blob ? URL.createObjectURL(data.blob) : ''),
        durationMs: Number(data.durationMs) || 0,
        durationLabel: data.durationLabel || clockMs(data.durationMs),
        durationLabelX: data.durationLabelX || clockX(data.durationMs),
        score: data.score != null ? data.score : null,
        blob: data.blob || null,
      };
      let insertAt = state.turns.length;
      for (let i = 0; i < state.turns.length; i += 1) {
        const row = state.turns[i];
        if (row.side === 'them' && row.index === index) insertAt = i + 1;
      }
      state.turns.splice(insertAt, 0, turn);
      render();
      scrollActiveIntoView();
      return turn;
    }

    async function playOriginal(index) {
      const list = sentences();
      if (!list.length) return;
      const next = Math.max(0, Math.min(list.length - 1, Number(index)));
      if (!Number.isFinite(next)) return;
      // Check play state before lock — lock updates active index and used to fake "already playing".
      if (typeof opts.isPlayingOriginal === 'function' && opts.isPlayingOriginal(next)) {
        lockPracticeTarget(next, { silent: false });
        if (typeof opts.pauseOriginal === 'function') {
          try { opts.pauseOriginal(next); } catch (_) {}
        }
        return;
      }
      const locked = lockPracticeTarget(next, { silent: false });
      if (locked < 0) return;
      if (typeof opts.playOriginal === 'function') {
        await opts.playOriginal(locked);
      }
    }

    async function goTo(index, options) {
      const list = sentences();
      if (!list.length) return;
      const next = Math.max(0, Math.min(list.length - 1, Number(index) || 0));
      setPickerOpen(false);
      seedAround(next, 14);
      if (!options || options.play !== false) {
        await playOriginal(next);
      } else {
        render();
      }
      setHint('');
    }

    function setHoldLabel(text) {
      if (!holdBtn) return;
      let label = holdBtn.querySelector('[data-hold-label]') || holdBtn.querySelector('.mobile-hold-main');
      if (!label) {
        holdBtn.textContent = '';
        label = document.createElement('span');
        label.setAttribute('data-hold-label', '');
        holdBtn.appendChild(label);
      }
      label.textContent = text;
    }

    async function beginHold(event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (state.holding) return;
      // Recover from a stuck busy lock (interrupted hold left state.busy true).
      if (state.busy && !state.recordHandle && !state.recordPromise) {
        state.busy = false;
      }
      if (state.busy) return;
      const mic = root.LinglishShadowMic;
      if (!mic || typeof mic.acquireMic !== 'function' || typeof mic.recordShadow !== 'function') {
        setHint('录音组件还没加载，请刷新后再试', 'warn');
        return;
      }
      const list = sentences();
      // Always record the locked practice target (from last tapped subtitle).
      const index = lockPracticeTarget(currentIndex());
      const seg = list[index];
      if (!seg || index < 0) {
        setHint('还没有字幕，先选一段视频', 'warn');
        return;
      }

      state.holdPointerDown = true;
      state.holding = true;
      state.holdEpoch += 1;
      const epoch = state.holdEpoch;
      state.holdStartedAt = Date.now();
      state.busy = true;
      if (holdBtn) {
        holdBtn.classList.add('is-holding');
        setHoldLabel(HOLD_ACTIVE);
      }
      setHint('');
      if (typeof opts.onHoldStart === 'function') {
        try { opts.onHoldStart({ index }); } catch (_) {}
      }

      // Full transcript left (mobile sheet). Desktop Hold-only skips the dump.
      if (opts.holdOnly) {
        const keptMine = state.turns.filter((t) => t.side === 'me' && t.index !== index && (t.url || t.recording));
        state.turns = [
          {
            side: 'them',
            index,
            text: seg.text || '',
            zh: seg.translation || seg.zh || '',
            active: true,
          },
          ...keptMine,
        ];
      } else {
        seedAll(index);
      }
      state.turns.forEach((t) => { t.active = false; });
      state.turns = state.turns.filter((t) => !(t.side === 'me' && t.index === index));
      const meTurn = {
        side: 'me',
        index,
        recording: true,
        active: true,
        url: '',
        durationLabel: '…',
        score: null,
        blob: null,
      };
      let insertAt = state.turns.length;
      for (let i = 0; i < state.turns.length; i += 1) {
        const row = state.turns[i];
        if (row.side === 'them' && row.index === index) {
          row.active = true;
          insertAt = i + 1;
        }
      }
      state.turns.splice(insertAt, 0, meTurn);
      render();

      try {
        state.stream = await mic.acquireMic({
          deviceId: typeof opts.getMicDeviceId === 'function' ? opts.getMicDeviceId() : undefined,
        });
      } catch (error) {
        if (epoch !== state.holdEpoch) return;
        state.holding = false;
        state.holdPointerDown = false;
        state.busy = false;
        stopLiveMatch();
        if (holdBtn) {
          holdBtn.classList.remove('is-holding');
          setHoldLabel(HOLD_IDLE);
        }
        if (typeof opts.onHoldEnd === 'function') {
          try { opts.onHoldEnd(); } catch (_) {}
        }
        state.turns = state.turns.filter((t) => t !== meTurn);
        render();
        const code = error && error.code;
        if (code === 'MICROPHONE_DENIED') setHint('没有麦克风权限，请允许后重试', 'warn');
        else if (code === 'MICROPHONE_INSECURE') setHint('当前不是安全连接，无法开麦', 'warn');
        else setHint('打不开麦克风，请换 Chrome / Safari', 'warn');
        return;
      }

      // Released while mic was warming — do not start an orphaned recorder (locks busy).
      if (epoch !== state.holdEpoch || !state.holding || !state.holdPointerDown) {
        try { mic.stopTracks(state.stream); } catch (_) {}
        state.stream = null;
        state.holding = false;
        state.holdPointerDown = false;
        state.busy = false;
        stopLiveMatch();
        if (holdBtn) {
          holdBtn.classList.remove('is-holding');
          setHoldLabel(HOLD_IDLE);
        }
        state.turns = state.turns.filter((t) => t !== meTurn);
        render();
        return;
      }

      try {
        if (root.LinglishAudioCues && typeof root.LinglishAudioCues.playMicReadyCue === 'function') {
          root.LinglishAudioCues.playMicReadyCue();
        }
      } catch (_) {}

      // Start ASR after mic is live so recognition can attach on mobile.
      window.setTimeout(() => {
        if (state.holding && epoch === state.holdEpoch) startLiveMatch(index, seg);
      }, 120);

      const holdCapMs = Number.isFinite(Number(opts.maxHoldMs))
        ? Number(opts.maxHoldMs)
        : 60000;
      state.recordPromise = mic.recordShadow({
        stream: state.stream,
        releaseStream: true,
        // Voice note: hold up to 60s.
        maxDurationMs: holdCapMs,
        onReady(handle) {
          if (epoch !== state.holdEpoch) {
            try {
              if (handle && typeof handle.cancel === 'function') handle.cancel();
              else if (handle && typeof handle.stop === 'function') handle.stop();
            } catch (_) {}
            return;
          }
          state.recordHandle = handle;
        },
      }).then((captured) => {
        meTurn.blob = captured && captured.blob;
        meTurn.url = captured && captured.blob ? URL.createObjectURL(captured.blob) : '';
        meTurn.durationMs = Number(captured && captured.durationMs) || 0;
        meTurn.durationLabel = clockMs(meTurn.durationMs);
        meTurn.durationLabelX = clockX(meTurn.durationMs);
        meTurn.recording = false;
        return captured;
      }).catch((error) => {
        meTurn.recording = false;
        meTurn.error = error;
        throw error;
      });
    }

    async function endHold(event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      state.holdPointerDown = false;
      if (!state.holding) return;
      const heldMs = Date.now() - state.holdStartedAt;
      state.holding = false;
      state.holdEpoch += 1;
      stopLiveMatch();
      if (holdBtn) {
        holdBtn.classList.remove('is-holding');
        setHoldLabel(HOLD_IDLE);
      }
      if (typeof opts.onHoldEnd === 'function') {
        try { opts.onHoldEnd(); } catch (_) {}
      }

      const meTurn = [...state.turns].reverse().find((t) => t.side === 'me' && t.recording) ||
        [...state.turns].reverse().find((t) => t.side === 'me');

      if (heldMs < MIN_HOLD_MS) {
        if (state.recordHandle && typeof state.recordHandle.cancel === 'function') {
          try { state.recordHandle.cancel(); } catch (_) {}
        } else if (state.recordHandle && typeof state.recordHandle.stop === 'function') {
          try { state.recordHandle.stop(); } catch (_) {}
        }
        try { if (state.stream && root.LinglishShadowMic) root.LinglishShadowMic.stopTracks(state.stream); } catch (_) {}
        state.recordHandle = null;
        state.stream = null;
        state.recordPromise = null;
        state.busy = false;
        if (meTurn) state.turns = state.turns.filter((t) => t !== meTurn);
        render();
        setHint('');
        return;
      }

      if (state.recordHandle && typeof state.recordHandle.stop === 'function') {
        try { state.recordHandle.stop(); } catch (_) {}
      }
      setHint('');

      try {
        await state.recordPromise;
      } catch (error) {
        state.busy = false;
        state.recordHandle = null;
        state.stream = null;
        if (meTurn) state.turns = state.turns.filter((t) => t !== meTurn);
        render();
        setHint('');
        return;
      }

      state.recordHandle = null;
      state.stream = null;
      state.recordPromise = null;
      render();

      // No auto-play; user taps the voice bubble to listen.
      if (!opts.silent && !xUi && meTurn && meTurn.url && opts.autoPreview !== false) {
        await playUrl(meTurn.url);
      }

      if (typeof opts.onRecorded === 'function' && meTurn && meTurn.blob) {
        try {
          const result = await opts.onRecorded({
            blob: meTurn.blob,
            url: meTurn.url,
            index: meTurn.index,
            durationLabel: meTurn.durationLabel,
          });
          if (result && result.score != null) {
            meTurn.score = result.score;
            render();
          }
        } catch (_) {}
      }

      state.busy = false;
      const list = sentences();
      const nextIndex = (meTurn ? meTurn.index : currentIndex()) + 1;
      if (nextIndex < list.length) {
        setHint('');
        if (opts.autoAdvance !== false) {
          await goTo(nextIndex, { play: true });
        }
      } else {
        setHint('');
      }
      if (typeof opts.onTurnComplete === 'function') {
        try { opts.onTurnComplete(meTurn); } catch (_) {}
      }
    }

    // Click cue → stay put + play that track.
    // Press-and-hold cue (mouse or touch) → record that line (same as bottom Hold).
    let cuePressTimer = 0;
    let cuePressIndex = -1;
    let cuePressHolding = false;
    let cueSuppressClick = false;

    function clearCuePressTimer() {
      if (cuePressTimer) {
        clearTimeout(cuePressTimer);
        cuePressTimer = 0;
      }
    }

    function endCueBubbleHold(event) {
      clearCuePressTimer();
      if (!cuePressHolding) return;
      cuePressHolding = false;
      cueSuppressClick = true;
      Promise.resolve(endHold(event)).catch(() => {});
    }

    streamEl.addEventListener('pointerdown', (event) => {
      if (state.holding) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      // Word taps open a card — don't start long-press record on the word itself.
      if (event.target.closest('[data-vc-word], .vc-tap-word')) return;
      const them = event.target.closest('.voice-chat-bubble.is-text[data-sentence-index]');
      if (!them || event.target.closest('button.voice-chat-play, [data-play-me]')) return;
      const sentenceIndex = Number(them.getAttribute('data-sentence-index'));
      if (!Number.isFinite(sentenceIndex)) return;
      cuePressIndex = sentenceIndex;
      cuePressHolding = false;
      cueSuppressClick = false;
      clearCuePressTimer();
      cuePressTimer = setTimeout(() => {
        cuePressTimer = 0;
        cuePressHolding = true;
        cueSuppressClick = true;
        lockPracticeTarget(sentenceIndex);
        Promise.resolve(beginHold(event)).catch(() => {
          cuePressHolding = false;
        });
      }, 420);
    });

    streamEl.addEventListener('pointerup', endCueBubbleHold);
    streamEl.addEventListener('pointercancel', endCueBubbleHold);
    streamEl.addEventListener('lostpointercapture', endCueBubbleHold);

    streamEl.addEventListener('click', (event) => {
      if (state.holding || cuePressHolding) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (cueSuppressClick) {
        cueSuppressClick = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const continueBtn = event.target.closest('[data-continue-them]');
      if (continueBtn) {
        goTo(Number(continueBtn.getAttribute('data-continue-them')), { play: true });
        return;
      }
      // Tap a word → word card annotation.
      const tapWord = event.target.closest('[data-vc-word], .vc-tap-word');
      if (tapWord) {
        event.preventDefault();
        event.stopPropagation();
        const bubble = tapWord.closest('.voice-chat-bubble');
        const enEl = bubble && bubble.querySelector('.voice-chat-en');
        const sentence = enEl
          ? String(enEl.textContent || '').trim()
          : (bubble ? String(bubble.textContent || '').trim() : '');
        showVcWordCard(tapWord.getAttribute('data-vc-word') || tapWord.textContent, sentence);
        return;
      }

      // Tap / click subtitle (not a word) → replay that line in place.
      const them = event.target.closest('.voice-chat-bubble.is-text[data-sentence-index], [data-play-them], [data-focus-them]');
      if (them && !event.target.closest('button.voice-chat-play')) {
        hideVcWordCard();
        const sentenceIndex = Number(
          them.getAttribute('data-sentence-index')
          || (state.turns[Number(them.getAttribute('data-play-them') || them.getAttribute('data-focus-them'))] || {}).index
        );
        if (Number.isFinite(sentenceIndex)) playOriginal(sentenceIndex);
        return;
      }
      const me = event.target.closest('[data-play-me]');
      if (me) {
        const i = Number(me.getAttribute('data-play-me'));
        const turn = state.turns[i];
        if (turn && turn.url) {
          if (state.previewAudio && !state.previewAudio.paused) {
            stopPreview();
            clearVoicePlayingUi();
          } else {
            playUrl(turn.url, i);
          }
        }
      }
    });

    pickerEl.addEventListener('click', (event) => {
      if (event.target.closest('[data-vc-picker-close]')) {
        setPickerOpen(false);
        return;
      }
      const item = event.target.closest('[data-pick-index]');
      if (!item) return;
      goTo(Number(item.getAttribute('data-pick-index')), { play: true });
    });

    prevBtns.forEach((btn) => {
      btn.addEventListener('click', () => goTo(currentIndex() - 1, { play: true }));
    });
    nextBtns.forEach((btn) => {
      btn.addEventListener('click', () => goTo(currentIndex() + 1, { play: true }));
    });
    pickBtns.forEach((btn) => {
      btn.addEventListener('click', () => setPickerOpen(!state.pickerOpen));
    });
    if (micToolBtn) {
      micToolBtn.addEventListener('click', () => {
        if (typeof opts.onOpenMic === 'function') {
          try { opts.onOpenMic(); } catch (_) {}
        } else if (typeof root.openMobileMicSheet === 'function') {
          root.openMobileMicSheet();
        }
      });
    }
    if (focusPlayBtn) {
      focusPlayBtn.addEventListener('click', () => {
        playOriginal(currentIndex());
      });
    }
    if (focusMineBtn) {
      focusMineBtn.addEventListener('click', () => {
        const idx = currentIndex();
        const url = mineUrlForIndex(idx);
        if (!url) return;
        const turnDom = state.turns.findIndex((t) => t.side === 'me' && t.index === idx && t.url);
        if (state.previewAudio && !state.previewAudio.paused) {
          stopPreview();
          clearVoicePlayingUi();
        } else {
          playUrl(url, turnDom >= 0 ? turnDom : undefined);
        }
      });
    }

    if (holdBtn) {
      const onDown = (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        state.holdPointerDown = true;
        beginHold(event);
      };
      const onUp = (event) => endHold(event);
      holdBtn.addEventListener('pointerdown', (event) => {
        try {
          if (typeof holdBtn.setPointerCapture === 'function') {
            holdBtn.setPointerCapture(event.pointerId);
          }
        } catch (_) {}
        onDown(event);
      });
      holdBtn.addEventListener('pointerup', onUp);
      holdBtn.addEventListener('pointercancel', onUp);
      // Do not end on pointerleave — finger drift was aborting holds.
      holdBtn.addEventListener('lostpointercapture', onUp);
      holdBtn.addEventListener('contextmenu', (event) => event.preventDefault());
    }

    function syncFromIndex(index, options) {
      goTo(index, options);
    }

    function reset() {
      stopPreview();
      stopLiveMatch();
      state.turns.forEach((t) => {
        if (t.url) {
          try { URL.revokeObjectURL(t.url); } catch (_) {}
        }
      });
      state.turns = [];
      state.pickerOpen = false;
      render();
    }

    render();

    return {
      syncFromIndex,
      ensureThemBubble,
      seedAll,
      seedAround,
      appendMineRecording,
      playOriginal,
      lockPracticeTarget,
      goTo,
      beginHold,
      endHold,
      isHolding: () => !!state.holding,
      isBusy: () => !!state.busy,
      getPracticeIndex: () => currentIndex(),
      openSubtitleList: () => setPickerOpen(true),
      reset,
      render,
      setHint,
      getTurns: () => state.turns.slice(),
    };
  }

  root.LinglishVoiceChatCoach = {
    create,
    karaokeEnHtml,
  };
})(typeof window !== 'undefined' ? window : globalThis);
