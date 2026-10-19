(function () {
  'use strict';

  const mode = window.LinglishCoachingMode;
  if (!mode) return;

  const ENABLED_KEY = 'linglish.coaching.enabled';
  const state = {
    host: '',
    open: false,
    allowed: false,
    segments: [],
    index: -1,
    videoId: null,
    user: null,
    transport: null,
    record: mode.emptyRecord(),
    selectedWord: '',
    translations: {},
    signature: '',
    roll: '',
    phase: 'idle',
    job: 0,
    rollTimer: 0,
    root: null,
    noteSession: null,
  };

  function storage() {
    try { return window.localStorage; } catch (_) { return null; }
  }

  function token() {
    const store = storage();
    return (window.AuthManager && window.AuthManager.getToken && window.AuthManager.getToken())
      || (store && (store.getItem('linglish_token') || store.getItem('authToken')))
      || '';
  }

  function resolveUser(user) {
    if (user && (user.membership_type || user.is_admin)) return user;
    const store = storage();
    if (!store) return user || null;
    const membership = store.getItem('membership_type');
    if (!membership) return user || null;
    return {
      id: user && user.id,
      is_admin: user && user.is_admin,
      membership_type: membership,
      subscription_status: store.getItem('subscription_status') || (user && user.subscription_status) || 'none',
      membership_expires_at: store.getItem('membership_expires_at') || (user && user.membership_expires_at) || null,
    };
  }

  function userId() {
    return state.user && (state.user.id || state.user.user_id) || 'local';
  }

  function authHeaders() {
    const value = token();
    return value ? { Authorization: `Bearer ${value}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
  }

  function currentRow() {
    return mode.rollingRows(state.segments, state.index).find((row) => row.role === 'current') || null;
  }

  function translationFor(row) {
    if (!row) return '';
    const cached = state.translations[`${state.videoId}:${row.index}`];
    return cached || row.translation || '';
  }

  function setStatus(text) {
    const node = state.root && state.root.querySelector('.coach-status');
    if (node) node.textContent = text || '';
  }

  function rememberTranslation(index, translation) {
    if (!translation || index < 0) return;
    state.translations[`${state.videoId}:${index}`] = translation;
  }

  function loadRecord() {
    state.record = mode.readRecord(storage(), userId(), state.videoId);
  }

  function persist(record) {
    state.record = mode.writeRecord(storage(), userId(), state.videoId, record);
  }

  function beginJob() {
    state.job += 1;
    state.phase = 'idle';
    return state.job;
  }

  function alive(job) {
    return job === state.job;
  }

  function desktopTransport() {
    const bridge = window.__vrdPro || {};
    const player = bridge.playerEl || document.getElementById('player');
    const youtube = typeof bridge.getYouTubePlayer === 'function' ? bridge.getYouTubePlayer() : null;
    const kind = typeof bridge.getPlayerType === 'function' ? bridge.getPlayerType() : 'local';
    if (kind === 'youtube' && youtube && typeof youtube.getCurrentTime === 'function') {
      return {
        getCurrentTime() { try { return Number(youtube.getCurrentTime()) || 0; } catch (_) { return 0; } },
        seek(seconds) { try { youtube.seekTo(seconds, true); } catch (_) {} },
        play() { try { if (typeof youtube.play === 'function') youtube.play(); else youtube.playVideo(); } catch (_) {} },
        pause() { try { if (typeof youtube.pause === 'function') youtube.pause(); else youtube.pauseVideo(); } catch (_) {} },
        isPlaying() {
          try {
            if (typeof youtube.isPlaying === 'function') return youtube.isPlaying() === true;
            if (typeof youtube.getPlayerState === 'function') {
              const code = youtube.getPlayerState();
              return code === 1 || code === 3;
            }
          } catch (_) {}
          return false;
        },
      };
    }
    if (!player) return null;
    return {
      getCurrentTime() { return Number(player.currentTime) || 0; },
      seek(seconds) { try { player.currentTime = seconds; } catch (_) {} },
      play() {
        const pending = player.play();
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      },
      pause() { try { player.pause(); } catch (_) {} },
      isPlaying() { return !player.paused && !player.ended; },
    };
  }

  function desktopFrame() {
    const bridge = window.__vrdPro || {};
    const segments = bridge.state && Array.isArray(bridge.state.currentSegments) ? bridge.state.currentSegments : [];
    const transport = desktopTransport();
    const time = transport ? transport.getCurrentTime() : 0;
    let index = -1;
    if (typeof bridge.currentSegmentIndexByTime === 'function') {
      try { index = bridge.currentSegmentIndexByTime(time); } catch (_) { index = -1; }
    }
    if (!Number.isInteger(index) || index < 0) index = mode.indexAtTime(segments, time);
    const video = bridge.state && bridge.state.currentVideo;
    return {
      segments,
      index,
      videoId: video && (video.id || video.video_id),
      user: bridge.state && bridge.state.user,
      transport,
    };
  }

  function applyFrame(frame) {
    const nextVideo = frame.videoId == null ? state.videoId : frame.videoId;
    const videoChanged = String(nextVideo || '') !== String(state.videoId || '');
    state.segments = Array.isArray(frame.segments) ? frame.segments : [];
    state.user = resolveUser(frame.user || state.user);
    state.allowed = mode.canUseCoaching(state.user);
    if (frame.transport) state.transport = frame.transport;
    if (videoChanged) {
      state.noteSession = null;
      const layer = document.getElementById('coach-study');
      if (layer) layer.replaceChildren();
      state.videoId = nextVideo;
      state.selectedWord = '';
      loadRecord();
    }
    let index = Number.isInteger(frame.index) ? frame.index : -1;
    if (index < 0 && state.transport) index = mode.indexAtTime(state.segments, state.transport.getCurrentTime());
    if (state.noteSession && state.noteSession.index >= 0 && state.noteSession.index < state.segments.length) {
      index = state.noteSession.index;
    }
    if (index !== state.index) {
      state.roll = index > state.index ? 'forward' : 'back';
      state.selectedWord = '';
      state.index = index;
    }
    if (state.noteSession) holdSentence();
    render();
  }

  function ensureRoot() {
    if (state.root && state.root.isConnected) return state.root;
    const mount = state.host === 'mobile'
      ? document.getElementById('video-wrapper')
      : (document.getElementById('coach-slot') || document.querySelector('.player'));
    if (!mount) return null;
    const root = document.createElement('section');
    root.className = 'coach-dock';
    root.id = 'coach-dock';
    root.setAttribute('aria-label', '视频带教');
    root.innerHTML = [
      '<div class="coach-panel" hidden></div>',
      '<div class="coach-rows" hidden></div>',
      '<div class="coach-actions" hidden></div>',
      '<div class="coach-bar"><button type="button" class="coach-toggle">带教</button><p class="coach-status"></p></div>',
    ].join('');
    mount.appendChild(root);
    root.querySelector('.coach-toggle').addEventListener('click', toggleOpen);
    root.querySelector('.coach-rows').addEventListener('click', onRowClick);
    root.querySelector('.coach-actions').addEventListener('click', onActionClick);
    state.root = root;
    return root;
  }

  function toggleOpen() {
    state.user = resolveUser(state.user);
    state.allowed = mode.canUseCoaching(state.user);
    state.open = !state.open;
    if (state.allowed) {
      const store = storage();
      if (store) store.setItem(ENABLED_KEY, state.open ? '1' : '0');
      if (!state.open) {
        beginJob();
        closeStudy();
      }
    }
    render();
    if (state.open && !state.allowed) {
      showLocked();
      return;
    }
    const box = state.root && state.root.querySelector('.coach-panel');
    if (!state.open && box) box.hidden = true;
    setStatus(state.open ? '点当前句里的单词，再选择下方动作' : (state.allowed ? '带教已收起' : '会员和高级会员可打开带教'));
  }

  function showLocked() {
    const panel = state.root.querySelector('.coach-panel');
    panel.hidden = false;
    panel.replaceChildren();
    const text = document.createElement('p');
    text.textContent = '带教模式对会员和高级会员开放。打开后，视频底部会滚动上一句、当前句和下一句，可以复制、做笔记、划线、AI查词、讲解、翻译、逐句朗读和跟读。';
    const link = document.createElement('a');
    link.href = './pricing.html?from=coaching#plans';
    link.textContent = '查看会员方案';
    panel.append(text, link);
    setStatus('会员和高级会员可用');
  }

  function inFocus() {
    return document.body.classList.contains('focus-mode');
  }

  function render() {
    const root = ensureRoot();
    if (!root) return;
    const focusReady = inFocus() && state.allowed;
    const showTools = state.allowed && (state.open || focusReady);
    root.dataset.allowed = state.allowed ? 'true' : 'false';
    root.dataset.open = state.open ? 'true' : 'false';
    root.dataset.roll = state.roll || '';
    const rows = root.querySelector('.coach-rows');
    const actions = root.querySelector('.coach-actions');
    rows.hidden = !showTools;
    actions.hidden = !showTools;
    if (!showTools) return;
    if (state.roll && !state.rollTimer) {
      const roll = state.roll;
      state.rollTimer = window.setTimeout(() => {
        state.rollTimer = 0;
        state.roll = '';
        if (state.root && state.root.dataset.roll === roll) state.root.dataset.roll = '';
      }, 280);
    }
    const modelRows = mode.rollingRows(state.segments, state.index);
    const signature = [
      state.videoId,
      state.index,
      modelRows.map((row) => row.text).join('\n'),
      JSON.stringify(state.record.notes || {}),
      JSON.stringify(state.record.marks || {}),
      state.selectedWord,
    ].join('::');
    if (signature !== state.signature) {
      state.signature = signature;
      paintRows(rows, modelRows);
      paintActions(actions);
    }
    attachTranscriptTools();
  }

  function lineMarked(row) {
    if (!row || row.index < 0) return false;
    return mode.isMarked(state.record, row.index, state.selectedWord || mode.LINE_MARK);
  }

  function actionLabel(action, row) {
    if (action.id === 'note') return mode.noteFor(state.record, row && row.index).trim() ? '查看笔记' : '写笔记';
    if (action.id === 'highlight') return lineMarked(row) ? '移除划线' : '划线';
    return action.label;
  }

  function rowAt(index) {
    const segment = state.segments[index];
    if (!segment || index < 0) return null;
    const bounds = mode.boundsOf(segment);
    return {
      index,
      text: mode.textOf(segment),
      translation: mode.translationOf(segment),
      start: bounds.start,
      end: bounds.end,
    };
  }

  function paintRows(container, rows) {
    container.replaceChildren();
    rows.forEach((row) => {
      const line = document.createElement('p');
      line.className = `coach-row is-${row.role}`;
      line.dataset.index = String(row.index);
      if (!row.text) {
        line.textContent = row.role === 'current' ? '选择视频后，这里滚动三句字幕' : '';
        container.appendChild(line);
        return;
      }
      if (row.role === 'current' && mode.isMarked(state.record, row.index, mode.LINE_MARK)) {
        line.classList.add('is-marked');
      }
      if (row.role !== 'current') {
        line.textContent = row.text;
        container.appendChild(line);
        return;
      }
      mode.tokenize(row.text).forEach((token) => {
        if (!token.word) {
          line.appendChild(document.createTextNode(token.text));
          return;
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'coach-word';
        button.dataset.word = token.word;
        button.textContent = token.text;
        if (token.word.toLowerCase() === state.selectedWord.toLowerCase()) button.classList.add('is-selected');
        if (mode.isMarked(state.record, row.index, token.word)) button.classList.add('is-marked');
        line.appendChild(button);
      });
      container.appendChild(line);
    });
  }

  function paintActions(container) {
    container.replaceChildren();
    const row = currentRow();
    mode.ACTIONS.forEach((action) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'coach-action';
      button.dataset.action = action.id;
      button.textContent = actionLabel(action, row);
      button.disabled = !row || row.index < 0;
      if (row && action.id === 'note' && mode.noteFor(state.record, row.index)) button.classList.add('is-on');
      if (row && action.id === 'highlight' && lineMarked(row)) {
        button.classList.add('is-on');
      }
      container.appendChild(button);
    });
  }

  function onRowClick(event) {
    const word = event.target.closest('.coach-word');
    if (word) {
      const value = word.dataset.word || '';
      state.selectedWord = state.selectedWord.toLowerCase() === value.toLowerCase() ? '' : value;
      state.signature = '';
      render();
      return;
    }
    const row = event.target.closest('.coach-row');
    if (!row) return;
    if (state.noteSession) {
      setStatus('先保存笔记，再换一句');
      return;
    }
    const index = Number(row.dataset.index);
    const segment = state.segments[index];
    if (!segment || !state.transport) return;
    const bounds = mode.boundsOf(segment);
    state.transport.seek(bounds.start + 0.01);
    state.transport.play();
  }

  function onActionClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    const row = currentRow();
    if (!row || row.index < 0) {
      setStatus('先播放到一句字幕');
      return;
    }
    if (action === 'copy') copySentence(row);
    else if (action === 'note') openNote(row);
    else if (action === 'highlight') highlight(row);
    else if (action === 'lookup') lookup(row);
    else if (action === 'explain') explain(row);
    else if (action === 'translate') translate(row);
    else if (action === 'read') readSentence(row);
    else if (action === 'shadow') shadowSentence(row);
  }

  async function copySentence(row) {
    const text = mode.copyText(Object.assign({}, row, { translation: translationFor(row) }), state.selectedWord);
    if (!text) return;
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch (_) { copied = false; }
    if (!copied) {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.left = '-9999px';
        document.body.appendChild(area);
        area.select();
        copied = document.execCommand('copy');
        area.remove();
      } catch (_) { copied = false; }
    }
    setStatus(copied ? '已复制' : '复制失败，请再试一次');
  }

  function panel() {
    return state.root.querySelector('.coach-panel');
  }

  function transportPlaying(transport) {
    return Boolean(transport && typeof transport.isPlaying === 'function' && transport.isPlaying());
  }

  function parkOnSentence(row) {
    const transport = state.transport;
    const playing = transportPlaying(transport);
    if (!transport || typeof transport.pause !== 'function') return playing;
    const time = Number(transport.getCurrentTime()) || 0;
    if (time < row.start || time >= row.end - 0.05) transport.seek(row.start + 0.01);
    transport.pause();
    return playing;
  }

  function holdSentence() {
    const session = state.noteSession;
    const transport = state.transport;
    if (!session || !transport || typeof transport.pause !== 'function') return;
    const segment = state.segments[session.index];
    if (segment) {
      const bounds = mode.boundsOf(segment);
      const time = Number(transport.getCurrentTime()) || 0;
      if (time < bounds.start || time >= bounds.end - 0.05) transport.seek(bounds.start + 0.01);
    }
    if (transportPlaying(transport)) transport.pause();
  }

  function endNote(resumePlayback) {
    const session = state.noteSession;
    state.noteSession = null;
    if (resumePlayback && session && session.resume && state.transport && typeof state.transport.play === 'function') {
      state.transport.play();
    }
    return Boolean(session && session.resume);
  }

  function openNote(row) {
    const existing = document.querySelector('#coach-study .study-note textarea');
    if (state.noteSession && state.noteSession.index === row.index && existing) {
      existing.focus();
      return;
    }
    beginJob();
    const resume = state.noteSession ? state.noteSession.resume : parkOnSentence(row);
    state.noteSession = { index: row.index, resume };
    const layer = studyRoot(true);
    layer.replaceChildren();
    const card = document.createElement('form');
    card.className = 'study-pop study-note';
    const head = document.createElement('div');
    head.className = 'study-head';
    const title = document.createElement('strong');
    title.textContent = '记下这句想记住的点';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'study-save';
    save.textContent = resume ? '保存并继续' : '保存笔记';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'study-x';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    close.addEventListener('click', closeStudy);
    head.append(title, save, close);
    const sentence = document.createElement('p');
    sentence.className = 'study-sentence';
    sentence.textContent = row.text;
    const input = document.createElement('textarea');
    input.placeholder = '在这里输入你的笔记...';
    input.value = mode.noteFor(state.record, row.index);
    const hint = document.createElement('p');
    hint.className = 'study-hint';
    hint.textContent = resume ? '已暂停在这一句。保存后继续播放，笔记会留在这句下面。' : '笔记会留在这句下面，之后播到这里还能看到。';
    card.append(head, sentence, input, hint);
    card.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value;
      try {
        persist(mode.saveNote(state.record, row.index, text));
      } catch (_) {
        hint.textContent = '没能保存，请再试一次';
        return;
      }
      const hadText = Boolean(String(text || '').trim());
      state.noteSaved = true;
      state.signature = '';
      render();
      setStatus(hadText
        ? (resume ? '笔记已保存，继续播放' : '笔记已保存')
        : (resume ? '笔记已清空，继续播放' : '笔记已清空'));
      closeStudy();
    });
    layer.appendChild(card);
    anchorCard(card, '#caption-bar');
    input.focus();
  }

  function savedNoteText(index) {
    return mode.noteFor(state.record, index).trim();
  }

  function showSavedNotes() {
    document.querySelectorAll('.seg-note').forEach((node) => node.remove());
    const notes = state.record && state.record.notes ? state.record.notes : {};
    Object.keys(notes).forEach((key) => {
      const text = String(notes[key] || '').trim();
      const seg = document.querySelector(`#transcript-list .seg[data-index="${key}"]`);
      if (!text || !seg) return;
      const note = document.createElement('button');
      note.type = 'button';
      note.className = 'seg-note';
      note.textContent = text;
      note.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const row = rowAt(Number(key));
        if (row) openNote(row);
      });
      const tools = seg.querySelector('.seg-tools');
      if (tools) seg.insertBefore(note, tools);
      else seg.appendChild(note);
    });
    const row = currentRow();
    const text = row && row.index >= 0 ? savedNoteText(row.index) : '';
    let slot = document.getElementById('caption-note');
    const host = document.getElementById('caption-bar');
    if (!text || !host || !state.open) {
      if (slot) slot.remove();
      return;
    }
    if (!slot) {
      slot = document.createElement('button');
      slot.type = 'button';
      slot.id = 'caption-note';
      host.appendChild(slot);
      slot.addEventListener('click', () => {
        const current = currentRow();
        if (current && current.index >= 0) openNote(current);
      });
    }
    slot.textContent = text;
  }

  function attachTranscriptTools() {
    document.querySelectorAll('.seg-tools').forEach((node) => node.remove());
    document.querySelectorAll('.seg.is-lined').forEach((node) => node.classList.remove('is-lined'));
    const row = currentRow();
    if (!state.open || !state.allowed || !row || row.index < 0) {
      showSavedNotes();
      return;
    }
    const seg = document.querySelector(`#transcript-list .seg[data-index="${row.index}"]`);
    if (!seg) {
      showSavedNotes();
      return;
    }
    if (mode.isMarked(state.record, row.index, mode.LINE_MARK)) seg.classList.add('is-lined');
    const bar = document.createElement('div');
    bar.className = 'seg-tools';
    [
      ['copy', '复制'],
      ['highlight', mode.isMarked(state.record, row.index, mode.LINE_MARK) ? '移除划线' : '划线'],
      ['note', savedNoteText(row.index) ? '查看笔记' : '写笔记'],
      ['translate', '翻译'],
      ['explain', '讲解'],
    ].forEach(([id, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'seg-tool';
      button.dataset.action = id;
      button.textContent = label;
      bar.appendChild(button);
    });
    bar.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onActionClick(event);
    });
    seg.appendChild(bar);
    showSavedNotes();
  }

  function highlight(row) {
    const token = state.selectedWord || mode.LINE_MARK;
    const marked = mode.isMarked(state.record, row.index, token);
    persist(mode.toggleMark(state.record, row.index, token));
    state.signature = '';
    render();
    if (marked) setStatus('已取消划线');
    else setStatus(state.selectedWord ? `已划线：${state.selectedWord}` : '已划线整句');
  }

  function studyRoot(keepNote) {
    if (!keepNote && document.querySelector('#coach-study .study-note')) endNote(true);
    let layer = document.getElementById('coach-study');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'coach-study';
      document.body.appendChild(layer);
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeStudy();
        const note = layer.querySelector('.study-note');
        if (note && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          note.dispatchEvent(new Event('submit'));
        }
      });
    }
    return layer;
  }

  function closeStudy() {
    const noting = Boolean(document.querySelector('#coach-study .study-note'));
    const saved = state.noteSaved;
    state.noteSaved = false;
    const layer = document.getElementById('coach-study');
    if (layer) layer.replaceChildren();
    if (!noting) return;
    const resume = endNote(true);
    if (!saved) setStatus(resume ? '继续播放' : '已留在这一句');
  }

  function anchorCard(card, prefer) {
    const seg = (prefer && document.querySelector(prefer))
      || document.querySelector('#transcript-list .seg.active .seg-tools')
      || document.querySelector('#transcript-list .seg.active')
      || document.querySelector('.coach-dock');
    const rect = seg ? seg.getBoundingClientRect() : { left: 24, top: 160, bottom: 220, width: 320 };
    const width = Math.min(prefer ? Math.max(280, rect.width || 360) : 360, window.innerWidth - 32);
    const height = card.offsetHeight || 240;
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 12) top = rect.top - height - 8;
    if (top < 12) top = 12;
    card.style.width = `${width}px`;
    card.style.left = `${Math.max(16, Math.min(window.innerWidth - width - 16, rect.left))}px`;
    card.style.top = `${top}px`;
    card.style.maxHeight = `${Math.max(180, window.innerHeight - top - 12)}px`;
  }

  function field(label, value) {
    const block = document.createElement('section');
    const title = document.createElement('p');
    title.className = 'study-label';
    title.textContent = label;
    const body = document.createElement('p');
    body.className = 'study-copy';
    body.textContent = value || '';
    block.append(title, body);
    return block;
  }

  async function lookup(row) {
    const word = state.selectedWord;
    const box = panel();
    box.hidden = false;
    box.replaceChildren();
    if (!word) {
      const tip = document.createElement('p');
      tip.textContent = '先点当前句里的一个单词，再查词。';
      box.appendChild(tip);
      return;
    }
    const pending = document.createElement('p');
    pending.textContent = `正在查 ${word}`;
    box.appendChild(pending);
    try {
      const response = await fetch(`/dictionary/${encodeURIComponent(word)}`, { headers: authHeaders() });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '查词失败');
      const entry = payload.entry || {};
      const assist = window.LinglishSentenceAssist;
      const gloss = assist ? assist.shortGloss(entry) : '';
      const phonetic = assist ? assist.phoneticOf(entry) : (entry.phonetic || '');
      box.replaceChildren();
      const title = document.createElement('p');
      title.textContent = word;
      if (phonetic) {
        const sound = document.createElement('span');
        sound.className = 'coach-phon';
        sound.textContent = ` ${phonetic}`;
        title.appendChild(sound);
      }
      const meaning = document.createElement('p');
      meaning.textContent = gloss || payload.wordTranslation || '词典里暂时没有这词的简短释义。';
      const sentence = document.createElement('p');
      sentence.textContent = `原句：${row.text}`;
      box.append(title, meaning, sentence);
    } catch (error) {
      pending.textContent = error.message || '查词失败';
    }
  }

  async function postCoaching(body) {
    const response = await fetch('/api/coaching/sentence', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 402) {
      const error = new Error(payload.message || '带教模式仅对会员和高级会员开放');
      error.upgrade = payload.upgrade_url || './pricing.html?from=coaching#plans';
      throw error;
    }
    if (!response.ok) throw new Error(payload.message || '带教请求失败');
    return payload;
  }

  function showUpgrade(message, href) {
    const box = panel();
    box.hidden = false;
    box.replaceChildren();
    const text = document.createElement('p');
    text.textContent = message;
    const link = document.createElement('a');
    link.href = href || './pricing.html?from=coaching#plans';
    link.textContent = '查看会员方案';
    box.append(text, link);
  }

  function localAnalysis(text) {
    const analyzer = window.LinglishSentenceAnalysis;
    return analyzer ? analyzer.analyze(text) : { original: text, simplified: text, trunk: text, keywords: [], parts: [], points: [] };
  }

  async function dictionaryGloss(word) {
    try {
      const response = await fetch(`/dictionary/${encodeURIComponent(word)}`, { headers: authHeaders() });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) return { en: '', zh: '' };
      const entry = payload.entry || {};
      const assist = window.LinglishSentenceAssist;
      const zh = assist ? assist.shortGloss(entry) : '';
      const meanings = Array.isArray(entry.meanings) ? entry.meanings : [];
      let en = '';
      for (let i = 0; i < meanings.length && !en; i += 1) {
        const defs = Array.isArray(meanings[i].definitions) ? meanings[i].definitions : [];
        en = String((defs[0] && defs[0].definition) || '').trim();
      }
      return { en, zh: zh && zh !== en ? zh : String(payload.wordTranslation || '').trim() };
    } catch (_) {
      return { en: '', zh: '' };
    }
  }

  async function explain(row) {
    const layer = studyRoot();
    layer.replaceChildren();
    const card = document.createElement('section');
    card.className = 'study-modal';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '讲解');
    const analysis = localAnalysis(row.text);
    let tab = 'simple';
    const head = document.createElement('div');
    head.className = 'study-head';
    const title = document.createElement('strong');
    title.textContent = '讲解';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'study-x';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    close.addEventListener('click', closeStudy);
    head.append(title, close);
    const tabs = document.createElement('div');
    tabs.className = 'study-tabs';
    const body = document.createElement('div');
    body.className = 'study-body';
    let meaningText = translationFor(row) || '先按简化版读一遍，再回到原句。';
    let explanationText = '';
    const keywordNodes = [];

    function paint() {
      tabs.replaceChildren();
      [
        ['simple', '简化版'],
        ['words', '重点'],
        ['structure', '结构拆解'],
      ].forEach(([id, label]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = id === tab ? 'is-on' : '';
        button.textContent = label;
        button.addEventListener('click', () => { tab = id; paint(); });
        tabs.appendChild(button);
      });
      body.replaceChildren();
      body.appendChild(field('原文', analysis.original));
      if (tab === 'simple') {
        const easy = document.createElement('section');
        easy.className = 'study-block';
        const badge = document.createElement('p');
        badge.className = 'study-badge';
        badge.textContent = '简化版';
        const line = document.createElement('p');
        line.className = 'study-copy';
        line.textContent = analysis.simplified || analysis.original;
        const sense = document.createElement('p');
        sense.className = 'study-label';
        sense.textContent = '句意';
        const meaning = document.createElement('p');
        meaning.className = 'study-copy';
        meaning.textContent = meaningText;
        easy.append(badge, line, sense, meaning);
        if (explanationText) {
          const extra = document.createElement('p');
          extra.className = 'study-copy';
          extra.textContent = explanationText;
          easy.appendChild(extra);
        }
        body.appendChild(easy);
      } else if (tab === 'words') {
        if (!keywordNodes.length) {
          const empty = document.createElement('p');
          empty.className = 'study-copy';
          empty.textContent = '这句里没有需要单独抽出的词。';
          body.appendChild(empty);
        }
        keywordNodes.forEach((node) => body.appendChild(node));
      } else {
        const trunk = document.createElement('section');
        trunk.className = 'study-block';
        const trunkLabel = document.createElement('p');
        trunkLabel.className = 'study-badge';
        trunkLabel.textContent = '主干';
        const trunkText = document.createElement('p');
        trunkText.className = 'study-trunk';
        trunkText.textContent = analysis.trunk || analysis.original;
        trunk.append(trunkLabel, trunkText);
        body.appendChild(trunk);
        if (analysis.parts.length) {
          const list = document.createElement('section');
          const label = document.createElement('p');
          label.className = 'study-badge';
          label.textContent = '拆解';
          const items = document.createElement('ul');
          items.className = 'study-parts';
          analysis.parts.forEach((part) => {
            const item = document.createElement('li');
            const en = document.createElement('strong');
            en.textContent = part.en;
            item.append(en, document.createTextNode(` — ${part.zh}`));
            items.appendChild(item);
          });
          list.append(label, items);
          body.appendChild(list);
        }
        const pointLabel = document.createElement('p');
        pointLabel.className = 'study-badge';
        pointLabel.textContent = '要点';
        const pointList = document.createElement('ul');
        pointList.className = 'study-points';
        analysis.points.forEach((point) => {
          const item = document.createElement('li');
          item.textContent = point;
          pointList.appendChild(item);
        });
        body.append(pointLabel, pointList);
      }
    }

    analysis.keywords.forEach((word) => {
      const block = document.createElement('section');
      block.className = 'study-word';
      const name = document.createElement('p');
      name.className = 'study-word-name';
      name.textContent = word;
      const en = document.createElement('p');
      en.className = 'study-copy';
      en.textContent = '正在查这个词…';
      const zh = document.createElement('p');
      zh.className = 'study-label';
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'study-add';
      add.textContent = '加入生词本';
      add.addEventListener('click', async () => {
        add.disabled = true;
        try {
          const response = await fetch('/vocabulary/v2/add', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ word, context: { sentence: row.text, video_id: state.videoId } }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.message || '加入失败');
          add.textContent = '已加入';
          setStatus(`${word} 已加入生词本`);
        } catch (error) {
          add.disabled = false;
          add.textContent = '加入生词本';
          setStatus(error.message || '加入生词本失败');
        }
      });
      block.append(name, en, zh, add);
      keywordNodes.push(block);
      dictionaryGloss(word).then((gloss) => {
        en.textContent = gloss.en || '先看它在这句里怎么用。';
        zh.textContent = gloss.zh || '';
      });
    });

    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'study-backdrop';
    backdrop.setAttribute('aria-label', '关闭讲解');
    backdrop.addEventListener('click', closeStudy);
    card.append(head, tabs, body);
    layer.append(backdrop, card);
    paint();
    setStatus('正在讲解这句');
    try {
      const payload = await postCoaching({
        action: 'explain',
        text: row.text,
        translation: translationFor(row),
        word: state.selectedWord,
      });
      if (payload.translation) rememberTranslation(row.index, payload.translation);
      const known = translationFor(row);
      meaningText = known || payload.explanation || '暂时没有这句的中文意思';
      explanationText = known && payload.explanation && payload.explanation !== known ? payload.explanation : '';
      if (tab === 'simple') paint();
    } catch (error) {
      if (!translationFor(row) && error.upgrade) meaningText = error.message || '讲解需要会员';
      if (tab === 'simple') paint();
    }
  }

  async function translate(row) {
    const layer = studyRoot();
    layer.replaceChildren();
    const card = document.createElement('section');
    card.className = 'study-pop';
    const head = document.createElement('div');
    head.className = 'study-head';
    const title = document.createElement('strong');
    title.textContent = '翻译';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'study-x';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    close.addEventListener('click', closeStudy);
    head.append(title, close);
    const original = field('原文', row.text);
    const translated = document.createElement('p');
    translated.className = 'study-copy';
    const known = translationFor(row);
    translated.textContent = known || '正在翻译…';
    const sense = document.createElement('section');
    const senseLabel = document.createElement('p');
    senseLabel.className = 'study-label';
    senseLabel.textContent = '译文';
    sense.append(senseLabel, translated);
    card.append(head, original, sense);
    layer.appendChild(card);
    anchorCard(card);
    if (known) {
      setStatus('已显示这句翻译');
      return;
    }
    try {
      const payload = await postCoaching({ action: 'translate', text: row.text });
      rememberTranslation(row.index, payload.translation);
      translated.textContent = payload.translation || '没有得到翻译';
      setStatus('翻译已放在这句下面');
    } catch (error) {
      if (error.upgrade) translated.textContent = error.message || '翻译需要会员';
      else translated.textContent = error.message || '翻译失败';
    }
  }

  function playBounds(bounds, job) {
    return new Promise((resolve) => {
      const transport = state.transport;
      if (!transport) {
        resolve('missing');
        return;
      }
      transport.seek(bounds.start + 0.01);
      transport.play();
      const started = Date.now();
      const limit = Math.min(20000, Math.max(2500, (bounds.end - bounds.start) * 1000 + 1200));
      const timer = window.setInterval(() => {
        if (!alive(job)) {
          window.clearInterval(timer);
          transport.pause();
          resolve('cancelled');
          return;
        }
        const time = transport.getCurrentTime();
        if (time >= bounds.end - 0.05 || Date.now() - started > limit) {
          window.clearInterval(timer);
          transport.pause();
          resolve('ended');
        }
      }, 80);
    });
  }

  async function readSentence(row) {
    const job = beginJob();
    state.phase = 'reading';
    setStatus('正在逐句朗读');
    const result = await playBounds({ start: row.start, end: row.end }, job);
    if (!alive(job)) return;
    state.phase = 'idle';
    setStatus(result === 'missing' ? '还不能控制播放器' : '这一句读完了');
  }

  function speakFallback(text) {
    if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    window.speechSynthesis.speak(utterance);
  }

  async function shadowSentence(row) {
    const job = beginJob();
    state.phase = 'reading';
    setStatus('先听原句，接着跟读');
    const played = await playBounds({ start: row.start, end: row.end }, job);
    if (!alive(job)) return;
    if (played === 'missing') {
      speakFallback(row.text);
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      state.phase = 'idle';
      setStatus('这个浏览器不能录音，请换一个再跟读');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) {
      state.phase = 'idle';
      setStatus('没有麦克风权限，无法跟读');
      return;
    }
    if (!alive(job)) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.addEventListener('dataavailable', (event) => { if (event.data && event.data.size) chunks.push(event.data); });
    const duration = Math.min(12000, Math.max(2000, (row.end - row.start) * 1000 + 700));
    state.phase = 'recording';
    setStatus('请跟读');
    const blob = await new Promise((resolve) => {
      recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })));
      recorder.start();
      window.setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, duration);
    });
    stream.getTracks().forEach((track) => track.stop());
    if (!alive(job)) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play().catch(() => {});
    setStatus('正在对比你的跟读');
    try {
      const dataUrl = await blobToDataUrl(blob);
      const response = await fetch('/pronunciation/assess', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          text: row.text,
          audio_data: dataUrl,
          video_id: state.videoId,
          fast_asr: true,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || '跟读评分失败');
      const score = payload.overall != null ? `跟读评分 ${payload.overall}` : '跟读已记录';
      const headline = payload.coaching && payload.coaching.headline ? ` · ${payload.coaching.headline}` : '';
      setStatus(score + headline);
      const box = panel();
      box.hidden = false;
      box.replaceChildren();
      const summary = document.createElement('p');
      summary.textContent = score + headline;
      box.appendChild(summary);
    } catch (error) {
      setStatus(error.message || '录音已保存，这次没能评分');
    } finally {
      if (alive(job)) state.phase = 'idle';
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function sync(frame) {
    applyFrame(frame || {});
  }

  function mount() {
    state.host = document.getElementById('video-wrapper') && document.getElementById('video-player')
      ? 'mobile'
      : (document.querySelector('.player') && document.getElementById('player') ? 'desktop' : '');
    if (!state.host || document.getElementById('coach-dock')) return;
    const store = storage();
    state.user = resolveUser(null);
    state.allowed = mode.canUseCoaching(state.user);
    state.open = state.allowed && store && store.getItem(ENABLED_KEY) === '1';
    ensureRoot();
    render();
    if (state.host === 'desktop') {
      window.setInterval(() => applyFrame(desktopFrame()), 250);
    }
    setStatus(state.allowed ? '带教模式已就绪' : '会员和高级会员可打开带教');
    new MutationObserver(() => render()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  window.LinglishCoachingDock = { sync, mount };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
