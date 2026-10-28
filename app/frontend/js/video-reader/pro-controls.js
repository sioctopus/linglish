/* =====================================================================
 * Linglish · Video Reader Pro Controls
 * ---------------------------------------------------------------------
 * Adds three industry-leader-class UX layers on top of the existing
 * video-reader-desktop page, without touching its main 6000-line script:
 *
 *   1. Pro keyboard shortcuts (Space/J/K/L/R/A/T/F/M/?, arrows for
 *      sentence nav, [/] for speed, 0–9 for percent seek)
 *   2. Visible playback bar with speed presets, sentence loop, sentence
 *      navigation, auto-pause-at-sentence-end
 *   3. Help overlay (toggle with ? or H), and a transient speed/loop toast
 *
 * Reads existing closure state via window.__vrdPro (exposed by the host
 * script). Falls back to the raw <video> if the shim is missing, so the
 * page never breaks even if the host JS errors out earlier.
 * ===================================================================== */
(function () {
  'use strict';

  // ---------- 1. Bridge to the host page's closures ------------------
  const bridge = window.__vrdPro || {};
  const firstLesson = bridge.firstLesson || { enabled: false };
  function firstLessonIsActive() {
    try {
      return typeof firstLesson.isActive === 'function'
        ? firstLesson.isActive()
        : Boolean(firstLesson.enabled);
    } catch (_) { return false; }
  }
  const playerEl = bridge.playerEl || document.getElementById('player');
  if (!playerEl) {
    console.warn('[VRP] No <video id="player"> found, aborting init.');
    return;
  }

  function getYT() {
    try { return bridge.getYouTubePlayer ? bridge.getYouTubePlayer() : null; } catch (_) { return null; }
  }
  function getPlayerType() {
    try { return bridge.getPlayerType ? bridge.getPlayerType() : 'local'; } catch (_) { return 'local'; }
  }
  function getSegments() {
    try {
      const s = bridge.state || {};
      return Array.isArray(s.currentSegments) ? s.currentSegments : [];
    } catch (_) { return []; }
  }
  function segIdxByTime(t) {
    if (typeof bridge.currentSegmentIndexByTime === 'function') {
      try { return bridge.currentSegmentIndexByTime(t); } catch (_) { /* fallthrough */ }
    }
    const segs = getSegments();
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const st = s.start_sec ?? s.start ?? s.startTime ?? 0;
      const en = s.end_sec   ?? s.end   ?? s.endTime   ?? 0;
      if (t >= st && t <= en) return i;
    }
    return -1;
  }
  function highlightSeg(i, scroll) {
    if (typeof bridge.highlightActiveSegment === 'function') {
      try { return bridge.highlightActiveSegment(i, !!scroll); } catch (_) { /* ignore */ }
    }
    // soft fallback: pulse the matching seg if rendered
    const list = document.getElementById('transcript-list');
    if (!list) return;
    const target = list.querySelector(`.seg[data-index="${i}"]`);
    if (target) {
      target.classList.add('vrp-pulse');
      setTimeout(() => target.classList.remove('vrp-pulse'), 850);
      if (scroll) target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // Unified getters/setters that work for both <video> and YouTube.
  function getCurrentTime() {
    const yt = getYT();
    if (getPlayerType() === 'youtube' && yt && typeof yt.getCurrentTime === 'function') {
      return yt.getCurrentTime() || 0;
    }
    return playerEl.currentTime || 0;
  }
  function setCurrentTime(v) {
    const yt = getYT();
    if (getPlayerType() === 'youtube' && yt && typeof yt.seekTo === 'function') {
      yt.seekTo(v); return;
    }
    try { playerEl.currentTime = v; } catch (_) { /* ignore */ }
  }
  function getDuration() {
    const yt = getYT();
    if (getPlayerType() === 'youtube' && yt && typeof yt.getDuration === 'function') {
      return yt.getDuration() || 0;
    }
    return playerEl.duration || 0;
  }
  function isPaused() {
    const yt = getYT();
    if (getPlayerType() === 'youtube' && yt && typeof yt.getPlayerState === 'function') {
      // YT.PlayerState.PLAYING === 1
      try { return yt.getPlayerState() !== 1; } catch (_) { /* ignore */ }
    }
    return !!playerEl.paused;
  }
  function play() {
    try { if (typeof bridge.stopDictAudio === 'function') bridge.stopDictAudio(); } catch (_) { /* ignore */ }
    const yt = getYT();
    if (getPlayerType() === 'youtube' && yt && typeof yt.play === 'function') {
      try { yt.play(); return; } catch (_) { /* fall through */ }
    }
    try { const p = playerEl.play(); if (p && p.catch) p.catch(() => { /* autoplay block */ }); } catch (_) { /* ignore */ }
  }
  function pause() {
    const yt = getYT();
    if (getPlayerType() === 'youtube' && yt && typeof yt.pause === 'function') {
      try { yt.pause(); return; } catch (_) { /* fall through */ }
    }
    try { playerEl.pause(); } catch (_) { /* ignore */ }
  }
  function togglePlay() { isPaused() ? play() : pause(); }
  function setRate(r) {
    const yt = getYT();
    const clamped = Math.min(3, Math.max(0.25, Math.round(r * 100) / 100));
    if (getPlayerType() === 'youtube' && yt && typeof yt.setPlaybackRate === 'function') {
      try { yt.setPlaybackRate(clamped); } catch (_) { /* ignore */ }
    }
    try { playerEl.playbackRate = clamped; } catch (_) { /* ignore */ }
    return clamped;
  }
  function getRate() {
    const yt = getYT();
    if (getPlayerType() === 'youtube' && yt && typeof yt.getPlaybackRate === 'function') {
      try { return yt.getPlaybackRate() || 1; } catch (_) { /* ignore */ }
    }
    return playerEl.playbackRate || 1;
  }
  function toggleMute() {
    try { playerEl.muted = !playerEl.muted; } catch (_) { /* ignore */ }
  }
  function toggleFullscreen() {
    const wrap = document.querySelector('.player') || playerEl;
    try {
      if (!document.fullscreenElement) {
        (wrap.requestFullscreen || wrap.webkitRequestFullscreen || (() => {})).call(wrap);
      } else {
        (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
      }
    } catch (_) { /* ignore */ }
  }
  function jumpSegments(delta) {
    const segs = getSegments();
    if (!segs.length) return;
    const t = getCurrentTime();
    let cur = segIdxByTime(t);
    if (cur < 0) {
      // pick nearest
      cur = segs.findIndex(s => (s.start_sec ?? s.start ?? 0) > t) - 1;
      if (cur < -1) cur = segs.length - 1;
    }
    const next = Math.min(segs.length - 1, Math.max(0, cur + delta));
    const seg = segs[next];
    if (!seg) return;
    const start = (seg.start_sec ?? seg.start ?? seg.startTime ?? 0) + 0.01;
    setCurrentTime(start);
    play();
    highlightSeg(next, true);
    showToast(`${delta > 0 ? '⤼ Next' : '⤺ Prev'} sentence · ${next + 1}/${segs.length}`);
  }
  function jumpToBookmark(direction) {
    const vid = getCurrentVideoId();
    if (!vid) return;
    const list = getBookmarks(vid);
    if (!list.length) { showToast('No bookmarks yet — press S to star this sentence'); return; }
    const sorted = [...list].sort((a, b) => (a.idx || 0) - (b.idx || 0));
    const segs = getSegments();
    const cur = segIdxByTime(getCurrentTime());
    let target;
    if (direction > 0) {
      target = sorted.find(b => (b.idx || 0) > cur);
      if (!target) target = sorted[0];
    } else {
      target = [...sorted].reverse().find(b => (b.idx || 0) < cur);
      if (!target) target = sorted[sorted.length - 1];
    }
    if (!target) return;
    const idx = Math.min(segs.length - 1, Math.max(0, target.idx || 0));
    const seg = segs[idx];
    if (!seg) return;
    const start = (seg.start_sec ?? seg.start ?? seg.startTime ?? 0) + 0.01;
    setCurrentTime(start);
    play();
    if (typeof highlightSeg === 'function') highlightSeg(idx, true);
    showToast(`★ ${direction > 0 ? 'Next' : 'Prev'} bookmark · sentence ${idx + 1}`);
  }
  function jumpToSegment(oneBasedIdx) {
    const segs = getSegments();
    if (!segs.length) return false;
    const idx = Math.min(segs.length, Math.max(1, oneBasedIdx)) - 1;
    const seg = segs[idx];
    if (!seg) return false;
    const start = (seg.start_sec ?? seg.start ?? seg.startTime ?? 0) + 0.01;
    setCurrentTime(start);
    play();
    if (typeof highlightSeg === 'function') highlightSeg(idx, true);
    showToast(`⤳ Sentence ${idx + 1}/${segs.length}`);
    return true;
  }
  function replayCurrentSegment() {
    const segs = getSegments();
    if (!segs.length) return;
    const cur = segIdxByTime(getCurrentTime());
    const idx = cur >= 0 ? cur : 0;
    const seg = segs[idx];
    if (!seg) return;
    const start = (seg.start_sec ?? seg.start ?? seg.startTime ?? 0) + 0.01;
    setCurrentTime(start);
    play();
    highlightSeg(idx, true);
    showToast(`↻ Replay · sentence ${idx + 1}`);
  }
  // Echo replay: play current sentence once at 0.5x, then restore previous rate.
  // Pure UX nicety inspired by Speak / Cake's "slow replay" button.
  let echoState = null; // { restoreRate, segIdx, endSec }
  function startEchoReplay() {
    const segs = getSegments();
    if (!segs.length) return;
    const cur = segIdxByTime(getCurrentTime());
    const idx = cur >= 0 ? cur : 0;
    const seg = segs[idx];
    if (!seg) return;
    const start = (seg.start_sec ?? seg.start ?? seg.startTime ?? 0) + 0.01;
    const end   = (seg.end_sec   ?? seg.end   ?? seg.endTime   ?? start + 4);
    if (echoState) cancelEchoReplay();
    echoState = { restoreRate: getRate(), segIdx: idx, endSec: end };
    setRate(0.5);
    setCurrentTime(start);
    play();
    highlightSeg(idx, true);
    showToast(`🐢 Echo @ 0.5× · sentence ${idx + 1}`);
  }
  function cancelEchoReplay() {
    if (!echoState) return;
    setRate(echoState.restoreRate);
    echoState = null;
  }
  function tickEchoReplay(t) {
    if (!echoState) return;
    if (t > echoState.endSec - 0.05) {
      setRate(echoState.restoreRate);
      const r = echoState.restoreRate;
      echoState = null;
      showToast(`▶ Resumed @ ${r}×`);
    }
  }

  // ---------- 2. Persistent settings ---------------------------------
  const SETTINGS_KEY = 'linglish.vrp.settings.v1';
  const POSITION_KEY = 'linglish.vrp.position.v1';
  // loopMode: 0=off, 3=loop 3 times, 5=loop 5 times, -1=infinite
  // loopSentence (legacy boolean) is migrated below
  // subtitleScale: integer 0..4 → maps to xs/sm/md/lg/xl (1.0 == md)
  // dictationMode: hide English subtitle until reveal-on-click (Cake-style)
  const defaults = { rate: 1, loopSentence: false, loopMode: 0, autoPauseAtEnd: false, bilingualOn: false, subtitleScale: 2, dictationMode: false };
  let settings = Object.assign({}, defaults);
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = Object.assign({}, defaults, JSON.parse(raw));
  } catch (_) { /* ignore */ }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (_) { /* ignore */ }
  }
  // Migrate legacy loopSentence boolean → loopMode integer
  if (settings.loopSentence === true && (!settings.loopMode || settings.loopMode === 0)) {
    settings.loopMode = -1; // legacy "loop on" meant infinite
    saveSettings();
  }
  // Helper: is loop currently active in any mode
  function loopActive() { return settings.loopMode === -1 || settings.loopMode > 0; }
  // Subtitle scale levels (data-vrp-sub attribute on <body> drives CSS)
  const SUB_LEVELS = ['xs', 'sm', 'md', 'lg', 'xl'];
  const SUB_LABELS = ['极小 XS', '小 SM', '常规 MD', '大 LG', '特大 XL'];
  function applySubtitleScale() {
    const lvl = SUB_LEVELS[Math.max(0, Math.min(4, settings.subtitleScale | 0))] || 'md';
    document.body.setAttribute('data-vrp-sub', lvl);
  }
  function nudgeSubtitleScale(delta) {
    const cur = Math.max(0, Math.min(4, settings.subtitleScale | 0));
    const next = Math.max(0, Math.min(4, cur + delta));
    if (next === cur) {
      showToast(`字幕 ${SUB_LABELS[cur]} · already ${delta > 0 ? 'max' : 'min'}`);
      return;
    }
    settings.subtitleScale = next;
    saveSettings();
    applySubtitleScale();
    showToast(`📝 字幕 ${SUB_LABELS[next]}`);
  }
  // Dictation mode: hide English subtitle (transcript text + dock) until clicked/keyed reveal
  function applyDictationMode() {
    document.body.classList.toggle('vrp-dictation', !!settings.dictationMode);
  }
  function toggleDictationMode() {
    settings.dictationMode = !settings.dictationMode;
    saveSettings();
    applyDictationMode();
    showToast(settings.dictationMode ? '🎧 听写模式 ON · 字幕已隐藏，按 D 切换' : '🎧 听写模式 OFF');
  }
  // Cinema mode: dim everything except the player + subtitle for distraction-free viewing
  function applyCinemaMode() {
    document.body.classList.toggle('vrp-cinema', !!settings.cinemaMode);
  }
  function toggleCinemaMode() {
    settings.cinemaMode = !settings.cinemaMode;
    saveSettings();
    applyCinemaMode();
    showToast(settings.cinemaMode ? '🎬 影院模式 ON · 按 Z 切换' : '☀️ 影院模式 OFF');
  }
  // Bookmarks-only filter: hide non-starred sentences in transcript
  function applyBookmarksOnly() {
    document.body.classList.toggle('vrp-bookmarks-only', !!settings.bookmarksOnly);
    paintBookmarksOnlyBanner();
  }
  function toggleBookmarksOnly() {
    settings.bookmarksOnly = !settings.bookmarksOnly;
    saveSettings();
    applyBookmarksOnly();
    if (settings.bookmarksOnly) {
      const vid = getCurrentVideoId();
      const n = vid ? getBookmarks(vid).length : 0;
      if (n === 0) {
        showToast('No bookmarks yet — press S on a sentence to star it');
        // auto-disable so transcript isn't blank
        settings.bookmarksOnly = false;
        saveSettings();
        applyBookmarksOnly();
        return;
      }
      showToast(`★ Showing ${n} bookmarked · Shift+S to show all`);
    } else {
      showToast('Showing all sentences');
    }
  }
  function paintBookmarksOnlyBanner() {
    const list = document.getElementById('transcript-list');
    if (!list) return;
    let banner = document.getElementById('vrp-bm-only-banner');
    if (!settings.bookmarksOnly) { if (banner) banner.remove(); return; }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'vrp-bm-only-banner';
      banner.className = 'vrp-bm-only-banner';
      banner.setAttribute('role', 'status');
      list.parentNode.insertBefore(banner, list);
    }
    const vid = getCurrentVideoId();
    const n = vid ? getBookmarks(vid).length : 0;
    banner.innerHTML = `<span class="vrp-bm-only-banner__dot">★</span><span class="vrp-bm-only-banner__txt">Showing ${n} bookmarked sentence${n === 1 ? '' : 's'}</span><button type="button" class="vrp-bm-only-banner__close" aria-label="Show all sentences">Show all</button>`;
    const closeBtn = banner.querySelector('.vrp-bm-only-banner__close');
    if (closeBtn) closeBtn.onclick = () => toggleBookmarksOnly();
  }

  // Cycle through 0 → 3 → 5 → -1 (∞) → 0
  function cycleLoopMode() {
    const order = [0, 3, 5, -1];
    const cur = settings.loopMode || 0;
    const idx = order.indexOf(cur);
    settings.loopMode = order[(idx + 1) % order.length];
    settings.loopSentence = loopActive(); // keep legacy field in sync
    saveSettings();
    paintLoopBtn();
    showToast(loopBtnLabel(true));
    // reset internal loop tally
    loopRemaining = settings.loopMode > 0 ? settings.loopMode - 1 : (settings.loopMode === -1 ? Infinity : 0);
  }
  function loopBtnLabel(verbose) {
    const m = settings.loopMode || 0;
    if (m === 0) return verbose ? '↻ Loop OFF' : 'Loop';
    if (m === -1) return verbose ? '↻ Loop ∞' : 'Loop ∞';
    return verbose ? `↻ Loop ×${m}` : `Loop ×${m}`;
  }
  function loopShortLabel() {
    const m = settings.loopMode || 0;
    if (m === 0) return '循环';
    if (m === -1) return '∞';
    return `×${m}`;
  }
  function paintLoopBtn() {
    const btn = document.getElementById('vrp-loop');
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(loopActive()));
    btn.dataset.mode = String(settings.loopMode || 0);
    const label = btn.querySelector('.vrp-toggle__label');
    if (label) label.textContent = loopBtnLabel(false);
    const short = btn.querySelector('.vrp-toggle__short');
    if (short) short.textContent = loopShortLabel();
  }

  // Per-video resume positions: { [videoId]: { sec, ts } }
  function loadPositionMap() {
    try { return JSON.parse(localStorage.getItem(POSITION_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function savePosition(videoId, sec) {
    if (!videoId) return;
    if (firstLessonIsActive() && typeof firstLesson.markResume === 'function') {
      firstLesson.markResume(sec);
      return;
    }
    try {
      const map = loadPositionMap();
      map[String(videoId)] = { sec: Math.max(0, Math.round(sec)), ts: Date.now() };
      localStorage.setItem(POSITION_KEY, JSON.stringify(map));
    } catch (_) { /* ignore */ }
  }
  function getSavedPosition(videoId) {
    if (!videoId) return null;
    if (firstLessonIsActive() && typeof firstLesson.snapshot === 'function') {
      return firstLesson.snapshot()?.resumeSeconds || 0;
    }
    const map = loadPositionMap();
    const entry = map[String(videoId)];
    if (!entry) return null;
    // expire after 14 days
    if (Date.now() - (entry.ts || 0) > 14 * 24 * 3600 * 1000) return null;
    return entry.sec || 0;
  }
  function getCurrentVideoId() {
    try { return bridge.state && bridge.state.currentVideo ? bridge.state.currentVideo.id : null; }
    catch (_) { return null; }
  }

  // Sentence bookmarks per video — { [videoId]: [{ idx, t, txt, ts }, ...] }
  const BOOKMARKS_KEY = 'linglish.vrp.bookmarks.v1';
  function loadBookmarksMap() {
    try { return JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function getBookmarks(videoId) {
    if (!videoId) return [];
    const map = loadBookmarksMap();
    return Array.isArray(map[String(videoId)]) ? map[String(videoId)] : [];
  }
  function isBookmarked(videoId, idx) {
    return getBookmarks(videoId).some(b => b.idx === idx);
  }
  function toggleBookmark(videoId, idx, t, txt) {
    if (!videoId || typeof idx !== 'number' || idx < 0) return false;
    const map = loadBookmarksMap();
    const list = Array.isArray(map[String(videoId)]) ? map[String(videoId)] : [];
    const existing = list.findIndex(b => b.idx === idx);
    let added;
    if (existing >= 0) {
      list.splice(existing, 1);
      added = false;
    } else {
      list.push({ idx, t: Math.round(t), txt: (txt || '').slice(0, 140), ts: Date.now() });
      list.sort((a, b) => a.idx - b.idx);
      added = true;
    }
    map[String(videoId)] = list;
    try { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(map)); } catch (_) {}
    return added;
  }
  function bookmarkCurrentSentence() {
    const segs = getSegments();
    const t = getCurrentTime();
    const idx = segIdxByTime(t);
    if (idx < 0) { showToast('Not on a sentence yet'); return; }
    const vid = getCurrentVideoId();
    if (!vid) { showToast('Pick a video first'); return; }
    const seg = segs[idx];
    const stxt = (seg.text_en || seg.text || seg.en || '').trim();
    const stStart = seg.start_sec ?? seg.start ?? seg.startTime ?? t;
    const added = toggleBookmark(vid, idx, stStart, stxt);
    paintBookmarkBtn();
    decorateBookmarkSeg(idx, added);
    showToast(added ? `★ Bookmarked sentence ${idx + 1}` : `☆ Removed sentence ${idx + 1}`);
  }
  function decorateBookmarkSeg(idx, on) {
    const list = document.getElementById('transcript-list');
    if (!list) return;
    const target = list.querySelector(`.seg[data-index="${idx}"]`);
    if (!target) return;
    target.classList.toggle('vrp-bookmarked', !!on);
  }
  function decorateAllBookmarks() {
    const vid = getCurrentVideoId();
    if (!vid) return;
    const list = document.getElementById('transcript-list');
    if (!list) return;
    list.querySelectorAll('.seg.vrp-bookmarked').forEach(el => el.classList.remove('vrp-bookmarked'));
    getBookmarks(vid).forEach(b => decorateBookmarkSeg(b.idx, true));
  }
  function paintBookmarkBtn() {
    const btn = document.getElementById('vrp-bookmark');
    const cnt = document.getElementById('vrp-bookmark-count');
    if (!btn || !cnt) return;
    const vid = getCurrentVideoId();
    const list = vid ? getBookmarks(vid) : [];
    cnt.textContent = String(list.length);
    btn.classList.toggle('vrp-btn--star--active', list.length > 0);
    // Reflect "current sentence is bookmarked"
    const idx = segIdxByTime(getCurrentTime());
    btn.classList.toggle('vrp-btn--star--current', vid && idx >= 0 && isBookmarked(vid, idx));
  }
  let bookmarkPopoverEl = null;
  function openBookmarkPopover(anchor) {
    closeBookmarkPopover();
    const vid = getCurrentVideoId();
    const list = vid ? getBookmarks(vid) : [];
    bookmarkPopoverEl = document.createElement('div');
    bookmarkPopoverEl.className = 'vrp-bm-pop';
    bookmarkPopoverEl.setAttribute('role', 'dialog');
    bookmarkPopoverEl.setAttribute('aria-label', 'Sentence bookmarks');
    if (!list.length) {
      bookmarkPopoverEl.innerHTML = `
        <div class="vrp-bm-pop__head">★ 收藏的句子 · Bookmarks</div>
        <div class="vrp-bm-pop__empty">还没有收藏 · Press <span class="vrp-kbd">S</span> on a sentence to save it</div>
      `;
    } else {
      const rows = list.map(b => {
        const m = Math.floor((b.t || 0) / 60);
        const s = String(Math.floor((b.t || 0) % 60)).padStart(2, '0');
        const txt = escapeHTML(b.txt || `Sentence ${b.idx + 1}`);
        return `
          <button class="vrp-bm-row" type="button" data-jump="${b.t}" data-idx="${b.idx}">
            <span class="vrp-bm-row__t">${m}:${s}</span>
            <span class="vrp-bm-row__txt">${txt}</span>
            <span class="vrp-bm-row__del" data-del="${b.idx}" title="Remove">✕</span>
          </button>
        `;
      }).join('');
      bookmarkPopoverEl.innerHTML = `
        <div class="vrp-bm-pop__head">★ <b>${list.length}</b> 收藏 · Bookmarks <button class="vrp-bm-pop__close" type="button" aria-label="Close">×</button></div>
        <div class="vrp-bm-pop__list">${rows}</div>
        <div class="vrp-bm-pop__foot"><span class="vrp-kbd">S</span> add/remove · click row to jump</div>
      `;
    }
    document.body.appendChild(bookmarkPopoverEl);
    const r = anchor.getBoundingClientRect();
    const pop = bookmarkPopoverEl.getBoundingClientRect();
    let left = Math.max(8, Math.min(window.innerWidth - pop.width - 8, r.right - pop.width));
    let top = r.bottom + 8;
    if (top + pop.height > window.innerHeight - 8) top = r.top - pop.height - 8;
    bookmarkPopoverEl.style.left = left + 'px';
    bookmarkPopoverEl.style.top = top + 'px';
    requestAnimationFrame(() => bookmarkPopoverEl && bookmarkPopoverEl.classList.add('show'));
    bookmarkPopoverEl.addEventListener('click', (e) => {
      const closeBtn = e.target.closest && e.target.closest('.vrp-bm-pop__close');
      if (closeBtn) { closeBookmarkPopover(); return; }
      const delEl = e.target.closest && e.target.closest('[data-del]');
      if (delEl) {
        e.stopPropagation();
        const idx = parseInt(delEl.dataset.del, 10);
        if (!isNaN(idx)) {
          const segs = getSegments();
          toggleBookmark(vid, idx, 0, ''); // toggle off (existing)
          decorateBookmarkSeg(idx, false);
          paintBookmarkBtn();
          // re-render the popover
          openBookmarkPopover(anchor);
        }
        return;
      }
      const row = e.target.closest && e.target.closest('.vrp-bm-row');
      if (row && row.dataset.jump) {
        const jt = parseFloat(row.dataset.jump);
        if (!isNaN(jt)) {
          setCurrentTime(jt + 0.01);
          play();
          showToast(`★ Jumped to sentence ${parseInt(row.dataset.idx, 10) + 1}`);
        }
      }
    });
    setTimeout(() => document.addEventListener('mousedown', outsideBookmarkClick, { once: true }), 0);
    setTimeout(() => document.addEventListener('keydown', escBookmarkClose, { once: true }), 0);
  }
  function closeBookmarkPopover() {
    if (bookmarkPopoverEl) { bookmarkPopoverEl.remove(); bookmarkPopoverEl = null; }
  }
  function outsideBookmarkClick(e) {
    if (!bookmarkPopoverEl) return;
    if (!bookmarkPopoverEl.contains(e.target) && !(e.target && e.target.closest && e.target.closest('#vrp-bookmark'))) {
      closeBookmarkPopover();
    } else {
      setTimeout(() => document.addEventListener('mousedown', outsideBookmarkClick, { once: true }), 0);
    }
  }
  function escBookmarkClose(e) {
    if (e.key === 'Escape' && bookmarkPopoverEl) { closeBookmarkPopover(); }
    else if (bookmarkPopoverEl) {
      setTimeout(() => document.addEventListener('keydown', escBookmarkClose, { once: true }), 0);
    }
  }

  // Visited sentences per video — Set<number> stored per videoId
  const VISITED_KEY = 'linglish.vrp.visited.v1';
  function loadVisitedMap() {
    try { return JSON.parse(localStorage.getItem(VISITED_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function getVisitedSet(videoId) {
    if (!videoId) return new Set();
    const map = loadVisitedMap();
    return new Set(map[String(videoId)] || []);
  }
  // Per-sentence repeat counter: { [videoId]: { [idx]: count } }
  const REPEATS_KEY = 'linglish.vrp.repeats.v1';
  function loadRepeatsMap() {
    try { return JSON.parse(localStorage.getItem(REPEATS_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function getRepeats(videoId) {
    if (!videoId) return {};
    const map = loadRepeatsMap();
    return map[String(videoId)] || {};
  }
  function bumpRepeat(videoId, idx) {
    if (!videoId || typeof idx !== 'number' || idx < 0) return 0;
    const map = loadRepeatsMap();
    const obj = map[String(videoId)] || {};
    obj[idx] = (obj[idx] || 0) + 1;
    map[String(videoId)] = obj;
    try { localStorage.setItem(REPEATS_KEY, JSON.stringify(map)); } catch (_) {}
    return obj[idx];
  }
  function decorateSegRepeat(idx, count) {
    const seg = document.querySelector(`#transcript-list .seg[data-index="${idx}"]`);
    if (!seg) return;
    let badge = seg.querySelector('.vrp-rep');
    if (count < 2) { if (badge) badge.remove(); return; }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'vrp-rep';
      badge.setAttribute('aria-hidden', 'true');
      seg.appendChild(badge);
    }
    badge.textContent = `×${count}`;
    badge.title = `Played ${count} times`;
    // Subtle pulse on bump
    badge.classList.remove('vrp-rep--bump');
    void badge.offsetWidth; // force reflow
    badge.classList.add('vrp-rep--bump');
  }
  function decorateAllRepeats() {
    const vid = getCurrentVideoId();
    if (!vid) return;
    const obj = getRepeats(vid);
    Object.keys(obj).forEach(k => decorateSegRepeat(parseInt(k, 10), obj[k]));
  }

  function markVisited(videoId, idx) {
    if (!videoId || typeof idx !== 'number' || idx < 0) return false;
    const map = loadVisitedMap();
    const list = map[String(videoId)] || [];
    if (list.includes(idx)) return false;
    list.push(idx);
    map[String(videoId)] = list;
    try { localStorage.setItem(VISITED_KEY, JSON.stringify(map)); } catch (_) {}
    return true;
  }

  // ---------- 3. Build the playback bar ------------------------------
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

  function svg(d, opts) {
    opts = opts || {};
    return `<svg class="${opts.cls || 'vrp-btn__icon'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  }
  function lx(name, fallbackInner) {
    if (typeof window !== 'undefined' && window.LxIcon && typeof window.LxIcon.html === 'function') {
      return window.LxIcon.html(name, { className: 'vrp-btn__icon lx-icon' });
    }
    return svg(fallbackInner);
  }
  const ICONS = {
    prev:    lx('prev', '<path d="M19 5v14l-10-7 10-7z"/><path d="M5 5v14"/>'),
    next:    lx('next', '<path d="M5 5v14l10-7L5 5z"/><path d="M19 5v14"/>'),
    replay:  lx('replay', '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 5v5h5"/>'),
    loop:    lx('loop', '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'),
    pause:   lx('pause', '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>'),
    speed:   lx('clock', '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    help:    lx('help', '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.7 2.2c-.8.5-1.2 1-1.2 2"/><path d="M12 17h.01"/>'),
  };

  function buildBar() {
    const wrap = document.querySelector('.player-wrap');
    if (!wrap) return null;
    if (document.getElementById('vrp-bar')) return document.getElementById('vrp-bar');

    const dock = document.createElement('div');
    dock.className = 'vrp-control-dock';
    dock.id = 'vrp-control-dock';
    dock.setAttribute('aria-label', 'Persistent video learning controls');

    const bar = document.createElement('div');
    bar.className = 'vrp-bar';
    bar.id = 'vrp-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Video learning controls');

    bar.innerHTML = `
      <div class="vrp-bar__group" role="group" aria-label="Sentence navigation">
        <button class="vrp-btn" id="vrp-prev"  type="button" title="上一句 (←)" aria-label="上一句"><span>上一句</span></button>
        <button class="vrp-btn" id="vrp-replay" type="button" title="重放当前句 (R)" aria-label="重放当前句"><span>重放</span></button>
        <button class="vrp-btn" id="vrp-next"  type="button" title="下一句 (→)" aria-label="下一句"><span>下一句</span></button>
      </div>

      <div class="vrp-bar__group" role="group" aria-label="Speed">
        <span class="vrp-bar__label">Speed</span>
        <div class="vrp-speed" id="vrp-speed">
          ${SPEEDS.map(s => {
            const full = s === 1 ? '1×' : s + '×';
            const short = s === 1 ? '1' : String(s).replace(/^0/, '');
            return `<button class="vrp-speed__btn" type="button" data-speed="${s}" aria-label="${full}" aria-pressed="${s === settings.rate}"><span class="vrp-speed__full">${full}</span><span class="vrp-speed__short">${short}</span></button>`;
          }).join('')}
        </div>
      </div>

      <button class="vrp-toggle" id="vrp-loop" type="button" aria-pressed="${loopActive()}" data-mode="${settings.loopMode || 0}" title="循环当前句：关闭 → 3次 → 5次 → 一直 (A)" aria-label="循环当前句">
        ${ICONS.loop}<span class="vrp-toggle__dot"></span><span class="vrp-toggle__label">${loopBtnLabel(false)}</span><span class="vrp-toggle__short">${loopShortLabel()}</span>
      </button>
      <button class="vrp-toggle" id="vrp-autopause"  type="button" aria-pressed="${!!settings.autoPauseAtEnd}" title="句末自动暂停 (P)" aria-label="句末自动暂停">
        <span class="vrp-toggle__dot"></span><span>句末暂停</span>
      </button>
      <button class="vrp-btn" id="vrp-pip" type="button" title="Picture-in-Picture (I)" aria-label="Picture-in-Picture">
        <svg class="vrp-btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" opacity="0.18"/></svg>
        <span class="vrp-pip__label">画中画</span>
      </button>

      <button class="vrp-ab-pill" id="vrp-ab-pill" type="button" data-state="off" style="display:none" title="Click to clear A↔B (B to set, B again to start, B again to clear)">
        <span class="vrp-ab-pill__dot" aria-hidden="true"></span>
        <span class="vrp-ab-pill__txt">A↔B</span>
        <span class="vrp-ab-pill__x" aria-hidden="true">×</span>
      </button>

      <div class="vrp-bar__spacer"></div>
      <div class="vrp-time" id="vrp-time" title="Current time / total" aria-label="Playback time">
        <span class="vrp-time__cur" id="vrp-time-cur">0:00</span>
        <span class="vrp-time__sep" aria-hidden="true">/</span>
        <span class="vrp-time__tot" id="vrp-time-tot">--:--</span>
      </div>
      <button class="vrp-btn vrp-btn--star" id="vrp-bookmark" type="button" title="Bookmark this sentence (S) · click ★ to open list">
        <span class="vrp-btn__icon vrp-bookmark__icon" aria-hidden="true">★</span>
        <span class="vrp-bookmark__count" id="vrp-bookmark-count">0</span>
      </button>
      <div class="vrp-studied" id="vrp-studied" title="Sentences studied in this video" aria-label="Sentences studied">
        <span class="vrp-studied__icon" aria-hidden="true">✓</span>
        <span class="vrp-studied__num"><span id="vrp-studied-x">0</span> / <span id="vrp-studied-y">0</span></span>
      </div>
      <div class="vrp-segpos" id="vrp-segpos" title="Position within current sentence" aria-label="Sentence progress">
        <span class="vrp-segpos__num"><span id="vrp-segpos-i">--</span> / <span id="vrp-segpos-n">--</span></span>
        <div class="vrp-segpos__track" aria-hidden="true"><div class="vrp-segpos__fill" id="vrp-segpos-fill"></div></div>
      </div>
      <button class="vrp-help-btn" id="vrp-help-btn" type="button" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button>
    `;

    // The player already has its own progress bar, so this dock is only the
    // sentence controls. Place it directly under the video, above 带教.
    dock.appendChild(bar);
    const caption = wrap.querySelector('#caption-bar');
    const meta = wrap.querySelector('#video-meta');
    if (caption) {
      wrap.insertBefore(dock, caption);
    } else if (meta) {
      wrap.insertBefore(dock, meta);
    } else {
      wrap.appendChild(dock);
    }

    // wire controls
    bar.querySelector('#vrp-prev').addEventListener('click', () => jumpSegments(-1));
    bar.querySelector('#vrp-next').addEventListener('click', () => jumpSegments(+1));
    bar.querySelector('#vrp-replay').addEventListener('click', replayCurrentSegment);
    bar.querySelectorAll('.vrp-speed__btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = parseFloat(btn.dataset.speed);
        const applied = setRate(r);
        settings.rate = applied; saveSettings();
        bar.querySelectorAll('.vrp-speed__btn').forEach(b => b.setAttribute('aria-pressed', String(parseFloat(b.dataset.speed) === applied)));
        showToast(`Speed ${applied}×`);
      });
    });
    bar.querySelector('#vrp-loop').addEventListener('click', cycleLoopMode);
    const apBtn = bar.querySelector('#vrp-autopause');
    apBtn.addEventListener('click', () => {
      settings.autoPauseAtEnd = !settings.autoPauseAtEnd;
      apBtn.setAttribute('aria-pressed', String(settings.autoPauseAtEnd));
      saveSettings();
      showToast(settings.autoPauseAtEnd ? '⏸ Auto-pause ON' : '⏸ Auto-pause OFF');
    });
    bar.querySelector('#vrp-help-btn').addEventListener('click', () => toggleHelp());
    const studiedEl = bar.querySelector('#vrp-studied');
    if (studiedEl) {
      studiedEl.style.cursor = 'pointer';
      studiedEl.setAttribute('role', 'button');
      studiedEl.setAttribute('tabindex', '0');
      const trigger = (e) => { if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return; if (e.preventDefault) e.preventDefault(); openStudiedPopover(studiedEl); };
      studiedEl.addEventListener('click', trigger);
      studiedEl.addEventListener('keydown', trigger);
    }
    const pipBtn = bar.querySelector('#vrp-pip');
    if (pipBtn) {
      pipBtn.addEventListener('click', togglePiP);
      // hide if PiP unsupported (or if YouTube embed — not supported via IFrame API)
      if (!supportsPiP()) pipBtn.style.display = 'none';
    }
    const abPill = bar.querySelector('#vrp-ab-pill');
    if (abPill) {
      abPill.addEventListener('click', () => clearABLoop());
    }
    const bmBtn = bar.querySelector('#vrp-bookmark');
    if (bmBtn) {
      // Click ★ icon = open list; click count area also opens list. Long-press / shift-click = toggle current.
      bmBtn.addEventListener('click', (e) => {
        if (e.shiftKey) { bookmarkCurrentSentence(); return; }
        openBookmarkPopover(bmBtn);
      });
      bmBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); bookmarkCurrentSentence(); });
    }

    // Apply persisted speed once player is ready
    if (settings.rate && settings.rate !== 1) setRate(settings.rate);

    return bar;
  }

  // ---------- 3b. Mini scrubber rail with sentence ticks ------------
  function buildScrubber() {
    if (document.getElementById('vrp-scrub')) return document.getElementById('vrp-scrub');
    const scrub = document.createElement('div');
    scrub.className = 'vrp-scrub';
    scrub.id = 'vrp-scrub';
    scrub.setAttribute('role', 'slider');
    scrub.setAttribute('aria-label', 'Scrub through video');
    scrub.setAttribute('tabindex', '0');
    scrub.innerHTML = `
      <div class="vrp-scrub__track" id="vrp-scrub-track">
        <div class="vrp-scrub__buffer" id="vrp-scrub-buffer"></div>
        <div class="vrp-scrub__fill"   id="vrp-scrub-fill"></div>
        <div class="vrp-scrub__ticks"  id="vrp-scrub-ticks"></div>
        <div class="vrp-scrub__bookmarks" id="vrp-scrub-bookmarks"></div>
        <div class="vrp-scrub__head"   id="vrp-scrub-head"></div>
        <div class="vrp-scrub__hover"  id="vrp-scrub-hover" hidden></div>
      </div>
    `;
    // click → seek
    const track = scrub.querySelector('#vrp-scrub-track');
    function seekFromEvent(e) {
      const dur = getDuration();
      if (!dur) return;
      const r = track.getBoundingClientRect();
      const x = (e.clientX || (e.touches && e.touches[0]?.clientX) || 0) - r.left;
      const pct = Math.min(1, Math.max(0, x / Math.max(1, r.width)));
      setCurrentTime(pct * dur);
      // small flash on seek
      track.classList.add('vrp-scrub--just-seeked');
      setTimeout(() => track.classList.remove('vrp-scrub--just-seeked'), 400);
    }
    track.addEventListener('click', seekFromEvent);
    // Hover preview chip
    const hover = scrub.querySelector('#vrp-scrub-hover');
    track.addEventListener('mousemove', (e) => {
      const dur = getDuration();
      if (!dur) return;
      const r = track.getBoundingClientRect();
      const x = e.clientX - r.left;
      const pct = Math.min(1, Math.max(0, x / Math.max(1, r.width)));
      const t = pct * dur;
      const segs = getSegments();
      let segLabel = '';
      if (segs.length) {
        // find seg containing this time
        let i = -1;
        for (let k = 0; k < segs.length; k++) {
          const st = segs[k].start_sec ?? segs[k].start ?? segs[k].startTime ?? 0;
          const en = segs[k].end_sec   ?? segs[k].end   ?? segs[k].endTime   ?? st + 1;
          if (t >= st && t <= en) { i = k; break; }
        }
        if (i < 0) {
          // nearest before
          for (let k = 0; k < segs.length; k++) {
            const st = segs[k].start_sec ?? segs[k].start ?? segs[k].startTime ?? 0;
            if (st > t) { i = Math.max(0, k - 1); break; }
          }
          if (i < 0) i = segs.length - 1;
        }
        segLabel = ` · ${i + 1}/${segs.length}`;
      }
      hover.textContent = `${fmtTimeShort(t)}${segLabel}`;
      hover.style.left = (x) + 'px';
      hover.removeAttribute('hidden');
    });
    track.addEventListener('mouseleave', () => hover.setAttribute('hidden', ''));
    // basic drag (mouse)
    let dragging = false;
    track.addEventListener('mousedown', (e) => { dragging = true; seekFromEvent(e); });
    document.addEventListener('mousemove', (e) => { if (dragging) seekFromEvent(e); });
    document.addEventListener('mouseup',   () => { dragging = false; });
    // keyboard ←/→ on the rail (only when focused)
    scrub.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); setCurrentTime(Math.max(0, getCurrentTime() - 5)); }
      if (e.key === 'ArrowRight') { e.preventDefault(); setCurrentTime(getCurrentTime() + 5); }
    });
    return scrub;
  }
  function renderScrubberTicks() {
    const ticks = document.getElementById('vrp-scrub-ticks');
    if (!ticks) return;
    const segs = getSegments();
    const dur = getDuration();
    if (!dur || !segs.length) { ticks.innerHTML = ''; return; }
    // Avoid re-rendering if signature unchanged
    const sig = `${getCurrentVideoId() || ''}:${segs.length}:${Math.round(dur)}`;
    if (ticks.dataset.sig === sig) return;
    ticks.dataset.sig = sig;
    // Cap to ~120 ticks for very long videos to keep DOM light
    const stride = Math.max(1, Math.ceil(segs.length / 120));
    const html = segs
      .filter((_, i) => i % stride === 0)
      .map((s) => {
        const st = s.start_sec ?? s.start ?? s.startTime ?? 0;
        const pct = Math.min(100, Math.max(0, (st / dur) * 100));
        return `<span class="vrp-scrub__tick" style="left:${pct.toFixed(2)}%"></span>`;
      })
      .join('');
    ticks.innerHTML = html;
  }
  function renderScrubberBookmarks() {
    const cont = document.getElementById('vrp-scrub-bookmarks');
    if (!cont) return;
    const dur = getDuration();
    const vid = getCurrentVideoId();
    if (!dur || !vid) { cont.innerHTML = ''; return; }
    const list = getBookmarks(vid);
    const sig = `${vid}:${list.length}:${list.map(b => b.idx + ':' + b.t).join(',')}:${Math.round(dur)}`;
    if (cont.dataset.sig === sig) return;
    cont.dataset.sig = sig;
    cont.innerHTML = list.map(b => {
      const pct = Math.min(100, Math.max(0, ((b.t || 0) / dur) * 100));
      return `<span class="vrp-scrub__bm" style="left:${pct.toFixed(2)}%" title="★ ${escapeHTML(b.txt || '').slice(0,80)}"></span>`;
    }).join('');
  }
  function updateScrubberHead(t) {
    const fill = document.getElementById('vrp-scrub-fill');
    const head = document.getElementById('vrp-scrub-head');
    if (!fill || !head) return;
    const dur = getDuration();
    if (!dur) { fill.style.width = '0%'; head.style.left = '0%'; return; }
    const pct = Math.min(100, Math.max(0, (t / dur) * 100));
    fill.style.width = pct.toFixed(2) + '%';
    head.style.left = pct.toFixed(2) + '%';
    // buffered (HTML5 only)
    try {
      const buf = document.getElementById('vrp-scrub-buffer');
      if (buf && playerEl && playerEl.buffered && playerEl.buffered.length) {
        const end = playerEl.buffered.end(playerEl.buffered.length - 1);
        buf.style.width = Math.min(100, (end / dur) * 100).toFixed(2) + '%';
      }
    } catch (_) { /* ignore */ }
  }

  // ---------- 4. Sentence loop / auto-pause loop driver --------------
  let lastSeenIdx = -1;
  let loopRemaining = settings.loopMode > 0 ? settings.loopMode - 1 : (settings.loopMode === -1 ? Infinity : 0);
  let lastSavedPosTs = 0;
  let lastResumedVideoId = null;

  // A-B Repeat (ephemeral, per-page-load — not persisted)
  // States: { a: number|null, b: number|null }
  // - a==null, b==null   → off
  // - a!=null, b==null   → A armed (waiting for B)
  // - a!=null, b!=null   → looping A→B
  let ab = { a: null, b: null };
  function abActive() { return ab.a != null && ab.b != null; }
  function abArmed()  { return ab.a != null && ab.b == null; }
  function fmtTimeShort(s) {
    s = Math.max(0, Math.floor(s));
    const m = Math.floor(s / 60), r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }
  function cycleABLoop() {
    const t = getCurrentTime();
    if (ab.a == null) {
      ab.a = t;
      showToast(`A → ${fmtTimeShort(ab.a)} · Press B again at the end`);
    } else if (ab.b == null) {
      // Ensure B > A by at least 0.4s
      if (t <= ab.a + 0.4) {
        showToast('B must be after A · try again');
        return;
      }
      ab.b = t;
      // Jump back to A and start playing
      setCurrentTime(ab.a + 0.01);
      play();
      showToast(`A↔B ${fmtTimeShort(ab.a)} → ${fmtTimeShort(ab.b)}`);
    } else {
      ab.a = null; ab.b = null;
      showToast('A↔B cleared');
    }
    paintABPill();
  }
  function clearABLoop(silent) {
    if (ab.a == null && ab.b == null) return;
    ab.a = null; ab.b = null;
    paintABPill();
    if (!silent) showToast('A↔B cleared');
  }
  function paintABPill() {
    const pill = document.getElementById('vrp-ab-pill');
    if (!pill) return;
    if (abActive()) {
      pill.style.display = '';
      pill.dataset.state = 'on';
      pill.querySelector('.vrp-ab-pill__txt').textContent = `A↔B ${fmtTimeShort(ab.a)}–${fmtTimeShort(ab.b)}`;
    } else if (abArmed()) {
      pill.style.display = '';
      pill.dataset.state = 'arm';
      pill.querySelector('.vrp-ab-pill__txt').textContent = `A ${fmtTimeShort(ab.a)} · ⌛ B?`;
    } else {
      pill.style.display = 'none';
      pill.dataset.state = 'off';
    }
  }
  function tick() {
    const t = getCurrentTime();

    // Per-video resume: detect new video & restore saved position once
    const vid = getCurrentVideoId();
    if (vid && vid !== lastResumedVideoId) {
      lastResumedVideoId = vid;
      // re-decorate transcript with this video's visited segments
      decorateAllVisited();
      decorateAllBookmarks();
      decorateAllRepeats();
      paintBookmarkBtn();
      refreshStudiedCounter(getSegments().length);
      const saved = getSavedPosition(vid);
      const dur = getDuration();
      // only restore if saved is meaningful and not near the very end / very start
      if (saved && saved > 5 && (!dur || saved < dur - 8)) {
        // give the player ~600ms to settle before seeking
        setTimeout(() => {
          if (getCurrentVideoId() === vid && getCurrentTime() < 4) {
            setCurrentTime(saved);
            const mm = Math.floor(saved / 60);
            const ss = String(Math.floor(saved % 60)).padStart(2, '0');
            showToast(`↪ 上次看到 ${mm}:${ss} · Resumed`);
          }
        }, 600);
      }
    }
    // Save position every ~5s while playing
    if (vid && !isPaused() && Date.now() - lastSavedPosTs > 5000) {
      savePosition(vid, t);
      lastSavedPosTs = Date.now();
    }

    const segs = getSegments();

    // Mini sentence progress strip update
    updateSegPosStrip(t, segs);

    // Refresh time readout + bookmark indicator
    updateTimeReadout(t);

    // Scrubber updates: head + fill always, ticks/bookmarks lazily by signature
    updateScrubberHead(t);
    renderScrubberTicks();
    renderScrubberBookmarks();

    // Echo replay: when current sentence ends, restore rate
    tickEchoReplay(t);

    // A-B Repeat takes precedence over sentence loop / auto-pause
    if (abActive()) {
      // If we drifted past B, jump back to A
      if (t > ab.b - 0.05) {
        setCurrentTime(ab.a + 0.01);
      } else if (t < ab.a - 0.5) {
        // If user scrubbed back well before A, snap forward to A
        setCurrentTime(ab.a + 0.01);
      }
      return;
    }

    if (!segs.length) return;
    const idx = segIdxByTime(t);

    // sentence loop: if we're past the end of the seg we entered, jump back to its start
    if (loopActive() && lastSeenIdx >= 0 && idx === -1) {
      const seg = segs[lastSeenIdx];
      const en = seg ? (seg.end_sec ?? seg.end ?? seg.endTime ?? 0) : 0;
      const st = seg ? (seg.start_sec ?? seg.start ?? seg.startTime ?? 0) : 0;
      if (en && t > en && t < en + 1.2) {
        if (loopRemaining > 0) {
          loopRemaining = loopRemaining === Infinity ? Infinity : (loopRemaining - 1);
          setCurrentTime(st + 0.01);
          // brief toast of remaining count for finite modes
          if (settings.loopMode > 0 && loopRemaining !== Infinity) {
            showToast(`↻ Loop ${settings.loopMode - loopRemaining}/${settings.loopMode}`);
          }
          return;
        } else {
          // counter exhausted — reset for next sentence
          loopRemaining = settings.loopMode > 0 ? settings.loopMode - 1 : (settings.loopMode === -1 ? Infinity : 0);
        }
      }
    }
    // auto-pause at end of sentence: pause once on the boundary
    if (settings.autoPauseAtEnd && lastSeenIdx >= 0 && idx === -1) {
      const seg = segs[lastSeenIdx];
      const en = seg ? (seg.end_sec ?? seg.end ?? seg.endTime ?? 0) : 0;
      if (en && t >= en && t < en + 0.6) {
        pause();
        showToast('⏸ Paused at end of sentence');
        // mute auto-pause for current sentence boundary so user can hit play
        lastSeenIdx = -2;
        return;
      }
    }
    if (idx >= 0 && idx !== lastSeenIdx) {
      lastSeenIdx = idx;
      // entered a new sentence — reset loop counter
      loopRemaining = settings.loopMode > 0 ? settings.loopMode - 1 : (settings.loopMode === -1 ? Infinity : 0);
      // mark active scrubber tick + smooth-scroll active seg into transcript view
      markActiveScrubberTick(idx);
      smoothScrollActiveSeg(idx);
      updateNextPreview(idx, segs);
      // bump repeat counter & decorate
      const vid = getCurrentVideoId();
      if (vid) {
        const c = bumpRepeat(vid, idx);
        decorateSegRepeat(idx, c);
      }
    } else if (idx >= 0) {
      lastSeenIdx = idx;
    }
  }
  function updateNextPreview(idx, segs) {
    const chip = ensureNextPreviewChip();
    if (!chip) return;
    const next = segs[idx + 1];
    if (!next) { chip.classList.remove('show'); chip.textContent = ''; return; }
    const txt = (next.text || next.en || next.english || '').toString().trim();
    if (!txt) { chip.classList.remove('show'); return; }
    chip.textContent = `Next · ${txt.slice(0, 120)}${txt.length > 120 ? '…' : ''}`;
    chip.classList.add('show');
  }
  let nextChipEl = null;
  function ensureNextPreviewChip() {
    if (nextChipEl && nextChipEl.parentNode) return nextChipEl;
    const wrap = document.querySelector('.player') || document.body;
    nextChipEl = document.createElement('div');
    nextChipEl.className = 'vrp-next-preview';
    nextChipEl.id = 'vrp-next-preview';
    nextChipEl.setAttribute('aria-hidden', 'true');
    wrap.appendChild(nextChipEl);
    return nextChipEl;
  }
  function markActiveScrubberTick(idx) {
    const ticks = document.querySelectorAll('#vrp-scrub-ticks .vrp-scrub__tick');
    if (!ticks.length) return;
    // Note: ticks may be subsampled when stride>1; find nearest by index ratio.
    const segs = getSegments();
    const stride = Math.max(1, Math.ceil(segs.length / 120));
    const tickIdx = Math.floor(idx / stride);
    ticks.forEach((el, i) => el.classList.toggle('vrp-scrub__tick--active', i === tickIdx));
  }
  let lastScrolledIdx = -1;
  let lastScrolledAt = 0;
  function smoothScrollActiveSeg(idx) {
    if (idx === lastScrolledIdx) return;
    // Throttle to one scroll per 800ms to avoid jank during fast loops
    const now = Date.now();
    if (now - lastScrolledAt < 800) return;
    lastScrolledIdx = idx;
    lastScrolledAt = now;
    const list = document.getElementById('transcript-list');
    if (!list) return;
    const target = list.querySelector(`.seg[data-index="${idx}"]`);
    if (!target) return;
    // Only auto-scroll if user is not actively interacting with the transcript
    if (list.dataset.vrpUserScroll === '1') return;
    try {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (_) { /* ignore */ }
  }
  // Detect manual scroll on the transcript and pause auto-scroll for 5s
  function attachTranscriptScrollGuard() {
    const list = document.getElementById('transcript-list');
    if (!list || list.dataset.vrpScrollGuard) return;
    list.dataset.vrpScrollGuard = '1';
    let timer;
    list.addEventListener('wheel',     () => { list.dataset.vrpUserScroll = '1'; clearTimeout(timer); timer = setTimeout(() => { delete list.dataset.vrpUserScroll; }, 5000); }, { passive: true });
    list.addEventListener('touchmove', () => { list.dataset.vrpUserScroll = '1'; clearTimeout(timer); timer = setTimeout(() => { delete list.dataset.vrpUserScroll; }, 5000); }, { passive: true });
  }
  let lastTruthfulPlaybackTime = 0;
  function updateSegPosStrip(t, segs) {
    const fill = document.getElementById('vrp-segpos-fill');
    const iEl = document.getElementById('vrp-segpos-i');
    const nEl = document.getElementById('vrp-segpos-n');
    if (!fill || !iEl || !nEl) return;
    const total = segs.length;
    nEl.textContent = total ? String(total) : '--';
    // also update studied counter
    refreshStudiedCounter(total);
    if (!total) { iEl.textContent = '--'; fill.style.width = '0%'; return; }
    const idx = segIdxByTime(t);
    if (idx < 0) {
      iEl.textContent = '–';
      fill.style.width = '0%';
      return;
    }
    iEl.textContent = String(idx + 1);
    const seg = segs[idx];
    const st = seg.start_sec ?? seg.start ?? seg.startTime ?? 0;
    const en = seg.end_sec ?? seg.end ?? seg.endTime ?? (st + 0.001);
    const span = Math.max(0.001, en - st);
    const pct = Math.min(100, Math.max(0, ((t - st) / span) * 100));
    fill.style.width = pct.toFixed(1) + '%';
    const forwardPlayback = !isPaused() && t > lastTruthfulPlaybackTime && (t - lastTruthfulPlaybackTime) < 1.25;
    lastTruthfulPlaybackTime = t;
    // Heard is distinct from practiced in the first lesson. Only continuous
    // forward playback can mark heard; ordinary mode retains visited behavior.
    if (pct >= 50) {
      const vid = getCurrentVideoId();
      if (firstLessonIsActive() && typeof firstLesson.markHeard === 'function') {
        firstLesson.markHeard(idx, {
          source: 'playback',
          forward: forwardPlayback,
          fraction: pct / 100,
        });
        refreshStudiedCounter(total);
      } else if (vid && markVisited(vid, idx)) {
        decorateVisitedSeg(idx);
        refreshStudiedCounter(total);
      }
    }
  }
  function updateTimeReadout(t) {
    const cur = document.getElementById('vrp-time-cur');
    const tot = document.getElementById('vrp-time-tot');
    if (!cur || !tot) return;
    cur.textContent = fmtTimeShort(t);
    const d = getDuration();
    tot.textContent = d > 0 ? fmtTimeShort(d) : '--:--';
    // Also keep bookmark "current" state up-to-date
    const btn = document.getElementById('vrp-bookmark');
    if (btn) {
      const vid = getCurrentVideoId();
      const idx = segIdxByTime(t);
      btn.classList.toggle('vrp-btn--star--current', !!(vid && idx >= 0 && isBookmarked(vid, idx)));
    }
  }
  function decorateVisitedSeg(idx) {
    const list = document.getElementById('transcript-list');
    if (!list) return;
    const target = list.querySelector(`.seg[data-index="${idx}"]`);
    if (target && !target.classList.contains('vrp-visited')) {
      target.classList.add('vrp-visited');
    }
  }
  function decorateAllVisited() {
    const vid = getCurrentVideoId();
    if (!vid) return;
    const visited = getVisitedSet(vid);
    if (!visited.size) return;
    const list = document.getElementById('transcript-list');
    if (!list) return;
    visited.forEach(i => {
      const target = list.querySelector(`.seg[data-index="${i}"]`);
      if (target && !target.classList.contains('vrp-visited')) target.classList.add('vrp-visited');
    });
  }
  function resetVisitedForCurrentVideo() {
    const vid = getCurrentVideoId();
    if (!vid) return;
    try {
      const map = JSON.parse(localStorage.getItem(VISITED_KEY) || '{}') || {};
      delete map[String(vid)];
      localStorage.setItem(VISITED_KEY, JSON.stringify(map));
    } catch (_) { /* ignore */ }
    document.querySelectorAll('#transcript-list .seg.vrp-visited').forEach(el => el.classList.remove('vrp-visited'));
    refreshStudiedCounter(getSegments().length);
    showToast('🔄 Visited reset');
  }
  let studiedPopoverEl = null;
  function openStudiedPopover(anchor) {
    closeStudiedPopover();
    const vid = getCurrentVideoId();
    if (!vid) { showToast('Pick a video first'); return; }
    const cnt = getVisitedSet(vid).size;
    if (cnt === 0) { showToast('Nothing to reset yet'); return; }
    const total = getSegments().length || 0;
    studiedPopoverEl = document.createElement('div');
    studiedPopoverEl.className = 'vrp-studied-pop';
    studiedPopoverEl.setAttribute('role', 'dialog');
    studiedPopoverEl.innerHTML = `
      <div class="vrp-studied-pop__head">已学 <b>${cnt}</b> / ${total} 句</div>
      <div class="vrp-studied-pop__body">清空当前视频的「已学」标记？</div>
      <div class="vrp-studied-pop__row">
        <button class="vrp-studied-pop__btn vrp-studied-pop__btn--ghost" data-act="cancel" type="button">取消</button>
        <button class="vrp-studied-pop__btn vrp-studied-pop__btn--danger" data-act="reset" type="button">重置</button>
      </div>
    `;
    document.body.appendChild(studiedPopoverEl);
    // position below the anchor
    const r = anchor.getBoundingClientRect();
    const pop = studiedPopoverEl.getBoundingClientRect();
    let left = Math.max(8, Math.min(window.innerWidth - pop.width - 8, r.left + r.width / 2 - pop.width / 2));
    let top = r.bottom + 8;
    if (top + pop.height > window.innerHeight - 8) top = r.top - pop.height - 8;
    studiedPopoverEl.style.left = left + 'px';
    studiedPopoverEl.style.top = top + 'px';
    requestAnimationFrame(() => studiedPopoverEl && studiedPopoverEl.classList.add('show'));
    studiedPopoverEl.addEventListener('click', (e) => {
      const act = e.target && e.target.dataset && e.target.dataset.act;
      if (act === 'reset') { resetVisitedForCurrentVideo(); closeStudiedPopover(); }
      else if (act === 'cancel') { closeStudiedPopover(); }
    });
    setTimeout(() => document.addEventListener('mousedown', outsideStudiedClick, { once: true }), 0);
    setTimeout(() => document.addEventListener('keydown', escStudiedClose, { once: true }), 0);
  }
  function closeStudiedPopover() {
    if (studiedPopoverEl) { studiedPopoverEl.remove(); studiedPopoverEl = null; }
  }
  function outsideStudiedClick(e) {
    if (!studiedPopoverEl) return;
    if (!studiedPopoverEl.contains(e.target) && !(e.target && e.target.closest && e.target.closest('#vrp-studied'))) {
      closeStudiedPopover();
    } else {
      // re-arm
      setTimeout(() => document.addEventListener('mousedown', outsideStudiedClick, { once: true }), 0);
    }
  }
  function escStudiedClose(e) {
    if (e.key === 'Escape' && studiedPopoverEl) { closeStudiedPopover(); }
    else if (studiedPopoverEl) {
      setTimeout(() => document.addEventListener('keydown', escStudiedClose, { once: true }), 0);
    }
  }
  function refreshStudiedCounter(total) {
    const x = document.getElementById('vrp-studied-x');
    const y = document.getElementById('vrp-studied-y');
    if (!x || !y) return;
    const vid = getCurrentVideoId();
    const practiceSnapshot = firstLessonIsActive() && typeof firstLesson.snapshot === 'function'
      ? firstLesson.snapshot()
      : null;
    const cnt = practiceSnapshot ? practiceSnapshot.practicedCount : (vid ? getVisitedSet(vid).size : 0);
    if (practiceSnapshot) total = practiceSnapshot.total;
    x.textContent = String(cnt);
    y.textContent = total ? String(total) : '0';
    const wrap = document.getElementById('vrp-studied');
    if (wrap) {
      const done = total > 0 && cnt >= total;
      wrap.classList.toggle('vrp-studied--done', !!done);
    }
  }
  // Save final position when leaving the page
  window.addEventListener('beforeunload', () => {
    const vid = getCurrentVideoId();
    if (vid) try { savePosition(vid, getCurrentTime()); } catch (_) {}
  });
  setInterval(tick, 200);

  // ---------- 4b. Rewind-on-resume after pause (Plex/Netflix UX) ----
  // When the user pauses for more than 2 seconds and resumes, seek back
  // ~1.5s so they don't miss the last bit of audio context. Skip the
  // rewind for momentary pauses (likely keyboard scrubs).
  const REWIND_AFTER_MS = 2000;
  const REWIND_AMOUNT_S = 1.5;
  let lastPauseAt = 0;
  let suppressNextRewind = false;
  function attachResumeRewind() {
    if (!playerEl || playerEl.tagName !== 'VIDEO') return;
    if (playerEl.dataset.vrpResumeRewindAttached) return;
    playerEl.dataset.vrpResumeRewindAttached = '1';
    playerEl.addEventListener('pause', () => { lastPauseAt = Date.now(); });
    playerEl.addEventListener('play', () => {
      if (suppressNextRewind) { suppressNextRewind = false; lastPauseAt = 0; return; }
      const dt = Date.now() - lastPauseAt;
      if (lastPauseAt && dt > REWIND_AFTER_MS) {
        const t = playerEl.currentTime || 0;
        const next = Math.max(0, t - REWIND_AMOUNT_S);
        try { playerEl.currentTime = next; } catch (_) {}
        showToast('↺ Caught you up · −1.5s');
      }
      lastPauseAt = 0;
    });
    // seek/ratechange shouldn't trigger rewind
    playerEl.addEventListener('seeking', () => { suppressNextRewind = true; });
  }
  attachResumeRewind();

  // ---------- 5. Toast --------------------------------------------------
  let toastEl = null;
  let toastTimer = null;
  function showToast(text) {
    const wrap = document.querySelector('.player') || document.body;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'vrp-toast';
      wrap.appendChild(toastEl);
    } else if (toastEl.parentNode !== wrap) {
      wrap.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl && toastEl.classList.remove('show'); }, 1100);
  }

  // ---------- 6. Help overlay --------------------------------------
  let helpEl = null;
  const SHORTCUTS = [
    {
      title: 'Playback',
      rows: [
        { keys: ['Space'], label: 'Play / pause' },
        { keys: ['K'],     label: 'Play / pause (alt)' },
        { keys: ['J'],     label: 'Back 5 seconds' },
        { keys: ['L'],     label: 'Forward 5 seconds' },
        { keys: [','],     label: 'Back 1 second (frame nudge)' },
        { keys: ['.'],     label: 'Forward 1 second (frame nudge)' },
      ],
    },
    {
      title: 'Sentence',
      rows: [
        { keys: ['←'],         label: '上一句 / Previous sentence' },
        { keys: ['→'],         label: '下一句 / Next sentence' },
        { keys: ['R'],          label: 'Replay current sentence' },
        { keys: ['E'],          label: 'Echo: replay current sentence at 0.5×' },
        { keys: ['A'],          label: 'Cycle loop: off → ×3 → ×5 → ∞' },
        { keys: ['P'],          label: 'Toggle auto-pause at end' },
        { keys: ['B'],          label: 'A↔B repeat: B = A, B again = B, B = clear' },
        { keys: ['S'],          label: 'Bookmark / unbookmark this sentence' },
        { keys: ['Shift', 'S'], label: 'Toggle bookmarks-only filter view' },
        { keys: ['N'],          label: 'Jump to next bookmark' },
        { keys: ['Shift', 'N'], label: 'Jump to previous bookmark' },
        { keys: ['G', '+', 'N'], label: 'Jump to sentence N (e.g. G 1 5 Enter)' },
      ],
    },
    {
      title: 'Speed',
      rows: [
        { keys: ['['],  label: 'Slow down (−0.25×)' },
        { keys: [']'],  label: 'Speed up (+0.25×)' },
        { keys: ['\\'], label: 'Reset to 1×' },
      ],
    },
    {
      title: 'View',
      rows: [
        { keys: ['T'],          label: 'Toggle bilingual / translation' },
        { keys: ['D'],          label: 'Dictation mode (hide EN, click to peek)' },
        { keys: ['Z'],          label: 'Cinema mode (dim everything but the player)' },
        { keys: ['+'],          label: 'Subtitle text bigger' },
        { keys: ['−'],          label: 'Subtitle text smaller' },
        { keys: ['F'],          label: 'Fullscreen' },
        { keys: ['I'],          label: 'Picture-in-Picture' },
        { keys: ['Y'],          label: 'Copy current subtitle' },
        { keys: ['M'],          label: 'Mute / unmute' },
        { keys: ['↑'],          label: 'Volume +10%' },
        { keys: ['↓'],          label: 'Volume −10%' },
        { keys: ['0'], label: 'Jump to start' },
        { keys: ['1', '–', '9'], label: 'Jump to 10% – 90%' },
        { keys: ['/'],          label: 'Search transcript (Enter for next, Shift+Enter prev)' },
        { keys: ['?'],          label: 'Show / hide this help' },
      ],
    },
  ];
  function buildHelp() {
    if (helpEl) return helpEl;
    helpEl = document.createElement('div');
    helpEl.className = 'vrp-help-overlay';
    helpEl.id = 'vrp-help-overlay';
    helpEl.setAttribute('role', 'dialog');
    helpEl.setAttribute('aria-modal', 'true');
    helpEl.setAttribute('aria-labelledby', 'vrp-help-title');

    const sectionsHTML = SHORTCUTS.map(sec => `
      <div class="vrp-help-section">
        <div class="vrp-help-section__title">${escapeHTML(sec.title)}</div>
        ${sec.rows.map(r => `
          <div class="vrp-help-row">
            <div class="vrp-help-row__label">${escapeHTML(r.label)}</div>
            <div class="vrp-help-keys">
              ${r.keys.map(k => k === '–' ? '<span aria-hidden="true">–</span>' : `<span class="vrp-kbd${k.length > 2 ? ' vrp-kbd--wide' : ''}">${escapeHTML(k)}</span>`).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `).join('');

    helpEl.innerHTML = `
      <div class="vrp-help-card" role="document">
        <div class="vrp-help-head">
          <div class="vrp-help-title" id="vrp-help-title">
            <span class="vrp-help-title__badge">PRO</span>
            键盘快捷键 · Keyboard shortcuts
          </div>
          <button class="vrp-help-close" id="vrp-help-close" type="button" aria-label="Close shortcuts">×</button>
        </div>
        <div class="vrp-help-grid">${sectionsHTML}</div>
        <div class="vrp-help-foot">
          <span class="vrp-kbd">?</span><span>or</span><span class="vrp-kbd">H</span><span>anywhere on the page to reopen.</span>
        </div>
      </div>
    `;
    document.body.appendChild(helpEl);
    helpEl.addEventListener('click', (e) => {
      if (e.target === helpEl) toggleHelp(false);
    });
    helpEl.querySelector('#vrp-help-close').addEventListener('click', () => toggleHelp(false));
    return helpEl;
  }
  function toggleHelp(force) {
    const el = buildHelp();
    const next = (typeof force === 'boolean') ? force : !el.classList.contains('show');
    el.classList.toggle('show', next);
  }
  function escapeHTML(s) { return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

  // ---------- 7. Polished empty / loading states -------------------
  function upgradeEmptyAndSkeleton() {
    // Replace bland transcript empty state with a shimmer skeleton until real segments arrive
    const list = document.getElementById('transcript-list');
    if (list && !list.dataset.vrpSkeletonInjected) {
      let lastDecoratedSig = '';
      const observer = new MutationObserver(() => {
        const segCount = list.querySelectorAll('.seg').length;
        const empty = list.querySelector('.empty');
        if (segCount === 0 && empty) {
          // page already showed empty state — do nothing
          return;
        }
        // After segs render or change, repaint visited markers
        const sig = `${getCurrentVideoId() || ''}:${segCount}`;
        if (sig !== lastDecoratedSig) {
          lastDecoratedSig = sig;
          decorateAllVisited();
          decorateAllBookmarks();
          decorateAllRepeats();
          paintBookmarkBtn();
          refreshStudiedCounter(segCount);
        }
      });
      observer.observe(list, { childList: true, subtree: false });
      list.dataset.vrpSkeletonInjected = '1';
      // initial: if list is empty AND no <div class="empty"> child, inject skeleton
      if (!list.children.length || (list.children.length === 1 && list.firstElementChild.classList.contains('empty'))) {
        const skel = document.createElement('div');
        skel.className = 'vrp-skeleton-list';
        skel.innerHTML = Array.from({ length: 5 }).map(() => `
          <div class="vrp-skeleton-row">
            <div class="vrp-skeleton h-3"></div>
            <div class="vrp-skeleton h-4"></div>
            <div class="vrp-skeleton h-4--short h-4"></div>
          </div>
        `).join('');
        // only show if there's no real content — guard against race
        if (!list.querySelector('.seg')) {
          // overlay the empty <div class="empty">…</div> if present
          const existingEmpty = list.querySelector('.empty');
          if (existingEmpty) existingEmpty.style.display = 'none';
          list.appendChild(skel);
          // remove skeleton once segs render
          const killSkel = new MutationObserver(() => {
            if (list.querySelector('.seg')) {
              skel.remove();
              if (existingEmpty) existingEmpty.style.display = '';
              killSkel.disconnect();
            }
          });
          killSkel.observe(list, { childList: true, subtree: false });
        }
      }
    }

    // Refresh "select a video" empty state inside the active subtitle
    const sub = document.getElementById('active-subtitle');
    if (sub && /选择视频后显示当前字幕|Select a video/i.test(sub.textContent || '')) {
      sub.innerHTML = `
        <div class="vrp-empty-art">
          <div class="vrp-empty-art__glyph">🎬</div>
          <div class="vrp-empty-art__title">从左侧挑一段视频开始学习</div>
          <div class="vrp-empty-art__hint">选好视频后，这里会显示当前播放的字幕。点击单词可即时查词。</div>
        </div>
      `;
      // when host script later overwrites this with real subtitle, that's fine
    }
  }

  // ---------- 8. Keyboard shortcuts --------------------------------
  function isTypingTarget(el) {
    if (!el) return false;
    if (el.closest?.('.topbar')) return true;
    if (el.closest?.('.goal-studio')) return true;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'summary') return true;
    if (el.getAttribute?.('role') === 'slider') return true;
    if (el.isContentEditable) return true;
    return false;
  }
  // Toggle bilingual: try to click the existing #mode-bilingual / #mode-en buttons
  function toggleBilingual() {
    settings.bilingualOn = !settings.bilingualOn; saveSettings();
    const btn = document.getElementById(settings.bilingualOn ? 'mode-bilingual' : 'mode-en');
    if (btn) btn.click();
    showToast(settings.bilingualOn ? '🌐 双语字幕 ON' : '🌐 英文字幕');
  }
  function speedNudge(delta) {
    const next = setRate(getRate() + delta);
    settings.rate = next; saveSettings();
    const bar = document.getElementById('vrp-bar');
    if (bar) bar.querySelectorAll('.vrp-speed__btn').forEach(b => b.setAttribute('aria-pressed', String(parseFloat(b.dataset.speed) === next)));
    showToast(`Speed ${next}×`);
  }
  function speedReset() {
    setRate(1); settings.rate = 1; saveSettings();
    const bar = document.getElementById('vrp-bar');
    if (bar) bar.querySelectorAll('.vrp-speed__btn').forEach(b => b.setAttribute('aria-pressed', String(parseFloat(b.dataset.speed) === 1)));
    showToast('Speed 1×');
  }
  function copyCurrentSubtitle() {
    const segs = getSegments();
    const t = getCurrentTime();
    const idx = segIdxByTime(t);
    let text = '';
    if (idx >= 0 && segs[idx]) {
      const seg = segs[idx];
      text = (seg.text_en || seg.text || seg.en || seg.text_original || '').trim();
    }
    if (!text) {
      // fallback: read from #active-subtitle dock
      const sub = document.getElementById('active-subtitle');
      if (sub) text = (sub.innerText || sub.textContent || '').trim();
    }
    if (!text) { showToast('No subtitle to copy'); return; }
    const doneToast = (snippet) => showToast(`📋 Copied · "${snippet.length > 38 ? snippet.slice(0, 38) + '…' : snippet}"`);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => doneToast(text), () => fallbackCopy(text, doneToast));
    } else {
      fallbackCopy(text, doneToast);
    }
  }
  function fallbackCopy(text, ondone) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      ondone(text);
    } catch (_) {
      showToast('Copy failed');
    }
  }
  // ---------- Transcript search (press / to open) -----------------------
  const search = { open: false, results: [], cursor: -1, el: null, input: null, status: null };
  function openSearch() {
    if (search.el && search.el.classList.contains('show')) {
      search.input?.focus();
      return;
    }
    if (!search.el) buildSearch();
    search.el.classList.add('show');
    search.open = true;
    search.input.value = '';
    search.input.focus();
    runSearch('');
  }
  function closeSearch() {
    if (!search.el) return;
    search.el.classList.remove('show');
    search.open = false;
    // Clear visual highlights
    document.querySelectorAll('#transcript-list .seg.vrp-search-hit, #transcript-list .seg.vrp-search-current')
      .forEach(el => el.classList.remove('vrp-search-hit', 'vrp-search-current'));
  }
  function buildSearch() {
    const box = document.createElement('div');
    box.className = 'vrp-search';
    box.id = 'vrp-search';
    box.setAttribute('role', 'search');
    box.innerHTML = `
      <div class="vrp-search__inner">
        <span class="vrp-search__icon" aria-hidden="true">🔎</span>
        <input id="vrp-search-input" type="text" placeholder="Search transcript… (Enter, ↓ next · Shift+Enter, ↑ prev · Esc close)" aria-label="Search transcript" autocomplete="off" spellcheck="false" />
        <span class="vrp-search__status" id="vrp-search-status">Press / anywhere to reopen</span>
        <button type="button" class="vrp-search__close" id="vrp-search-close" aria-label="Close search">×</button>
      </div>
    `;
    document.body.appendChild(box);
    search.el = box;
    search.input = box.querySelector('#vrp-search-input');
    search.status = box.querySelector('#vrp-search-status');
    box.querySelector('#vrp-search-close').addEventListener('click', closeSearch);
    let debounceTimer;
    search.input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runSearch(search.input.value), 80);
    });
    search.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeSearch(); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) cycleSearch(-1); else cycleSearch(+1);
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); cycleSearch(+1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); cycleSearch(-1); return; }
    });
  }
  function runSearch(query) {
    const q = (query || '').trim().toLowerCase();
    document.querySelectorAll('#transcript-list .seg.vrp-search-hit, #transcript-list .seg.vrp-search-current')
      .forEach(el => el.classList.remove('vrp-search-hit', 'vrp-search-current'));
    if (!q) {
      search.results = [];
      search.cursor = -1;
      search.status.textContent = 'Type to search…';
      return;
    }
    const segs = getSegments();
    const hits = [];
    for (let i = 0; i < segs.length; i++) {
      const txt = ((segs[i].text || segs[i].en || segs[i].english || '') + '').toLowerCase();
      if (txt.includes(q)) hits.push(i);
    }
    search.results = hits;
    search.cursor = hits.length ? 0 : -1;
    // paint hits
    hits.forEach(idx => {
      const seg = document.querySelector(`#transcript-list .seg[data-index="${idx}"]`);
      if (seg) seg.classList.add('vrp-search-hit');
    });
    if (hits.length) {
      search.status.textContent = `${hits.length} match${hits.length === 1 ? '' : 'es'} · ↓ to step`;
      // Highlight first but don't seek (let user opt in via Enter)
      const seg = document.querySelector(`#transcript-list .seg[data-index="${hits[0]}"]`);
      if (seg) seg.classList.add('vrp-search-current');
    } else {
      search.status.textContent = 'No matches';
    }
  }
  function cycleSearch(delta) {
    if (!search.results.length) return;
    search.cursor = (search.cursor + delta + search.results.length) % search.results.length;
    document.querySelectorAll('#transcript-list .seg.vrp-search-current')
      .forEach(el => el.classList.remove('vrp-search-current'));
    const idx = search.results[search.cursor];
    const seg = document.querySelector(`#transcript-list .seg[data-index="${idx}"]`);
    if (seg) {
      seg.classList.add('vrp-search-current');
      try { seg.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
    }
    jumpToSegment(idx + 1);
    search.status.textContent = `${search.cursor + 1} / ${search.results.length} matches`;
    // keep focus on input
    search.input.focus();
  }

  function supportsPiP() {
    // YouTube IFrame doesn't expose PiP through its API; only HTMLVideoElement supports it
    if (getPlayerType() === 'youtube') return false;
    if (!playerEl || playerEl.tagName !== 'VIDEO') return false;
    if (playerEl.disablePictureInPicture) return false;
    return !!document.pictureInPictureEnabled || typeof playerEl.requestPictureInPicture === 'function';
  }
  async function togglePiP() {
    if (!supportsPiP()) {
      showToast('PiP not supported here');
      return;
    }
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        showToast('▢ Exited PiP');
      } else {
        await playerEl.requestPictureInPicture();
        showToast('▣ Picture-in-Picture');
      }
    } catch (e) {
      console.warn('[VRP] PiP toggle failed:', e);
      showToast('PiP unavailable');
    }
  }
  function volumeNudge(delta) {
    const yt = getYT();
    let next;
    if (getPlayerType() === 'youtube' && yt && typeof yt.getVolume === 'function') {
      // YouTube volume is 0..100
      const cur = (typeof yt.getVolume === 'function' ? yt.getVolume() : 100) / 100;
      next = Math.max(0, Math.min(1, cur + delta));
      try { yt.setVolume(Math.round(next * 100)); } catch (_) { /* ignore */ }
      try { if (next > 0 && yt.isMuted && yt.isMuted()) yt.unMute(); } catch (_) { /* ignore */ }
    } else {
      const cur = (typeof playerEl.volume === 'number') ? playerEl.volume : 1;
      next = Math.max(0, Math.min(1, cur + delta));
      try { playerEl.volume = next; } catch (_) { /* ignore */ }
      try { if (next > 0 && playerEl.muted) playerEl.muted = false; } catch (_) { /* ignore */ }
    }
    const pct = Math.round(next * 100);
    showToast(`${next === 0 ? '🔇' : pct < 35 ? '🔈' : pct < 70 ? '🔉' : '🔊'} Volume ${pct}%`);
  }

  // Vim-style sentence jump: g, then digits, then Enter (or auto-commit after 1.4s)
  const gJump = { active: false, buffer: '', timer: null, hint: null };
  function showGJumpHint() {
    if (!gJump.hint) {
      gJump.hint = document.createElement('div');
      gJump.hint.className = 'vrp-gjump';
      gJump.hint.id = 'vrp-gjump';
      document.body.appendChild(gJump.hint);
    }
    const segs = getSegments();
    const total = segs.length || '?';
    const txt = gJump.buffer || '_';
    gJump.hint.textContent = `Jump → sentence ${txt}/${total}  (Enter to confirm · Esc to cancel)`;
    gJump.hint.classList.add('show');
  }
  function hideGJumpHint() {
    if (gJump.hint) gJump.hint.classList.remove('show');
  }
  function commitGJump() {
    if (gJump.buffer) {
      const n = parseInt(gJump.buffer, 10);
      if (!isNaN(n) && n > 0) jumpToSegment(n);
    }
    cancelGJump();
  }
  function cancelGJump() {
    gJump.active = false;
    gJump.buffer = '';
    if (gJump.timer) { clearTimeout(gJump.timer); gJump.timer = null; }
    hideGJumpHint();
  }
  function bumpGJumpTimer() {
    if (gJump.timer) clearTimeout(gJump.timer);
    gJump.timer = setTimeout(commitGJump, 1400);
  }

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;

    // Vim-style g+N sentence jump (intercept before other handlers)
    if (gJump.active) {
      if (e.key === 'Escape') { e.preventDefault(); cancelGJump(); return; }
      if (e.key === 'Enter')  { e.preventDefault(); commitGJump(); return; }
      if (e.key === 'Backspace') {
        e.preventDefault();
        gJump.buffer = gJump.buffer.slice(0, -1);
        if (!gJump.buffer) { cancelGJump(); return; }
        showGJumpHint(); bumpGJumpTimer(); return;
      }
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        gJump.buffer = (gJump.buffer + e.key).slice(0, 5);
        showGJumpHint(); bumpGJumpTimer(); return;
      }
      // Any other key cancels
      cancelGJump();
      // fall through so the key still works (e.g., Space to play)
    }
    if (!gJump.active && (e.key === 'g' || e.key === 'G') && !e.shiftKey) {
      e.preventDefault();
      gJump.active = true;
      gJump.buffer = '';
      showGJumpHint();
      bumpGJumpTimer();
      return;
    }

    // ? always works (Shift+/ on US layouts) — unshifted / opens search
    if (e.key === '?' || (e.shiftKey && e.key === '/') || e.key === 'h' || e.key === 'H') {
      e.preventDefault();
      toggleHelp();
      return;
    }
    if (e.key === '/' && !e.shiftKey) {
      e.preventDefault();
      openSearch();
      return;
    }
    // Esc closes help, or clears A-B if no help open
    if (e.key === 'Escape') {
      const open = document.querySelector('.vrp-help-overlay.show');
      if (open) { e.preventDefault(); toggleHelp(false); return; }
      if (abActive() || abArmed()) { e.preventDefault(); clearABLoop(); return; }
    }

    // Sentence nav
    if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      jumpSegments(e.key === 'ArrowRight' ? +1 : -1);
      return;
    }

    switch (e.key) {
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        if (!e.repeat) togglePlay();
        return;
      case 'k': case 'K':
        e.preventDefault(); togglePlay(); return;
      case 'j': case 'J':
        e.preventDefault(); setCurrentTime(Math.max(0, getCurrentTime() - 5)); showToast('⏪ −5s'); return;
      case 'l': case 'L':
        e.preventDefault(); setCurrentTime(getCurrentTime() + 5); showToast('⏩ +5s'); return;
      case ',': case '<':
        e.preventDefault(); setCurrentTime(Math.max(0, getCurrentTime() - 1)); showToast('⏪ −1s'); return;
      case '.': case '>':
        e.preventDefault(); setCurrentTime(getCurrentTime() + 1); showToast('⏩ +1s'); return;
      case 'ArrowLeft':
        e.preventDefault(); jumpSegments(-1); return;
      case 'ArrowRight':
        e.preventDefault(); jumpSegments(+1); return;
      case 'r': case 'R':
        e.preventDefault(); replayCurrentSegment(); return;
      case 'e': case 'E':
        e.preventDefault(); startEchoReplay(); return;
      case 'a': case 'A':
        e.preventDefault(); cycleLoopMode(); return;
      case 'b': case 'B':
        e.preventDefault(); cycleABLoop(); return;
      case 's': case 'S':
        e.preventDefault();
        if (e.shiftKey) toggleBookmarksOnly();
        else bookmarkCurrentSentence();
        return;
      case 'n': case 'N':
        e.preventDefault();
        jumpToBookmark(e.shiftKey ? -1 : +1);
        return;
      case 'd': case 'D':
        e.preventDefault(); toggleDictationMode(); return;
      case 'z': case 'Z':
        e.preventDefault(); toggleCinemaMode(); return;
      case '=': case '+':
        e.preventDefault(); nudgeSubtitleScale(+1); return;
      case '-': case '_':
        e.preventDefault(); nudgeSubtitleScale(-1); return;
      case 'p': case 'P': {
        e.preventDefault();
        settings.autoPauseAtEnd = !settings.autoPauseAtEnd; saveSettings();
        const btn = document.getElementById('vrp-autopause');
        if (btn) btn.setAttribute('aria-pressed', String(settings.autoPauseAtEnd));
        showToast(settings.autoPauseAtEnd ? '⏸ Auto-pause ON' : '⏸ Auto-pause OFF');
        return;
      }
      case '[':
        e.preventDefault(); speedNudge(-0.25); return;
      case ']':
        e.preventDefault(); speedNudge(+0.25); return;
      case '\\':
        e.preventDefault(); speedReset(); return;
      case 't': case 'T':
        e.preventDefault(); toggleBilingual(); return;
      case 'f': case 'F':
        e.preventDefault(); toggleFullscreen(); return;
      case 'm': case 'M':
        e.preventDefault(); toggleMute(); showToast(playerEl.muted ? '🔇 Muted' : '🔊 Sound on'); return;
      case 'ArrowUp':
        e.preventDefault(); volumeNudge(+0.1); return;
      case 'ArrowDown':
        e.preventDefault(); volumeNudge(-0.1); return;
      case 'i': case 'I':
        e.preventDefault(); togglePiP(); return;
      case 'y': case 'Y':
        e.preventDefault(); copyCurrentSubtitle(); return;
    }

    // 0-9 percent seek
    if (e.key >= '0' && e.key <= '9') {
      const dur = getDuration();
      if (dur > 0) {
        e.preventDefault();
        const pct = parseInt(e.key, 10) / 10;
        setCurrentTime(dur * pct);
        showToast(`⤳ ${Math.round(pct * 100)}%`);
      }
    }
  }, true);

  // ---------- 9. Boot ------------------------------------------------
  function boot() {
    buildBar();
    upgradeEmptyAndSkeleton();
    applySubtitleScale();
    applyDictationMode();
    applyCinemaMode();
    applyBookmarksOnly();
    attachTranscriptScrollGuard();
    // Click on a hidden seg in dictation mode → reveal that seg only
    document.addEventListener('click', (e) => {
      if (!settings.dictationMode) return;
      const t = e.target;
      if (!t || !t.closest) return;
      const seg = t.closest('#transcript-list .seg');
      if (seg && !seg.classList.contains('vrp-revealed')) {
        seg.classList.add('vrp-revealed');
        // auto-rehide after 6s
        setTimeout(() => seg.classList.remove('vrp-revealed'), 6000);
        return;
      }
      const sub = t.closest('#active-subtitle');
      if (sub && !sub.classList.contains('vrp-revealed')) {
        sub.classList.add('vrp-revealed');
        setTimeout(() => sub.classList.remove('vrp-revealed'), 4000);
      }
    });
    // First-time hint: show a tiny toast inviting the user to press ?
    if (!localStorage.getItem('linglish.vrp.hinted')) {
      setTimeout(() => {
        showToast('Press ?  for keyboard shortcuts');
        try { localStorage.setItem('linglish.vrp.hinted', '1'); } catch (_) { /* ignore */ }
      }, 1400);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // expose for diagnostics / page-level integration
  window.VRP = {
    play, pause, togglePlay, setRate, getRate, jumpSegments, replayCurrentSegment, toggleHelp, settings,
    volumeNudge, savePosition, getSavedPosition, getCurrentVideoId,
    cycleLoopMode, togglePiP, copyCurrentSubtitle,
    getVisitedSet, markVisited, decorateAllVisited, resetVisitedForCurrentVideo,
    cycleABLoop, clearABLoop, getAB: () => ({ a: ab.a, b: ab.b }),
    bookmarkCurrentSentence, getBookmarks, openBookmarkPopover,
    nudgeSubtitleScale, toggleDictationMode,
    startEchoReplay, cancelEchoReplay,
    jumpToSegment, jumpToBookmark, toggleCinemaMode, toggleBookmarksOnly,
    openSearch, closeSearch,
  };
})();
