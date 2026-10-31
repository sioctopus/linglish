/**
 * X-style DM 跟读回听 on mobile video-reader.
 * Chat sheet: full episode subtitles on the left; voice bubbles only where recorded.
 */
(function (root) {
  'use strict';

  let chat = null;
  let lastIndex = -1;
  let holdContext = null;
  let selectionGeneration = 0;
  let selectionVideoId = '';

  function recordingContext() {
    const videoId = resolveVideoId();
    const segments = readerState().currentSegments;
    if (videoId !== selectionVideoId) {
      selectionVideoId = videoId;
      selectionGeneration += 1;
      root.__lastShadowBlob = null;
      root.__lastShadowUrl = '';
      root.__lastShadowIndex = -1;
      const state = readerState();
      if (state.lastRecordingUrl) { try { URL.revokeObjectURL(state.lastRecordingUrl); } catch (_) {} }
      state.lastRecordingBlob = null;
      state.lastRecordingUrl = '';
      state.lastRecordingSegmentIndex = -1;
      markHearEnabled(false);
    }
    return { videoId, generation: selectionGeneration, segments };
  }

  function isRecordingContextCurrent(context, requireSegments = false) {
    const current = recordingContext();
    return Boolean(context && context.videoId === current.videoId && context.generation === current.generation && (!requireSegments || context.segments === current.segments));
  }

  function readerState() {
    try {
      if (root.__vrdPro && root.__vrdPro.state) return root.__vrdPro.state;
    } catch (_) {}
    return root.LinglishVideoReaderState || root.state || {};
  }

  function resolveVideoId() {
    const st = readerState();
    if (st.currentVideo && st.currentVideo.id != null) return String(st.currentVideo.id);
    if (st.selectedVideoId != null && st.selectedVideoId !== '') return String(st.selectedVideoId);
    try {
      if (root.LinglishStudyVideoId) return String(root.LinglishStudyVideoId);
    } catch (_) {}
    return '';
  }

  function recordingCache() {
    return root.LinglishShadowRecordingCache || null;
  }

  function markHearEnabled(enabled) {
    const hear = document.getElementById('mobile-hear-me-btn');
    if (hear) hear.disabled = !enabled;
    if (typeof root.syncDesktopHearMe === 'function') {
      try { root.syncDesktopHearMe(!!enabled); } catch (_) {}
    }
  }

  async function persistShadowRecording(blob, index, context = recordingContext()) {
    const cache = recordingCache();
    if (!cache || typeof cache.save !== 'function' || !blob) return null;
    const videoId = context.videoId;
    if (!isRecordingContextCurrent(context, true) || !videoId || !Number.isFinite(Number(index))) return null;
    try {
      return await cache.save({
        videoId,
        segmentIndex: Number(index),
        blob,
        mimeType: blob.type || 'audio/webm',
      });
    } catch (_) {
      return null;
    }
  }

  async function hydrateShadowRecording(videoId, preferredIndex) {
    const context = recordingContext();
    const cache = recordingCache();
    if (!cache) return false;
    const id = videoId != null && String(videoId) !== '' ? String(videoId) : resolveVideoId();
    if (!id || id !== context.videoId) return false;
    let record = null;
    try {
      const prefer = Number.isFinite(Number(preferredIndex))
        ? Number(preferredIndex)
        : currentSegmentIndex();
      if (Number.isFinite(prefer) && prefer >= 0 && typeof cache.get === 'function') {
        record = await cache.get({ videoId: id, segmentIndex: prefer });
      }
      if (!record && typeof cache.getLatestForVideo === 'function') {
        record = await cache.getLatestForVideo(id);
      }
    } catch (_) {
      return false;
    }
    if (!record || !record.blob || !isRecordingContextCurrent(context)) return false;
    const st = readerState();
    if (typeof cache.applyToState === 'function') {
      cache.applyToState(st, record);
    } else {
      st.lastRecordingBlob = record.blob;
      st.lastRecordingSegmentIndex = Number(record.segmentIndex);
      try {
        if (st.lastRecordingUrl) URL.revokeObjectURL(st.lastRecordingUrl);
      } catch (_) {}
      try {
        st.lastRecordingUrl = URL.createObjectURL(record.blob);
      } catch (_) {
        st.lastRecordingUrl = '';
      }
    }
    root.__lastShadowBlob = record.blob;
    root.__lastShadowUrl = st.lastRecordingUrl || '';
    root.__lastShadowIndex = Number(record.segmentIndex);
    markHearEnabled(true);
    return true;
  }

  async function resolvePlayableShadowUrl(preferredIndex) {
    const context = recordingContext();
    const st = readerState();
    const videoId = resolveVideoId();
    const prefer = Number.isFinite(Number(preferredIndex))
      ? Number(preferredIndex)
      : currentSegmentIndex();
    const cache = recordingCache();
    if (cache && videoId) {
      try {
        let record = null;
        if (Number.isFinite(prefer) && prefer >= 0) {
          record = await cache.get({ videoId, segmentIndex: prefer });
        }
        if (!record) record = await cache.getLatestForVideo(videoId);
        if (!isRecordingContextCurrent(context)) return '';
        if (record && record.blob) {
          cache.applyToState(st, record);
          root.__lastShadowBlob = record.blob;
          root.__lastShadowUrl = st.lastRecordingUrl || '';
          root.__lastShadowIndex = Number(record.segmentIndex);
          markHearEnabled(true);
          return st.lastRecordingUrl || '';
        }
      } catch (_) {}
    }
    if (!isRecordingContextCurrent(context)) return '';
    return root.__lastShadowUrl
      || st.lastRecordingUrl
      || (st.lastRecordingBlob ? URL.createObjectURL(st.lastRecordingBlob) : '');
  }

  function isMobileReader() {
    return /(?:^|\/)video-reader\.html$/i.test(root.location.pathname || '');
  }

  function isDesktopReader() {
    return /video-reader-desktop\.html$/i.test(root.location.pathname || '');
  }

  function isVideoReaderPage() {
    return isMobileReader() || isDesktopReader();
  }

  function isCoachMode() {
    const study = new URLSearchParams(root.location.search).get('study');
    return document.body.classList.contains('study-mode-coach')
      || document.body.classList.contains('study-mode-arena')
      || document.body.dataset.studyMode === 'coach'
      || document.body.dataset.studyMode === 'arena'
      || study === 'coach'
      || study === 'arena';
  }

  function sessionEl() {
    return document.getElementById('desktop-voice-session')
      || document.getElementById('mobile-voice-session');
  }

  function ensureHost() {
    let host = document.getElementById('voice-chat-coach');
    if (host) return host;
    if (isDesktopReader()) {
      // Conversation lives in the X DM page — never dump bubbles under the player.
      const panel = document.querySelector('#desktop-voice-session .desk-voice-session-panel')
        || document.getElementById('desktop-voice-session');
      if (!panel) return null;
      host = document.createElement('div');
      host.id = 'voice-chat-coach';
      host.className = 'voice-chat is-xdm';
      host.hidden = true;
      host.setAttribute('aria-label', 'Voice DM');
      panel.appendChild(host);
      return host;
    }
    const panel = document.querySelector('#mobile-voice-session .mobile-voice-session-panel');
    const controls = document.getElementById('mobile-player-controls');
    const parent = panel || (controls && controls.parentNode);
    if (!parent) return null;
    host = document.createElement('div');
    host.id = 'voice-chat-coach';
    host.className = 'voice-chat';
    host.hidden = true;
    host.setAttribute('aria-label', '跟读回听会话');
    parent.appendChild(host);
    return host;
  }

  function sessionIsOpen() {
    const sheet = sessionEl();
    return Boolean(sheet && !sheet.hidden);
  }

  function currentSegmentIndex() {
    const st = readerState();
    if (isDesktopReader()) {
      try {
        const vrp = root.__vrdPro;
        if (vrp && typeof vrp.currentSegmentIndexByTime === 'function') {
          let t = 0;
          const el = vrp.playerEl || document.getElementById('player');
          if (el && Number.isFinite(Number(el.currentTime))) t = Number(el.currentTime);
          const yt = typeof vrp.getYouTubePlayer === 'function' ? vrp.getYouTubePlayer() : null;
          if (yt && typeof yt.getCurrentTime === 'function') {
            try { t = Number(yt.getCurrentTime()) || t; } catch (_) {}
          }
          const idx = vrp.currentSegmentIndexByTime(t);
          if (Number.isInteger(idx) && idx >= 0) return idx;
        }
      } catch (_) {}
      const active = document.querySelector('#transcript-list .seg.active, #transcript-list .seg.is-tools-open');
      if (active) {
        const n = Number(active.getAttribute('data-index'));
        if (Number.isInteger(n) && n >= 0) return n;
      }
    }
    if (Number.isFinite(Number(st.activeSegmentIndex))) return Number(st.activeSegmentIndex);
    if (Number.isFinite(Number(st.currentSegmentIndex))) return Number(st.currentSegmentIndex);
    if (Number.isFinite(Number(st.mobileSegmentPosition))) return Number(st.mobileSegmentPosition);
    if (typeof root.mobileSegmentPosition === 'number' && root.mobileSegmentPosition >= 0) {
      return root.mobileSegmentPosition;
    }
    return Math.max(0, lastIndex);
  }

  function readJsonStore(key) {
    try {
      const raw = root.localStorage && root.localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function currentVideo() {
    const st = readerState();
    const id = st.selectedVideoId != null ? String(st.selectedVideoId) : '';
    if (id && Array.isArray(st.videos)) {
      const hit = st.videos.find((v) => String(v.id) === id);
      if (hit) return hit;
    }
    try {
      if (root.LinglishStudyMedia && typeof root.LinglishStudyMedia === 'object') {
        return root.LinglishStudyMedia;
      }
    } catch (_) {}
    try {
      const snap = readJsonStore('linglish.last_study_media.v1');
      if (snap && (snap.id != null || snap.audioUrl || snap.youtube_video_id)) return snap;
    } catch (_) {}
    return null;
  }

  /**
   * Channel/podcast → host/show artwork.
   * Self-upload / unknown → null (coach shows Grok-bot).
   */
  function resolveHostAvatarUrl() {
    const video = currentVideo();
    if (!video) return null;
    const id = String(video.id || '');
    const isPodcast = !!(video.external_podcast || video.audioUrl || /^pod:/i.test(id));
    const isChannel = !!(video.external_youtube || video.youtube_video_id || /^yt:/i.test(id));
    const isSelfUpload = /^\d+$/.test(id) && !isPodcast && !isChannel
      && !video.youtube_video_id && !video.external_youtube && !video.external_podcast;

    if (isSelfUpload) return null;

    const collection = String(video.collection_name || video.channel_title || video.show_title || '').trim();

    if (isPodcast) {
      const pods = readJsonStore('linglish_podcasts_v1');
      const list = Array.isArray(pods) ? pods : (pods && Array.isArray(pods.items) ? pods.items : []);
      let show = null;
      if (collection && list.length) {
        show = list.find((p) => String(p.title || '') === collection)
          || list.find((p) => String(p.author || '') === collection);
      }
      if (!show && list.length && video.audioUrl) {
        show = list.find((p) => Array.isArray(p.episodes)
          && p.episodes.some((ep) => String(ep.audioUrl || '') === String(video.audioUrl)));
      }
      const url = (show && (show.image || show.artworkUrl))
        || video.thumbnail_path
        || video.image
        || '';
      return url ? String(url) : null;
    }

    if (isChannel) {
      const chans = readJsonStore('linglish_channels_v1');
      const list = Array.isArray(chans) ? chans : (chans && Array.isArray(chans.items) ? chans.items : []);
      let channel = null;
      if (collection && list.length) {
        channel = list.find((c) => String(c.title || '') === collection)
          || list.find((c) => String(c.handle || '') === collection);
      }
      const ytId = String(video.youtube_video_id || (id.startsWith('yt:') ? id.slice(3) : '') || '');
      if (!channel && list.length && ytId) {
        channel = list.find((c) => Array.isArray(c.videos)
          && c.videos.some((v) => String(v.videoId || v.id || '') === ytId));
      }
      const url = (channel && channel.image)
        || video.channel_image
        || video.thumbnail_path
        || (ytId ? ('https://i.ytimg.com/vi/' + ytId + '/hqdefault.jpg') : '')
        || '';
      return url ? String(url) : null;
    }

    // Imported YouTube saved as library row still has youtube_video_id
    if (video.youtube_video_id) {
      return String(video.thumbnail_path
        || ('https://i.ytimg.com/vi/' + video.youtube_video_id + '/hqdefault.jpg'));
    }
    return null;
  }

  function absorbLastRecording() {
    if (!chat || typeof chat.appendMineRecording !== 'function') return;
    const st = readerState();
    const index = Number.isFinite(Number(st.lastRecordingSegmentIndex))
      ? Number(st.lastRecordingSegmentIndex)
      : currentSegmentIndex();
    const url = st.lastRecordingUrl;
    const blob = st.lastRecordingBlob;
    if (!url && !blob) return;
    const existing = (chat.getTurns && chat.getTurns()) || [];
    const already = existing.some((t) => t.side === 'me' && t.index === index && (t.url || t.blob));
    if (already) return;
    try {
      chat.appendMineRecording({
        index,
        url: url || (blob ? URL.createObjectURL(blob) : ''),
        blob: blob || null,
        durationLabel: '3"',
      });
    } catch (_) {}
  }

  function seedChatWindow() {
    if (!chat) return;
    absorbLastRecording();
    const idx = currentSegmentIndex();
    // Desktop session: only a window around the current cue (avoids 600+ bubbles + red cover art flood).
    if (isDesktopReader() && typeof chat.seedAround === 'function') {
      chat.seedAround(idx, 14);
      return;
    }
    if (typeof chat.seedAround === 'function') chat.seedAround(idx, 20);
    else if (typeof chat.seedAll === 'function') chat.seedAll(idx);
  }

  function openSession() {
    const sheet = sessionEl();
    const host = document.getElementById('voice-chat-coach') || ensureHost();
    if (!chat) mount();
    if (host) host.hidden = false;
    seedChatWindow();
    // Lock current cue without re-expanding to the full episode seed.
    try {
      if (chat && typeof chat.lockPracticeTarget === 'function') {
        chat.lockPracticeTarget(currentSegmentIndex(), {
          silent: true,
          skipSeed: true,
        });
      }
    } catch (_) {}
    if (sheet) sheet.hidden = false;
    document.body.classList.add('voice-session-open');
    document.body.classList.add('has-voice-chat');
  }

  function closeSession() {
    const sheet = sessionEl();
    if (sheet) sheet.hidden = true;
    document.body.classList.remove('voice-session-open');
    try {
      if (chat && typeof chat.endHold === 'function' && chat.isHolding && chat.isHolding()) {
        chat.endHold();
      }
    } catch (_) {}
  }

  function toggleSession() {
    const sheet = sessionEl();
    if (!sheet || sheet.hidden) openSession();
    else closeSession();
  }

  function playSegment(index) {
    const st = readerState();
    const seg = (st.currentSegments || [])[index];
    if (!seg) return Promise.resolve();
    lastIndex = index;
    if (typeof root.seekToSegment === 'function') {
      try { root.seekToSegment(index); } catch (_) {}
    } else if (typeof root.playSegment === 'function') {
      try { root.playSegment(index); } catch (_) {}
    } else {
      const player = document.getElementById('video-player') || document.getElementById('player');
      const start = Number(seg.start ?? seg.start_sec ?? 0);
      if (player) {
        try {
          player.currentTime = start;
          player.play().catch(() => {});
        } catch (_) {}
      }
    }
    return new Promise((resolve) => {
      const start = Number(seg.start ?? seg.start_sec ?? 0);
      const end = Number(seg.end ?? seg.end_sec ?? start + 3);
      const wait = Math.max(600, Math.min(12000, (end - start) * 1000 + 200));
      setTimeout(resolve, wait);
    });
  }

  function pauseDesktopPlayback() {
    try {
      const vrp = root.__vrdPro;
      const el = (vrp && vrp.playerEl) || document.getElementById('player');
      if (el && typeof el.pause === 'function') el.pause();
      const yt = vrp && typeof vrp.getYouTubePlayer === 'function' ? vrp.getYouTubePlayer() : null;
      if (yt && typeof yt.pauseVideo === 'function') yt.pauseVideo();
      else if (yt && typeof yt.pause === 'function') yt.pause();
    } catch (_) {}
  }

  function mount() {
    if (!isVideoReaderPage()) return;
    if (!root.LinglishVoiceChatCoach || typeof root.LinglishVoiceChatCoach.create !== 'function') return;
    const host = ensureHost();
    if (!host || chat) return;
    const desktop = isDesktopReader();
    chat = root.LinglishVoiceChatCoach.create({
      host,
      getSentences: () => {
        const list = readerState().currentSegments || [];
        return list.map((seg, index) => ({
          index,
          text: String(seg.text || seg.en || '').trim(),
          translation: String(seg.translation || seg.cn || seg.zh || '').trim(),
          start: Number(seg.start ?? seg.start_sec ?? 0),
          end: Number(seg.end ?? seg.end_sec ?? 0),
        })).filter((seg) => seg.text);
      },
      getIndex: () => currentSegmentIndex(),
      setIndex: (index) => {
        lastIndex = index;
        const st = readerState();
        st.activeSegmentIndex = index;
        try {
          if (typeof root.mobileSegmentPosition !== 'undefined') root.mobileSegmentPosition = index;
        } catch (_) {}
        // While X DM session is open, update highlight without scrolling the page list
        // (that scroll felt like “jump to bottom then climb back” inside the chat).
        const open = sessionIsOpen();
        const vrp = root.__vrdPro;
        if (vrp && typeof vrp.highlightActiveSegment === 'function') {
          try { vrp.highlightActiveSegment(index, !open); } catch (_) {}
        } else if (typeof root.highlightActiveSegment === 'function') {
          try { root.highlightActiveSegment(index, !open); } catch (_) {}
        }
        if (!open && typeof root.renderMobileTranscriptWindow === 'function') {
          try { root.renderMobileTranscriptWindow(index); } catch (_) {}
        }
      },
      playOriginal: (index) => playSegment(index),
      getHostAvatarUrl: () => resolveHostAvatarUrl(),
      pauseOriginal: () => {
        try {
          const player = document.getElementById('video-player') || document.getElementById('player');
          if (player) player.pause();
        } catch (_) {}
        try {
          if (typeof root.pauseLearningVideoNow === 'function') root.pauseLearningVideoNow();
        } catch (_) {}
        if (desktop) pauseDesktopPlayback();
      },
      // Must use cue time bounds — not activeSegmentIndex (lock happens before this check).
      isPlayingOriginal: (index) => {
        try {
          const player = document.getElementById('video-player') || document.getElementById('player');
          let t = player && !player.paused ? Number(player.currentTime) : NaN;
          if (!Number.isFinite(t) && desktop) {
            const vrp = root.__vrdPro;
            const yt = vrp && typeof vrp.getYouTubePlayer === 'function' ? vrp.getYouTubePlayer() : null;
            if (yt && typeof yt.getPlayerState === 'function' && yt.getPlayerState() === 1
              && typeof yt.getCurrentTime === 'function') {
              t = Number(yt.getCurrentTime());
            }
          }
          if (!Number.isFinite(t)) return false;
          const seg = (readerState().currentSegments || [])[Number(index)];
          if (!seg) return false;
          const start = Number(seg.start ?? seg.start_sec ?? 0);
          const end = Number(seg.end ?? seg.end_sec ?? start + 8);
          return t >= start - 0.35 && t <= end + 0.25;
        } catch (_) {
          return false;
        }
      },
      // Player Hold and X DM Hold share one session — keep both UIs in sync.
      onHoldStart: ({ index } = {}) => {
        holdContext = recordingContext();
        document.body.classList.add('voice-chat-holding');
        try {
          if (typeof root.syncMobilePlayButtonVoiceHold === 'function') {
            root.syncMobilePlayButtonVoiceHold(true, false);
          }
        } catch (_) {}
        try {
          if (typeof root.syncDesktopHoldUi === 'function') {
            root.syncDesktopHoldUi(true, false);
          }
        } catch (_) {}
        try {
          if (Number.isFinite(Number(index)) && typeof root.renderMobileTranscriptWindow === 'function') {
            root.mobileSegmentPosition = Number(index);
            root.renderMobileTranscriptWindow(Number(index));
          }
        } catch (_) {}
        if (desktop) pauseDesktopPlayback();
      },
      onHoldEnd: () => {
        document.body.classList.remove('voice-chat-holding');
        try {
          if (typeof root.syncMobilePlayButtonVoiceHold === 'function') {
            root.syncMobilePlayButtonVoiceHold(false, false);
          }
        } catch (_) {}
        try {
          if (typeof root.syncDesktopHoldUi === 'function') {
            root.syncDesktopHoldUi(false, false);
          }
        } catch (_) {}
      },
      onLiveMatch: (info) => {
        try {
          root.dispatchEvent(new CustomEvent('linglish:voice-live-match', { detail: info || {} }));
        } catch (_) {}
      },
      onRecorded: async ({ blob, url, index, durationLabel }) => {
        const context = holdContext;
        if (!isRecordingContextCurrent(context, true)) return null;
        try {
          root.__lastShadowBlob = blob;
          root.__lastShadowUrl = url || (blob ? URL.createObjectURL(blob) : '');
          root.__lastShadowIndex = index;
          if (typeof root.rememberLastRecording === 'function') {
            root.rememberLastRecording(blob, index);
          } else if (typeof root.rememberMobileShadowRecording === 'function') {
            root.rememberMobileShadowRecording(blob, index);
          } else {
            const st = readerState();
            st.lastRecordingBlob = blob;
            if (st.lastRecordingUrl) {
              try { URL.revokeObjectURL(st.lastRecordingUrl); } catch (_) {}
            }
            st.lastRecordingUrl = url || (blob ? URL.createObjectURL(blob) : '');
            st.lastRecordingSegmentIndex = index;
          }
          markHearEnabled(true);
          await persistShadowRecording(blob, index, context);
        } catch (_) {}
        // Hold only records — do not auto-open the DM sheet. User opens via @linglish.
        if (sessionIsOpen()) seedChatWindow();
        return null;
      },
      onTurnComplete: () => {
        if (sessionIsOpen()) seedChatWindow();
      },
      autoAdvance: false,
      autoPreview: false,
      silent: true,
      xUi: true,
      maxHoldMs: 60000,
      onOpenMic: () => {
        if (typeof root.openMobileMicSheet === 'function') root.openMobileMicSheet();
      },
    });
    sync();
  }

  function sync() {
    if (!isVideoReaderPage()) return;
    recordingContext();
    if (!chat) mount();
    if (!chat) return;
    const host = document.getElementById('voice-chat-coach');
    document.body.classList.add('has-voice-chat');
    // Desktop video learning: chat only visible inside the X DM session page.
    if (isDesktopReader()) {
      if (host) host.hidden = !sessionIsOpen();
      if (sessionIsOpen()) {
        try { seedChatWindow(); } catch (_) {}
      }
      return;
    }
    if (host) host.hidden = false;
    // Mobile: keep the full subtitle list ready (voice slots fill in as user records).
    try { seedChatWindow(); } catch (_) {}
  }

  function beginHold(event) {
    if (!chat) mount();
    if (!chat || typeof chat.beginHold !== 'function') return Promise.resolve(false);
    holdContext = recordingContext();
    // Lock the cue currently on the player so player Hold == X DM Hold target.
    try {
      const idx = currentSegmentIndex();
      // skipSeed: do not paint the under-player / closed-session bubble dump.
      if (typeof chat.lockPracticeTarget === 'function') {
        chat.lockPracticeTarget(idx, { silent: true, skipSeed: !sessionIsOpen() });
      }
    } catch (_) {}
    // Stay on figure-1 player; do not open 跟读回听 sheet.
    return Promise.resolve(chat.beginHold(event)).then(() => true);
  }

  function endHold(event) {
    if (!chat || typeof chat.endHold !== 'function') return Promise.resolve(false);
    return Promise.resolve(chat.endHold(event)).then(() => true);
  }

  function isHolding() {
    return !!(chat && typeof chat.isHolding === 'function' && chat.isHolding());
  }

  function bindSessionChrome() {
    const sheet = sessionEl();
    if (!sheet) return;
    const backdrop = document.getElementById('desktop-voice-session-backdrop')
      || document.getElementById('mobile-voice-session-backdrop');
    const closeBtn = document.getElementById('desktop-voice-session-close')
      || document.getElementById('mobile-voice-session-close');
    const micBtn = document.getElementById('mobile-voice-session-mic');
    const openBtn = document.getElementById('desk-open-voice-session');
    if (backdrop) backdrop.addEventListener('click', closeSession);
    if (closeBtn) closeBtn.addEventListener('click', closeSession);
    if (openBtn) openBtn.addEventListener('click', (event) => {
      event.preventDefault();
      openSession();
    });
    if (micBtn) {
      micBtn.addEventListener('click', () => {
        if (typeof root.openMobileMicSheet === 'function') root.openMobileMicSheet();
        else {
          const micSheet = document.getElementById('mobile-mic-sheet');
          if (micSheet) {
            micSheet.hidden = false;
            document.body.classList.add('mobile-feature-open');
          }
        }
      });
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && sessionIsOpen() && isDesktopReader()) closeSession();
    });
  }

  function boot() {
    if (!isVideoReaderPage()) return;
    mount();
    sync();
    bindSessionChrome();
    root.addEventListener('linglish:segments-ready', sync);
    document.addEventListener('linglish:videosLoaded', sync);
    const study = document.getElementById('study-switch');
    study?.addEventListener('click', () => setTimeout(sync, 0));
    root.addEventListener('popstate', () => setTimeout(sync, 0));
    const list = document.getElementById('mobile-transcript-list');
    list?.addEventListener('click', () => setTimeout(sync, 50));
    // Desktop: clicking the right transcript only plays that cue (+ copy/划线/笔记).
    // Do not seed / open the X DM bubble stream under the player.
  }

  root.LinglishVoiceChatBridge = {
    sync,
    mount,
    openSession,
    closeSession,
    toggleSession,
    beginHold,
    endHold,
    isHolding,
    isCoachMode,
    seedChatWindow,
    getChat: () => chat,
    persistShadowRecording,
    hydrateShadowRecording,
    resolvePlayableShadowUrl,
    resolveVideoId,
  };
  root.hydrateShadowRecording = hydrateShadowRecording;
  root.resolvePlayableShadowUrl = resolvePlayableShadowUrl;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof window !== 'undefined' ? window : globalThis);
