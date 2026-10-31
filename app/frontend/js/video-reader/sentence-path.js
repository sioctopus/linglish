(function () {
  'use strict';

  const STYLE_ID = 'sentence-path-style';
  const CSS = `
    .sentence-path {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .sentence-path-label {
      display: none !important;
    }
    .sentence-path button {
      height: 32px;
      padding: 0 12px;
      border: 1px solid #99f6e4;
      border-radius: 999px;
      background: #f0fdfa;
      color: #0f766e;
      font: inherit;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }
    .sentence-path button:hover { background: #ccfbf1; }
    .sentence-path button.is-on {
      background: #0f766e;
      border-color: #0f766e;
      color: #fff;
    }
    body.study-mode-coach .sentence-path-label::after {
      content: ' · AI陪练';
      color: #0f766e;
      font-weight: 800;
    }
    body.study-mode-arena .sentence-path-label::after {
      content: ' · 实战场';
      color: #0f766e;
      font-weight: 800;
    }
    .caption-bar:has(.coach-dock[data-open="true"]) .sentence-path {
      margin-bottom: 8px;
    }
  `;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function ensureMarkup() {
    const bar = document.getElementById('caption-bar');
    if (!bar) return null;
    let path = document.getElementById('sentence-path');
    if (path) return path;
    path = document.createElement('div');
    path.className = 'sentence-path';
    path.id = 'sentence-path';
    path.innerHTML = [
      '<button type="button" id="sentence-listen">听这一句</button>',
      '<button type="button" id="sentence-shadow">跟读这一句</button>',
      '<button type="button" id="sentence-review" title="循环播放当前句，再点一次停止">重复播放</button>',
    ].join('');
    bar.insertBefore(path, bar.firstChild);
    return path;
  }

  function markSentencePath(action) {
    ['sentence-listen', 'sentence-shadow', 'sentence-review'].forEach((id) => {
      const button = document.getElementById(id);
      if (button) button.classList.toggle('is-on', id === action);
    });
  }

  let repeatTimer = 0;
  let repeatActive = false;
  let repeatSegment = null;

  function stopRepeatPractice(silent) {
    repeatActive = false;
    repeatSegment = null;
    if (repeatTimer) {
      clearInterval(repeatTimer);
      repeatTimer = 0;
    }
    const button = document.getElementById('sentence-review');
    if (button) button.classList.remove('is-on');
    if (!silent) toast('已停止重复播放', 'info');
  }

  function resolveYouTubePlayer() {
    const bridge = window.__vrdPro || {};
    if (typeof bridge.getYouTubePlayer === 'function') {
      try {
        const viaBridge = bridge.getYouTubePlayer();
        if (viaBridge) return viaBridge;
      } catch (_) {}
    }
    return window.youtubePlayer || bridge.youtubePlayer || null;
  }

  function resolvePlayerType() {
    const bridge = window.__vrdPro || {};
    if (typeof bridge.getPlayerType === 'function') {
      try {
        const viaBridge = bridge.getPlayerType();
        if (viaBridge) return viaBridge;
      } catch (_) {}
    }
    return window.currentPlayerType || bridge.currentPlayerType || '';
  }

  function getPlaybackTime() {
    const youtubePlayer = resolveYouTubePlayer();
    const currentPlayerType = resolvePlayerType();
    if (currentPlayerType === 'youtube' && youtubePlayer && typeof youtubePlayer.getCurrentTime === 'function') {
      try { return Number(youtubePlayer.getCurrentTime()) || 0; } catch (_) { return 0; }
    }
    const playerEl = document.getElementById('player');
    return playerEl ? (Number(playerEl.currentTime) || 0) : 0;
  }

  function startRepeatPractice() {
    const segment = currentStudySegment();
    if (!segment) {
      toast('先选一句字幕，再重复播放');
      return;
    }
    const start = Number(segment.start) || 0;
    let end = Number(segment.end);
    if (!Number.isFinite(end) || end <= start + 0.2) end = start + 4;
    if (window.VRP && typeof window.VRP.clearPracticeEnd === 'function') {
      try { window.VRP.clearPracticeEnd(); } catch (_) {}
    }
    repeatActive = true;
    repeatSegment = { start, end, text: segment.text || '' };
    playStudySegment(repeatSegment);
    toast('重复播放这一句 · 再点一次停止', 'info');
    if (repeatTimer) clearInterval(repeatTimer);
    repeatTimer = window.setInterval(() => {
      if (!repeatActive || !repeatSegment) return;
      const now = getPlaybackTime();
      if (now >= repeatSegment.end - 0.12 || now < repeatSegment.start - 0.35) {
        playStudySegment(repeatSegment);
      }
    }, 180);
  }

  function toggleRepeatPractice() {
    if (repeatActive) {
      stopRepeatPractice(false);
      return;
    }
    markSentencePath('sentence-review');
    startRepeatPractice();
  }

  function readerState() {
    return (window.__vrdPro && window.__vrdPro.state) || window.state || {};
  }

  function currentStudySegment() {
    const transcriptListEl = document.getElementById('transcript-list');
    const activeSubtitleEl = document.getElementById('active-subtitle');
    const active = transcriptListEl && transcriptListEl.querySelector('.seg.active');
    if (active) {
      return {
        start: Number(active.dataset.start || 0),
        end: Number(active.dataset.end || 0),
        text: (active.querySelector('.text') && active.querySelector('.text').textContent)
          || (activeSubtitleEl && activeSubtitleEl.textContent)
          || '',
      };
    }
    const bridge = window.__vrdPro || {};
    const state = readerState();
    const segments = (bridge.state && bridge.state.currentSegments) || state.currentSegments || [];
    let index = -1;
    const playerEl = document.getElementById('player');
    if (typeof bridge.currentSegmentIndexByTime === 'function') {
      try {
        const time = playerEl && Number.isFinite(playerEl.currentTime) ? playerEl.currentTime : 0;
        index = bridge.currentSegmentIndexByTime(time);
      } catch (_) { index = -1; }
    }
    const seg = (Number.isInteger(index) && index >= 0 ? segments[index] : null) || segments[0];
    if (!seg) return null;
    return {
      start: Number(seg.start_sec ?? seg.start ?? seg.startTime ?? 0),
      end: Number(seg.end_sec ?? seg.end ?? seg.endTime ?? 0),
      text: String(seg.text || seg.transcript || ''),
    };
  }

  function playStudySegment(segment) {
    if (!segment) {
      if (typeof window.showToast === 'function') window.showToast('先选一个视频，再听这一句', 'warn');
      return;
    }
    const start = Number.isFinite(segment.start) ? segment.start : 0;
    const youtubePlayer = resolveYouTubePlayer();
    const currentPlayerType = resolvePlayerType();
    if (currentPlayerType === 'youtube' && youtubePlayer && typeof youtubePlayer.seekTo === 'function') {
      try {
        if (youtubePlayer.seekTo.length >= 2) youtubePlayer.seekTo(start, true);
        else youtubePlayer.seekTo(start);
      } catch (_) {
        try { youtubePlayer.seekTo(start); } catch (__) {}
      }
      try {
        if (typeof youtubePlayer.playVideo === 'function') youtubePlayer.playVideo();
        else if (typeof youtubePlayer.play === 'function') youtubePlayer.play();
      } catch (_) {}
      return;
    }
    const playerEl = document.getElementById('player');
    if (playerEl) {
      playerEl.currentTime = start;
      playerEl.play().catch(() => {});
    }
  }

  function toast(message, kind) {
    if (typeof window.showToast === 'function') window.showToast(message, kind || 'warn');
  }

  function wireButtons() {
    const listen = document.getElementById('sentence-listen');
    const shadow = document.getElementById('sentence-shadow');
    const review = document.getElementById('sentence-review');
    if (listen && !listen.dataset.wired) {
      listen.dataset.wired = '1';
      listen.addEventListener('click', () => {
        stopRepeatPractice(true);
        markSentencePath('sentence-listen');
        const dock = window.LinglishCoachingDock;
        if (dock && typeof dock.listenCurrent === 'function' && dock.listenCurrent()) return;
        playStudySegment(currentStudySegment());
      });
    }
    if (shadow && !shadow.dataset.wired) {
      shadow.dataset.wired = '1';
      shadow.addEventListener('click', () => {
        stopRepeatPractice(true);
        markSentencePath('sentence-shadow');
        const state = readerState();
        const segment = currentStudySegment();
        if (!state.currentVideo || !segment) {
          toast('先选一个视频，再跟读这一句');
          return;
        }
        const dock = window.LinglishCoachingDock;
        if (dock && typeof dock.ensureOpen === 'function') dock.ensureOpen();
        if (dock && typeof dock.shadowCurrent === 'function' && dock.shadowCurrent()) return;
        toast('带教还没就绪，稍后再跟读这一句');
      });
    }
    if (review && !review.dataset.wired) {
      review.dataset.wired = '1';
      review.textContent = '重复播放';
      review.title = '循环播放当前句，再点一次停止';
      review.addEventListener('click', () => {
        toggleRepeatPractice();
      });
    }
  }

  function switchVideoStudyMode(target, options) {
    const mode = target === 'coach' || target === 'arena' ? target : 'video';
    document.body.dataset.studyMode = mode;
    document.body.classList.toggle('study-mode-coach', mode === 'coach');
    document.body.classList.toggle('study-mode-arena', mode === 'arena');
    const dock = window.LinglishCoachingDock;
    if (mode === 'coach' || mode === 'arena') {
      if (dock && typeof dock.ensureOpen === 'function') dock.ensureOpen();
      if (dock && typeof dock.setStudyHint === 'function') {
        dock.setStudyHint(mode === 'arena' ? '实战场：选一句，扮演着说' : 'AI陪练：听一句跟着说');
      }
    } else if (dock && typeof dock.setStudyHint === 'function') {
      dock.setStudyHint('带教模式已就绪');
    }
    if (!options || options.history !== 'skip') {
      try {
        const url = new URL(window.location.href);
        if (mode === 'video') url.searchParams.delete('study');
        else url.searchParams.set('study', mode);
        history.replaceState({}, '', url);
      } catch (_) {}
    }
    const studyRoot = document.getElementById('study-switch');
    if (studyRoot) {
      const label = studyRoot.querySelector('[data-study-label]');
      if (label) {
        label.textContent = mode === 'arena' ? '实战场' : mode === 'coach' ? 'AI陪练' : '视频学习';
      }
      studyRoot.querySelectorAll('[data-study]').forEach((node) => {
        if (node.dataset.study === mode) node.setAttribute('aria-current', 'page');
        else node.removeAttribute('aria-current');
      });
    }
    if (window.LinglishVoiceChatBridge && typeof window.LinglishVoiceChatBridge.sync === 'function') {
      window.LinglishVoiceChatBridge.sync();
    }
  }

  function mount() {
    const onDesktop = /video-reader-desktop\.html$/i.test(window.location.pathname);
    const onMobile = /(?:^|\/)video-reader\.html$/i.test(window.location.pathname);
    if (!onDesktop && !onMobile) return;
    if (onDesktop) {
      // Desktop caption stays clean: click a line to practice + use 带教 tools.
      // Do not inject the permanent 听/跟读/重复播放 bar.
      const existing = document.getElementById('sentence-path');
      if (existing) existing.remove();
    }
    window.switchVideoStudyMode = switchVideoStudyMode;
    const study = new URLSearchParams(window.location.search).get('study');
    if (study === 'coach' || study === 'arena') {
      switchVideoStudyMode(study, { history: 'skip' });
      // Mobile: open library only when no video/podcast is selected yet.
      if (onMobile) {
        setTimeout(() => {
          try {
            const selected = window.LinglishVideoReaderState && window.LinglishVideoReaderState.selectedVideoId;
            const media = window.LinglishStudyMedia;
            const hasContent = Boolean(selected)
              || Boolean(media && (media.audioUrl || media.youtube_video_id || media.id));
            if (!hasContent && typeof window.openMobileVideoLibrary === 'function') {
              window.openMobileVideoLibrary('videos');
            }
          } catch (_) {}
        }, 60);
      }
    }
  }

  window.LinglishSentencePath = { mount, switchVideoStudyMode, currentStudySegment };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
