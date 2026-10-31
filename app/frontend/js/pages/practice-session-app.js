/**
 * Mobile practice-session: shadowing + real 实战场 dialogue.
 * Entry: practice-session.html?mode=dialogue|arena|shadowing&videoId=
 */
(function (root) {
  'use strict';

  const API_BASE = (root.location.hostname === 'localhost' || root.location.hostname === '127.0.0.1')
    ? ''
    : (root.API_BASE || '');

  const state = {
    mode: 'dialogue',
    video: null,
    sentences: [],
    index: 0,
    speakers: [],
    selectedSpeaker: '',
    segmentSpeakerMap: {},
    roleCount: 'auto',
    dialogueRunning: false,
    dialogueAwaitingHold: false,
    practicing: false,
    autoPause: true,
    loop: false,
    playerType: 'none',
    isRecording: false,
    mediaRecorder: null,
    recordChunks: [],
    lastRecordingUrl: '',
    youtubePlayer: null,
  };
  root.state = state;

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  function token() {
    try {
      return root.localStorage.getItem('linglish_token')
        || root.sessionStorage.getItem('linglish_token')
        || '';
    } catch (_) {
      return '';
    }
  }

  function headers() {
    const h = { Accept: 'application/json' };
    const value = token();
    if (value && value !== 'null' && value !== 'undefined') h.Authorization = 'Bearer ' + value;
    return h;
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(msg) {
    const nodes = [
      document.querySelector('#shadowing-status .status-text'),
      document.getElementById('status-text'),
      document.getElementById('practice-feedback'),
    ];
    nodes.forEach((el) => {
      if (el) el.textContent = String(msg || '');
    });
  }

  function videoEl() {
    return document.getElementById('practice-video');
  }

  function coerceSegments(raw) {
    let list = raw;
    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch (_) { list = []; }
    }
    if (!Array.isArray(list)) list = [];
    return list.map((seg, index) => ({
      index,
      text: String(seg.text || seg.transcript || '').trim(),
      translation: String(seg.translation || seg.cn || seg.zh || '').trim(),
      speaker: String(seg.speaker || seg.role || '').trim(),
      start: Number(seg.start_sec ?? seg.start ?? seg.startTime ?? 0),
      end: Number(seg.end_sec ?? seg.end ?? seg.endTime ?? 0),
    })).filter((seg) => seg.text);
  }

  function chosenRoleCount() {
    if (state.roleCount === 'auto') {
      const names = new Set();
      state.sentences.forEach((seg) => { if (seg.speaker) names.add(seg.speaker); });
      if (names.size >= 2) return Math.min(5, names.size);
      return state.sentences.length >= 30 ? 3 : 2;
    }
    const n = parseInt(state.roleCount, 10);
    return Number.isFinite(n) && n >= 2 && n <= 5 ? n : 2;
  }

  function buildSpeakers() {
    const segs = state.sentences;
    const k = chosenRoleCount();
    const freq = new Map();
    segs.forEach((seg) => {
      if (!seg.speaker) return;
      freq.set(seg.speaker, (freq.get(seg.speaker) || 0) + 1);
    });
    let speakers = [];
    if (freq.size >= 2) {
      const top = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, k).map(([n]) => n);
      speakers = top.map((name) => ({ speaker: name, lines: [] }));
      const indexOf = (n) => {
        const i = top.indexOf(n);
        return i >= 0 ? i : 0;
      };
      segs.forEach((seg, i) => {
        speakers[indexOf(seg.speaker || top[0])].lines.push(i);
      });
    } else {
      speakers = Array.from({ length: k }, (_, i) => ({ speaker: '角色 ' + (i + 1), lines: [] }));
      let cur = 0;
      let consec = 0;
      const qRe = /(\?|？|\b(who|what|when|where|why|how|can|do|are|is|will)\b)/i;
      let lastText = '';
      segs.forEach((seg, i) => {
        const text = seg.text || '';
        const switchTurn = (qRe.test(lastText) && text.length < 48) || consec >= 3;
        if (switchTurn) {
          cur = (cur + 1) % k;
          consec = 1;
        } else {
          consec += 1;
        }
        speakers[cur].lines.push(i);
        lastText = text;
      });
    }
    state.speakers = speakers;
    state.segmentSpeakerMap = {};
    speakers.forEach((sp) => {
      sp.lines.forEach((idx) => { state.segmentSpeakerMap[idx] = sp.speaker; });
    });
    if (!state.selectedSpeaker || !speakers.some((s) => s.speaker === state.selectedSpeaker)) {
      state.selectedSpeaker = speakers[0] ? speakers[0].speaker : '';
    }
    return speakers;
  }

  function speakerOf(index) {
    return state.segmentSpeakerMap[index] || (state.sentences[index] && state.sentences[index].speaker) || '';
  }

  function isMyLine(index) {
    if (state.mode !== 'dialogue' || !state.selectedSpeaker) return true;
    return speakerOf(index) === state.selectedSpeaker;
  }

  function currentSentence() {
    return state.sentences[state.index] || null;
  }

  function pauseCue() {
    const video = videoEl();
    if (video) {
      try { video.pause(); } catch (_) {}
    }
  }

  function seek(seconds) {
    const video = videoEl();
    if (!video) return;
    try { video.currentTime = Math.max(0, Number(seconds) || 0); } catch (_) {}
  }

  function playCue(index, force) {
    const seg = state.sentences[index];
    if (!seg) return;
    state.index = index;
    renderLines();
    renderCurrentLine();
    seek(seg.start);
    const video = videoEl();
    if (!video) return;
    const play = video.play();
    if (play && play.catch) play.catch(() => {});
    hideOverlay();
  }

  function hideOverlay() {
    const overlay = document.getElementById('play-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  function renderRoles() {
    const box = document.getElementById('role-buttons-container');
    const startSec = document.getElementById('start-dialogue-section');
    if (!box) return;
    if (state.mode !== 'dialogue' || !state.sentences.length) {
      box.innerHTML = '';
      if (startSec) startSec.style.display = 'none';
      return;
    }
    buildSpeakers();
    box.innerHTML = state.speakers.map((sp) => {
      const on = sp.speaker === state.selectedSpeaker ? ' selected' : '';
      return `<button type="button" class="role-button${on}" data-role="${escapeHtml(sp.speaker)}">`
        + `<span class="role-name">${escapeHtml(sp.speaker)}</span>`
        + `<span class="role-count">${sp.lines.length} 句</span>`
        + `</button>`;
    }).join('');
    if (startSec) startSec.style.display = state.selectedSpeaker ? 'block' : 'none';
  }

  function selectRole(name) {
    state.selectedSpeaker = String(name || '');
    state.dialogueRunning = false;
    state.dialogueAwaitingHold = false;
    renderRoles();
    renderLines();
    setStatus(state.selectedSpeaker
      ? ('你选了「' + state.selectedSpeaker + '」。点开始对话，对方自动播，轮到你就按住说。')
      : '先选一个角色');
  }

  function renderCurrentLine() {
    const box = document.getElementById('practice-current-line');
    const seg = currentSentence();
    if (!box) return;
    if (!seg) {
      box.innerHTML = '';
      return;
    }
    const sp = state.mode === 'dialogue' ? speakerOf(state.index) : '';
    const mine = state.mode === 'dialogue' && isMyLine(state.index);
    box.innerHTML = (sp ? `<div class="line-speaker">${escapeHtml(sp)}${mine ? ' · 你的台词' : ''}</div>` : '')
      + `<div class="line-text">${escapeHtml(seg.text)}</div>`
      + (seg.translation ? `<div class="line-translation">${escapeHtml(seg.translation)}</div>` : '');
  }

  function renderLines() {
    const list = document.getElementById('practice-line-list');
    if (!list) return;
    if (!state.sentences.length) {
      list.innerHTML = '<li class="line-item"><div class="line-text">还没有字幕</div></li>';
      renderCurrentLine();
      return;
    }
    if (state.mode === 'dialogue' && !Object.keys(state.segmentSpeakerMap).length) buildSpeakers();
    list.innerHTML = state.sentences.map((seg, index) => {
      const active = index === state.index ? ' current active' : '';
      let roleClass = '';
      let speakerHtml = '';
      if (state.mode === 'dialogue') {
        const sp = speakerOf(index);
        roleClass = (state.selectedSpeaker && sp === state.selectedSpeaker) ? ' my-role' : ' other-speaker';
        if (sp) speakerHtml = `<div class="line-speaker">${escapeHtml(sp)}</div>`;
      }
      return `<li class="line-item${active}${roleClass}" data-index="${index}">`
        + speakerHtml
        + `<div class="line-text">${escapeHtml(seg.text)}</div>`
        + (seg.translation ? `<div class="line-translation">${escapeHtml(seg.translation)}</div>` : '')
        + `</li>`;
    }).join('');
    const cur = list.querySelector('.line-item.current, .line-item.active');
    if (cur && cur.scrollIntoView) {
      try { cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {}
    }
    renderCurrentLine();
  }

  function switchPracticeMode(mode, options) {
    const next = (mode === 'dialogue' || mode === 'arena') ? 'dialogue' : 'shadowing';
    state.mode = next;
    state.dialogueRunning = false;
    state.dialogueAwaitingHold = false;
    state.practicing = next === 'shadowing' ? state.practicing : false;
    document.body.classList.toggle('dialogue-mode', next === 'dialogue');
    document.body.classList.toggle('shadowing-mode', next === 'shadowing');
    document.querySelectorAll('.mode-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.mode === next);
    });
    const shadowing = document.getElementById('shadowing-controls');
    const dialogue = document.getElementById('dialogue-controls');
    if (shadowing) shadowing.style.display = next === 'shadowing' ? '' : 'none';
    if (dialogue) dialogue.style.display = next === 'dialogue' ? '' : 'none';
    const onboardS = document.getElementById('onboarding-shadowing');
    const onboardD = document.getElementById('onboarding-dialogue');
    if (onboardS) onboardS.style.display = next === 'shadowing' ? '' : 'none';
    if (onboardD) onboardD.style.display = next === 'dialogue' ? '' : 'none';
    const hint = document.getElementById('mode-hint');
    if (hint) {
      hint.textContent = next === 'dialogue'
        ? '选角色后对方自动播，轮到你就按住说'
        : '听一句，停一下，再跟着说';
    }
    const startLabel = document.querySelector('#start-practice-btn .btn-text');
    if (startLabel) startLabel.textContent = next === 'dialogue' ? '开始对话' : '开始练习';
    if (next === 'dialogue') renderRoles();
    renderLines();
    syncFab();
    if (!(options && options.history === 'skip')) {
      try {
        const url = new URL(root.location.href);
        url.searchParams.set('mode', next);
        root.history.replaceState({}, '', url);
      } catch (_) {}
    }
    setStatus(next === 'dialogue' ? '选一个角色，再开始对话练习' : '点开始跟读，或点一句听原声');
  }
  root.switchPracticeMode = switchPracticeMode;

  function syncFab() {
    const fab = document.getElementById('fab-record-container');
    const startFab = document.getElementById('start-recording-fab');
    const show = state.mode === 'dialogue' && state.dialogueRunning && state.dialogueAwaitingHold;
    if (fab) fab.hidden = !show;
    if (startFab) startFab.hidden = !show;
    const practiceBox = document.getElementById('dialogue-practice-container');
    if (practiceBox) practiceBox.style.display = (state.mode === 'dialogue' && state.dialogueRunning) ? '' : 'none';
    const roleSec = document.getElementById('role-selection-section');
    if (roleSec && state.dialogueRunning) roleSec.style.display = 'none';
    else if (roleSec && state.mode === 'dialogue') roleSec.style.display = '';
  }

  function startDialoguePractice() {
    if (!state.sentences.length) {
      setStatus('还没有字幕，换一段视频试试');
      return;
    }
    if (!state.selectedSpeaker) {
      setStatus('先选一个角色');
      return;
    }
    state.practicing = true;
    state.dialogueRunning = true;
    state.dialogueAwaitingHold = false;
    state.autoPause = true;
    const selector = document.getElementById('practice-mode-selector');
    if (selector) {
      selector.classList.add('dialogue-practicing', 'collapsed');
      const collapseBtn = document.getElementById('mode-toggle-btn');
      if (collapseBtn) {
        collapseBtn.textContent = '展开';
        collapseBtn.setAttribute('aria-expanded', 'false');
      }
    }
    syncFab();
    runDialogueFrom(0);
  }

  function runDialogueFrom(index) {
    if (!state.dialogueRunning || state.mode !== 'dialogue') return;
    const i = Math.max(0, Math.min(state.sentences.length - 1, Number(index) || 0));
    state.index = i;
    renderLines();
    if (isMyLine(i)) {
      state.dialogueAwaitingHold = true;
      pauseCue();
      seek(state.sentences[i].start);
      syncFab();
      setStatus('轮到你（' + state.selectedSpeaker + '）。按住麦克风说这一句');
      return;
    }
    state.dialogueAwaitingHold = false;
    syncFab();
    playCue(i, true);
    setStatus('对方在说…听完自动下一句');
  }

  function advanceDialogueAfterPartner() {
    if (!state.dialogueRunning) return;
    const next = state.index + 1;
    if (next >= state.sentences.length) {
      state.dialogueRunning = false;
      state.dialogueAwaitingHold = false;
      pauseCue();
      syncFab();
      setStatus('这段对话练完了。可换角色再来。');
      return;
    }
    runDialogueFrom(next);
  }

  function advanceDialogueAfterMyTake() {
    if (!state.dialogueRunning) return;
    state.dialogueAwaitingHold = false;
    const next = state.index + 1;
    if (next >= state.sentences.length) {
      state.dialogueRunning = false;
      syncFab();
      setStatus('这段对话练完了。可换角色再来。');
      return;
    }
    runDialogueFrom(next);
  }

  function onTimeUpdate() {
    const video = videoEl();
    if (!video || !state.sentences.length) return;
    const t = video.currentTime || 0;
    const sentence = currentSentence();
    if (!sentence || !Number.isFinite(sentence.end) || sentence.end <= sentence.start) return;
    if (t < sentence.end - 0.08) return;
    if (state.mode === 'dialogue' && state.dialogueRunning && !isMyLine(state.index)) {
      pauseCue();
      advanceDialogueAfterPartner();
      return;
    }
    if (state.autoPause || state.practicing) {
      pauseCue();
      if (state.mode === 'shadowing') setStatus('这句听完了。跟读后点下一句。');
    }
  }

  async function startHoldRecord() {
    if (state.isRecording) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('这个浏览器不支持录音');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.recordChunks = [];
      const recorder = new MediaRecorder(stream);
      state.mediaRecorder = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) state.recordChunks.push(event.data);
      };
      recorder.onstop = () => {
        try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
        const blob = new Blob(state.recordChunks, { type: 'audio/webm' });
        if (state.lastRecordingUrl) {
          try { URL.revokeObjectURL(state.lastRecordingUrl); } catch (_) {}
        }
        state.lastRecordingUrl = URL.createObjectURL(blob);
        state.isRecording = false;
        const status = document.getElementById('dialogue-status');
        if (status) status.style.display = 'none';
        if (state.mode === 'dialogue' && state.dialogueRunning) {
          setTimeout(() => advanceDialogueAfterMyTake(), 200);
        } else {
          setStatus('录音完成');
        }
      };
      recorder.start();
      state.isRecording = true;
      const status = document.getElementById('dialogue-status');
      if (status) status.style.display = '';
      setStatus('正在录音…松手结束');
    } catch (err) {
      console.warn('[practice-mobile] mic failed', err);
      setStatus('打不开麦克风，请允许权限后再试');
    }
  }

  function endHoldRecord() {
    if (!state.isRecording || !state.mediaRecorder) return;
    try {
      if (state.mediaRecorder.state !== 'inactive') state.mediaRecorder.stop();
    } catch (_) {}
  }

  function absoluteUrl(src) {
    if (!src) return '';
    if (/^https?:\/\//i.test(src) || src.startsWith('blob:')) return src;
    return API_BASE + (src.startsWith('/') ? '' : '/') + src;
  }

  async function loadVideo(id) {
    const res = await fetch(API_BASE + '/video-resources/' + id, { headers: headers() });
    if (!res.ok) throw new Error('视频加载失败');
    const data = await res.json();
    const detail = data.video || data || {};
    state.video = detail;
    let segs = coerceSegments(detail.transcript_segments || detail.segments || []);
    if (!segs.length) {
      try {
        const trRes = await fetch(API_BASE + '/video-resources/' + id + '/transcript', { headers: headers() });
        if (trRes.ok) {
          const trData = await trRes.json().catch(() => ({}));
          segs = coerceSegments(trData.segments || trData.transcript_segments);
        }
      } catch (_) {}
    }
    // Prefer API speakers when available
    try {
      const spRes = await fetch(API_BASE + '/practice/speakers?videoId=' + encodeURIComponent(id), { headers: headers() });
      if (spRes.ok) {
        const spData = await spRes.json().catch(() => ({}));
        if (Array.isArray(spData.speakers) && spData.speakers.length >= 2) {
          state.speakers = spData.speakers.map((sp) => ({
            speaker: sp.speaker,
            lines: (sp.lines || []).map((line) => (line && line.index != null ? Number(line.index) : -1)).filter((n) => n >= 0),
          }));
          state.segmentSpeakerMap = {};
          state.speakers.forEach((sp) => {
            sp.lines.forEach((idx) => { state.segmentSpeakerMap[idx] = sp.speaker; });
          });
          // Align speaker labels onto sentences when possible
          segs.forEach((seg, i) => {
            if (state.segmentSpeakerMap[i]) seg.speaker = state.segmentSpeakerMap[i];
          });
        }
      }
    } catch (_) {}
    state.sentences = segs;
    state.index = 0;
    const src = detail.local_video_path || detail.video_url || detail.url || '';
    const video = videoEl();
    if (video && src) {
      video.src = absoluteUrl(src);
      video.load();
      state.playerType = 'local';
      hideOverlay();
    }
    if (state.mode === 'dialogue') renderRoles();
    renderLines();
    setStatus(segs.length
      ? (state.mode === 'dialogue' ? '选角色，开始对话练习' : '点一句听原声，或开始跟读')
      : '还没有字幕');
  }

  function wireHoldControls() {
    const bindHold = (el) => {
      if (!el || el.dataset.holdWired) return;
      el.dataset.holdWired = '1';
      const down = (event) => {
        event.preventDefault();
        startHoldRecord();
      };
      const up = (event) => {
        event.preventDefault();
        endHoldRecord();
      };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', () => {
        if (state.isRecording) endHoldRecord();
      });
      el.addEventListener('contextmenu', (event) => event.preventDefault());
    };
    bindHold(document.getElementById('fab-record-btn'));
    bindHold(document.getElementById('start-recording-fab'));
    document.getElementById('stop-recording-btn')?.addEventListener('click', endHoldRecord);
  }

  function wire() {
    const params = new URLSearchParams(root.location.search || '');
    // No video → pick from library with 实战场 study mode.
    if (!params.get('videoId') && params.get('source') !== 'external') {
      const study = /^(dialogue|arena)$/.test(params.get('mode') || '') ? 'arena' : 'coach';
      try {
        root.location.replace('./video-reader.html?study=' + study);
        return;
      } catch (_) {}
    }

    const bootMode = params.get('mode');
    switchPracticeMode((bootMode === 'shadowing' || bootMode === 'coach') ? 'shadowing' : 'dialogue', { history: 'skip' });

    // Theme chip + collapse for the mode header
    (function wireModeHeaderChrome() {
      const rootEl = document.documentElement;
      const themeBtn = document.getElementById('theme-toggle');
      const collapseBtn = document.getElementById('mode-toggle-btn');
      const selector = document.getElementById('practice-mode-selector');
      try {
        const saved = root.localStorage.getItem('linglish.theme');
        if (saved === 'dark' || saved === 'light') rootEl.setAttribute('data-theme', saved);
      } catch (_) {}
      themeBtn?.addEventListener('click', () => {
        const next = rootEl.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        rootEl.setAttribute('data-theme', next);
        try { root.localStorage.setItem('linglish.theme', next); } catch (_) {}
      });
      const syncCollapseLabel = () => {
        if (!collapseBtn || !selector) return;
        const collapsed = selector.classList.contains('collapsed');
        collapseBtn.textContent = collapsed ? '展开' : '收起';
        collapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      };
      collapseBtn?.addEventListener('click', () => {
        if (!selector) return;
        selector.classList.toggle('collapsed');
        syncCollapseLabel();
      });
      syncCollapseLabel();
    })();

    document.querySelectorAll('.mode-tab').forEach((tab) => {
      tab.addEventListener('click', () => switchPracticeMode(tab.dataset.mode));
    });
    document.getElementById('role-buttons-container')?.addEventListener('click', (event) => {
      const btn = event.target.closest('.role-button, [data-role]');
      if (!btn || !btn.dataset.role) return;
      selectRole(btn.dataset.role);
    });
    document.getElementById('start-dialogue-btn')?.addEventListener('click', startDialoguePractice);
    document.getElementById('start-practice-btn')?.addEventListener('click', () => {
      if (state.mode === 'dialogue') {
        if (!state.selectedSpeaker) {
          renderRoles();
          setStatus('先选一个角色');
          return;
        }
        startDialoguePractice();
        return;
      }
      state.practicing = true;
      state.autoPause = true;
      playCue(state.index, true);
      setStatus('跟读中：听完自动停，再说这一句');
    });
    document.getElementById('practice-line-list')?.addEventListener('click', (event) => {
      const item = event.target.closest('.line-item');
      if (!item || item.dataset.index == null) return;
      const index = Number(item.dataset.index);
      if (state.mode === 'dialogue' && state.dialogueRunning) {
        runDialogueFrom(index);
        return;
      }
      playCue(index, true);
    });
    document.getElementById('play-overlay')?.addEventListener('click', () => {
      if (state.sentences.length) playCue(state.index, true);
      else {
        const video = videoEl();
        if (video) video.play().catch(() => {});
        hideOverlay();
      }
    });
    document.getElementById('shadowing-next-btn')?.addEventListener('click', () => {
      playCue(Math.min(state.sentences.length - 1, state.index + 1), true);
    });
    document.getElementById('shadowing-replay-btn')?.addEventListener('click', () => {
      playCue(state.index, true);
    });
    document.getElementById('shadowing-start-btn')?.addEventListener('click', () => {
      state.practicing = true;
      state.autoPause = true;
      playCue(state.index, true);
    });
    document.getElementById('dialogue-original-btn')?.addEventListener('click', () => {
      playCue(state.index, true);
    });
    document.querySelectorAll('.speed-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const speed = Number(btn.dataset.speed);
        const video = videoEl();
        if (video && Number.isFinite(speed)) video.playbackRate = speed;
        document.querySelectorAll('.speed-btn').forEach((el) => el.classList.remove('active'));
        btn.classList.add('active');
      });
    });
    wireHoldControls();
    videoEl()?.addEventListener('timeupdate', onTimeUpdate);

    root.goBack = function goBack() {
      if (root.history.length > 1) root.history.back();
      else root.location.href = './mobile-arena.html';
    };

    const videoId = params.get('videoId') || '';
    if (/^\d+$/.test(videoId)) {
      loadVideo(videoId).catch((err) => {
        console.warn('[practice-mobile]', err);
        setStatus(err.message || '视频加载失败');
      });
    } else {
      setStatus('缺少视频，请从实战场重新选');
    }
  }

  ready(wire);
})(typeof window !== 'undefined' ? window : this);
