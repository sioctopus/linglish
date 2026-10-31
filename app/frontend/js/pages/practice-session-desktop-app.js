/**
 * Desktop AI coaching / arena bootstrap.
 * Loads the selected video, lists sentences, and steps through them.
 */
(function (root) {
  'use strict';

  const API_BASE = (root.location.hostname === 'localhost' || root.location.hostname === '127.0.0.1')
    ? ''
    : (root.API_BASE || '');

  const state = {
    mode: 'shadowing',
    video: null,
    sentences: [],
    index: 0,
    practicing: false,
    loop: false,
    autoPause: true,
    playerType: 'none',
    isRecording: false,
    shadowBusy: false,
    lastRecordingUrl: '',
    lastRecordingIndex: -1,
    activeShadowStop: null,
    previewAudio: null,
    // 实战场 / dialogue
    speakers: [],
    selectedSpeaker: '',
    segmentSpeakerMap: {},
    roleCount: 'auto',
    dialogueRunning: false,
    dialogueAwaitingHold: false,
    // 课后弱点练习
    lastAssessmentId: null,
    weaknessQueue: [],
    weaknessCursor: -1,
  };
  root.state = state;
  let voiceChat = null;
  let youtubePlayer = null;
  let focusController = null;

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

  function coerceSegments(raw) {
    let list = raw;
    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch (_) { list = []; }
    }
    if (!Array.isArray(list)) list = [];
    const mapped = list.map((seg, index) => ({
      index,
      text: String(seg.text || seg.transcript || '').trim(),
      translation: String(seg.translation || seg.cn || seg.zh || '').trim(),
      speaker: String(seg.speaker || seg.role || '').trim(),
      start: Number(seg.start_sec ?? seg.start ?? seg.startTime ?? 0),
      end: Number(seg.end_sec ?? seg.end ?? seg.endTime ?? 0),
    })).filter((seg) => seg.text);
    try {
      if (root.LinglishSentenceSegments && typeof root.LinglishSentenceSegments.toDisplayedSentences === 'function') {
        const next = root.LinglishSentenceSegments.toDisplayedSentences(mapped);
        if (Array.isArray(next) && next.length) {
          return next.map((seg, index) => ({
            index,
            text: String(seg.text || '').trim(),
            translation: String(seg.translation || seg.cn || seg.zh || '').trim(),
            speaker: String(seg.speaker || seg.role || (mapped[index] && mapped[index].speaker) || '').trim(),
            start: Number(seg.start_sec ?? seg.start ?? 0),
            end: Number(seg.end_sec ?? seg.end ?? 0),
          })).filter((seg) => seg.text);
        }
      }
    } catch (_) {}
    return mapped;
  }

  function chosenRoleCount() {
    if (state.roleCount === 'auto') {
      const names = new Set();
      state.sentences.forEach((seg) => {
        if (seg.speaker) names.add(seg.speaker);
      });
      if (names.size >= 2) return Math.min(5, names.size);
      return state.sentences.length >= 30 ? 3 : 2;
    }
    const n = parseInt(state.roleCount, 10);
    return Number.isFinite(n) && n >= 2 && n <= 5 ? n : 2;
  }

  /** Infer 2–N roles from transcript speakers or turn-taking heuristics. */
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
        const name = seg.speaker || top[0];
        speakers[indexOf(name)].lines.push(i);
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
        if (switchTurn) cur = (cur + 1) % k;
        if (switchTurn) consec = 1;
        else consec += 1;
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

  function nextDialogueIndex(from, direction) {
    const step = direction < 0 ? -1 : 1;
    let i = from + step;
    while (i >= 0 && i < state.sentences.length) {
      if (!state.dialogueRunning || isMyLine(i) || !state.selectedSpeaker) return i;
      // During dialogue run, auto-skip is handled elsewhere; nav still lands on any line.
      return i;
    }
    return from;
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
        + `<div class="role-head"><span class="role-icon">🎭</span></div>`
        + `<span class="role-name">${escapeHtml(sp.speaker)}</span>`
        + `<span class="role-meta">${sp.lines.length} 句</span>`
        + `</button>`;
    }).join('');
    if (startSec) startSec.style.display = state.selectedSpeaker ? 'block' : 'none';
    const name = document.getElementById('selected-role-name');
    if (name) name.textContent = state.selectedSpeaker || '选一个角色';
    const count = document.getElementById('role-preview-count');
    const mine = state.speakers.find((s) => s.speaker === state.selectedSpeaker);
    if (count) count.textContent = mine ? mine.lines.length + ' 句轮到你' : '';
    updateDialogueProgress();
  }

  function selectRole(name) {
    state.selectedSpeaker = String(name || '');
    state.dialogueRunning = false;
    state.dialogueAwaitingHold = false;
    renderRoles();
    renderLines();
    const startSec = document.getElementById('start-dialogue-section');
    if (startSec) startSec.style.display = state.selectedSpeaker ? '' : 'none';
    setStatus(state.selectedSpeaker
      ? ('你选了「' + state.selectedSpeaker + '」。点「开始对话练习」，对方台词自动播，轮到你就按住说。')
      : '先选一个角色');
  }

  function updateDialogueProgress() {
    const mine = state.speakers.find((s) => s.speaker === state.selectedSpeaker);
    const total = mine ? mine.lines.length : 0;
    const done = mine
      ? mine.lines.filter((idx) => idx < state.index || (idx === state.index && !state.dialogueAwaitingHold)).length
      : 0;
    const countEl = document.getElementById('progress-count');
    if (countEl) countEl.textContent = done + '/' + total;
    const fill = document.getElementById('dialogue-progress-fill');
    if (fill) fill.style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    const progress = document.getElementById('practice-progress-section');
    if (progress) progress.style.display = state.mode === 'dialogue' && state.selectedSpeaker ? '' : 'none';
  }

  function startDialoguePractice() {
    if (!state.sentences.length) {
      setStatus('还没有字幕。先提取字幕或换一段视频。');
      return;
    }
    if (!state.selectedSpeaker) {
      setStatus('先选一个角色，再开始对话');
      return;
    }
    state.practicing = true;
    state.dialogueRunning = true;
    state.dialogueAwaitingHold = false;
    state.autoPause = true;
    const setup = document.getElementById('dialogue-setup-container');
    if (setup) setup.classList.add('collapsed');
    syncVoiceChatVisibility();
    // Start from the first line; partner lines auto-play, your lines wait for Hold.
    runDialogueFrom(0);
  }

  function runDialogueFrom(index) {
    if (!state.dialogueRunning || state.mode !== 'dialogue') return;
    const i = Math.max(0, Math.min(state.sentences.length - 1, Number(index) || 0));
    state.index = i;
    renderLines();
    updateDialogueProgress();
    syncVoiceChatSeed(i);
    if (isMyLine(i)) {
      state.dialogueAwaitingHold = true;
      pauseCue();
      seek(state.sentences[i].start);
      syncCaptionFocus(state.sentences[i]);
      setStatus('轮到你（' + state.selectedSpeaker + '）。按住 Hold to record 说这一句');
      return;
    }
    state.dialogueAwaitingHold = false;
    playIndex(i, { forcePlay: true, skipVoiceChat: false });
    setStatus('对方在说…听完自动到下一句');
  }

  function advanceDialogueAfterPartner() {
    if (!state.dialogueRunning || state.mode !== 'dialogue') return;
    const next = state.index + 1;
    if (next >= state.sentences.length) {
      state.dialogueRunning = false;
      state.dialogueAwaitingHold = false;
      pauseCue();
      setStatus('这段对话练完了。可换角色再来一遍。');
      updateDialogueProgress();
      return;
    }
    runDialogueFrom(next);
  }

  function advanceDialogueAfterMyTake() {
    if (!state.dialogueRunning || state.mode !== 'dialogue') return;
    state.dialogueAwaitingHold = false;
    const next = state.index + 1;
    if (next >= state.sentences.length) {
      state.dialogueRunning = false;
      setStatus('这段对话练完了。可换角色再来一遍。');
      updateDialogueProgress();
      return;
    }
    runDialogueFrom(next);
  }

  function videoEl() {
    return document.getElementById('practice-video');
  }

  function overlayEl() {
    return document.getElementById('play-overlay');
  }

  function setOverlay(text) {
    const overlay = overlayEl();
    const title = document.getElementById('coach-empty-title');
    if (title && text) title.textContent = text;
    if (overlay) overlay.style.display = 'flex';
  }

  function clock(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const min = Math.floor(value / 60);
    const sec = String(value % 60).padStart(2, '0');
    return min + ':' + sec;
  }

  function hideOverlay() {
    const overlay = overlayEl();
    if (overlay) overlay.style.display = 'none';
  }

  function setStatus(text) {
    const el = document.querySelector('#shadowing-status .status-text');
    if (el) el.textContent = text;
    const hint = document.getElementById('practice-feedback');
    if (hint) hint.textContent = text;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('read audio failed'));
      reader.readAsDataURL(blob);
    });
  }

  function currentVideoId() {
    const id = state.video && (state.video.id || state.video.video_resource_id);
    return id != null && /^\d+$/.test(String(id)) ? String(id) : '';
  }

  function locateSentenceIndexByText(text) {
    const api = root.LinglishPronunciationProfileUI;
    if (api && typeof api.locateFocusSegment === 'function') {
      const match = api.locateFocusSegment(state.sentences, text);
      if (match && Number.isFinite(Number(match.index))) {
        const found = state.sentences.findIndex((seg, i) => {
          const segIndex = seg && seg.index != null ? seg.index : i;
          return segIndex === match.index;
        });
        if (found >= 0) return found;
      }
    }
    const needle = String(text || '').trim().toLowerCase();
    if (!needle) return -1;
    return state.sentences.findIndex((seg) => String(seg.text || '').trim().toLowerCase() === needle);
  }

  function showPronunciationFeedback(payload, index) {
    const panel = document.getElementById('pronunciation-feedback-panel');
    const body = document.getElementById('pronunciation-feedback-body');
    const actions = document.getElementById('pronunciation-weakness-actions');
    const retryBtn = document.getElementById('pronunciation-weakness-retry');
    const nextBtn = document.getElementById('pronunciation-weakness-next');
    if (!panel || !body) return;
    const assessment = (payload && payload.assessment) || payload || {};
    const coaching = assessment.coaching || payload.coaching || null;
    const skillUpdate = payload && payload.skill_update;
    const coachUi = root.LinglishPronunciationCoachUI;
    const profileUi = root.LinglishPronunciationProfileUI;
    body.innerHTML = '';
    let mounted = false;
    if (coachUi && typeof coachUi.mount === 'function' && coaching) {
      mounted = !!coachUi.mount(body, coaching, {
        impressionId: String(assessment.id || index || ''),
      });
    }
    if (profileUi && typeof profileUi.consumeSkillUpdate === 'function' && skillUpdate) {
      profileUi.consumeSkillUpdate(body, skillUpdate, {
        eventKey: String(assessment.id || index || Date.now()),
      });
      mounted = true;
    }
    const needsFocus = Array.isArray(skillUpdate && skillUpdate.needs_focus)
      ? skillUpdate.needs_focus.filter(Boolean)
      : [];
    const hasIssue = mounted && (
      needsFocus.length > 0
      || (coaching && Array.isArray(coaching.issues) && coaching.issues.length > 0)
      || (coaching && coaching.next_action && /retry/i.test(String(coaching.next_action.type || '')))
    );
    if (actions) {
      actions.hidden = !hasIssue;
      if (retryBtn) {
        retryBtn.dataset.index = String(Number.isFinite(Number(index)) ? index : state.index);
        retryBtn.hidden = !hasIssue;
      }
      if (nextBtn) nextBtn.hidden = true;
    }
    panel.hidden = !mounted;
    if (assessment.id != null) state.lastAssessmentId = assessment.id;
  }

  function jumpToWeaknessIndex(index, notice) {
    if (!Number.isFinite(Number(index)) || index < 0 || index >= state.sentences.length) {
      setStatus('暂时找不到这句弱点，请再选一句跟读');
      return;
    }
    state.index = Number(index);
    state.practicing = true;
    syncVoiceChatSeed(state.index);
    renderLines();
    playIndex(state.index);
    setStatus(notice || ('弱点练习 · 第 ' + (state.index + 1) + ' 句 · 按住 Hold 再练一次'));
    try {
      const panel = document.getElementById('pronunciation-feedback-panel');
      if (panel) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (_) {}
  }

  async function loadWeaknessQueueFromProfile() {
    const auth = token();
    if (!auth) return [];
    try {
      const res = await fetch(API_BASE + '/pronunciation/profile?limit=3', {
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return [];
      const items = Array.isArray(data.focus_items) ? data.focus_items : [];
      const videoId = currentVideoId();
      return items.filter((item) => {
        if (!item) return false;
        if (!videoId) return true;
        const itemVideo = item.video_resource_id != null ? String(item.video_resource_id) : '';
        return !itemVideo || itemVideo === videoId;
      });
    } catch (_) {
      return [];
    }
  }

  async function startWeaknessDrill({ preferIndex } = {}) {
    const queue = await loadWeaknessQueueFromProfile();
    state.weaknessQueue = queue;
    state.weaknessCursor = -1;
    const nextBtn = document.getElementById('pronunciation-weakness-next');
    if (nextBtn) nextBtn.hidden = queue.length < 2;

    if (Number.isFinite(Number(preferIndex)) && Number(preferIndex) >= 0) {
      jumpToWeaknessIndex(Number(preferIndex), '课后弱点练习 · 再按住 Hold 跟读这一句');
      return;
    }
    const first = queue[0];
    if (!first) {
      jumpToWeaknessIndex(state.index, '这句再练一遍 · 按住 Hold 跟读');
      return;
    }
    const idx = locateSentenceIndexByText(first.sample_text || '');
    state.weaknessCursor = 0;
    if (idx >= 0) jumpToWeaknessIndex(idx, '课后弱点练习 · ' + (first.display_target || '本句') + ' · 按住 Hold');
    else jumpToWeaknessIndex(state.index, '课后弱点练习 · 按住 Hold 再练这一句');
  }

  function advanceWeaknessQueue() {
    if (!state.weaknessQueue.length) {
      startWeaknessDrill();
      return;
    }
    state.weaknessCursor = Math.min(state.weaknessQueue.length - 1, Math.max(0, state.weaknessCursor) + 1);
    const item = state.weaknessQueue[state.weaknessCursor];
    if (!item) {
      setStatus('这组弱点已练完，可继续正常跟读');
      return;
    }
    const idx = locateSentenceIndexByText(item.sample_text || '');
    if (idx >= 0) jumpToWeaknessIndex(idx, '下一项弱点 · ' + (item.display_target || '') + ' · 按住 Hold');
    else setStatus('找不到该弱点对应句子，可换一句继续');
  }

  async function applyFocusAssessment(assessmentId) {
    const profileUi = root.LinglishPronunciationProfileUI;
    if (!profileUi || typeof profileUi.createFocusController !== 'function') return;
    const id = String(assessmentId || '').trim();
    if (!/^\d+$/.test(id)) return;
    focusController = profileUi.createFocusController({
      assessmentId: id,
      fetchFocus: async (focusId) => {
        const res = await fetch(API_BASE + '/pronunciation/assessments/' + encodeURIComponent(focusId) + '/focus', {
          headers: headers(),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || '无法加载发音重点');
        return data;
      },
      getLoadedVideoId: () => currentVideoId(),
      getSegments: () => state.sentences,
      apply: (position) => {
        const index = Number(position && position.arrayIndex);
        if (!Number.isFinite(index) || index < 0) return;
        jumpToWeaknessIndex(index, '已定位发音重点 · 按住 Hold 再练这一句');
        const seek = Number(position.seekTime);
        try {
          if (Number.isFinite(seek)) {
            if (state.playerType === 'youtube' && youtubePlayer && typeof youtubePlayer.seekTo === 'function') {
              youtubePlayer.seekTo(seek, true);
            } else {
              const video = videoEl();
              if (video) video.currentTime = seek;
            }
          }
        } catch (_) {}
      },
      feedback: (msg, kind) => {
        if (kind === 'success' || kind === 'info') setStatus(msg);
      },
    });
    try {
      focusController.markPlayerReady();
      focusController.markTranscriptReady();
    } catch (_) {}
  }

  function currentSentence() {
    return state.sentences[state.index] || null;
  }

  function syncStudy(sentence) {
    if (!sentence || !root.LinglishSubtitleStudy || typeof root.LinglishSubtitleStudy.show !== 'function') return;
    if (typeof root.LinglishSubtitleStudy.isArmed === 'function' && !root.LinglishSubtitleStudy.isArmed()) return;
    root.LinglishSubtitleStudy.show({
      text: sentence.text,
      translation: sentence.translation,
      onListen() { playIndex(state.index); },
    });
  }

  function syncExtractButton() {
    const btn = document.getElementById('sentence-extract');
    if (!btn) return;
    const hasVideo = Boolean(state.video && (state.video.id || state.video.youtube_video_id));
    btn.hidden = !(hasVideo && !state.sentences.length);
  }

  function syncStudyToggle() {
    const btn = document.getElementById('sentence-study-toggle');
    if (!btn || !root.LinglishSubtitleStudy || typeof root.LinglishSubtitleStudy.isArmed !== 'function') return;
    const on = root.LinglishSubtitleStudy.isArmed();
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('is-on', on);
  }

  function syncCaptionFocus(sentence) {
    const focus = document.getElementById('practice-caption-focus');
    const en = document.getElementById('practice-caption-en');
    const zh = document.getElementById('practice-caption-zh');
    const line = document.getElementById('practice-current-line');
    if (!state.sentences.length || !sentence) {
      if (focus) focus.classList.add('is-empty');
      if (en) en.textContent = '还没有可练的句子';
      if (zh) {
        zh.hidden = true;
        zh.textContent = '';
      }
      if (line) {
        line.hidden = true;
        line.textContent = '';
      }
      return;
    }
    if (focus) focus.classList.remove('is-empty');
    if (en) en.textContent = sentence.text || '';
    const translation = String(sentence.translation || sentence.cn || sentence.zh || '').trim();
    if (zh) {
      if (translation) {
        zh.hidden = false;
        zh.textContent = translation;
      } else {
        zh.hidden = true;
        zh.textContent = '';
      }
    }
    if (line) {
      line.hidden = false;
      line.textContent = sentence.text || '';
    }
  }

  function renderLines() {
    const list = document.getElementById('practice-line-list');
    if (!list) return;
    if (!state.sentences.length) {
      list.innerHTML = '<li class="line-item"><span class="line-text">还没有字幕。点下方「提取字幕」，或换一段视频。</span></li>';
      syncCaptionFocus(null);
      syncExtractButton();
      return;
    }
    if (state.mode === 'dialogue' && (!state.speakers.length || !Object.keys(state.segmentSpeakerMap).length)) {
      buildSpeakers();
    }
    const total = state.sentences.length;
    list.innerHTML = state.sentences.map((seg, index) => {
      const active = index === state.index ? ' active' : '';
      const start = clock(seg.start);
      const end = Number.isFinite(seg.end) && seg.end > seg.start ? clock(seg.end) : '';
      let roleClass = '';
      let speakerHtml = '';
      if (state.mode === 'dialogue') {
        const sp = speakerOf(index);
        const mine = state.selectedSpeaker && sp === state.selectedSpeaker;
        roleClass = mine ? ' my-role' : ' other-speaker';
        if (sp) speakerHtml = `<div class="line-speaker">${escapeHtml(sp)}</div>`;
      }
      return `<li class="line-item${active}${roleClass}" data-index="${index}" data-start="${seg.start}">
        <div class="practice-line-meta"><span>Line ${index + 1} of ${total}</span><span>${start}${end ? ' - ' + end : ''}</span></div>
        ${speakerHtml}
        <span class="line-text">${escapeHtml(seg.text)}</span>
        ${seg.translation ? `<span class="line-translation">${escapeHtml(seg.translation)}</span>` : ''}
      </li>`;
    }).join('');
    const current = list.querySelector('.line-item.active');
    if (current && current.scrollIntoView) current.scrollIntoView({ block: 'nearest' });
    const sentence = currentSentence();
    syncCaptionFocus(sentence);
    syncStudy(sentence);
    syncExtractButton();
    syncStudyToggle();
    updateDialogueProgress();
    if (voiceChat && (state.mode === 'shadowing' || state.mode === 'dialogue') && typeof voiceChat.render === 'function') {
      voiceChat.render();
    }
  }

  function seek(seconds) {
    const at = Math.max(0, Number(seconds) || 0);
    if (state.playerType === 'youtube' && youtubePlayer && typeof youtubePlayer.seekTo === 'function') {
      try { youtubePlayer.seekTo(at); } catch (_) {}
      return;
    }
    const video = videoEl();
    if (!video || state.playerType !== 'local') return;
    try { video.currentTime = at; } catch (_) {}
  }

  function stopPreviewAudio() {
    if (!state.previewAudio) return;
    try { state.previewAudio.pause(); } catch (_) {}
    state.previewAudio = null;
  }

  function syncHearButtons() {
    const has = Boolean(state.lastRecordingUrl);
    const hear = document.getElementById('sentence-hear-me');
    const compare = document.getElementById('sentence-compare');
    if (hear) hear.disabled = !has;
    if (compare) compare.disabled = !has;
    const shadow = document.getElementById('sentence-shadow');
    if (shadow) {
      if (state.mode === 'dialogue') {
        shadow.textContent = state.isRecording ? '完成录音' : '说这一句';
      } else if (voiceChat && typeof voiceChat.beginHold === 'function') {
        shadow.textContent = state.isRecording ? '松开结束' : '按住跟读';
      } else {
        shadow.textContent = state.isRecording ? '完成录音' : '跟读这一句';
      }
      shadow.classList.toggle('is-on', state.isRecording);
    }
  }

  function playBlobUrl(url) {
    stopPreviewAudio();
    const audio = new Audio(url);
    state.previewAudio = audio;
    return audio.play().then(() => new Promise((resolve) => {
      audio.onended = () => {
        if (state.previewAudio === audio) state.previewAudio = null;
        resolve(true);
      };
      audio.onerror = () => {
        if (state.previewAudio === audio) state.previewAudio = null;
        resolve(false);
      };
    })).catch(() => false);
  }

  function playbackTime() {
    if (state.playerType === 'youtube' && youtubePlayer && typeof youtubePlayer.getCurrentTime === 'function') {
      try { return Number(youtubePlayer.getCurrentTime()) || 0; } catch (_) { return 0; }
    }
    const video = videoEl();
    return video ? Number(video.currentTime) || 0 : 0;
  }

  function isMediaPlaying() {
    if (state.playerType === 'youtube' && youtubePlayer) {
      try {
        if (typeof youtubePlayer.isPlaying === 'function') return !!youtubePlayer.isPlaying();
        return youtubePlayer.getPlayerState && youtubePlayer.getPlayerState() === 1;
      } catch (_) { return false; }
    }
    const video = videoEl();
    return Boolean(video && !video.paused);
  }

  function waitForSentenceEnd(sentence) {
    if (!sentence) return Promise.resolve('missing');
    if (state.playerType !== 'local' && state.playerType !== 'youtube') return Promise.resolve('missing');
    return new Promise((resolve) => {
      const end = Number(sentence.end);
      const limit = Math.min(20000, Math.max(2500, ((Number.isFinite(end) ? end - sentence.start : 3) * 1000) + 1200));
      const started = Date.now();
      const tick = () => {
        if (!state.shadowBusy) {
          window.clearInterval(timer);
          resolve('cancelled');
          return;
        }
        if ((Number.isFinite(end) && playbackTime() >= end - 0.08) || Date.now() - started > limit) {
          window.clearInterval(timer);
          pauseCue();
          resolve('ended');
        }
      };
      const timer = window.setInterval(tick, 80);
      tick();
    });
  }

  function isCuePlaying(index) {
    const sentence = state.sentences[Number(index)];
    if (!sentence || !isMediaPlaying()) return false;
    if (state.playerType !== 'local' && state.playerType !== 'youtube') return false;
    const start = Number(sentence.start);
    const end = Number(sentence.end);
    const t = playbackTime();
    const endAt = Number.isFinite(end) && end > start ? end : start + 8;
    return Number.isFinite(t) && t >= start - 0.35 && t <= endAt + 0.25;
  }

  function pauseCue() {
    if (state.playerType === 'youtube' && youtubePlayer) {
      try { youtubePlayer.pause(); } catch (_) {}
      return;
    }
    const video = videoEl();
    if (video) {
      try { video.pause(); } catch (_) {}
    }
  }

  function destroyYoutubePlayer() {
    if (youtubePlayer) {
      try { youtubePlayer.destroy(); } catch (_) {}
      youtubePlayer = null;
    }
  }

  async function playYoutube(youtubeId) {
    destroyYoutubePlayer();
    const box = document.getElementById('youtube-player-container');
    const video = videoEl();
    if (video) {
      try { video.pause(); } catch (_) {}
      video.removeAttribute('src');
      video.style.display = 'none';
    }
    if (!box) throw new Error('找不到 YouTube 容器');
    const Player = root.YouTubePlayer || root.YouTubePlayerAPI;
    if (typeof Player !== 'function') throw new Error('YouTube 播放器未加载，请刷新页面');
    try { root.YouTubePlayer = Player; } catch (_) {}
    box.style.display = 'block';
    box.innerHTML = '<div id="practice-youtube-player" style="width:100%;height:100%;"></div>';
    youtubePlayer = new Player('practice-youtube-player');
    await youtubePlayer.init(String(youtubeId), {
      playerVars: {
        rel: 0,
        modestbranding: 1,
        controls: 1,
        playsinline: 1,
      },
    });
    state.playerType = 'youtube';
    if (typeof youtubePlayer.on === 'function') {
      youtubePlayer.on('timeupdate', onPlaybackTimeUpdate);
    }
  }

  function syncVoiceChatSeed(index) {
    if (!voiceChat) return;
    if (state.mode !== 'shadowing' && state.mode !== 'dialogue') return;
    const idx = Number.isFinite(Number(index)) ? Number(index) : state.index;
    // Desktop: never dump the full chat transcript under Hold — right rail is the list.
    if (typeof voiceChat.lockPracticeTarget === 'function') {
      try { voiceChat.lockPracticeTarget(idx, { silent: true, skipSeed: true }); } catch (_) {}
    }
  }

  function paintDesktopCaptionKaraoke(detail) {
    const en = document.getElementById('practice-caption-en');
    if (!en) return;
    const sentence = currentSentence();
    if (!detail || !detail.holding) {
      en.classList.remove('is-karaoke');
      en.textContent = (sentence && sentence.text) || en.textContent || '';
      return;
    }
    const html = detail.html
      || (root.LinglishVoiceChatCoach && typeof root.LinglishVoiceChatCoach.karaokeEnHtml === 'function'
        ? root.LinglishVoiceChatCoach.karaokeEnHtml(detail.text || '', detail.hitCount || 0, detail.partial || 0)
        : '');
    if (!html) return;
    en.classList.add('is-karaoke');
    en.innerHTML = html;
  }

  function playIndex(index, options) {
    if (!state.sentences.length) {
      setStatus('还没有字幕。点「提取字幕」后再练。');
      syncExtractButton();
      return;
    }
    const next = Math.max(0, Math.min(state.sentences.length - 1, Number(index) || 0));
    // Same cue already playing → pause (matches mobile tap-to-toggle).
    if (!(options && options.forcePlay) && isCuePlaying(next)) {
      state.index = next;
      pauseCue();
      renderLines();
      if (!(options && options.skipVoiceChat)) syncVoiceChatSeed(next);
      setStatus('已暂停 · 再点一句继续听，或按住 Hold to record 跟读');
      return;
    }
    if (!state.loop) {
      state.autoPause = true;
      const pause = document.getElementById('coach-autopause');
      if (pause) pause.setAttribute('aria-pressed', 'true');
    }
    state.index = next;
    renderLines();
    const sentence = currentSentence();
    if (!sentence) return;
    seek(sentence.start);
    const video = videoEl();
    if (video && state.playerType === 'local') {
      const play = video.play();
      if (play && play.catch) play.catch(() => {});
      hideOverlay();
    } else if (state.playerType === 'youtube' && youtubePlayer) {
      try { youtubePlayer.play(); } catch (_) {}
      hideOverlay();
    }
    if (!(options && options.skipVoiceChat)) syncVoiceChatSeed(state.index);
    if (state.loop) {
      setStatus('重复播放这一句 · 再点一次「重复播放」停止');
      return;
    }
    if (state.mode === 'dialogue' && state.dialogueRunning) {
      setStatus(isMyLine(state.index)
        ? ('轮到你（' + state.selectedSpeaker + '）。按住 Hold to record 说这一句')
        : '对方在说…听完自动到下一句');
      return;
    }
    setStatus(state.mode === 'dialogue'
      ? '选角色后点开始对话练习'
      : '点字幕听原声 · 按住 Hold to record 开麦跟读');
  }

  function syncVoiceChatVisibility() {
    const host = document.getElementById('voice-chat-coach');
    const path = document.getElementById('sentence-path');
    const show = !!voiceChat && (
      state.mode === 'shadowing'
      || (state.mode === 'dialogue' && state.practicing && !!state.selectedSpeaker)
    );
    document.body.classList.toggle('has-voice-chat', show);
    if (host) host.hidden = !show;
    // Caption + Hold only. Hide the old multi-button chat chrome.
    if (path) path.hidden = true;
    const hold = host && host.querySelector('[data-vc-hold]');
    if (hold && show && !hold.classList.contains('is-holding')) {
      const label = hold.querySelector('[data-hold-label]') || hold.querySelector('.mobile-hold-main');
      // Hold is the mic — one control for open-mic + record.
      if (label) label.textContent = 'Hold to record';
      else if (!hold.classList.contains('x-dm-hold')) hold.textContent = 'Hold to record';
      hold.setAttribute('aria-label', state.mode === 'dialogue' ? '按住说你的台词' : '按住开麦跟读');
      hold.setAttribute('title', '按住开麦（系统默认麦克风）');
    }
  }

  function mountVoiceChat() {
    const host = document.getElementById('voice-chat-coach');
    if (!host || !root.LinglishVoiceChatCoach || typeof root.LinglishVoiceChatCoach.create !== 'function') {
      return;
    }
    if (voiceChat) return;
    voiceChat = root.LinglishVoiceChatCoach.create({
      host,
      xUi: true,
      silent: true,
      // Focused X DM: current cue + my voice takes (same bubbles as mobile session).
      holdOnly: true,
      autoAdvance: false,
      autoPreview: false,
      getSentences: () => state.sentences,
      getIndex: () => state.index,
      setIndex: (index) => {
        if (state.index === index) return;
        state.index = index;
        renderLines();
      },
      // Always OS default input (wired / BT / headset — whatever Windows is using).
      getMicDeviceId: () => '',
      isPlayingOriginal: (index) => isCuePlaying(index),
      pauseOriginal: () => pauseCue(),
      playOriginal: async (index) => {
        playIndex(index, { skipVoiceChat: true, forcePlay: false });
        // Don't block UI for the whole cue — karaoke / next taps stay responsive.
      },
      onHoldStart: () => {
        state.isRecording = true;
        syncHearButtons();
        setStatus('开麦跟读中 · 说对的词会变蓝');
      },
      onHoldEnd: () => {
        state.isRecording = false;
        syncHearButtons();
        paintDesktopCaptionKaraoke({ holding: false });
        if (state.mode === 'dialogue' && state.dialogueRunning && state.dialogueAwaitingHold) {
          // Advance after the user finishes their take.
          setTimeout(() => {
            try { advanceDialogueAfterMyTake(); } catch (_) {}
          }, 280);
        } else {
          setStatus(state.mode === 'dialogue'
            ? '说完了。听不清可再按住重说，或点下一句。'
            : '跟读结束 · 点下一句继续，或再按住重说');
        }
      },
      onLiveMatch: (info) => {
        try { paintDesktopCaptionKaraoke(info || {}); } catch (_) {}
      },
      onOpenSubtitleList: (index) => {
        const panel = document.querySelector('.practice-right');
        const list = document.getElementById('practice-line-list');
        if (panel) {
          panel.classList.add('is-subtitle-pick');
          window.clearTimeout(panel._pickTimer);
          panel._pickTimer = window.setTimeout(() => panel.classList.remove('is-subtitle-pick'), 2600);
        }
        if (list) {
          const item = list.querySelector('.line-item[data-index="' + index + '"]')
            || list.querySelector('.line-item.active');
          if (item && item.scrollIntoView) item.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        setStatus('右侧字幕已高亮。点任意一句，就能回到陪练继续跟读');
      },
      onRecorded: async ({ blob, index }) => {
        state.lastRecordingIndex = index;
        if (state.lastRecordingUrl) {
          try { URL.revokeObjectURL(state.lastRecordingUrl); } catch (_) {}
        }
        state.lastRecordingUrl = URL.createObjectURL(blob);
        syncHearButtons();
        const auth = token();
        if (!auth) return null;
        try {
          const text = (state.sentences[index] && state.sentences[index].text) || '';
          const audioData = await blobToDataUrl(blob);
          const profileUi = root.LinglishPronunciationProfileUI;
          const body = profileUi && typeof profileUi.buildPronunciationAssessmentPayload === 'function'
            ? profileUi.buildPronunciationAssessmentPayload({
              text,
              audioData,
              videoId: currentVideoId(),
            })
            : {
              text,
              audio_data: audioData,
              language: 'en',
              video_id: currentVideoId() || undefined,
            };
          body.language = body.language || 'en';
          body.fast_asr = true;
          const res = await fetch(API_BASE + '/pronunciation/assess', {
            method: 'POST',
            headers: Object.assign({
              Authorization: 'Bearer ' + auth,
              'Content-Type': 'application/json',
            }, headers()),
            body: JSON.stringify(body),
          });
          const data = await res.json().catch(() => ({}));
          if (res.status === 402) {
            setStatus(data.message || data.paywall?.message || '今日发音评测次数已用完');
            return null;
          }
          if (!res.ok) {
            setStatus(data.message || '跟读评分失败，仍可听自己 / 再按住重说');
            return null;
          }
          const assessment = data.assessment || data;
          const score = assessment.overall != null ? Math.round(Number(assessment.overall))
            : (data.overall != null ? Math.round(Number(data.overall)) : null);
          const headline = assessment.coaching && assessment.coaching.headline
            ? (' · ' + assessment.coaching.headline)
            : '';
          if (score != null) setStatus('本句跟读评分 ' + score + headline);
          else setStatus('跟读已记录' + headline);
          showPronunciationFeedback(data, index);
          return score != null ? { score } : null;
        } catch (_) {
          setStatus('评分暂时不可用，录音已保存，可听自己或再练');
          return null;
        }
      },
      onTurnComplete: () => {
        setStatus('可点下一句继续，或再按住 Hold to record');
      },
    });
    syncVoiceChatVisibility();
    if (state.sentences.length) syncVoiceChatSeed(state.index);
  }

  async function startShadowTake() {
    const mic = root.LinglishShadowMic;
    if (state.isRecording && typeof state.activeShadowStop === 'function') {
      setStatus('正在结束录音…');
      state.activeShadowStop();
      return;
    }
    if (state.shadowBusy) return;
    if (!state.sentences.length) {
      setStatus('还没有字幕。先点「提取字幕」。');
      return;
    }
    if (!mic || typeof mic.recordShadow !== 'function') {
      setStatus('跟读录音组件还没加载，请刷新后再试');
      return;
    }
    switchPracticeMode('shadowing');
    state.practicing = true;
    state.autoPause = true;
    state.loop = false;
    const pause = document.getElementById('coach-autopause');
    if (pause) pause.setAttribute('aria-pressed', 'true');
    const loopBtn = document.getElementById('coach-loop');
    if (loopBtn) loopBtn.setAttribute('aria-pressed', 'false');
    const reviewBtn = document.getElementById('sentence-review');
    if (reviewBtn) reviewBtn.classList.remove('is-on');

    state.shadowBusy = true;
    stopPreviewAudio();
    const sentence = currentSentence();

    // Open mic first so mobile Safari still has the tap gesture.
    let stream = null;
    try {
      setStatus('正在打开麦克风…');
      stream = await mic.acquireMic();
    } catch (error) {
      state.shadowBusy = false;
      syncHearButtons();
      const code = error && error.code;
      if (code === 'MICROPHONE_DENIED') setStatus('没有麦克风权限，请在浏览器里允许麦克风');
      else if (code === 'MICROPHONE_INSECURE') setStatus('当前页面不是安全连接，无法开麦');
      else setStatus('打不开麦克风，请换 Chrome / Safari 再试');
      return;
    }

    playIndex(state.index);
    setStatus('先听原声，接着跟读');
    await waitForSentenceEnd(sentence);
    if (!state.shadowBusy) {
      try { mic.stopTracks(stream); } catch (_) {}
      return;
    }

    state.isRecording = true;
    syncHearButtons();
    setStatus('请跟读 · 说完再点「完成录音」');
    let captured = null;
    try {
      captured = await mic.recordShadow({
        stream,
        releaseStream: true,
        maxDurationMs: mic.recordingDurationMs(sentence),
        onReady(handle) {
          state.activeShadowStop = handle && handle.stop;
          try {
            if (root.LinglishAudioCues && typeof root.LinglishAudioCues.playMicReadyCue === 'function') {
              root.LinglishAudioCues.playMicReadyCue();
            }
          } catch (_) {}
        },
      });
    } catch (error) {
      try { mic.stopTracks(stream); } catch (_) {}
      state.isRecording = false;
      state.activeShadowStop = null;
      state.shadowBusy = false;
      syncHearButtons();
      const code = error && error.code;
      if (code === 'MICROPHONE_DENIED') setStatus('没有麦克风权限，请在浏览器里允许麦克风');
      else if (code === 'EMPTY_RECORDING') setStatus('没录到有效声音，请靠近麦克风再跟读一次');
      else if (code === 'RECORDING_UNAVAILABLE') setStatus('这个浏览器不能录音，请换 Chrome / Edge 再试');
      else setStatus((error && error.message) || '录音失败，请再试一次');
      return;
    } finally {
      state.isRecording = false;
      state.activeShadowStop = null;
      syncHearButtons();
    }

    state.shadowBusy = false;
    if (!captured || !captured.blob) {
      setStatus('录音已取消');
      return;
    }
    if (state.lastRecordingUrl) {
      try { URL.revokeObjectURL(state.lastRecordingUrl); } catch (_) {}
    }
    state.lastRecordingUrl = URL.createObjectURL(captured.blob);
    state.lastRecordingIndex = state.index;
    syncHearButtons();
    setStatus('正在预听你的跟读');
    const ok = await playBlobUrl(state.lastRecordingUrl);
    setStatus(ok
      ? '可点「听自己」再听，或点「对比」听原声→自己'
      : '录音已保存 · 点「听自己」或「对比」');
  }

  async function hearMyRecording() {
    if (!state.lastRecordingUrl) {
      setStatus('先跟读一句，再听自己的声音');
      return;
    }
    setStatus('正在播放你的跟读');
    const ok = await playBlobUrl(state.lastRecordingUrl);
    setStatus(ok
      ? '可再点「听自己」，或点「对比」对照原声'
      : '预听失败，请再点「听自己」');
  }

  async function compareRecording() {
    if (!state.lastRecordingUrl) {
      setStatus('先跟读一句，再对比原声');
      return;
    }
    const sentence = state.sentences[state.lastRecordingIndex] || currentSentence();
    stopPreviewAudio();
    if (sentence) {
      setStatus('对比：先听原声');
      state.shadowBusy = true;
      playIndex(state.lastRecordingIndex >= 0 ? state.lastRecordingIndex : state.index);
      await waitForSentenceEnd(sentence);
      state.shadowBusy = false;
    }
    setStatus('对比：再听你的跟读');
    const ok = await playBlobUrl(state.lastRecordingUrl);
    setStatus(ok
      ? '对比结束 · 可再点「对比」，或继续下一句'
      : '你的录音播不了，请再跟读一次');
  }

  function togglePlayback() {
    if (state.playerType === 'youtube') {
      if (isMediaPlaying()) {
        pauseCue();
        const playBtn = document.getElementById('focus-play-btn');
        if (playBtn) playBtn.textContent = '重复播放';
        setStatus('已停止。要再听点「重复播放」，继续下一段点「下一句」。');
      } else {
        playIndex(state.index, { forcePlay: true });
        const playBtn = document.getElementById('focus-play-btn');
        if (playBtn) playBtn.textContent = '停止';
      }
      return;
    }
    const video = videoEl();
    if (!video || state.playerType !== 'local') {
      playIndex(state.index);
      return;
    }
    if (video.paused) {
      playIndex(state.index, { forcePlay: true });
      const playBtn = document.getElementById('focus-play-btn');
      if (playBtn) playBtn.textContent = '停止';
    } else {
      video.pause();
      const playBtn = document.getElementById('focus-play-btn');
      if (playBtn) playBtn.textContent = '重复播放';
      setStatus('已停止。要再听点「重复播放」，继续下一段点「下一句」。');
    }
  }

  function rememberPracticeVideo(detail, seconds) {
    const id = detail && detail.id;
    if (!/^\d+$/.test(String(id || ''))) return;
    root.LinglishStudyVideoId = String(id);
    const api = root.LinglishStudyRecent;
    if (!api) return;
    const prev = api.get(id) || {};
    const duration = videoEl() && Number.isFinite(videoEl().duration) ? videoEl().duration : 0;
    const played = Number.isFinite(Number(seconds)) ? Number(seconds) : Number(prev.seconds || 0);
    const percent = duration > 0 ? Math.round((played / duration) * 100) : Number(prev.percent || 0);
    api.record({
      id: String(id),
      title: detail.title || detail.original_filename || ('视频 ' + id),
      thumb: detail.thumbnail_path || detail.thumbnail || prev.thumb || '',
      seconds: played,
      percent,
    });
  }

  function seekRemembered(id) {
    const api = root.LinglishStudyRecent;
    const video = videoEl();
    const prev = api && api.get(id);
    if (!video || !prev || !(Number(prev.seconds) > 1)) return;
    const apply = () => {
      try { video.currentTime = Number(prev.seconds); } catch (_) {}
    };
    if (video.readyState >= 1) apply();
    else video.addEventListener('loadedmetadata', apply, { once: true });
  }

  function onPlaybackTimeUpdate() {
    if (state.playerType !== 'local' && state.playerType !== 'youtube') return;
    const t = playbackTime();
    let duration = 0;
    if (state.playerType === 'local') {
      const video = videoEl();
      duration = video && Number.isFinite(video.duration) ? video.duration : 0;
    } else if (youtubePlayer && typeof youtubePlayer.getDuration === 'function') {
      try { duration = Number(youtubePlayer.getDuration()) || 0; } catch (_) { duration = 0; }
    }
    if (state.video && state.video.id && root.LinglishStudyRecent) {
      const now = Date.now();
      if (!state.recentAt || now - state.recentAt > 5000) {
        state.recentAt = now;
        const percent = duration > 0 ? Math.round((t / duration) * 100) : undefined;
        root.LinglishStudyRecent.touch(state.video.id, { seconds: t, percent });
      }
    }
    const cur = document.getElementById('coach-time-cur');
    const tot = document.getElementById('coach-time-tot');
    if (cur) cur.textContent = clock(t);
    if (tot && duration > 0) tot.textContent = clock(duration);
    const sentence = currentSentence();
    if (!sentence || !Number.isFinite(sentence.end) || sentence.end <= sentence.start) return;
    if (!state.autoPause && !state.loop && !state.practicing) return;
    if (t >= sentence.end - 0.08) {
      if (state.loop) {
        seek(sentence.start);
        if (state.playerType === 'youtube' && youtubePlayer) {
          try { youtubePlayer.play(); } catch (_) {}
        } else {
          const video = videoEl();
          if (video) video.play().catch(() => {});
        }
        return;
      }
      if (state.mode === 'dialogue' && state.dialogueRunning && !isMyLine(state.index)) {
        pauseCue();
        advanceDialogueAfterPartner();
        return;
      }
      if (state.autoPause || state.practicing) {
        pauseCue();
        const playBtn = document.getElementById('focus-play-btn');
        if (playBtn) playBtn.textContent = '重复播放';
        setStatus(state.mode === 'dialogue'
          ? (state.dialogueAwaitingHold
            ? '轮到你了。按住 Hold to record 说这一句'
            : '这句说完了。再听点「重复播放」，继续点「下一句」。')
          : '这句听完了。再听点「重复播放」，继续下一段点「下一句」。');
      }
    }
  }

  function onTimeUpdate() {
    onPlaybackTimeUpdate();
  }

  function switchPracticeMode(mode, options) {
    const next = (mode === 'dialogue' || mode === 'arena') ? 'dialogue' : 'shadowing';
    state.mode = next;
    state.dialogueRunning = false;
    state.dialogueAwaitingHold = false;
    if (next === 'dialogue') state.practicing = false;
    root.currentPracticeMode = next;
    document.body.classList.toggle('mode-shadowing', next === 'shadowing');
    document.body.classList.toggle('mode-dialogue', next === 'dialogue');
    document.title = (next === 'dialogue' ? '对话练习' : '跟读练习') + '（桌面版） Linglish';
    document.querySelectorAll('.mode-tab').forEach((tab) => {
      const on = tab.dataset.mode === next;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const study = document.getElementById('study-switch');
    if (study) {
      const key = next === 'dialogue' ? 'arena' : 'coach';
      study.querySelectorAll('[data-study]').forEach((link) => {
        if (link.dataset.study === key) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
    }
    const shadowing = document.getElementById('shadowing-controls');
    const dialogue = document.getElementById('dialogue-controls');
    if (shadowing) shadowing.style.display = next === 'shadowing' ? '' : 'none';
    if (dialogue) dialogue.style.display = next === 'dialogue' ? '' : 'none';
    const setup = document.getElementById('dialogue-setup-container');
    if (setup && next === 'dialogue') setup.classList.remove('collapsed');
    const startLabel = document.querySelector('#start-practice-btn .btn-text');
    if (startLabel && !document.getElementById('start-practice-btn')?.hidden) {
      startLabel.textContent = next === 'dialogue' ? '开始对话' : '开始跟读';
    }
    const hint = document.getElementById('mode-top-hint');
    if (hint) {
      hint.textContent = next === 'dialogue'
        ? '实战场：选角色 → 对方自动播 → 轮到你按住说'
        : '跟读：点字幕听原声，按住 Hold to record 开麦';
    }
    syncHearButtons();
    if (next === 'dialogue') {
      renderRoles();
      renderLines();
    } else {
      const box = document.getElementById('role-buttons-container');
      if (box) box.innerHTML = '';
      renderLines();
    }
    syncVoiceChatVisibility();
    if (next === 'shadowing' && state.sentences.length) syncVoiceChatSeed(state.index);
    if (!(options && options.history === 'skip')) {
      try {
        const url = new URL(root.location.href);
        if (url.searchParams.get('mode') !== next) {
          url.searchParams.set('mode', next);
          root.history.pushState({ studyMode: next }, '', url);
        }
      } catch (_) {}
    }
    setStatus(next === 'dialogue'
      ? '选一个角色，再点「开始对话练习」'
      : '跟读练习：左边原声，右边按住说话');
  }
  root.switchPracticeMode = switchPracticeMode;

  function showControls() {
    const box = document.getElementById('desktop-controls-container');
    if (box) box.style.display = 'block';
  }

  function absoluteUrl(src) {
    if (!src) return '';
    if (/^https?:\/\//i.test(src) || src.startsWith('blob:')) return src;
    return API_BASE + (src.startsWith('/') ? '' : '/') + src;
  }

  async function playLocal(src) {
    const video = videoEl();
    if (!video) throw new Error('找不到播放器');
    destroyYoutubePlayer();
    const box = document.getElementById('youtube-player-container');
    if (box) {
      box.style.display = 'none';
      box.innerHTML = '';
    }
    video.style.display = 'block';
    state.playerType = 'local';
    video.src = absoluteUrl(src);
    video.load();
  }

  async function fetchStoredTranscript(id) {
    const trRes = await fetch(API_BASE + '/video-resources/' + id + '/transcript', { headers: headers() });
    if (!trRes.ok) return [];
    const trData = await trRes.json().catch(() => ({}));
    return coerceSegments(trData.segments || trData.transcript_segments);
  }

  async function fetchYoutubeCaptions(youtubeId) {
    if (!youtubeId) return [];
    const res = await fetch(API_BASE + '/youtube/transcript', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
      body: JSON.stringify({
        url: 'https://www.youtube.com/watch?v=' + youtubeId,
        language: 'en',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      throw new Error(data.error || data.message || '暂时拉不到 YouTube 字幕');
    }
    return coerceSegments(data.segments);
  }

  async function requestRetranscribe(id) {
    const res = await fetch(API_BASE + '/video-resources/' + id + '/retranscribe', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
      body: JSON.stringify({ language: 'en' }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error('没有权限提取这段视频的字幕');
    if (!res.ok && res.status !== 202) throw new Error(data.message || '提取字幕失败');
    return data;
  }

  async function resolveSentences(detail) {
    let segs = coerceSegments(detail.transcript_segments || detail.video_sentences || detail.segments);
    const id = detail && detail.id;
    if (!segs.length && id != null && /^\d+$/.test(String(id))) {
      try { segs = await fetchStoredTranscript(id); } catch (_) {}
    }
    const yt = detail.youtube_video_id || detail.youtubeId;
    if (!segs.length && yt) {
      try { segs = await fetchYoutubeCaptions(yt); } catch (_) {}
    }
    return segs;
  }

  async function extractCaptions() {
    const detail = state.video || {};
    const id = detail.id;
    const yt = detail.youtube_video_id || detail.youtubeId;
    const btn = document.getElementById('sentence-extract');
    if (btn) btn.disabled = true;
    setStatus('正在提取字幕…');
    try {
      let segs = [];
      if (yt) {
        try { segs = await fetchYoutubeCaptions(yt); } catch (err) {
          if (!(id != null && /^\d+$/.test(String(id)))) throw err;
        }
      }
      if (!segs.length && id != null && /^\d+$/.test(String(id))) {
        await requestRetranscribe(id);
        setStatus('已开始后台提取。约几十秒后点「提取字幕」再试，或重新打开这段视频。');
        for (let i = 0; i < 8; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2500));
          try { segs = await fetchStoredTranscript(id); } catch (_) { segs = []; }
          if (segs.length) break;
          setStatus('还在提取字幕…(' + (i + 1) + '/8)');
        }
      }
      if (!segs.length) {
        setStatus('还没有拉到字幕。稍后再点「提取字幕」，或换有字幕的视频。');
        return;
      }
      state.sentences = segs;
      state.index = 0;
      if (state.mode === 'dialogue') renderRoles();
      renderLines();
      syncVoiceChatSeed(0);
      setStatus(state.mode === 'dialogue'
        ? ('字幕已就绪，共 ' + segs.length + ' 句。选角色后开始对话。')
        : ('字幕已就绪，共 ' + segs.length + ' 句。点气泡听原声，按住跟读。'));
    } catch (err) {
      setStatus(err.message || '提取字幕失败');
    } finally {
      if (btn) btn.disabled = false;
      syncExtractButton();
    }
  }

  async function loadVideo(id) {
    const res = await fetch(API_BASE + '/video-resources/' + id, { headers: headers() });
    if (!res.ok) throw new Error('视频加载失败');
    const data = await res.json();
    const detail = data.video || data || {};
    state.video = detail;
    setStatus('正在准备字幕…');
    let segs = await resolveSentences(detail);
    state.sentences = segs;
    state.index = 0;
    if (state.mode === 'dialogue') renderRoles();
    renderLines();
    syncVoiceChatSeed(0);
    const src = detail.local_video_path || detail.video_url || detail.url || '';
    rememberPracticeVideo(detail);
    if (src) {
      await playLocal(src);
      seekRemembered(detail.id);
      hideOverlay();
      if (segs.length) {
        setStatus(state.mode === 'dialogue'
          ? '视频准备好了。选角色，开始对话练习。'
          : '视频准备好了。点气泡听原声，按住跟读。');
      } else {
        setStatus('这段还没有字幕。点「提取字幕」试试。');
        syncExtractButton();
      }
      return;
    }
    const yt = detail.youtube_video_id || detail.youtubeId;
    if (yt) {
      await playYoutube(yt);
      hideOverlay();
      if (segs.length) {
        setStatus(state.mode === 'dialogue'
          ? '句子已列出。选角色，开始对话练习。'
          : '句子已列出。点字幕听这一句，按住跟读。');
      } else {
        setStatus('还没有字幕。点「提取字幕」从 YouTube 拉。');
        syncExtractButton();
      }
      return;
    }
    throw new Error('没有可播放的地址');
  }

  async function loadExternal() {
    let media = null;
    try { media = JSON.parse(root.sessionStorage.getItem('linglish.coach.media') || 'null'); } catch (_) {}
    if (!media) media = readCanonicalStudyMedia();
    if (!media) return false;
    let ytFromUrl = '';
    try { ytFromUrl = new URLSearchParams(root.location.search).get('yt') || ''; } catch (_) {}
    const yt = media.youtube_video_id || media.youtubeId
      || (String(media.id || '').match(/^yt:([A-Za-z0-9_-]{6,})$/) || [])[1]
      || ytFromUrl
      || '';
    const src = media.videoUrl || media.audioUrl || media.url || '';
    if (!src && !yt) return false;
    state.video = media;
    if (media.id && /^\d+$/.test(String(media.id))) root.LinglishStudyVideoId = String(media.id);
    else {
      root.LinglishStudyVideoId = '';
      root.LinglishStudyMedia = media;
    }
    setStatus('正在准备字幕…');
    state.sentences = await resolveSentences(media);
    state.index = 0;
    if (state.mode === 'dialogue') renderRoles();
    renderLines();
    if (src) {
      await playLocal(src);
      hideOverlay();
      if (state.sentences.length) setStatus('内容准备好了，点「听这一句」');
      else {
        setStatus('这段还没有字幕。点「提取字幕」试试。');
        syncExtractButton();
      }
      return true;
    }
    await playYoutube(yt);
    hideOverlay();
    if (state.sentences.length) {
      syncVoiceChatSeed(0);
      setStatus('句子已列出。点字幕听这一句，按住跟读。');
    } else {
      setStatus('还没有字幕。点「提取字幕」从 YouTube 拉。');
      syncExtractButton();
    }
    return true;
  }

  function openLibraryFromNav(library) {
    // 换片只能在「视频学习」完成；选完后再切回 AI陪练 / 实战场
    const next = library === 'channels' || library === 'podcasts' ? library : 'videos';
    const params = new URLSearchParams();
    params.set('library', next);
    try {
      const id = state.video && state.video.id != null ? String(state.video.id) : '';
      if (id) params.set('videoId', id);
    } catch (_) {}
    root.location.href = `./video-reader-desktop.html?${params.toString()}`;
  }

  function readCanonicalStudyMedia() {
    try {
      if (root.LinglishStudySelection && typeof root.LinglishStudySelection.read === 'function') {
        return root.LinglishStudySelection.read();
      }
    } catch (_) {}
    try {
      const raw = root.localStorage.getItem('linglish.last_study_media.v1');
      const data = raw ? JSON.parse(raw) : null;
      if (data && data.id != null) return data;
    } catch (_) {}
    try {
      if (root.LinglishStudyMedia && root.LinglishStudyMedia.id) return root.LinglishStudyMedia;
    } catch (_) {}
    try {
      if (root.LinglishStudyVideoId && /^\d+$/.test(String(root.LinglishStudyVideoId))) {
        return { id: String(root.LinglishStudyVideoId) };
      }
    } catch (_) {}
    return null;
  }

  function wire() {
    document.querySelectorAll('[data-library]').forEach((el) => {
      if (el.dataset.libraryWired === '1') return;
      el.dataset.libraryWired = '1';
      el.addEventListener('click', (event) => {
        event.preventDefault();
        openLibraryFromNav(el.getAttribute('data-library') || 'videos');
      });
    });
    const params = new URLSearchParams(root.location.search);
    const bootMode = params.get('mode');
    switchPracticeMode((bootMode === 'dialogue' || bootMode === 'arena') ? 'dialogue' : 'shadowing', { history: 'skip' });
    showControls();
    mountVoiceChat();

    document.querySelectorAll('.mode-tab').forEach((tab) => {
      tab.addEventListener('click', () => switchPracticeMode(tab.dataset.mode));
    });
    document.getElementById('role-buttons-container')?.addEventListener('click', (event) => {
      const btn = event.target.closest('.role-button, .role-btn, [data-role]');
      if (!btn || !btn.dataset.role) return;
      selectRole(btn.dataset.role);
    });
    document.getElementById('start-dialogue-btn')?.addEventListener('click', () => {
      startDialoguePractice();
    });
    document.getElementById('role-count-select')?.addEventListener('change', (event) => {
      state.roleCount = event.target.value || 'auto';
      state.selectedSpeaker = '';
      renderRoles();
      renderLines();
      setStatus('角色数已更新，重新选一个角色');
    });
    document.getElementById('toggle-setup-btn')?.addEventListener('click', () => {
      const setup = document.getElementById('dialogue-setup-container');
      const btn = document.getElementById('toggle-setup-btn');
      if (!setup) return;
      const collapsed = setup.classList.toggle('collapsed');
      if (btn) {
        const label = btn.querySelector('span:not(.icon)') || btn;
        if (label && label !== btn) label.textContent = collapsed ? '展开' : '收起';
        const icon = btn.querySelector('.icon');
        if (icon) icon.textContent = collapsed ? '▼' : '▲';
      }
    });
    document.getElementById('focus-play-btn')?.addEventListener('click', togglePlayback);
    document.getElementById('focus-prev-btn')?.addEventListener('click', () => playIndex(state.index - 1));
    document.getElementById('focus-next-btn')?.addEventListener('click', () => playIndex(state.index + 1));
    document.getElementById('focus-replay-btn')?.addEventListener('click', () => playIndex(state.index));
    document.getElementById('coach-prev')?.addEventListener('click', () => playIndex(state.index - 1));
    document.getElementById('coach-next')?.addEventListener('click', () => playIndex(state.index + 1));
    document.getElementById('coach-replay')?.addEventListener('click', () => playIndex(state.index));
    document.getElementById('sentence-listen')?.addEventListener('click', () => playIndex(state.index));
    const shadowBtn = document.getElementById('sentence-shadow');
    if (shadowBtn) {
      // Prefer hold-to-record (same as chat dock). Click fallback keeps old listen→record.
      const useHold = () => voiceChat
        && (state.mode === 'shadowing' || (state.mode === 'dialogue' && state.practicing))
        && typeof voiceChat.beginHold === 'function'
        && typeof voiceChat.endHold === 'function';
      const onShadowDown = (event) => {
        if (!useHold()) return;
        event.preventDefault();
        if (typeof voiceChat.lockPracticeTarget === 'function') {
          try { voiceChat.lockPracticeTarget(state.index); } catch (_) {}
        }
        Promise.resolve(voiceChat.beginHold(event)).catch((err) => {
          console.warn('[practice-app] hold start failed', err);
          setStatus('跟读失败，请再按住试一次');
        });
      };
      const onShadowUp = (event) => {
        if (!useHold()) return;
        event.preventDefault();
        Promise.resolve(voiceChat.endHold(event)).catch(() => {});
      };
      shadowBtn.addEventListener('pointerdown', onShadowDown);
      shadowBtn.addEventListener('pointerup', onShadowUp);
      shadowBtn.addEventListener('pointercancel', onShadowUp);
      shadowBtn.addEventListener('pointerleave', (event) => {
        if (voiceChat && typeof voiceChat.isHolding === 'function' && voiceChat.isHolding()) {
          onShadowUp(event);
        }
      });
      shadowBtn.addEventListener('click', (event) => {
        if (useHold()) {
          event.preventDefault();
          return;
        }
        startShadowTake().catch((err) => {
          console.warn('[practice-app] shadow failed', err);
          setStatus('跟读失败，请再试一次');
          state.shadowBusy = false;
          state.isRecording = false;
          syncHearButtons();
        });
      });
      shadowBtn.addEventListener('contextmenu', (event) => event.preventDefault());
    }
    // Prefer OS default mic; clear any old in-page device lock.
    try {
      const mic = root.LinglishShadowMic;
      if (mic && typeof mic.setPreferredMicId === 'function') mic.setPreferredMicId('');
    } catch (_) {}
    document.getElementById('sentence-hear-me')?.addEventListener('click', () => {
      hearMyRecording().catch(() => setStatus('预听失败，请再试一次'));
    });
    document.getElementById('sentence-compare')?.addEventListener('click', () => {
      compareRecording().catch(() => setStatus('对比失败，请再试一次'));
    });
    document.getElementById('sentence-review')?.addEventListener('click', () => {
      const sentence = currentSentence();
      if (!sentence) {
        setStatus('先选一句，再重复播放');
        return;
      }
      state.loop = !state.loop;
      const loopBtn = document.getElementById('coach-loop');
      if (loopBtn) loopBtn.setAttribute('aria-pressed', state.loop ? 'true' : 'false');
      const reviewBtn = document.getElementById('sentence-review');
      if (reviewBtn) reviewBtn.classList.toggle('is-on', state.loop);
      if (state.loop) {
        state.autoPause = false;
        const pause = document.getElementById('coach-autopause');
        if (pause) pause.setAttribute('aria-pressed', 'false');
        playIndex(state.index);
        setStatus('重复播放这一句 · 再点一次停止');
      } else {
        setStatus('已停止重复播放');
      }
    });
    document.getElementById('sentence-study-toggle')?.addEventListener('click', () => {
      if (!root.LinglishSubtitleStudy || typeof root.LinglishSubtitleStudy.setArmed !== 'function') {
        setStatus('拆句学组件还没加载');
        return;
      }
      const next = !root.LinglishSubtitleStudy.isArmed();
      root.LinglishSubtitleStudy.setArmed(next);
      syncStudyToggle();
      if (next) {
        const sentence = currentSentence();
        if (sentence) syncStudy(sentence);
        setStatus('拆句学已打开。点右侧一句，这里生成这一句。');
      } else {
        setStatus('拆句学已收起');
      }
    });
    document.getElementById('sentence-extract')?.addEventListener('click', () => {
      extractCaptions();
    });
    document.getElementById('practice-study-toggle')?.addEventListener('click', () => {
      document.getElementById('sentence-study-toggle')?.click();
    });
    document.getElementById('coach-loop')?.addEventListener('click', (event) => {
      state.loop = !state.loop;
      event.currentTarget.setAttribute('aria-pressed', state.loop ? 'true' : 'false');
    });
    document.getElementById('coach-autopause')?.addEventListener('click', (event) => {
      state.autoPause = !state.autoPause;
      event.currentTarget.setAttribute('aria-pressed', state.autoPause ? 'true' : 'false');
    });
    (function bindCoachSpeedDropdown() {
      const shell = document.getElementById('coach-speed');
      const trigger = document.getElementById('coach-speed-trigger');
      const menu = document.getElementById('coach-speed-menu');
      if (!shell || !trigger || !menu) return;

      const formatSpeed = (rate) => {
        const n = Number(rate);
        if (!Number.isFinite(n)) return '1x';
        return `${Math.round(n * 100) / 100}x`;
      };
      const setOpen = (open) => {
        const next = Boolean(open);
        menu.hidden = !next;
        trigger.setAttribute('aria-expanded', next ? 'true' : 'false');
        shell.classList.toggle('is-open', next);
      };
      const syncUi = (speed) => {
        trigger.textContent = formatSpeed(speed);
        menu.querySelectorAll('.vrp-speed__btn').forEach((el) => {
          const on = Math.abs(Number(el.dataset.speed) - speed) < 0.001;
          el.classList.toggle('active', on);
          el.setAttribute('aria-selected', on ? 'true' : 'false');
        });
      };
      const applySpeed = (speed) => {
        if (!Number.isFinite(speed)) return;
        const video = videoEl();
        if (video) video.playbackRate = speed;
        if (youtubePlayer && youtubePlayer.player && typeof youtubePlayer.player.setPlaybackRate === 'function') {
          try { youtubePlayer.player.setPlaybackRate(speed); } catch (_) {}
        }
        syncUi(speed);
        setOpen(false);
      };

      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setOpen(menu.hidden);
      });
      menu.addEventListener('click', (event) => {
        const btn = event.target.closest('.vrp-speed__btn');
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
        applySpeed(Number(btn.dataset.speed));
      });
      document.addEventListener('click', (event) => {
        if (menu.hidden) return;
        if (shell.contains(event.target)) return;
        setOpen(false);
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !menu.hidden) {
          setOpen(false);
          trigger.focus();
        }
      });
    })();
    document.getElementById('play-overlay')?.addEventListener('click', () => {
      if (!state.sentences.length) togglePlayback();
      else playIndex(state.index, { forcePlay: true });
    });
    document.getElementById('practice-caption-focus')?.addEventListener('click', (event) => {
      if (event.target.closest('.practice-caption-tools')) return;
      if (!state.sentences.length) return;
      playIndex(state.index);
    });
    document.getElementById('practice-line-list')?.addEventListener('click', (event) => {
      const item = event.target.closest('.line-item');
      if (!item || item.dataset.index == null) return;
      const index = Number(item.dataset.index);
      if (state.mode === 'dialogue' && state.dialogueRunning) {
        runDialogueFrom(index);
        return;
      }
      if (voiceChat && state.mode === 'shadowing') {
        syncVoiceChatSeed(index);
        playIndex(index);
        setStatus('第 ' + (index + 1) + ' 句 · 按住 Hold to record 开麦跟读');
        return;
      }
      playIndex(index);
    });
    document.getElementById('start-practice-btn')?.addEventListener('click', () => {
      showControls();
      if (!state.sentences.length) {
        setStatus('还没有字幕。先点「提取字幕」，或换一段视频。');
        return;
      }
      if (state.mode === 'dialogue') {
        if (!state.selectedSpeaker) {
          renderRoles();
          setStatus('先选一个角色，再开始对话');
          return;
        }
        startDialoguePractice();
        return;
      }
      state.practicing = true;
      syncVoiceChatVisibility();
      startShadowTake().catch((err) => {
        console.warn('[practice-app] start practice failed', err);
        setStatus('跟读失败，请再试一次');
        state.shadowBusy = false;
        state.isRecording = false;
        syncHearButtons();
      });
    });
    syncHearButtons();
    document.getElementById('pronunciation-weakness-retry')?.addEventListener('click', () => {
      const prefer = Number(document.getElementById('pronunciation-weakness-retry')?.dataset?.index);
      startWeaknessDrill({ preferIndex: prefer }).catch(() => {
        jumpToWeaknessIndex(Number.isFinite(prefer) ? prefer : state.index);
      });
    });
    document.getElementById('pronunciation-weakness-next')?.addEventListener('click', () => {
      advanceWeaknessQueue();
    });
    document.querySelectorAll('.speed-btn-compact').forEach((btn) => {
      btn.addEventListener('click', () => {
        const speed = Number(btn.dataset.speed);
        const video = videoEl();
        if (video && Number.isFinite(speed)) video.playbackRate = speed;
        document.querySelectorAll('.speed-btn-compact').forEach((el) => el.classList.remove('active'));
        btn.classList.add('active');
      });
    });
    videoEl()?.addEventListener('timeupdate', onTimeUpdate);
    document.addEventListener('keydown', (event) => {
      const tag = event.target && event.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (event.key === ' ') {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === 'ArrowLeft') {
        playIndex(state.index - 1);
      } else if (event.key === 'ArrowRight') {
        playIndex(state.index + 1);
      }
    });
    root.addEventListener('popstate', () => {
      const m = new URLSearchParams(root.location.search).get('mode');
      switchPracticeMode((m === 'dialogue' || m === 'arena') ? 'dialogue' : 'shadowing', { history: 'skip' });
    });
    root.goBack = function goBack() {
      if (root.history.length > 1) root.history.back();
      else root.location.href = './video-reader-desktop.html';
    };

    // 片源只认「视频学习」写下的 canonical selection，不用 StudyRecent 另起炉灶
    const canonical = readCanonicalStudyMedia();
    let videoId = params.get('videoId') || '';
    if (canonical && canonical.id != null) {
      const canonicalId = String(canonical.id);
      if (!videoId || String(videoId) !== canonicalId) videoId = canonicalId;
    } else if (!videoId && params.get('source') !== 'external') {
      videoId = '';
    }
    if (videoId && params.get('videoId') !== videoId) {
      try {
        const url = new URL(root.location.href);
        url.searchParams.set('videoId', videoId);
        if (canonical && canonical.youtube_video_id) url.searchParams.set('yt', String(canonical.youtube_video_id));
        root.history.replaceState({}, '', url);
      } catch (_) {}
    }
    function bootExternalFromId(id) {
      const yt = params.get('yt')
        || (String(id || '').match(/^yt:([A-Za-z0-9_-]{6,})$/) || [])[1]
        || (canonical && canonical.youtube_video_id)
        || '';
      const existing = canonical || root.LinglishStudyMedia;
      const media = (existing && String(existing.id) === String(id)) ? existing : {
        id: String(id || (yt ? 'yt:' + yt : '')),
        title: (existing && existing.title) || '',
        youtube_video_id: yt || (existing && existing.youtube_video_id) || '',
        audioUrl: (existing && existing.audioUrl) || '',
        transcriptUrl: (existing && existing.transcriptUrl) || '',
        cues: (existing && existing.cues) || [],
      };
      if (!media.youtube_video_id && !media.audioUrl) return Promise.resolve(false);
      try { root.sessionStorage.setItem('linglish.coach.media', JSON.stringify(media)); } catch (_) {}
      return loadExternal();
    }
    const boot = params.get('source') === 'external'
      ? loadExternal()
      : (/^\d+$/.test(videoId)
        ? loadVideo(videoId)
        : (videoId ? bootExternalFromId(videoId) : Promise.resolve(false)));
    const focusAssessment = params.get('focusAssessment') || '';
    Promise.resolve(boot).then((loaded) => {
      if (loaded === false) {
        renderLines();
        setOverlay('还没在视频学习里选内容');
        setStatus('请先到「视频学习」选视频或播客，再回来练。');
        return;
      }
      if (focusAssessment && state.sentences.length) {
        applyFocusAssessment(focusAssessment).catch(() => {});
      }
    }).catch((err) => {
      console.warn('[practice-app]', err);
      renderLines();
      setOverlay('视频加载失败');
      setStatus(err.message || '视频加载失败');
    });
  }

  ready(wire);
})(typeof window !== 'undefined' ? window : this);
