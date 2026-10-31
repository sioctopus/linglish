/**
 * Mobile 实战场: pick a role → partner lines auto-play → Hold on your lines.
 * Lives on video-reader so the player matches 视频学习.
 */
(function (root) {
  'use strict';

  const state = {
    selectedSpeaker: '',
    speakers: [],
    segmentSpeakerMap: {},
    running: false,
    awaitingHold: false,
    index: 0,
    epoch: 0,
    wired: false,
  };

  function isArena() {
    return document.body.classList.contains('study-mode-arena')
      || document.body.dataset.studyMode === 'arena'
      || new URLSearchParams(root.location.search).get('study') === 'arena';
  }

  function readerState() {
    return root.LinglishVideoReaderState || root.state || {};
  }

  function segments() {
    const list = readerState().currentSegments;
    return Array.isArray(list) ? list : [];
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildSpeakers() {
    const segs = segments();
    const freq = new Map();
    segs.forEach((seg) => {
      const name = String(seg && seg.speaker || '').trim();
      if (!name) return;
      freq.set(name, (freq.get(name) || 0) + 1);
    });
    let speakers = [];
    const k = freq.size >= 2
      ? Math.min(5, freq.size)
      : (segs.length >= 30 ? 3 : 2);
    if (freq.size >= 2) {
      const top = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, k).map(([n]) => n);
      speakers = top.map((name) => ({ speaker: name, lines: [] }));
      const indexOf = (n) => {
        const i = top.indexOf(n);
        return i >= 0 ? i : 0;
      };
      segs.forEach((seg, i) => {
        const name = String(seg && seg.speaker || '').trim() || top[0];
        speakers[indexOf(name)].lines.push(i);
      });
    } else {
      speakers = Array.from({ length: k }, (_, i) => ({ speaker: '角色 ' + (i + 1), lines: [] }));
      let cur = 0;
      let consec = 0;
      const qRe = /(\?|？|\b(who|what|when|where|why|how|can|do|are|is|will)\b)/i;
      let lastText = '';
      segs.forEach((seg, i) => {
        const text = String(seg && seg.text || '');
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
    return state.segmentSpeakerMap[index]
      || (segments()[index] && segments()[index].speaker)
      || '';
  }

  function isMyLine(index) {
    if (!state.selectedSpeaker) return true;
    return speakerOf(index) === state.selectedSpeaker;
  }

  function playback() {
    return root.LinglishMobilePlayback || null;
  }

  function setIndex(index) {
    state.index = Math.max(0, Math.min(segments().length - 1, Number(index) || 0));
    const api = playback();
    if (api && typeof api.setIndex === 'function') api.setIndex(state.index);
    else {
      try {
        root.mobileSegmentPosition = state.index;
        if (typeof root.renderMobileTranscriptWindow === 'function') {
          root.renderMobileTranscriptWindow(state.index);
        }
      } catch (_) {}
    }
  }

  function pauseNow() {
    const api = playback();
    if (api && typeof api.pause === 'function') api.pause();
    else {
      try {
        const el = document.getElementById('video-player');
        if (el && !el.paused) el.pause();
      } catch (_) {}
    }
  }

  function playSegment(index) {
    const segs = segments();
    const seg = segs[index];
    if (!seg) return Promise.resolve('missing');
    const start = Number(seg.start ?? seg.start_sec ?? 0);
    const end = Number(seg.end ?? seg.end_sec ?? start + 4);
    const payload = {
      index: Number(index),
      start,
      end,
      text: seg.text || '',
      speaker: seg.speaker || '',
    };
    const api = playback();
    if (api && typeof api.playSegmentBounds === 'function') {
      return Promise.resolve(api.playSegmentBounds(payload));
    }
    return Promise.resolve('missing');
  }

  function ensureUi() {
    let dock = document.getElementById('arena-dock');
    if (dock) return dock;
    const controls = document.getElementById('mobile-player-controls');
    if (!controls) return null;
    dock = document.createElement('section');
    dock.id = 'arena-dock';
    dock.className = 'arena-dock';
    dock.hidden = true;
    dock.setAttribute('aria-label', '实战场');
    dock.innerHTML = [
      '<div class="arena-dock-top">',
      '  <p class="arena-dock-status" data-arena-status>选角色，对方自动播，轮到你再按住说</p>',
      '  <div class="arena-dock-meta">',
      '    <p class="arena-dock-progress" data-arena-progress hidden></p>',
      '    <button type="button" class="arena-stop-btn" data-arena-stop hidden>结束</button>',
      '  </div>',
      '</div>',
      '<div class="arena-dock-setup">',
      '  <div class="arena-roles" data-arena-roles role="group" aria-label="选择角色"></div>',
      '  <button type="button" class="arena-start-btn" data-arena-start>开始</button>',
      '</div>',
    ].join('');
    const stack = controls.querySelector('.mobile-speak-stack');
    if (stack) controls.insertBefore(dock, stack);
    else controls.insertBefore(dock, controls.firstChild);
    return dock;
  }

  function setStatus(text) {
    const el = document.querySelector('[data-arena-status]');
    if (el) el.textContent = text || '';
    // 状态只放在 arena-dock 顶栏，避免与 Hold 区 hint 叠字
    const hint = document.getElementById('mobile-speak-hint');
    if (hint && isArena()) {
      hint.hidden = true;
      hint.setAttribute('aria-hidden', 'true');
      hint.textContent = '';
    }
    syncHoldUi();
  }

  function syncHoldUi() {
    const hold = document.getElementById('mobile-hold');
    if (!hold) return;
    const label = hold.querySelector('[data-hold-label]');
    const canHold = !state.running || state.awaitingHold;
    hold.disabled = isArena() && state.running && !state.awaitingHold;
    hold.classList.toggle('is-arena-wait', isArena() && state.running && state.awaitingHold);
    hold.classList.toggle('is-arena-listen', isArena() && state.running && !state.awaitingHold);
    if (label && isArena()) {
      if (!state.running) label.textContent = 'Hold to record';
      else if (state.awaitingHold) label.textContent = '按住说你的台词';
      else label.textContent = '对方在说…';
    }
    document.body.classList.toggle('arena-awaiting-hold', isArena() && state.awaitingHold);
    document.body.classList.toggle('arena-running', isArena() && state.running);
  }

  function updateProgress() {
    const el = document.querySelector('[data-arena-progress]');
    if (!el) return;
    const mine = state.speakers.find((s) => s.speaker === state.selectedSpeaker);
    if (!state.selectedSpeaker || !mine) {
      el.hidden = true;
      return;
    }
    const total = mine.lines.length;
    const done = mine.lines.filter((idx) => idx < state.index
      || (idx === state.index && state.running && !state.awaitingHold)).length;
    el.hidden = false;
    el.textContent = state.running
      ? ('你的台词 ' + Math.min(done, total) + ' / ' + total)
      : ('你有 ' + total + ' 句');
  }

  function renderRoles() {
    const box = document.querySelector('[data-arena-roles]');
    const startBtn = document.querySelector('[data-arena-start]');
    const stopBtn = document.querySelector('[data-arena-stop]');
    if (!box) return;
    if (!segments().length) {
      box.innerHTML = '<p class="arena-roles-empty">先到「视频学习」选有对白的内容，再回来实战</p>';
      if (startBtn) startBtn.disabled = true;
      return;
    }
    buildSpeakers();
    box.innerHTML = state.speakers.map((sp) => {
      const on = sp.speaker === state.selectedSpeaker ? ' is-on' : '';
      return '<button type="button" class="arena-role-chip' + on + '" data-role="'
        + escapeHtml(sp.speaker) + '">'
        + '<span class="arena-role-name">' + escapeHtml(sp.speaker) + '</span>'
        + '<span class="arena-role-meta">' + sp.lines.length + ' 句</span>'
        + '</button>';
    }).join('');
    const setup = document.querySelector('.arena-dock-setup');
    if (startBtn) {
      startBtn.disabled = !state.selectedSpeaker || state.running;
      startBtn.hidden = false;
      startBtn.textContent = '开始';
    }
    if (stopBtn) stopBtn.hidden = !state.running;
    if (setup) setup.hidden = state.running;
    box.hidden = false;
    updateProgress();
  }

  function selectRole(name) {
    if (state.running) return;
    state.selectedSpeaker = String(name || '');
    renderRoles();
    setStatus(state.selectedSpeaker
      ? ('你是「' + state.selectedSpeaker + '」· 点开始')
      : '选角色，对方自动播，轮到你再按住说');
  }

  function stop(silent) {
    state.epoch += 1;
    state.running = false;
    state.awaitingHold = false;
    pauseNow();
    renderRoles();
    syncHoldUi();
    if (!silent) setStatus(state.selectedSpeaker
      ? ('已结束 · 可换角色再开始')
      : '选角色，对方自动播，轮到你再按住说');
    updateProgress();
  }

  async function runFrom(index) {
    if (!state.running || !isArena()) return;
    const segs = segments();
    if (!segs.length) {
      stop();
      setStatus('还没有字幕，换一段内容再试');
      return;
    }
    if (index >= segs.length) {
      state.running = false;
      state.awaitingHold = false;
      renderRoles();
      syncHoldUi();
      setStatus('这段练完了。可换角色再来一遍');
      updateProgress();
      return;
    }
    const epoch = state.epoch;
    setIndex(index);
    updateProgress();
    if (isMyLine(index)) {
      state.awaitingHold = true;
      pauseNow();
      setStatus('轮到你 · 按住说「' + state.selectedSpeaker + '」这句');
      return;
    }
    state.awaitingHold = false;
    syncHoldUi();
    setStatus('对方在说…听完自动到你');
    const result = await playSegment(index);
    if (epoch !== state.epoch || !state.running) return;
    if (result === 'missing') {
      setStatus('这一句播不了，点下一句或结束重来');
      return;
    }
    advanceAfterPartner();
  }

  function advanceAfterPartner() {
    if (!state.running) return;
    runFrom(state.index + 1);
  }

  function advanceAfterMyTake() {
    if (!state.running) return;
    state.awaitingHold = false;
    runFrom(state.index + 1);
  }

  function start() {
    if (!isArena()) return;
    if (!state.selectedSpeaker) {
      setStatus('先选一个角色');
      return;
    }
    if (!segments().length) {
      setStatus('先选一段有对白的内容');
      return;
    }
    buildSpeakers();
    state.epoch += 1;
    state.running = true;
    state.awaitingHold = false;
    renderRoles();
    setStatus('对方在说…听完到你再说');
    runFrom(0);
  }

  function onHoldComplete(detail) {
    if (!isArena() || !state.running || !state.awaitingHold) return;
    const idx = detail && Number.isFinite(Number(detail.index)) ? Number(detail.index) : state.index;
    if (idx !== state.index) return;
    advanceAfterMyTake();
  }

  function canBeginHold() {
    if (!isArena() || !state.running) return true;
    return state.awaitingHold;
  }

  function wire() {
    if (state.wired) return;
    const dock = ensureUi();
    if (!dock) return;
    state.wired = true;
    dock.addEventListener('click', (event) => {
      const role = event.target.closest('[data-role]');
      if (role) {
        selectRole(role.getAttribute('data-role'));
        return;
      }
      if (event.target.closest('[data-arena-start]')) {
        start();
        return;
      }
      if (event.target.closest('[data-arena-stop]')) stop();
    });
  }

  function sync() {
    wire();
    const dock = ensureUi();
    const on = isArena();
    document.body.classList.toggle('arena-dialogue-on', on);
    if (dock) dock.hidden = !on;
    if (!on) {
      stop(true);
      syncHoldUi();
      return;
    }
    if (segments().length) buildSpeakers();
    renderRoles();
    if (!state.running) {
      setStatus(state.selectedSpeaker
        ? ('你是「' + state.selectedSpeaker + '」· 点开始')
        : '选角色，对方自动播，轮到你再按住说');
    } else {
      syncHoldUi();
      updateProgress();
    }
  }

  root.LinglishArenaDialogue = {
    sync,
    start,
    stop,
    onHoldComplete,
    canBeginHold,
    isAwaitingHold: () => state.awaitingHold,
    isRunning: () => state.running,
    isMyLine,
    selectRole,
  };

  function boot() {
    wire();
    sync();
    root.addEventListener('linglish:segments-ready', () => { if (isArena()) sync(); });
    root.addEventListener('linglish:video-selected', () => { if (isArena()) sync(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
