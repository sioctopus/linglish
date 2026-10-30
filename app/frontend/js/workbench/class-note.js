/**
 * Workbench · 课后微信笔记
 * Reuses POST /class-notes + public /articles/:id share links.
 */
(function (global) {
  'use strict';

  let linesDirty = false;
  let lastNote = null;
  let noteId = null;
  let currentAudio = null;
  let speakToken = 0;
  let audioUnlocked = false;
  let bound = false;

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function readToken() {
    const keys = ['linglish_token', 'authToken'];
    for (const key of keys) {
      try {
        const value = localStorage.getItem(key) || sessionStorage.getItem(key);
        if (value && value !== 'null' && value !== 'undefined') return value;
      } catch (_) {}
    }
    return '';
  }

  function defaultLines(word) {
    const spoken = String(word || '').trim().replace(/\s+/g, ' ');
    const lower = spoken.toLowerCase();
    const titleWord = lower ? lower.charAt(0).toUpperCase() + lower.slice(1) : 'Cola';
    const say = lower || 'cola';
    return [say, `${titleWord} please`, `May I have ${say} please?`, 'Here you are', 'Thank you'];
  }

  function $(id) {
    return document.getElementById(id);
  }

  function renderLineFields(lines) {
    const host = $('wb-cn-line-fields');
    if (!host) return;
    host.innerHTML = lines.map((line, index) => (
      `<label class="wb-cn-line">
        <span>${index + 1}</span>
        <input data-line="${index}" type="text" value="${escapeHtml(line)}">
      </label>`
    )).join('');
  }

  function currentLines() {
    return [...document.querySelectorAll('#wb-cn-line-fields [data-line]')]
      .map((field) => field.value.trim())
      .filter(Boolean);
  }

  function setComposerStatus(message, isError) {
    const status = $('wb-cn-status');
    if (!status) return;
    status.hidden = !message;
    status.className = 'wb-status' + (isError ? ' error' : message ? ' ok' : '');
    status.textContent = message || '';
  }

  function setViewStatus(message) {
    const status = $('wb-cn-view-status');
    if (status) status.textContent = message || '';
  }

  function showShare(enabled) {
    const actions = $('wb-cn-share-actions');
    const link = $('wb-cn-share-link');
    if (actions) actions.hidden = !enabled;
    if (link) link.hidden = !enabled;
  }

  function stopSpeaking() {
    speakToken += 1;
    if (currentAudio) {
      try {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.pause();
        currentAudio.removeAttribute('src');
        currentAudio.load();
      } catch (_) {}
      currentAudio = null;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    document.querySelectorAll('#wb-cn-note .horn').forEach((item) => item.classList.remove('playing'));
  }

  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      }
    } catch (_) {}
  }

  function speakBrowser(text, token) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) {
        resolve(false);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      utterance.rate = 0.9;
      utterance.onend = () => resolve(token === speakToken);
      utterance.onerror = () => resolve(false);
      setTimeout(() => {
        if (token !== speakToken) {
          resolve(false);
          return;
        }
        window.speechSynthesis.speak(utterance);
      }, 40);
    });
  }

  function playUrl(url, token) {
    return new Promise((resolve) => {
      if (token !== speakToken) {
        resolve(false);
        return;
      }
      const audio = new Audio();
      currentAudio = audio;
      const finish = (ok) => {
        if (currentAudio === audio) currentAudio = null;
        resolve(ok && token === speakToken);
      };
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      audio.src = url;
      const start = audio.play();
      if (start && typeof start.then === 'function') start.catch(() => finish(false));
    });
  }

  async function fetchLineAudio(text) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/tts/practice', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: 'en-US-AvaMultilingualNeural' }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.audioUrl) return data.audioUrl;
    } catch (_) {
    } finally {
      clearTimeout(timer);
    }
    return '';
  }

  async function speak(text, button) {
    const value = String(text || '').trim();
    if (!value || !button) return;
    unlockAudio();
    stopSpeaking();
    const token = speakToken;
    button.classList.add('playing');
    const previous = $('wb-cn-view-status')?.textContent || '';
    setViewStatus('正在朗读…');
    let played = false;
    try {
      const audioUrl = await fetchLineAudio(value);
      if (token !== speakToken) return;
      if (audioUrl) played = await playUrl(audioUrl, token);
      if (!played && token === speakToken) played = await speakBrowser(value, token);
    } finally {
      if (token === speakToken) {
        button.classList.remove('playing');
        setViewStatus(played
          ? (previous || '点每一句前面的按钮听一听。')
          : '这句暂时读不出来，请再点一次。');
      }
    }
  }

  function showNote(note, share) {
    stopSpeaking();
    lastNote = {
      id: note.id || noteId || '',
      word: note.word || '',
      title: note.title || '',
      lines: Array.isArray(note.lines) ? note.lines.slice() : [],
      image: note.image || '',
    };
    $('wb-cn-composer').hidden = true;
    $('wb-cn-viewer').hidden = false;
    const image = note.image
      ? `<img src="${escapeHtml(note.image)}" alt="${escapeHtml(note.word)}">`
      : '';
    const lines = (note.lines || []).map((line) => (
      `<div class="line"><button class="horn" type="button" data-speak="${escapeHtml(line)}" aria-label="朗读">${(window.LxIcon && window.LxIcon.html) ? window.LxIcon.html('play', { className: 'lx-icon--sm' }) : '▶'}</button><div>${escapeHtml(line)}</div></div>`
    )).join('');
    $('wb-cn-note').innerHTML = `${image}<p class="word">${escapeHtml(note.word || '')}</p>${lines}`;
    const id = note.id || noteId;
    if (id) noteId = String(id);
    // Keep parent-facing share URL on class-note.html so existing WeChat links stay valid.
    const link = `${location.origin}/class-note.html?id=${encodeURIComponent(noteId || '')}`;
    $('wb-cn-share-link').textContent = link;
    showShare(true);
    setViewStatus(share
      ? '链接已准备好。粘贴到微信群后，家长点开就能看今天的卡片，并听每一句。'
      : '点每一句前面的按钮听一听。也可复制链接再发给家长。');
  }

  function showComposer(note) {
    stopSpeaking();
    $('wb-cn-viewer').hidden = true;
    $('wb-cn-composer').hidden = false;
    const word = String(note?.word || '').trim();
    const lines = Array.isArray(note?.lines) && note.lines.length
      ? note.lines
      : defaultLines(word || 'cola');
    $('wb-cn-word').value = word;
    linesDirty = Boolean(note?.lines?.length);
    renderLineFields(lines);
    $('wb-cn-photo').value = '';
    const fileName = $('wb-cn-file-name');
    if (fileName) fileName.textContent = '未选择照片';
    const button = $('wb-cn-save-btn');
    button.disabled = false;
    button.textContent = note?.word ? '重新生成笔记' : '生成笔记';
    setComposerStatus(note?.word
      ? '已带回单词和句子。请重新选择单词卡片照片，再生成。'
      : '');
    noteId = null;
    try {
      history.replaceState({}, '', './workbench.html?mode=class-note');
    } catch (_) {}
  }

  function bindEvents() {
    if (bound) return;
    bound = true;

    $('wb-cn-photo').addEventListener('change', () => {
      const file = $('wb-cn-photo').files[0];
      const name = $('wb-cn-file-name');
      if (name) name.textContent = file ? file.name : '未选择照片';
    });
    $('wb-cn-word').addEventListener('input', () => {
      if (linesDirty) return;
      renderLineFields(defaultLines($('wb-cn-word').value));
    });
    $('wb-cn-line-fields').addEventListener('input', () => { linesDirty = true; });

    $('wb-cn-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const token = readToken();
      if (!token) {
        setComposerStatus('请先登录，再生成笔记。', true);
        const banner = $('wb-auth-banner');
        if (banner) banner.hidden = false;
        return;
      }
      const word = $('wb-cn-word').value.trim();
      const file = $('wb-cn-photo').files[0];
      if (!word || !file) {
        setComposerStatus(file ? '请填写单词。' : '请选择单词卡片照片，再生成。', true);
        return;
      }
      const button = $('wb-cn-save-btn');
      button.disabled = true;
      setComposerStatus('正在生成笔记…');
      try {
        const body = new FormData();
        body.append('word', word);
        body.append('lines', JSON.stringify(currentLines()));
        body.append('file', file);
        const response = await fetch('/class-notes', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          body,
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || '笔记没有生成');
        let note = { ...result.note, lines: currentLines() };
        try {
          const articleRes = await fetch(`/articles/${encodeURIComponent(result.note.id)}`, { cache: 'no-store' });
          if (articleRes.ok) {
            const article = await articleRes.json();
            note = JSON.parse(article.content || '{}');
          }
        } catch (_) {}
        note.id = result.note.id;
        try {
          history.replaceState({}, '', `./workbench.html?mode=class-note&note=${encodeURIComponent(note.id)}`);
        } catch (_) {}
        showNote(note, true);
      } catch (err) {
        setComposerStatus(err.message || '笔记没有生成', true);
        button.disabled = false;
      }
    });

    $('wb-cn-note').addEventListener('click', (event) => {
      const button = event.target.closest('[data-speak]');
      if (!button) return;
      speak(button.getAttribute('data-speak') || '', button);
    });

    $('wb-cn-copy-btn').addEventListener('click', async () => {
      const link = $('wb-cn-share-link').textContent;
      try {
        await navigator.clipboard.writeText(link);
        setViewStatus('链接已复制。打开微信群，粘贴发送。');
      } catch (_) {
        setViewStatus('请长按下面的链接，复制后发到微信群。');
        showShare(true);
      }
    });

    $('wb-cn-edit-btn').addEventListener('click', () => {
      showComposer(lastNote || { word: '', lines: defaultLines('cola') });
    });

    $('wb-cn-another-btn').addEventListener('click', () => {
      linesDirty = false;
      showComposer({ word: '', lines: defaultLines('cola') });
      $('wb-cn-save-btn').textContent = '生成笔记';
      setComposerStatus('');
    });
  }

  async function loadNote(id) {
    const response = await fetch(`/articles/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('找不到这条笔记');
    const article = await response.json();
    const note = JSON.parse(article.content || '{}');
    if (note.kind !== 'class-note') throw new Error('这不是课后笔记');
    note.id = article.id;
    noteId = String(article.id);
    showNote(note, false);
  }

  function activate(options = {}) {
    bindEvents();
    const id = options.noteId || null;
    if (id) {
      loadNote(id).catch((err) => {
        showComposer({ word: '', lines: defaultLines('cola') });
        setComposerStatus(err.message || '笔记打开失败', true);
      });
    } else if (!lastNote) {
      showComposer({ word: '', lines: defaultLines('cola') });
    }
  }

  function deactivate() {
    stopSpeaking();
  }

  global.WorkbenchClassNote = {
    activate,
    deactivate,
    defaultLines,
  };
})(window);
