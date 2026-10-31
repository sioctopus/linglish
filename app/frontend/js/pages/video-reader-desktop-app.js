    // Debug helper: enable via localStorage.setItem('linglish_debug','1')
    function debugLog() {
      try { if (localStorage.getItem('linglish_debug') === '1') console.log('[VR-Desktop]', ...arguments); } catch (_) { }
    }
    const LINGLISH_ENV = window.__LINGLISH_ENV__ || {};
    const enableNetworkUpload = LINGLISH_ENV.enableNetworkUpload !== false;
    const parseEnvBool = (value, fallback) => {
      if (value === undefined || value === null || value === '') return fallback;
      if (typeof value === 'boolean') return value;
      return String(value).toLowerCase() !== 'false';
    };
    const parseEnvNumber = (value, fallback) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : fallback;
    };
    const waveformSegmentationConfig = {
      enabled: parseEnvBool(LINGLISH_ENV.waveformSegmentationEnabled, true),
      minDurationSec: parseEnvNumber(LINGLISH_ENV.waveformSegmentationMinDurationSec, 5.5),
      minWords: Math.max(1, Math.round(parseEnvNumber(LINGLISH_ENV.waveformSegmentationMinWords, 8))),
      minSilenceSec: parseEnvNumber(LINGLISH_ENV.waveformSegmentationMinSilenceSec, 0.25),
      silenceThresholdRatio: parseEnvNumber(LINGLISH_ENV.waveformSegmentationThresholdRatio, 0.1),
      minThreshold: parseEnvNumber(LINGLISH_ENV.waveformSegmentationMinThreshold, 0.02),
      minEdgeSec: parseEnvNumber(LINGLISH_ENV.waveformSegmentationMinEdgeSec, 0.25),
      minChunkSec: parseEnvNumber(LINGLISH_ENV.waveformSegmentationMinChunkSec, 0.45),
      maxSplits: Math.max(0, Math.round(parseEnvNumber(LINGLISH_ENV.waveformSegmentationMaxSplits, 24))),
      maxSplitsPerSegment: Math.max(1, Math.round(parseEnvNumber(LINGLISH_ENV.waveformSegmentationMaxSplitsPerSegment, 2))),
    };
    // ===== Env & Auth =====
    const API_BASE = (() => {
      const { protocol, hostname, port } = window.location;
      if (protocol === 'file:') return 'http://localhost:8000';
      if (hostname === 'localhost' || hostname === '127.0.0.1') {
        const resolvedPort = port || '8000';
        return `${protocol}//${hostname}:${resolvedPort}`;
      }
      return '';
    })();
    if (!enableNetworkUpload) {
      const youtubeUploadLink = document.getElementById('nav-youtube-upload');
      if (youtubeUploadLink) youtubeUploadLink.remove();
      const uploadSwitch = document.getElementById('nav-upload-switch');
      const localUpload = document.getElementById('nav-local-upload');
      if (uploadSwitch && localUpload) {
        const menu = uploadSwitch.querySelector('.upload-switch-menu');
        const remaining = menu ? menu.querySelectorAll('a').length : 0;
        if (remaining <= 1) {
          localUpload.classList.add('pill');
          uploadSwitch.replaceWith(localUpload);
        }
      }
    }

    // Removed: const token - now using dynamic getToken() function below
    // Only redirect if user is not a guest and has no token
    const isGuest = typeof window.GuestCheck !== 'undefined' && window.GuestCheck.isGuest && window.GuestCheck.isGuest();
    // Initial token check - will use dynamic getToken() for all API calls
    const initialToken = (window.AuthManager && window.AuthManager.getToken()) ||
      localStorage.getItem('linglish_token') ||
      sessionStorage.getItem('linglish_token') ||
      localStorage.getItem('authToken') ||
      sessionStorage.getItem('authToken');
    if (!initialToken && !isGuest) {
      showToast('请先登录', 'warn');
      setTimeout(() => { window.location.href = './desktop-auth.html'; }, 1200);
    }

    // ===== State =====
    const state = {
      videos: [],
      filteredVideos: [],
      currentVideo: null,
      vocab: [],
      vocabStats: null,
      // rawSegments: original timed cues (sync clock). currentSegments: display cards.
      rawSegments: [],
      currentSegments: [],
      vocabFilter: null,
      user: null,
      vocabMap: new Map(),
      segmentHtmlCache: new Map(),
      showBilingual: false,
      isMainlandUser: false,
      isLoadingVideos: false,
      isLoadingTranscript: false,
      hasLoadedVideos: false,
      cacheHint: ''
    };
    let videoSelectionGuard = null;

    // Track processed videos (for auto-import)
    function getProcessedVideosKey() {
      try { return `vocab_processed_videos_${localStorage.getItem('userEmail') || sessionStorage.getItem('userEmail') || 'anon'}`; } catch (_) { return 'vocab_processed_videos_anon'; }
    }
    function loadProcessedVideos() {
      try { const raw = localStorage.getItem(getProcessedVideosKey()); return (raw && raw !== 'undefined' && raw !== 'null') ? new Set(JSON.parse(raw)) : new Set(); } catch (_) { return new Set(); }
    }
    function markVideoProcessed(videoId) {
      try { const set = loadProcessedVideos(); set.add(Number(videoId)); localStorage.setItem(getProcessedVideosKey(), JSON.stringify(Array.from(set))); } catch (_) { }
    }
    const processedVideos = loadProcessedVideos();
    // Local overrides: persist lemmas user marked as "known" to bridge backend semantics (e.g., reviewing vs mastered)
    function getUserKey() {
      try { return localStorage.getItem('userEmail') || sessionStorage.getItem('userEmail') || 'anon'; } catch (_) { return 'anon'; }
    }
    function getOverrideKey() { return `vocab_known_override_${getUserKey()}`; }
    function loadKnownOverrides() {
      try {
        const raw = localStorage.getItem(getOverrideKey());
        if (!raw || raw === 'undefined' || raw === 'null') return new Set();
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
      } catch (_) { return new Set(); }
    }
    function saveKnownOverrides(set) {
      try { localStorage.setItem(getOverrideKey(), JSON.stringify(Array.from(set))); } catch (_) { }
    }
    const knownOverrides = loadKnownOverrides();
    let ownedLemmaSet = new Set();

    // ===== Elements =====
    const videoListEl = document.getElementById('video-list');
    const videoSearchEl = document.getElementById('video-search');
    const refreshVideosBtn = document.getElementById('refresh-videos');
    const playerEl = document.getElementById('player');
    const youtubePlayerEl = document.getElementById('youtube-player');
    const playerOverlayEl = document.getElementById('player-overlay');
    const playerOverlayIconEl = document.getElementById('player-overlay-icon');
    const playerOverlayTitleEl = document.getElementById('player-overlay-title');
    const playerOverlayDescEl = document.getElementById('player-overlay-desc');
    const playerOverlayTipsEl = document.getElementById('player-overlay-tips');
    const playerOverlayActionsEl = document.getElementById('player-overlay-actions');
    const playerOverlayRetryBtn = document.getElementById('player-overlay-retry');
    const playerOverlayRefreshBtn = document.getElementById('player-overlay-refresh');
    const openSourceBtn = document.getElementById('open-source');
    const importWordsBtn = document.getElementById('import-words');
    const focusToggleBtn = document.getElementById('focus-toggle');
    const currentTitleEl = document.getElementById('current-title');
    const videoMetaEl = document.getElementById('video-meta');
    const videoIdEl = document.getElementById('video-id');
    const videoDurationEl = document.getElementById('video-duration');
    const videoLanguageEl = document.getElementById('video-language');
    const videoDifficultyEl = document.getElementById('video-difficulty-tag');
    const videoProgressLabelEl = document.getElementById('video-progress-label');
    const extractWordsCta = document.getElementById('extract-words-cta');
    const activeSubtitleEl = document.getElementById('active-subtitle');
    const activeTranslationEl = document.getElementById('active-translation');
    const subtitleLocateBtn = document.getElementById('subtitle-locate-btn');
    const openVocabTabBtn = document.getElementById('open-vocab-tab');
    const nextVideoCardEl = document.getElementById('next-video-card');
    const nextVideoTitleEl = document.getElementById('next-video-title');
    const nextVideoMetaEl = document.getElementById('next-video-meta');
    const nextVideoReasonEl = document.getElementById('next-video-reason');
    const nextVideoBtn = document.getElementById('next-video-btn');
    const todayRecoCardEl = document.getElementById('today-reco-card');
    const todayRecoNameEl = document.getElementById('today-reco-name');
    const todayRecoMetaEl = document.getElementById('today-reco-meta');
    const todayRecoReasonEl = document.getElementById('today-reco-reason');
    const todayRecoBtn = document.getElementById('today-reco-btn');
    const todayRecoRefreshBtn = document.getElementById('today-reco-refresh');
    const todayRecoSession = window.TodayRecommendationSession
      ? window.TodayRecommendationSession.create()
      : null;

    // ===== Player overlay helpers =====
    const playerOverlayState = { mode: 'idle', lastMessageKey: null, slowTimer: null };
    function tOverlay(key, fallback) {
      try {
        if (typeof i18n !== 'undefined' && i18n && typeof i18n.t === 'function') {
          const v = i18n.t(key);
          return (v && v !== key) ? v : (fallback || v || key);
        }
      } catch (_) { }
      return fallback || key;
    }
    function getUploadTip() {
      if (!enableNetworkUpload) {
        return tOverlay('video.overlay.tip_upload_local', '也可以使用右上角「本地上传」导入新视频。');
      }
      return tOverlay('video.overlay.tip_upload', '也可以使用右上角「本地上传 / 网络上传」导入新视频。');
    }
    function setOverlayTips(tips) {
      if (!playerOverlayTipsEl) return;
      playerOverlayTipsEl.innerHTML = '';
      (tips || []).filter(Boolean).forEach((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        playerOverlayTipsEl.appendChild(li);
      });
    }
    function setPlayerOverlay(mode, opts = {}) {
      if (!playerOverlayEl) return;
      playerOverlayState.mode = mode;
      const hide = mode === 'ready';
      playerOverlayEl.classList.toggle('hidden', hide);
      playerOverlayEl.classList.toggle('loading', mode === 'loading');
      playerOverlayEl.classList.toggle('error', mode === 'error');
      if (playerEl && !playerEl.getAttribute('src')) playerEl.style.display = 'none';

      if (hide) return;

      const titleKey = opts.titleKey;
      const descKey = opts.descKey;
      const title = mode === 'loading' ? '' : (opts.title || (titleKey ? tOverlay(titleKey) : ''));
      const desc = mode === 'loading' ? '' : (opts.desc || (descKey ? tOverlay(descKey) : ''));
      const tips = mode === 'loading' ? [] : (opts.tips || []);

      if (playerOverlayTitleEl) playerOverlayTitleEl.textContent = title || '';
      if (playerOverlayDescEl) playerOverlayDescEl.textContent = desc || '';
      setOverlayTips(tips);

      // Icon + actions based on mode
      if (playerOverlayIconEl) {
        if (mode === 'loading') {
          playerOverlayIconEl.innerHTML = `
            <div class="lingbao-loader" aria-hidden="true">
              <svg viewBox="0 0 120 120" role="img" aria-label="Lingbao">
                <circle cx="60" cy="60" r="38" fill="#fef3c7" />
                <circle cx="44" cy="54" r="8" fill="#ffffff" />
                <circle cx="76" cy="54" r="8" fill="#ffffff" />
                <circle cx="44" cy="54" r="3.5" fill="#0f172a" />
                <circle cx="76" cy="54" r="3.5" fill="#0f172a" />
                <path d="M50 72c6 6 14 6 20 0" fill="none" stroke="#0f172a" stroke-width="4" stroke-linecap="round" />
                <circle cx="28" cy="60" r="10" fill="#0ea5e9" />
                <circle cx="92" cy="60" r="10" fill="#0ea5e9" />
                <rect x="36" y="36" width="48" height="10" rx="5" fill="#0ea5e9" />
              </svg>
            </div>`;
        } else if (mode === 'error') {
          playerOverlayIconEl.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 9V14M12 21C16.9706 21 21 16.9706 21 12C21 7.02944 16.9706 3 12 3C7.02944 3 3 7.02944 3 12C3 16.9706 7.02944 21 12 21ZM12 17H12.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>`;
        } else {
          // Idle state - Premium Video Icon
          playerOverlayIconEl.innerHTML = `
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M15 10L19.5528 7.72361C19.8176 7.59118 20.1343 7.64052 20.3478 7.84713C20.4433 7.93959 20.4983 8.06646 20.5 8.19934V15.8007C20.4983 15.9335 20.4433 16.0604 20.3478 16.1529C20.1343 16.3595 19.8176 16.4088 19.5528 16.2764L15 14M5 18H13C14.1046 18 15 17.1046 15 16V8C15 6.89543 14.1046 6 13 6H5C3.89543 6 3 6.89543 3 8V16C3 17.1046 3.89543 18 5 18Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>`;
        }
      }

      const showActions = mode === 'error';
      if (playerOverlayActionsEl) playerOverlayActionsEl.style.display = showActions ? 'flex' : 'none';

      // Slow-load nudge (only for loading)
      try {
        if (playerOverlayState.slowTimer) clearTimeout(playerOverlayState.slowTimer);
        playerOverlayState.slowTimer = null;
        if (mode === 'loading') {
          playerOverlayState.slowTimer = setTimeout(() => {
            if (playerOverlayState.mode !== 'loading') return;
            if (playerOverlayDescEl) {
              playerOverlayDescEl.textContent = '';
            }
          }, 4500);
        }
      } catch (_) { }
    }
    function refreshPlayerOverlayCopy() {
      // Re-apply copy for current mode (for language switching)
      if (!playerOverlayEl || playerOverlayEl.classList.contains('hidden')) return;
      if (playerOverlayState.mode === 'idle') {
        setPlayerOverlay('idle', {
          titleKey: 'video.overlay.empty_title',
          descKey: 'video.overlay.empty_desc',
          tips: [
            tOverlay('video.overlay.tip_pick', '打开顶部「视频库」，选一个视频开始学习。'),
            getUploadTip(),
          ]
        });
      } else if (playerOverlayState.mode === 'loading') {
        setPlayerOverlay('loading', {
          titleKey: 'video.overlay.loading_title',
          descKey: 'video.overlay.loading_desc',
          tips: [
            tOverlay('video.overlay.tip_switch', '加载期间仍可从左侧切换其它视频。'),
            tOverlay('video.overlay.tip_subtitle', '视频加载后会自动加载字幕；如果没字幕，可能还在转录中。'),
          ]
        });
      } else if (playerOverlayState.mode === 'error') {
        setPlayerOverlay('error', {
          titleKey: 'video.overlay.error_title',
          descKey: 'video.overlay.error_desc',
          tips: [
            tOverlay('video.overlay.tip_retry', '可以尝试重试加载，或切换到其它视频。'),
          ]
        });
      }
    }

    // Initial overlay: avoid blank black player
    setPlayerOverlay('idle', {
      titleKey: 'video.overlay.empty_title',
      descKey: 'video.overlay.empty_desc',
      tips: [
        tOverlay('video.overlay.tip_pick', '打开顶部「视频库」，选一个视频开始学习。'),
        getUploadTip(),
      ]
    });

    let nextVideoCandidate = null;
    let todayRecoCandidate = null;
    const difficultyLabels = {
      a1: 'A1',
      a2: 'A2',
      b1: 'B1',
      b2: 'B2',
      c1: 'C1',
      c2: 'C2',
      beginner: 'A1',
      intermediate: 'B1',
      advanced: 'C1'
    };

    function formatDifficultyLabel(level) {
      const key = String(level || '').toLowerCase();
      return difficultyLabels[key] || '难度未知';
    }

    function normalizeDifficultyLevel(raw) {
      const v = String(raw || '').trim().toLowerCase();
      if (v === 'beginner') return 'a1';
      if (v === 'intermediate') return 'b1';
      if (v === 'advanced') return 'c1';
      return (v === 'a1' || v === 'a2' || v === 'b1' || v === 'b2' || v === 'c1' || v === 'c2') ? v : null;
    }

    function getPreferredLevelForRecommend() {
      try {
        const stored = normalizeDifficultyLevel(localStorage.getItem('linglish_active_level'));
        if (stored) return stored;
      } catch (_) { }
      const profile = normalizeDifficultyLevel(state.user?.current_vocabulary_level || state.user?.level);
      return profile || null;
    }

    function scoreVideoCandidate(video, preferred, currentId) {
      if (!video || String(video.id) === currentId) return -1;
      let score = 0;
      const level = normalizeDifficultyLevel(video.difficulty_level);
      if (preferred && level === preferred) score += 3;
      const progressPercent = getVideoProgressPercent(video.id);
      if (progressPercent < 90) score += 1;
      if (!processedVideos.has(Number(video.id))) score += 1;
      const duration = Number(video.duration_sec || 0) || 0;
      if (duration >= 90 && duration <= 480) score += 1;
      if (String(video.status || '') === 'ready') score += 1;
      if (video.transcript) score += 1;
      return score;
    }

    function pickNextVideoCandidate(list) {
      const videos = Array.isArray(list) ? list : [];
      if (!videos.length) return null;
      const preferred = getPreferredLevelForRecommend();
      const currentId = state.currentVideo ? String(state.currentVideo.id) : null;
      let best = null;
      let bestScore = -1;
      for (const v of videos) {
        const score = scoreVideoCandidate(v, preferred, currentId);
        if (score > bestScore) {
          best = v;
          bestScore = score;
        }
      }
      return best || videos.find(v => String(v.id) !== currentId) || videos[0] || null;
    }

    function pickTodayRecoCandidate(list, avoidId = null) {
      const videos = Array.isArray(list) ? list : [];
      if (!videos.length) return null;
      const preferred = getPreferredLevelForRecommend();
      const currentId = state.currentVideo ? String(state.currentVideo.id) : null;
      const avoid = avoidId ? String(avoidId) : null;
      let best = null;
      let bestScore = -1;
      for (const v of videos) {
        if (!v) continue;
        if (avoid && String(v.id) === avoid) continue;
        const score = scoreVideoCandidate(v, preferred, currentId);
        if (score > bestScore) {
          best = v;
          bestScore = score;
        }
      }
      return best || videos.find(v => (!avoid || String(v.id) !== avoid) && String(v.id) !== currentId) || videos[0] || null;
    }

    function setExtractButtonState(enabled) {
      if (extractWordsCta) extractWordsCta.disabled = !enabled;
    }

    function updateVideoMeta(v) {
      if (!v) {
        if (videoIdEl) videoIdEl.textContent = 'ID: --';
        if (videoDurationEl) videoDurationEl.textContent = '--:--';
        if (videoLanguageEl) videoLanguageEl.textContent = 'auto';
        if (videoDifficultyEl) videoDifficultyEl.textContent = '难度未知';
        if (videoDifficultyEl) videoDifficultyEl.dataset.level = '';
        if (videoProgressLabelEl) videoProgressLabelEl.textContent = '已完成 0%';
        return;
      }
      if (videoIdEl) videoIdEl.textContent = `ID: ${v.id}`;
      if (videoDurationEl) videoDurationEl.textContent = fmtSec(v.duration_sec || 0);
      if (videoLanguageEl) videoLanguageEl.textContent = v.language || 'auto';
      if (videoDifficultyEl) {
        const level = String(v.difficulty_level || '').toLowerCase();
        videoDifficultyEl.textContent = formatDifficultyLabel(level);
        videoDifficultyEl.dataset.level = level;
      }
      if (videoProgressLabelEl) videoProgressLabelEl.textContent = '已完成 0%';
    }

    function updateVideoProgress(currentTime, duration) {
      if (!duration || !Number.isFinite(duration)) {
        duration = Number(state.currentVideo?.duration_sec || 0) || 0;
      }
      const safeDuration = Math.max(0, duration || 0);
      const safeCurrent = Math.max(0, currentTime || 0);
      const percent = safeDuration > 0 ? Math.min(100, Math.round((safeCurrent / safeDuration) * 100)) : 0;
      if (videoProgressLabelEl) videoProgressLabelEl.textContent = `已完成 ${percent}%`;
      if (state.currentVideo) {
        recordVideoProgress(state.currentVideo.id, safeCurrent, safeDuration);
        updateVideoCardProgress(state.currentVideo.id, percent);
        rememberPlaybackSeconds(safeCurrent, percent);
      }
    }

    function getActiveDuration() {
      if (currentPlayerType === 'local' && playerEl) {
        return Number(playerEl.duration || state.currentVideo?.duration_sec || 0) || 0;
      }
      if (currentPlayerType === 'youtube' && youtubePlayer && typeof youtubePlayer.getDuration === 'function') {
        return Number(youtubePlayer.getDuration() || state.currentVideo?.duration_sec || 0) || 0;
      }
      return Number(state.currentVideo?.duration_sec || 0) || 0;
    }

    function renderLyricStage(idx) {
      const stage = document.getElementById('lyric-stage');
      if (!stage) return;
      const segs = Array.isArray(state.currentSegments) ? state.currentSegments : [];
      if (idx < 0 || !segs[idx]) {
        stage.hidden = true;
        stage.dataset.idx = '';
        return;
      }
      stage.hidden = false;
      if (stage.dataset.idx !== String(idx)) {
        stage.dataset.idx = String(idx);
        stage.classList.remove('is-shifting');
        void stage.offsetWidth;
        stage.classList.add('is-shifting');
      }
      [['lyric-prev', idx - 1], ['lyric-current', idx], ['lyric-next', idx + 1]].forEach(([id, lineIdx]) => {
        const el = document.getElementById(id);
        const seg = segs[lineIdx];
        if (!el) return;
        if (!seg) {
          el.hidden = false;
          el.classList.add('is-empty');
          el.innerHTML = '';
          el.removeAttribute('data-index');
          return;
        }
        el.hidden = false;
        el.classList.remove('is-empty');
        el.dataset.index = String(lineIdx);
        el.dataset.start = String(seg.start_sec ?? seg.start ?? seg.startTime ?? 0);
        el.dataset.end = String(seg.end_sec ?? seg.end ?? seg.endTime ?? '');
        const text = seg.text || '';
        el.innerHTML = id === 'lyric-current' ? wrapWordsToHTML(text, missedWordsForSegment(lineIdx)) : esc(text);
      });
    }
    function renderActiveSubtitle(idx, updateLesson = true) {
      renderLyricStage(idx);
      if (!activeSubtitleEl) return;
      const segs = Array.isArray(state.currentSegments) ? state.currentSegments : [];
      const seg = idx >= 0 ? segs[idx] : null;
      if (!seg) {
        activeSubtitleEl.textContent = typeof i18n !== 'undefined' ? i18n.t('video.no_subtitle') : '暂无字幕';
        delete activeSubtitleEl.dataset.index;
        delete activeSubtitleEl.dataset.start;
        delete activeSubtitleEl.dataset.end;
        if (activeTranslationEl) {
          activeTranslationEl.textContent = '';
          activeTranslationEl.style.display = 'none';
        }
        syncSubtitleAssist(null);
        return;
      }
      const text = seg.text || '';
      activeSubtitleEl.innerHTML = wrapWordsToHTML(text, missedWordsForSegment(idx));
      activeSubtitleEl.dataset.index = String(idx);
      activeSubtitleEl.dataset.start = String(seg.start_sec ?? seg.start ?? seg.startTime ?? '');
      activeSubtitleEl.dataset.end = String(seg.end_sec ?? seg.end ?? seg.endTime ?? '');
      const translation = (seg.translation || seg.cn || seg.zh || seg.text_cn || '').trim();
      if (updateLesson && firstLessonSession.isActive()) {
        firstLessonOriginalController?.stop();
        firstLessonGoalCard.setSentence({ index: idx, text, translation });
      }
      if (activeTranslationEl) {
        if (state.showBilingual && translation) {
          activeTranslationEl.textContent = translation;
          activeTranslationEl.style.display = 'block';
        } else {
          activeTranslationEl.style.display = 'none';
        }
      }
      syncSubtitleAssist(idx);
    }

    function syncSubtitleAssist(idx) {
      const card = document.getElementById('subtitle-assist');
      if (!card || card.hidden) return;
      if (idx == null || String(idx) !== String(card.dataset.segment || '')) {
        card.hidden = true;
        return;
      }
      const word = String(card.dataset.word || '').toLowerCase();
      activeSubtitleEl.querySelectorAll('.word').forEach((el) => {
        const lemma = String(el.dataset.lemma || el.textContent || '').toLowerCase();
        el.classList.toggle('word-lookup', Boolean(word) && lemma === word);
      });
    }

    // 后端「下一个」推荐:按当前视频缓存,失败时保持本地候选
    const nextRecoCache = new Map();
    const nextRecoImpressions = window.VideoRecommendationClient
      ? window.VideoRecommendationClient.createImpressionTracker((name, props) => postEvent(name, props))
      : { track() {} };

    function findLocalVideo(id) {
      const key = String(id);
      return (state.videos || []).find(v => String(v.id) === key) || null;
    }

    function renderNextVideoCandidate(candidate, reason) {
      nextVideoCandidate = candidate;
      if (!nextVideoCardEl) return;
      if (nextVideoTitleEl) nextVideoTitleEl.textContent = candidate.title || candidate.original_filename || `视频 ${candidate.id}`;
      if (nextVideoMetaEl) {
        const diff = formatDifficultyLabel(candidate.difficulty_level || candidate.level);
        nextVideoMetaEl.textContent = `${diff} · ${fmtSec(candidate.duration_sec || candidate.duration || 0)}`;
      }
      if (nextVideoReasonEl) nextVideoReasonEl.textContent = reason;
      nextVideoCardEl.hidden = false;
      nextRecoImpressions.track(candidate, 'next', 0);
    }

    function localNextReason(candidate) {
      const preferred = getPreferredLevelForRecommend();
      const match = preferred && normalizeDifficultyLevel(candidate.difficulty_level) === preferred;
      const progressPercent = getVideoProgressPercent(candidate.id);
      if (match) return '匹配你的学习等级';
      if (progressPercent > 0 && progressPercent < 90) return '继续完成未学完的视频';
      return '根据你的学习进度推荐';
    }

    function applyRemoteNextVideo(afterId, remote) {
      if (!remote || !state.currentVideo || String(state.currentVideo.id) !== afterId) return;
      const local = findLocalVideo(remote.id);
      const candidate = { ...(local || {}), ...remote, fromBackend: true, local };
      renderNextVideoCandidate(candidate, remote.recommendationReason || '接着练下一个');
    }

    function updateNextVideoCard() {
      if (!nextVideoCardEl) return;
      nextVideoCardEl.classList.remove('is-ended');
      const list = Array.isArray(state.filteredVideos) && state.filteredVideos.length ? state.filteredVideos : state.videos;
      if (!state.currentVideo) {
        nextVideoCardEl.hidden = true;
        nextVideoCandidate = null;
        return;
      }
      const afterId = String(state.currentVideo.id);
      if (nextRecoCache.has(afterId) && nextRecoCache.get(afterId)) {
        applyRemoteNextVideo(afterId, nextRecoCache.get(afterId));
        return;
      }
      const candidate = list.length ? pickNextVideoCandidate(list) : null;
      if (candidate) {
        renderNextVideoCandidate(candidate, localNextReason(candidate));
      } else {
        nextVideoCardEl.hidden = true;
        nextVideoCandidate = null;
      }
      if (nextRecoCache.has(afterId) || !window.VideoRecommendationClient) return;
      nextRecoCache.set(afterId, null);
      window.VideoRecommendationClient.fetchNextVideo({ apiBase: API_BASE, afterId, token: getToken() })
        .then((remote) => {
          if (!remote) {
            nextRecoCache.delete(afterId);
            return;
          }
          nextRecoCache.set(afterId, remote);
          applyRemoteNextVideo(afterId, remote);
        });
    }

    function openNextVideoCandidate(candidate) {
      if (!candidate) return;
      if (window.VideoRecommendationClient) {
        postEvent('reco_click', window.VideoRecommendationClient.eventProps(candidate, 'next', 0));
      }
      const local = candidate.fromBackend ? (candidate.local || findLocalVideo(candidate.id)) : candidate;
      if (local) {
        selectVideo(local);
        return;
      }
      // 推荐的视频不在当前列表里:按 videoId 重新打开阅读器
      const url = new URL(window.location.href);
      url.search = '';
      url.searchParams.set('videoId', String(candidate.id));
      url.searchParams.set('from', 'next');
      window.location.href = url.toString();
    }

    function highlightNextVideoCard() {
      if (!nextVideoCardEl || nextVideoCardEl.hidden) return;
      nextVideoCardEl.classList.add('is-ended');
      nextVideoCardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function renderTodayRecoCard(candidate) {
      if (!todayRecoCardEl) return;
      if (!candidate || (todayRecoSession && !todayRecoSession.shouldShow(candidate))) {
        todayRecoCardEl.hidden = true;
        return;
      }
      if (todayRecoNameEl) {
        todayRecoNameEl.textContent = candidate.title || candidate.original_filename || `视频 ${candidate.id}`;
      }
      if (todayRecoMetaEl) {
        const diff = formatDifficultyLabel(candidate.difficulty_level);
        todayRecoMetaEl.textContent = `${diff} · ${fmtSec(candidate.duration_sec || 0)}`;
      }
      if (todayRecoReasonEl) {
        const preferred = getPreferredLevelForRecommend();
        const match = preferred && normalizeDifficultyLevel(candidate.difficulty_level) === preferred;
        const progressPercent = getVideoProgressPercent(candidate.id);
        if (match) {
          todayRecoReasonEl.textContent = '理由：匹配你的学习等级';
        } else if (progressPercent > 0 && progressPercent < 90) {
          todayRecoReasonEl.textContent = '理由：继续完成未学完的视频';
        } else if (candidate.transcript) {
          todayRecoReasonEl.textContent = '理由：字幕完整，适合跟读练习';
        } else {
          todayRecoReasonEl.textContent = '理由：适合今天的学习节奏';
        }
      }
      todayRecoCardEl.hidden = false;
    }

    function updateTodayRecoCard() {
      if (!todayRecoCardEl) return;
      if (state.isLoadingVideos && (!state.videos || state.videos.length === 0)) {
        todayRecoCardEl.hidden = true;
        todayRecoCandidate = null;
        return;
      }
      const difficultyFilter = typeof window.getCurrentDifficultyFilter === 'function' ? window.getCurrentDifficultyFilter() : null;
      let list = Array.isArray(state.videos) ? state.videos : [];
      if (difficultyFilter) {
        const filtered = list.filter(v => v.difficulty_level === difficultyFilter);
        if (filtered.length) list = filtered;
      }
      if (!list.length) {
        todayRecoCardEl.hidden = true;
        todayRecoCandidate = null;
        return;
      }
      const candidate = pickTodayRecoCandidate(list);
      todayRecoCandidate = candidate;
      renderTodayRecoCard(candidate);
    }

    if (extractWordsCta) {
      extractWordsCta.addEventListener('click', () => {
        if (importWordsBtn && !importWordsBtn.disabled) importWordsBtn.click();
      });
    }
    if (subtitleLocateBtn) {
      subtitleLocateBtn.addEventListener('click', () => {
        const locateBtn = document.getElementById('scroll-active');
        locateBtn?.click();
      });
    }
    if (openVocabTabBtn) {
      openVocabTabBtn.addEventListener('click', () => {
        if (location.hash === '#vocabulary') {
          location.hash = '';
          setHashView('');
          vocabStudyStop();
          return;
        }
        location.hash = '#vocabulary';
        setHashView('#vocabulary', { videoId: state.currentVideo && state.currentVideo.id });
        vocabStudyStart();
      });
    }
    if (nextVideoBtn) {
      nextVideoBtn.addEventListener('click', () => {
        openNextVideoCandidate(nextVideoCandidate);
      });
    }
    if (todayRecoBtn) {
      todayRecoBtn.addEventListener('click', () => {
        if (!todayRecoCandidate) return;
        if (todayRecoSession) {
          todayRecoSession.start(todayRecoCandidate, {
            card: todayRecoCardEl,
            selectVideo
          });
          return;
        }
        if (todayRecoCardEl) {
          todayRecoCardEl.hidden = true;
          todayRecoCardEl.style.display = 'none';
        }
        selectVideo(todayRecoCandidate);
      });
    }
    if (todayRecoRefreshBtn) {
      todayRecoRefreshBtn.addEventListener('click', () => {
        const difficultyFilter = typeof window.getCurrentDifficultyFilter === 'function' ? window.getCurrentDifficultyFilter() : null;
        let list = Array.isArray(state.videos) ? state.videos : [];
        if (difficultyFilter) {
          const filtered = list.filter(v => v.difficulty_level === difficultyFilter);
          if (filtered.length) list = filtered;
        }
        if (!list.length) return;
        const next = pickTodayRecoCandidate(list, todayRecoCandidate ? todayRecoCandidate.id : null);
        todayRecoCandidate = next;
        renderTodayRecoCard(next);
      });
    }

    playerOverlayRefreshBtn?.addEventListener('click', () => {
      try { location.reload(); } catch (_) { }
    });
    playerOverlayRetryBtn?.addEventListener('click', () => {
      try {
        if (!state.currentVideo) return;
        // Re-select current video to retry loading strategy.
        selectVideo(state.currentVideo);
      } catch (_) { }
    });

    // ===== Player Manager (supports both local and YouTube videos) =====
    let youtubePlayer = null;
    let currentPlayerType = null; // 'local' or 'youtube'
    let suppressLocalPlayerErrorsUntil = 0;
    let activeLocalSelectionToken = null;
    let pendingLocalSeekHandler = null;

    videoSelectionGuard = window.LinglishVideoSelectionGuard.createVideoSelectionLifecycle({
      cancelPendingLocalSeek: () => {
        if (!playerEl || !pendingLocalSeekHandler) return;
        playerEl.removeEventListener('loadedmetadata', pendingLocalSeekHandler);
        pendingLocalSeekHandler = null;
      },
      unloadLocal: () => {
        activeLocalSelectionToken = null;
        currentPlayerType = null;
        if (!playerEl) return;
        suppressLocalPlayerErrorsUntil = Date.now() + 1200;
        playerEl.onerror = null;
        try { playerEl.pause(); } catch (_) { }
        try { playerEl.removeAttribute('src'); } catch (_) { }
        try { playerEl.load(); } catch (_) { }
      },
      destroyYouTube: () => {
        if (!youtubePlayer) return;
        try { youtubePlayer.destroy(); } catch (_) { }
        youtubePlayer = null;
      },
      clearTranscript: () => {
        clearTranscriptCues();
        renderTranscript();
        renderActiveSubtitle(-1);
      },
    });

    const isActiveLocalSelection = () => {
      const currentId = state.currentVideo && state.currentVideo.id;
      return currentPlayerType === 'local' && activeLocalSelectionToken &&
        videoSelectionGuard.isCurrent(activeLocalSelectionToken, currentId);
    };
    if (playerEl) {
      playerEl.addEventListener('play', () => {
        try { noteLearningVideoStarted(); } catch (_) { }
        if (!isActiveLocalSelection()) return;
        isVideoPlaying = true;
        updateShellCollapse();
      });
      playerEl.addEventListener('pause', () => { if (!isActiveLocalSelection()) return; isVideoPlaying = false; updateShellCollapse(); });
      playerEl.addEventListener('ended', () => { if (!isActiveLocalSelection()) return; isVideoPlaying = false; updateShellCollapse(); });
      // Loading UX: show overlay instead of pure black
      const showLoading = () => {
        if (!isActiveLocalSelection()) return;
        setPlayerOverlay('loading', {
          titleKey: 'video.overlay.loading_title',
          descKey: 'video.overlay.loading_desc',
          tips: [
            tOverlay('video.overlay.tip_switch', '加载期间仍可从左侧切换其它视频。'),
            tOverlay('video.overlay.tip_subtitle', '视频加载后会自动加载字幕；如果没字幕，可能还在转录中。'),
          ]
        });
      };
      const showReady = () => {
        if (!isActiveLocalSelection()) return;
        setPlayerOverlay('ready');
      };
      const showError = () => {
        if (!isActiveLocalSelection()) return;
        // 例如“返回列表/清空 src”等主动重置时，浏览器可能触发一次 error 事件；此时不应显示失败提示
        if (Date.now() < suppressLocalPlayerErrorsUntil) {
          setPlayerOverlay('idle', {
            titleKey: 'video.overlay.empty_title',
            descKey: 'video.overlay.empty_desc',
            tips: [
              tOverlay('video.overlay.tip_pick', '打开顶部「视频库」，选一个视频开始学习。'),
              getUploadTip(),
            ]
          });
          return;
        }
        setPlayerOverlay('error', {
          titleKey: 'video.overlay.error_title',
          descKey: 'video.overlay.error_desc',
          tips: [tOverlay('video.overlay.tip_retry', '可以尝试重试加载，或切换到其它视频。')]
        });
      };
      playerEl.addEventListener('loadstart', showLoading);
      playerEl.addEventListener('waiting', showLoading);
      playerEl.addEventListener('stalled', showLoading);
      playerEl.addEventListener('loadeddata', showReady);
      playerEl.addEventListener('canplay', showReady);
      playerEl.addEventListener('playing', showReady);
      playerEl.addEventListener('error', showError);
    }

    // Unified player interface
    const unifiedPlayer = {
      get currentTime() {
        if (currentPlayerType === 'youtube' && youtubePlayer) {
          return youtubePlayer.getCurrentTime() || 0;
        }
        return playerEl.currentTime || 0;
      },
      set currentTime(value) {
        if (currentPlayerType === 'youtube' && youtubePlayer) {
          youtubePlayer.seekTo(value);
        } else {
          playerEl.currentTime = value;
        }
      },
      play() {
        stopSpokenAudio();
        if (currentPlayerType === 'youtube' && youtubePlayer) {
          youtubePlayer.play();
        } else {
          playerEl.play();
        }
      },
      pause() {
        if (currentPlayerType === 'youtube' && youtubePlayer) {
          youtubePlayer.pause();
        } else {
          playerEl.pause();
        }
      },
      addEventListener(event, handler) {
        if (currentPlayerType === 'youtube' && youtubePlayer) {
          if (event === 'timeupdate') {
            youtubePlayer.on('timeupdate', handler);
          } else if (event === 'play') {
            // Will be triggered through state change
          } else if (event === 'pause') {
            // Will be triggered through state change
          }
        } else {
          playerEl.addEventListener(event, handler);
        }
      }
    };
    const tabVideoBtn = document.getElementById('tab-video');
    const tabVocabBtn = document.getElementById('tab-vocab');
    const viewVideoEl = document.getElementById('view-video');
    const viewVocabEl = document.getElementById('view-vocab');
    const gotoVocabLink = document.getElementById('goto-vocab');
    const vocabListEl = document.getElementById('vocab-list');
    const vocabEmptyEl = document.getElementById('vocab-empty');
    const vocabStatsEl = document.getElementById('vocab-stats');
    const vocabSearchEl = document.getElementById('vocab-search');
    const reloadVocabBtn = document.getElementById('reload-vocab');
    const vocabSuggestionsEl = document.getElementById('vocab-suggestions');
    const vocabHistoryEl = document.getElementById('vocab-history');
    const vocabHotEl = document.getElementById('vocab-hot');
    const vocabEmbedFrame = document.getElementById('vocab-embed-frame');
    const vocabNativeWrap = document.getElementById('vocab-native');

    function normalizeLevel(raw) {
      const v = String(raw || '').trim().toLowerCase();
      if (v === 'beginner' || v === 'intermediate' || v === 'advanced') return v;
      return null;
    }

    function resolveVocabLevel() {
      const params = new URLSearchParams(window.location.search || '');
      const urlLevel = normalizeLevel(params.get('level') || params.get('difficulty'));
      if (urlLevel) return urlLevel;
      try {
        const stored = normalizeLevel(localStorage.getItem('vocab_difficulty_filter'));
        if (stored) return stored;
      } catch (_) { }
      try {
        const stored = normalizeLevel(localStorage.getItem('linglish_active_level'));
        if (stored) return stored;
      } catch (_) { }
      return 'beginner';
    }

    function resolveVocabVersion() {
      const params = new URLSearchParams(window.location.search || '');
      return params.get('v') || '20260102b';
    }

    function syncVocabEmbed(videoId, sentence) {
      if (!vocabEmbedFrame) return;
      const level = resolveVocabLevel();
      const v = resolveVocabVersion();
      const params = new URLSearchParams({ embed: '1', level, v });
      if (videoId) params.set('videoId', String(videoId));
      if (sentence) params.set('sentence', '1');
      const next = `./video-vocabulary-desktop.html?${params.toString()}`;
      if (vocabEmbedFrame.getAttribute('src') !== next) {
        vocabEmbedFrame.setAttribute('src', next);
      }
      const embedWrap = vocabEmbedFrame.closest('.vocab-embed');
      if (embedWrap) embedWrap.classList.add('loading');
      if (vocabNativeWrap) vocabNativeWrap.style.display = '';
    }

    if (vocabEmbedFrame) {
      vocabEmbedFrame.addEventListener('load', () => {
        const embedWrap = vocabEmbedFrame.closest('.vocab-embed');
        if (embedWrap) embedWrap.classList.remove('loading');
        if (vocabNativeWrap) vocabNativeWrap.style.display = 'none';
      });
      vocabEmbedFrame.addEventListener('error', () => {
        const embedWrap = vocabEmbedFrame.closest('.vocab-embed');
        if (embedWrap) embedWrap.classList.remove('loading');
        if (vocabNativeWrap) vocabNativeWrap.style.display = '';
      });
    }
    const transcriptListEl = document.getElementById('transcript-list');
    const modeEnBtn = document.getElementById('mode-en');
    const modeBiBtn = document.getElementById('mode-bilingual');
    const toggleSidebarBtn = document.getElementById('toggle-sidebar');
    // Dictionary drawer elements
    const dictDrawer = document.getElementById('dict-drawer');
    const dictBody = document.getElementById('dict-body');
    const dictClose = document.getElementById('dict-close');
    if (dictClose) dictClose.addEventListener('click', () => hideDrawer());
    const scrollActiveBtn = document.getElementById('scroll-active');

    // PC auto-follow guards
    let __isAutoScrolling = false;
    let __userScrollLockUntil = 0; // Skip auto-follow while user is actively scrolling
    const lockUserScroll = () => { __userScrollLockUntil = Date.now() + 1500; };
    if (transcriptListEl) {
      // Wheel/touch imply manual intent; lock briefly
      transcriptListEl.addEventListener('wheel', lockUserScroll, { passive: true });
      transcriptListEl.addEventListener('touchstart', lockUserScroll, { passive: true });
      // Distinguish auto vs manual scrolls
      transcriptListEl.addEventListener('scroll', () => {
        if (!__isAutoScrolling) {
          __userScrollLockUntil = Date.now() + 1200;
        }
      });
    }

    // Transcript display mode toggle
    const savedMode = (localStorage.getItem('transcript_mode') || 'en').toLowerCase();
    state.showBilingual = savedMode === 'bi';

    // 检测当前字幕是否已有中文（导入或已按需翻译）
    const hasTranslationAvailable = () => {
      if (!Array.isArray(state.currentSegments) || !state.currentSegments.length) return false;
      return state.currentSegments.some(seg => {
        const trans = seg.translation || seg.cn || seg.zh || seg.text_cn || '';
        return String(trans).trim().length > 0 && /[\u4e00-\u9fa5]/.test(String(trans));
      });
    };

    // 获取字幕来源标签
    const getSubtitleSourceLabel = () => {
      if (!Array.isArray(state.currentSegments) || !state.currentSegments.length) return '';
      const firstSeg = state.currentSegments[0] || {};
      const source = firstSeg.source || '';
      if (source === 'manual') return '手动导入';
      if (source === 'youtube') return 'YouTube';
      if (source === 'whisper' || source === 'openai') return 'Whisper';
      if (source === 'gemini') return 'Gemini';
      if (source === 'custom') return '自动转写';
      if (source === 'baidu') return '百度';
      return '';
    };

    const syncModeButtons = () => {
      if (!modeEnBtn || !modeBiBtn) return;
      const hasSegs = Array.isArray(state.currentSegments) && state.currentSegments.length > 0;
      modeEnBtn.classList.toggle('active', !state.showBilingual);
      modeBiBtn.classList.toggle('active', !!state.showBilingual);
      // 有字幕即可点双语：没有现成中文时会按需翻译
      modeBiBtn.disabled = !hasSegs;
      modeBiBtn.style.opacity = hasSegs ? '1' : '0.5';
      modeBiBtn.style.cursor = hasSegs ? 'pointer' : 'not-allowed';
      modeBiBtn.title = hasSegs ? '显示中英双语（无译文时自动翻译）' : '暂无字幕';
    };
    syncModeButtons();
    modeEnBtn?.addEventListener('click', () => {
      state.showBilingual = false;
      localStorage.setItem('transcript_mode', 'en');
      syncModeButtons();
      renderTranscript();
      syncActive();
    });
    modeBiBtn?.addEventListener('click', () => {
      if (!Array.isArray(state.currentSegments) || !state.currentSegments.length) {
        try { showToast('暂无字幕，无法切换双语', 'warn'); } catch (_) { }
        return;
      }
      state.showBilingual = true;
      localStorage.setItem('transcript_mode', 'bi');
      syncModeButtons();
      renderTranscript();
      syncActive();
      ensureDesktopBilingualTranslations().catch(() => { });
    });

    // ===== Helpers =====
    // Helper function to dynamically get current token
    const getToken = () => {
      try {
        return (window.AuthManager && window.AuthManager.getToken()) ||
          localStorage.getItem('linglish_token') ||
          sessionStorage.getItem('linglish_token') ||
          localStorage.getItem('authToken') ||
          sessionStorage.getItem('authToken');
      } catch (_) {
        return null;
      }
    };

    const headers = () => {
      const h = { 'Content-Type': 'application/json' };
      // Dynamically get token from AuthManager to handle login state changes
      try {
        const currentToken = getToken();
        if (currentToken && currentToken !== 'null' && currentToken !== 'undefined') {
          h['Authorization'] = `Bearer ${currentToken}`;
        }
      } catch (_) { }
      return h;
    };
    const fmtSec = s => { s = Number(s) || 0; const m = Math.floor(s / 60); const sec = Math.floor(s % 60).toString().padStart(2, '0'); return `${m}:${sec}`; };
    const resolveThumbnail = (video) => {
      const placeholder = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#667eea"/><stop offset="100%" style="stop-color:#764ba2"/></linearGradient></defs><rect width="160" height="90" fill="url(#g)"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="Arial" font-size="14" fill="white">No Thumb</text></svg>`)}`;
      const normalizeUrl = (path) => {
        if (!path) return null;
        if (/^https?:\/\//i.test(path)) return path;
        const trimmed = path.startsWith('/') ? path : `/${path}`;
        return `${API_BASE}${trimmed}`;
      };
      const ytId = video.youtube_video_id;
      // 优先使用 YouTube 官方缩略图
      if (ytId) return `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
      if (video.thumbnail_path) {
        // 尝试加载本地缩略图，如果失败 onerror 会显示占位图
        const normalized = normalizeUrl(video.thumbnail_path) || placeholder;
        return normalized;
      }
      // 兜底：根据视频文件名推导缩略图
      try {
        const raw = video.video_path || '';
        if (raw) {
          const base = raw.split('/').pop() || '';
          const stem = base ? base.replace(/\.[^/.]+$/, '') : '';
          if (stem) {
            const guess = normalizeUrl(`/static/thumbnails/${stem}.jpg`);
            return guess || placeholder;
          }
        }
      } catch (_) { }
      return placeholder;
    };
    const esc = (s) => String(s ?? '').replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    let pendingSeek = null;
    function normalizeStartSec(raw) {
      const v = Number(raw);
      return Number.isFinite(v) && v >= 0 ? v : null;
    }
    function readStartSecFromUrl() {
      try {
        const p = new URLSearchParams(location.search || '');
        return normalizeStartSec(p.get('startSec') || p.get('start_sec') || p.get('start') || p.get('t'));
      } catch (_) { return null; }
    }
    function applyPendingSeekToLocal(selectionToken) {
      if (!pendingSeek || !state.currentVideo) return;
      if (String(pendingSeek.videoId) !== String(state.currentVideo.id)) return;
      if (!playerEl) return;
      if (pendingLocalSeekHandler) {
        playerEl.removeEventListener('loadedmetadata', pendingLocalSeekHandler);
      }
      const seekRequest = pendingSeek;
      const expectedVideoId = String(seekRequest.videoId);
      const seekTime = Number(seekRequest.startSec) || 0;
      pendingLocalSeekHandler = () => {
        pendingLocalSeekHandler = null;
        if (pendingSeek !== seekRequest) return;
        if (!videoSelectionGuard.isCurrent(selectionToken, expectedVideoId)) return;
        if (!state.currentVideo || String(state.currentVideo.id) !== expectedVideoId) return;
        try { playerEl.currentTime = seekTime; } catch (_) { }
        pendingSeek = null;
      };
      playerEl.addEventListener('loadedmetadata', pendingLocalSeekHandler, { once: true });
    }
    function applyPendingSeekToYouTube() {
      if (!pendingSeek || !state.currentVideo) return;
      if (String(pendingSeek.videoId) !== String(state.currentVideo.id)) return;
      const seekTime = Number(pendingSeek.startSec) || 0;
      if (youtubePlayer && typeof youtubePlayer.seekTo === 'function') {
        youtubePlayer.seekTo(seekTime);
        pendingSeek = null;
      }
    }

    // ===== Video progress cache (local) =====
    function getVideoProgressKey() {
      return `video_progress_${getUserKey()}`;
    }
    function loadVideoProgressMap() {
      try {
        const raw = localStorage.getItem(getVideoProgressKey());
        if (!raw || raw === 'undefined' || raw === 'null') return new Map();
        const obj = JSON.parse(raw);
        return new Map(Object.entries(obj || {}));
      } catch (_) { return new Map(); }
    }
    function saveVideoProgressMap(map) {
      try {
        const obj = Object.fromEntries(map.entries());
        localStorage.setItem(getVideoProgressKey(), JSON.stringify(obj));
      } catch (_) { }
    }
    const videoProgressMap = loadVideoProgressMap();
    const progressSaveState = { lastAt: 0, lastPercent: 0 };
    const DAILY_GOAL_TOTAL = 3;
    const dailyGoalLabelEl = document.getElementById('daily-goal-label');
    const dailyGoalFillEl = document.getElementById('daily-goal-fill');

    function isSameLocalDay(a, b) {
      const da = new Date(a);
      const db = new Date(b);
      return da.getFullYear() === db.getFullYear() &&
        da.getMonth() === db.getMonth() &&
        da.getDate() === db.getDate();
    }

    function getDailyCompletedCount() {
      const now = Date.now();
      let count = 0;
      videoProgressMap.forEach((entry) => {
        const percent = Number(entry?.percent || 0);
        const updatedAt = Number(entry?.updatedAt || 0);
        if (percent >= 90 && updatedAt && isSameLocalDay(updatedAt, now)) {
          count += 1;
        }
      });
      return count;
    }

    function updateDailyGoalUI() {
      if (!dailyGoalLabelEl || !dailyGoalFillEl) return;
      const completed = Math.min(DAILY_GOAL_TOTAL, getDailyCompletedCount());
      dailyGoalLabelEl.textContent = `今日目标：${completed}/${DAILY_GOAL_TOTAL}视频`;
      dailyGoalFillEl.style.width = `${Math.min(100, (completed / DAILY_GOAL_TOTAL) * 100)}%`;
    }
    updateDailyGoalUI();

    function initFirstWinExperience() {
      const modal = document.getElementById('first-win-modal');
      const playBtn = document.getElementById('first-win-play');
      const completeBtn = document.getElementById('first-win-complete');
      const sentenceEl = document.getElementById('first-win-sentence');
      const celebrate = document.getElementById('first-win-celebration');
      if (!modal || !playBtn || !completeBtn) return;
      try {
        if (localStorage.getItem('linglish_first_win_done') === 'true') return;
      } catch (_) { }
      try {
        const token = window.AuthManager?.getToken?.() ||
          localStorage.getItem('linglish_token') ||
          sessionStorage.getItem('linglish_token') ||
          localStorage.getItem('authToken') ||
          sessionStorage.getItem('authToken');
        if (token && token !== 'null' && token !== 'undefined') return;
      } catch (_) { }

      modal.hidden = false;
      let unlocked = false;

      playBtn.addEventListener('click', () => {
        const sentence = sentenceEl ? sentenceEl.textContent.trim() : 'I can do this.';
        if ('speechSynthesis' in window) {
          try {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(sentence || 'I can do this.');
            utterance.lang = 'en-US';
            utterance.rate = 0.9;
            window.speechSynthesis.speak(utterance);
          } catch (_) { }
        }
        if (!unlocked) {
          unlocked = true;
          completeBtn.disabled = true;
          completeBtn.textContent = '跟读中...';
          setTimeout(() => {
            completeBtn.disabled = false;
            completeBtn.textContent = '我已跟读';
          }, 1200);
        }
      });

      completeBtn.addEventListener('click', () => {
        modal.hidden = true;
        try { localStorage.setItem('linglish_first_win_done', 'true'); } catch (_) { }
        if (celebrate) {
          celebrate.hidden = false;
          setTimeout(() => {
            celebrate.hidden = true;
          }, 1800);
        }
      });
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initFirstWinExperience);
    } else {
      initFirstWinExperience();
    }

    function getVideoProgressPercent(videoId) {
      const entry = videoProgressMap.get(String(videoId));
      const percent = Number(entry?.percent || 0);
      return Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 0;
    }

    function recordVideoProgress(videoId, currentTime, duration) {
      if (!videoId || !duration || duration <= 0) return;
      const percent = Math.min(100, Math.round((currentTime / duration) * 100));
      if (!Number.isFinite(percent)) return;
      const now = Date.now();
      const shouldSave = percent >= 100 || (percent - progressSaveState.lastPercent >= 1) || (now - progressSaveState.lastAt >= 6000);
      if (!shouldSave) return;
      progressSaveState.lastAt = now;
      progressSaveState.lastPercent = percent;
      videoProgressMap.set(String(videoId), { percent, seconds: Math.round(currentTime), updatedAt: now });
      saveVideoProgressMap(videoProgressMap);
      if (percent >= 90) updateDailyGoalUI();
    }

    function updateVideoCardProgress(videoId, percent) {
      if (!videoListEl || !videoId) return;
      const item = videoListEl.querySelector(`.video-item[data-video-id="${videoId}"]`);
      if (!item) return;
      const badgeWrap = item.querySelector('.video-badges');
      if (badgeWrap) {
        let badge = badgeWrap.querySelector('.video-badge.progress, .video-badge.complete');
        const isComplete = percent >= 90;
        if (!badge && percent > 0) {
          badge = document.createElement('span');
          badge.className = `video-badge ${isComplete ? 'complete' : 'progress'}`;
          badgeWrap.appendChild(badge);
        }
        if (badge) {
          badge.classList.toggle('complete', isComplete);
          badge.classList.toggle('progress', !isComplete);
          badge.textContent = isComplete ? '已完成' : `已学 ${percent}%`;
        }
      }
      let bar = item.querySelector('.video-progress-bar span');
      if (!bar && percent > 0) {
        const barWrap = document.createElement('div');
        barWrap.className = 'video-progress-bar';
        bar = document.createElement('span');
        barWrap.appendChild(bar);
        const meta = item.querySelector('.video-badges');
        if (meta) {
          meta.insertAdjacentElement('afterend', barWrap);
        } else {
          item.appendChild(barWrap);
        }
      }
      if (bar) {
        bar.style.width = `${percent}%`;
      }
    }

    function getPreviewText(video) {
      const candidates = [
        video.preview_sentence,
        video.key_sentence,
        video.transcript_summary,
        video.sample_sentence,
        video.transcript
      ];
      const raw = candidates.find(Boolean);
      if (!raw) return '';
      const text = String(raw).replace(/\s+/g, ' ').trim();
      if (!text) return '';
      return text.length > 80 ? `${text.slice(0, 78)}…` : text;
    }

    function getVideoWpm(video) {
      const raw = video.wpm || video.words_per_minute || video.speech_rate || video.speech_rate_wpm;
      const num = Number(raw);
      return Number.isFinite(num) && num > 0 ? Math.round(num) : null;
    }

    function getTextSample(video) {
      const candidates = [
        video.transcript_summary,
        video.preview_sentence,
        video.key_sentence,
        video.sample_sentence,
        video.transcript
      ];
      const raw = candidates.find(Boolean);
      if (!raw) return '';
      const text = String(raw).replace(/\s+/g, ' ').trim();
      if (!text) return '';
      return text.length > 1200 ? text.slice(0, 1200) : text;
    }

    function analyzeTextSample(text) {
      const words = String(text).toLowerCase().match(/[a-z']+/g) || [];
      if (words.length < 12) return null;
      const unique = new Set(words).size;
      const total = words.length;
      const sentences = String(text).split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
      const avgSentenceLen = sentences.length ? total / sentences.length : total;
      return {
        total,
        uniqueRatio: unique / total,
        avgSentenceLen
      };
    }

    function getSpeedLabel(wpm) {
      if (!wpm) return null;
      if (wpm <= 120) return '语速 慢';
      if (wpm <= 160) return '语速 适中';
      return '语速 快';
    }

    function getDensityLabel(ratio) {
      if (!Number.isFinite(ratio)) return null;
      if (ratio <= 0.35) return '生词密度 低';
      if (ratio <= 0.5) return '生词密度 中';
      return '生词密度 高';
    }

    function getComplexityLabel(avgSentenceLen) {
      if (!Number.isFinite(avgSentenceLen)) return null;
      if (avgSentenceLen <= 10) return '句子复杂度 低';
      if (avgSentenceLen <= 16) return '句子复杂度 中';
      return '句子复杂度 高';
    }

    // ===== Analytics helpers (video_watch, vocab_study) =====
    function getAnalyticsContext() {
      const params = new URLSearchParams(window.location.search || '');
      return {
        page: 'video-reader-desktop',
        from: params.get('from') || null,
      };
    }

    async function postEvent(name, properties = {}) {
      try {
        const currentToken = getToken();
        const eventHeaders = { 'Content-Type': 'application/json' };
        if (currentToken) eventHeaders.Authorization = `Bearer ${currentToken}`;
        await fetch(`${API_BASE}${currentToken ? '/events' : '/track/event'}`, {
          method: 'POST',
          headers: eventHeaders,
          body: JSON.stringify(window.LinglishVisitor.decorateEvent({ event_name: name, properties: { ...getAnalyticsContext(), ...properties } })),
        });
      } catch (e) { debugLog('postEvent failed', e); }
    }
    const firstLessonInitialContext = window.LinglishFirstLessonFocus.readContext(window.location.search);
    const readerEntry = firstLessonInitialContext.from;
    let firstLessonRecorderController = null;
    let currentDesktopSelectionToken = null;
    let firstLessonPlaybackLocked = false;
    let firstLessonOriginalController = null;
    const firstLessonSession = window.LinglishFirstLessonFocus.createSession({
      search: window.location.search,
      pathname: window.location.pathname,
      hash: window.location.hash,
      document,
      history: window.history,
      location: window.location,
      onClear: clearDesktopFirstLessonState,
    });
    const firstLessonReadiness = window.LinglishFirstLessonReadiness.createFirstLessonReadiness({
      focus: firstLessonInitialContext.enabled ? 'first_lesson' : null,
      from: readerEntry,
      startedAt: performance.timeOrigin || Date.now(),
    });
    const firstLessonLifecycle = window.LinglishFirstLessonFocus.createLifecycleTracker({
      search: window.location.search,
      isActive: () => firstLessonSession.isActive(),
      emit: postEvent,
    });
    const firstLessonProgressStore = window.LinglishFirstLessonProgress.createStore(localStorage, Date.now);
    let firstLessonProgressSubject = null;
    let firstLessonPracticeSnapshot = null;
    const firstLessonGoalStore = window.LinglishFirstLessonGoal.createStore(localStorage);
    let firstLessonGoal = null;
    const firstLessonGoalCard = window.LinglishFirstLessonGoal.createCard(document.getElementById('first-lesson-goal'), {
      mobile: false,
      getSentence: (index) => {
        const line = state.currentSegments[index];
        return line && { index, text: line.text, translation: line.translation || line.cn || line.zh || line.text_cn || '' };
      },
      pauseOriginal: () => { firstLessonOriginalController?.stop(); pauseFirstLessonSourcePlayback(); stopSpokenAudio(); },
      listen: (index) => {
        if (!firstLessonSession.isActive()) return;
        postEvent('first_lesson_goal_listen', { video_resource_id: state.currentVideo?.id });
        firstLessonOriginalController.play(index);
      },
      record: async (index) => {
        if (!firstLessonSession.isActive() || !firstLessonRecorderController) return;
        if (firstLessonRecorderController.isRecording()) { firstLessonRecorderController.stop('manual'); return; }
        firstLessonOriginalController.stop();
        const segment = state.currentSegments[index];
        if (!segment) return;
        pauseFirstLessonSourcePlayback();
        const start = Number(segment.start ?? segment.start_sec ?? 0);
        if (currentPlayerType === 'youtube' && youtubePlayer) youtubePlayer.seekTo(start);
        else playerEl.currentTime = start;
        renderActiveSubtitle(index);
        const context = createDesktopAssessmentContext({ index, segment });
        if (context) await firstLessonRecorderController.start(context);
      },
      next: () => {
        firstLessonOriginalController.stop();
        const selected = currentFirstLessonSegment();
        const nextIndex = firstLessonGoal && !firstLessonGoal.complete ? firstLessonGoal.nextIndex : selected && selected.index + 1;
        const moved = Number.isInteger(nextIndex) && advanceDesktopFirstLesson({ displayIndex: nextIndex - 1 });
        if (!moved) {
          location.href = './today.html?from=first_lesson_complete#day-end';
          return;
        }
        firstLessonGoalCard.update(firstLessonGoal);
      },
    });
    firstLessonOriginalController = createDesktopFirstLessonPreview();

    function clearDesktopFirstLessonState() {
      firstLessonProgressSubject = null;
      firstLessonPracticeSnapshot = null;
      firstLessonGoal = null;
      firstLessonGoalCard.hide();
      if (videoProgressLabelEl) videoProgressLabelEl.textContent = '';
    }

    function teardownFirstLessonRecording(reason) {
      if (firstLessonOriginalController) firstLessonOriginalController.stop();
      if (firstLessonRecorderController) firstLessonRecorderController.teardown(reason || 'exit');
    }

    firstLessonSession.addTeardown(teardownFirstLessonRecording);
    window.addEventListener('pagehide', () => teardownFirstLessonRecording('pagehide'));

    function resolveFirstLessonSubject() {
      const guestFlag = state.user
        ? Boolean(state.user.is_guest || state.user.isGuest || state.user.guest_id || state.user.guestId)
        : Boolean(localStorage.getItem('is_guest') === 'true' || sessionStorage.getItem('is_guest') === 'true');
      return window.LinglishFirstLessonProgress.resolveSubject({
        userId: state.user?.id || state.user?.user_id,
        token: getToken(),
        isGuest: guestFlag,
        visitorId: window.LinglishVisitor.getId(),
      });
    }

    function renderFirstLessonPracticeSnapshot(snapshot) {
      firstLessonPracticeSnapshot = snapshot;
      if (firstLessonSession.isActive() && videoProgressLabelEl && snapshot) {
        videoProgressLabelEl.textContent = `已练 ${snapshot.practicedCount}/${snapshot.total} · ${snapshot.percentage}%`;
      }
      if (firstLessonSession.isActive() && snapshot) {
        const ids = state.currentSegments.map((segment, index) => window.LinglishFirstLessonProgress.stableSegmentId(snapshot.videoId, segment, index));
        firstLessonGoal = firstLessonGoalStore.sync(snapshot, state.currentSegments, ids);
        firstLessonGoalCard.update(firstLessonGoal);
        if (firstLessonGoal?.newlyCompleted) postEvent('first_lesson_goal_completed', {
          video_resource_id: snapshot.videoId, target_lines: firstLessonGoal.total, full_video_complete: snapshot.complete,
        });
      }
    }

    function startFirstLessonProgress(video, segments) {
      if (!firstLessonSession.isActive() || !video || !Array.isArray(segments) || !segments.length) return null;
      firstLessonProgressSubject = resolveFirstLessonSubject();
      const snapshot = firstLessonProgressStore.start(firstLessonProgressSubject, video.id, segments);
      renderFirstLessonPracticeSnapshot(snapshot);
      if (firstLessonGoal) postEvent('first_lesson_goal_view', { video_resource_id: video.id, target_lines: firstLessonGoal.total, completed_lines: firstLessonGoal.completedCount });
      return snapshot;
    }

    function syncCompletedFirstLesson(snapshot) {
      if (!snapshot || !snapshot.complete) return false;
      return firstLessonProgressStore.syncCompleted(firstLessonProgressSubject, snapshot.videoId, (completed) => {
        const duration = Number(playerEl.duration || state.currentVideo?.duration_sec || 1);
        recordVideoProgress(snapshot.videoId, duration, duration);
        updateVideoCardProgress(snapshot.videoId, 100);
        try {
          const date = new Date();
          const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          localStorage.setItem('linglish_first_lesson_completion', JSON.stringify({
            date: dateKey,
            completed_at: new Date(completed.completedAt || Date.now()).toISOString(),
            video_id: completed.videoId,
            lines: completed.practicedCount,
            target_lines: completed.total,
            source: 'video-reader-desktop',
          }));
        } catch (_) { }
      });
    }

    function createDesktopAssessmentContext(selected) {
      if (!firstLessonSession.isActive() || !firstLessonProgressSubject || !state.currentVideo || !selected) return null;
      const segmentId = window.LinglishFirstLessonProgress.stableSegmentId(
        state.currentVideo.id,
        selected.segment,
        selected.index,
      );
      return window.LinglishFirstLessonPractice.createAssessmentContext({
        subject: firstLessonProgressSubject,
        videoId: state.currentVideo.id,
        stableSegmentId: segmentId,
        sourceIndices: selected.segment.source_indices,
        selectionGeneration: currentDesktopSelectionToken?.generation,
        displayIndex: selected.index,
      });
    }

    function isDesktopAssessmentContextCurrent(captured) {
      if (!captured || !firstLessonSession.isActive() || !state.currentVideo) return false;
      const selected = currentFirstLessonSegment();
      const displayIndex = selected && selected.index;
      const segment = selected && selected.segment;
      if (!segment) return false;
      const current = window.LinglishFirstLessonPractice.createAssessmentContext({
        subject: resolveFirstLessonSubject(),
        videoId: state.currentVideo.id,
        stableSegmentId: window.LinglishFirstLessonProgress.stableSegmentId(
          state.currentVideo.id,
          segment,
          displayIndex,
        ),
        sourceIndices: segment.source_indices,
        selectionGeneration: currentDesktopSelectionToken?.generation,
        displayIndex,
      });
      return window.LinglishFirstLessonPractice.assessmentContextMatches(captured, current)
        && videoSelectionGuard.isCurrent(currentDesktopSelectionToken, state.currentVideo.id);
    }

    function markFirstLessonPracticed(context, result, assessmentId) {
      if (!isDesktopAssessmentContextCurrent(context)) return null;
      const score = Number(result?.score ?? (Number(result?.similarity) * 100));
      const changed = firstLessonProgressStore.markPracticed(
        context.subject,
        context.videoId,
        context.stableSegmentId,
        {
          success: result?.success === true,
          score,
          evidence: { kind: 'recording_assessment', assessmentId, recording: true },
        },
      );
      renderFirstLessonPracticeSnapshot(changed.snapshot);
      if (changed.changed) {
        firstLessonLifecycle.practice(changed.snapshot);
        firstLessonLifecycle.feedback({ score, segmentId: context.stableSegmentId });
        syncCompletedFirstLesson(changed.snapshot);
      }
      return { accepted: result?.success === true, changed: changed.changed, score, snapshot: changed.snapshot };
    }
    const EVENT_CHUNK_SECONDS = 15;
    let watchTimer = null;
    let lastTickAt = null;
    function startWatchTimer() {
      if (!state.currentVideo || watchTimer) return;
      lastTickAt = Date.now();
      watchTimer = setInterval(() => {
        const now = Date.now();
        const delta = Math.max(1, Math.round((now - (lastTickAt || now)) / 1000));
        lastTickAt = now;
        postEvent('video_watch', { video_resource_id: state.currentVideo.id, seconds: Math.min(delta, EVENT_CHUNK_SECONDS) });
      }, EVENT_CHUNK_SECONDS * 1000);
    }
    function stopWatchTimer(flush = true) {
      if (flush && lastTickAt && state.currentVideo) {
        const now = Date.now();
        const delta = Math.round((now - lastTickAt) / 1000);
        if (delta > 0) postEvent('video_watch', { video_resource_id: state.currentVideo.id, seconds: Math.min(delta, EVENT_CHUNK_SECONDS) });
      }
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = null;
      lastTickAt = null;
    }
    let vocabStudyStartedAt = null;
    function vocabStudyStart() { if (!vocabStudyStartedAt) vocabStudyStartedAt = Date.now(); }
    function vocabStudyStop() {
      if (!vocabStudyStartedAt) return;
      const secs = Math.round((Date.now() - vocabStudyStartedAt) / 1000);
      vocabStudyStartedAt = null;
      if (secs > 0) postEvent('vocab_study', { seconds: secs });
    }

    function syncStudySwitch(isVocab) {
      if (!openVocabTabBtn) return;
      const label = isVocab ? '视频学习' : '查看词汇表';
      const labelEl = openVocabTabBtn.querySelector('.open-vocab-tab__label');
      if (labelEl) labelEl.textContent = label;
      else openVocabTabBtn.textContent = label;
      const vocabIcon = openVocabTabBtn.querySelector('.header-action-icon--vocab');
      const videoIcon = openVocabTabBtn.querySelector('.header-action-icon--video');
      if (vocabIcon) vocabIcon.hidden = !!isVocab;
      if (videoIcon) videoIcon.hidden = !isVocab;
      openVocabTabBtn.title = isVocab ? '返回视频播放' : '查看词汇表';
      openVocabTabBtn.setAttribute('aria-label', label);
      openVocabTabBtn.dataset.studyTarget = isVocab ? 'video' : 'vocab';
    }

    let vocabFocusVideoId = null;
    let vocabFocusSentence = false;
    function setHashView(hash, opts) {
      const isVocab = hash === '#vocabulary';
      const shell = document.querySelector('.shell');
      if (shell) shell.classList.toggle('vocab-view', isVocab);
      if (opts && Object.prototype.hasOwnProperty.call(opts, 'videoId')) {
        vocabFocusVideoId = opts.videoId || null;
        vocabFocusSentence = !!opts.sentence;
      } else if (!isVocab) {
        vocabFocusVideoId = null;
        vocabFocusSentence = false;
      }
      tabVideoBtn.classList.toggle('active', !isVocab);
      tabVocabBtn.classList.toggle('active', isVocab);
      viewVideoEl.style.display = isVocab ? 'none' : '';
      viewVocabEl.style.display = isVocab ? '' : 'none';
      syncStudySwitch(isVocab);
      if (isVocab) {
        syncVocabEmbed(vocabFocusVideoId, vocabFocusSentence);
      }
    }
    window.addEventListener('hashchange', () => setHashView(location.hash));
    tabVideoBtn.addEventListener('click', () => { location.hash = ''; setHashView(''); vocabStudyStop(); });
    tabVocabBtn.addEventListener('click', () => { location.hash = '#vocabulary'; setHashView('#vocabulary'); vocabStudyStart(); });
    gotoVocabLink.addEventListener('click', (e) => { e.preventDefault(); location.hash = '#vocabulary'; setHashView('#vocabulary', { videoId: null }); });

    // ===== User =====
    function renderMembershipBadge() {
      const badge = document.getElementById('vip-badge');
      if (!badge) return;
      const user = state.user;
      const email = String(user?.email || '');
      const guest = !user || user.is_guest || user.isGuest || /^guest_.*@temp\.linglish\.local$/i.test(email);
      if (guest) {
        badge.hidden = true;
        return;
      }
      const type = String(user.membership_type || 'free').toLowerCase();
      const names = { svip: 'SVIP', vip: 'VIP', family: '家庭版', free: '免费' };
      const level = names[type] || '会员';
      const text = badge.querySelector('.vip-text');
      if (text) text.textContent = user.is_admin ? `${level} · 管理员` : `${level} 会员`;
      badge.className = 'vip-badge ' + (type === 'vip' || type === 'svip' || type === 'family' || type === 'free' ? type : 'free');
      badge.hidden = false;
      badge.title = '进入会员中心，查看会员等级';
    }

    async function loadUser() {
      try {
        const res = await fetch(`${API_BASE}/users/me`, { headers: headers() });
        if (res.ok) {
          state.user = await res.json();
          renderMembershipBadge();
          debugLog('Loaded user:', state.user);
          // Sync user email to localStorage for TagSystem
          if (state.user && state.user.email) {
            try {
              const currentStored = localStorage.getItem('userEmail');
              if (currentStored !== state.user.email) {
                localStorage.setItem('userEmail', state.user.email);
                console.log('[VR-Desktop] Synced userEmail to localStorage:', state.user.email);
              }
            } catch (_) { }
          }
        }
      } catch (e) {
        console.warn('Failed to load user info:', e);
      }
    }

    // ===== Videos =====
    // 转录状态轮询
    let transcriptionPollInterval = null;

    function startTranscriptionPolling() {
      // 清除现有的轮询
      if (transcriptionPollInterval) {
        clearInterval(transcriptionPollInterval);
      }

      // 检查是否有processing状态的视频
      const hasProcessing = state.videos.some(v => normalizeVideoStatus(v.status) === 'processing');

      if (hasProcessing) {
        console.log('[Polling] Found processing videos, starting auto-refresh...');
        transcriptionPollInterval = setInterval(async () => {
          try {
            // 静默刷新视频列表
            const res = await fetch(`${API_BASE}/video-resources?lite=1`, { headers: headers() });
            if (res.ok) {
              const data = await res.json();
              const newVideos = Array.isArray(data && data.items) ? data.items : data;

              // 检查是否有状态变化
              const statusChanged = newVideos.some(newV => {
                const oldV = state.videos.find(v => v.id === newV.id);
                return oldV && normalizeVideoStatus(oldV.status) === 'processing' && normalizeVideoStatus(newV.status) !== 'processing';
              });

              if (statusChanged) {
                console.log('[Polling] Transcription completed, refreshing list...');
                state.videos = newVideos;
                state.filteredVideos = state.videos;
                renderVideoList();

                // 如果当前正在查看刚完成的视频，刷新详情
                if (state.currentVideo) {
                  const updatedCurrent = newVideos.find(v => v.id === state.currentVideo.id);
                  if (updatedCurrent && normalizeVideoStatus(updatedCurrent.status) === 'ready') {
                    await loadVideoDetails(updatedCurrent.id);
                    showToast('✅ 转录完成，字幕已加载', 'success');
                  }
                }
              }

              // 如果没有processing状态的视频了，停止轮询
              const stillHasProcessing = newVideos.some(v => normalizeVideoStatus(v.status) === 'processing');
              if (!stillHasProcessing) {
                console.log('[Polling] No more processing videos, stopping auto-refresh');
                clearInterval(transcriptionPollInterval);
                transcriptionPollInterval = null;
              }
            }
          } catch (err) {
            console.warn('[Polling] Auto-refresh failed:', err);
          }
        }, 5000); // 每5秒检查一次
      }
    }

    const VIDEO_CACHE_KEY = 'linglish_video_cache_v1';
    const VIDEO_CACHE_MAX = 120;
    const VIDEO_CACHE_TTL = 1000 * 60 * 60 * 24;

    function pruneVideoForCache(video) {
      return {
        id: video.id,
        title: video.title,
        original_filename: video.original_filename,
        duration_sec: video.duration_sec,
        status: video.status,
        transcript: video.transcript,
        transcript_summary: video.transcript_summary,
        preview_sentence: video.preview_sentence,
        key_sentence: video.key_sentence,
        sample_sentence: video.sample_sentence,
        thumbnail_url: video.thumbnail_url,
        youtube_thumbnail: video.youtube_thumbnail,
        video_path: video.video_path,
        youtube_video_id: video.youtube_video_id,
        difficulty_level: video.difficulty_level,
        wpm: video.wpm,
        words_per_minute: video.words_per_minute,
        speech_rate: video.speech_rate,
        speech_rate_wpm: video.speech_rate_wpm,
        language: video.language,
        local_video_path: video.local_video_path,
        local_video_status: video.local_video_status,
        collection_name: video.collection_name,
        collection: video.collection,
        series: video.series
      };
    }

    function loadVideoCache() {
      try {
        const raw = localStorage.getItem(VIDEO_CACHE_KEY);
        if (!raw || raw === 'undefined' || raw === 'null') return null;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.items)) return null;
        if (Date.now() - (data.savedAt || 0) > VIDEO_CACHE_TTL) return null;
        return data;
      } catch (_) {
        return null;
      }
    }

    function saveVideoCache(list) {
      try {
        const items = (list || []).slice(0, VIDEO_CACHE_MAX).map(pruneVideoForCache);
        localStorage.setItem(VIDEO_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), items }));
      } catch (_) { }
    }

    async function loadVideos() {
      state.isLoadingVideos = true;
      try {
        if (!state.hasLoadedVideos) {
          const cached = loadVideoCache();
          if (cached && Array.isArray(cached.items) && cached.items.length) {
            state.videos = cached.items;
            state.filteredVideos = cached.items;
            state.cacheHint = '已为你预加载上次推荐';
            renderVideoList();
          }
        }

        const res = await fetch(`${API_BASE}/video-resources?lite=1`, { headers: headers() });
        if (!res.ok) {
          const data = await res.json();
          throw new Error((data && data.message) || '加载视频失败');
        }
        const data = await res.json();
        state.videos = Array.isArray(data && data.items) ? data.items : data;
        state.cacheHint = '';
        saveVideoCache(state.videos);

        // 启动转录状态轮询
        startTranscriptionPolling();
        // 标签同步状态提示（非阻塞）：标签区标题旁的小状态文本
        function setTagSyncStatus(status) {
          const title = document.querySelector('#tag-filter-header .tag-filter-title');
          if (!title) return;
          let badge = document.getElementById('tag-sync-status');
          if (!badge) {
            badge = document.createElement('span');
            badge.id = 'tag-sync-status';
            badge.style.cssText = 'margin-left:6px;font-size:11px;font-weight:400;';
            title.appendChild(badge);
          }
          if (status === 'syncing') {
            badge.textContent = '同步中…';
            badge.style.color = '#94a3b8';
          } else if (status === 'error') {
            badge.textContent = '标签同步失败，已使用本地数据';
            badge.style.color = '#f59e0b';
          } else {
            badge.textContent = '';
          }
        }
        // 先渲染视频列表，避免等待标签同步导致首屏慢
        state.filteredVideos = state.videos;
        renderVideoList();
        try {
          document.dispatchEvent(new CustomEvent('linglish:videosLoaded', { detail: { count: (state.videos || []).length } }));
        } catch (_) { }
        // 重要：标签同步不要阻塞 loadVideos，否则“难度/标签 chips”会长时间显示为 0
        // 改为后台渐进加载：先用本地缓存渲染列表，随后同步并刷新 UI
        const debug = (() => { try { return localStorage.getItem('linglish_debug') === '1'; } catch (_) { return false; } })();
        const currentToken = getToken();
        const ids = (state.videos || []).map(v => v.id).filter(Boolean);

        if (window.VideoTagSystem && currentToken) {
          void (async () => {
            setTagSyncStatus('syncing');
            let loadOk = false;
            if (typeof window.VideoTagSystem.loadFromServer === 'function') {
              try {
                loadOk = await window.VideoTagSystem.loadFromServer(API_BASE, currentToken);
                if (debug) console.log('[Desktop Tag System] loadFromServer done', { ok: loadOk });
              } catch (e) {
                console.warn('[Desktop Tag System] loadFromServer failed', e);
              }
            }

            // 如果服务器标签拉取失败，使用预设标签作为全局标签，避免隐藏/筛选异常
            if (!loadOk && typeof window.VideoTagSystem.getPresetTags === 'function') {
              try {
                window.VideoTagSystem.serverCache = window.VideoTagSystem.serverCache || {};
                window.VideoTagSystem.serverCache.globalTags = window.VideoTagSystem.getPresetTags();
              } catch (_) { }
            }

            // 同步视频的标签映射（用于筛选/计数）；使用 force: true 确保与服务器同步
            let mapOk = false;
            try {
              if (typeof window.VideoTagSystem.syncVideoTagsFromServer === 'function') {
                mapOk = await window.VideoTagSystem.syncVideoTagsFromServer(API_BASE, currentToken, ids, { force: true });
                if (debug) console.log('[Desktop Tag System] syncVideoTagsFromServer done');
              }
            } catch (err) {
              console.warn('[Desktop Tag System] syncVideoTagsFromServer failed', err);
            }

            setTagSyncStatus(loadOk && mapOk ? 'done' : 'error');
            // 同步完成后刷新标签选项和结果数量（renderKey 含 dataVersion，必然重绘）
            if (window.applyVideoFilter) window.applyVideoFilter();
          })();
        }

        // 先应用一次筛选（搜索/难度），避免等待标签同步
        if (window.applyVideoFilter) window.applyVideoFilter();
        else applyVideoFilter();
        state.hasLoadedVideos = true;
      } catch (e) {
        throw e;
      } finally {
        state.isLoadingVideos = false;
        if (state.videos && state.videos.length) {
          renderVideoList();
        }
      }
    }
    function applyVideoFilter() {
      const q = (videoSearchEl.value || '').trim().toLowerCase();
      state.filteredVideos = !q ? state.videos : state.videos.filter(v => (v.title || v.original_filename || '').toLowerCase().includes(q));
      renderVideoList();
    }
    function normalizeVideoStatus(raw) {
      const status = String(raw || '').toLowerCase();
      if (['processing', 'transcribing', 'running', 'pending', 'queued', 'in_progress'].includes(status)) return 'processing';
      if (['ready', 'completed', 'complete', 'success', 'done', 'available'].includes(status)) return 'ready';
      if (!status || status === 'null' || status === 'undefined') return 'unknown';
      return status;
    }
    function hasTranscriptData(video) {
      if (!video) return false;
      const transcript = String(video.transcript || '').trim();
      if (transcript.length > 10) return true;
      const summary = String(video.transcript_summary || '').trim();
      if (summary.length > 10) return true;
      const segs = video.transcript_segments;
      if (Array.isArray(segs) && segs.length > 0) return true;
      if (typeof segs === 'string' && segs.trim().length > 10) return true;
      return false;
    }
    function getTranscriptStatusText(video, t) {
      const status = normalizeVideoStatus(video?.status);
      const transcribedText = (t && t('video.transcribed')) || '已转录';
      const processingText = (t && t('video.processing')) || '处理中…';
      const notTranscribedText = (t && t('video.not_transcribed')) || '未转录';
      if (hasTranscriptData(video) || status === 'ready') return `✅ ${transcribedText}`;
      if (status === 'processing') return `⏳ ${processingText}`;
      return `🕒 ${notTranscribedText}`;
    }
    function renderVideoList() {
      videoListEl.innerHTML = '';
      if (state.isLoadingVideos && (!state.filteredVideos || state.filteredVideos.length === 0)) {
        const loading = document.createElement('div');
        loading.className = 'video-list-loading';
        loading.innerHTML = `<span>⏳</span><span>正在为你加载推荐视频…</span>`;
        videoListEl.appendChild(loading);
        const skeleton = document.createElement('div');
        skeleton.className = 'video-list-skeleton';
        skeleton.innerHTML = `
          <div class="video-skeleton-item"></div>
          <div class="video-skeleton-item"></div>
          <div class="video-skeleton-item"></div>
        `;
        videoListEl.appendChild(skeleton);
        updateNextVideoCard();
        updateTodayRecoCard();
        return;
      }
      if (!state.filteredVideos.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = typeof i18n !== 'undefined' ? i18n.t('video.no_videos') : '没有找到相关视频';
        videoListEl.appendChild(empty);
        updateNextVideoCard();
        updateTodayRecoCard();
        return;
      }
      const frag = document.createDocumentFragment();
      const t = (key) => typeof i18n !== 'undefined' ? i18n.t(key) : key;
      const currentUserId = state.user?.id;
      if (state.isLoadingVideos || state.cacheHint) {
        const banner = document.createElement('div');
        banner.className = 'video-list-loading';
        banner.innerHTML = `<span>✨</span><span>${state.cacheHint || '正在更新视频列表…'}</span>`;
        videoListEl.appendChild(banner);
      }

      state.filteredVideos.forEach(v => {
        const title = v.title || v.original_filename || `视频 ${v.id}`;
        const duration = fmtSec(v.duration_sec);
        const status = normalizeVideoStatus(v.status);
        const hasTranscript = hasTranscriptData(v);
        const placeholderThumb = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='160' height='90'><defs><linearGradient id='g' x1='0%' y1='0%' x2='100%' y2='100%'><stop offset='0%' style='stop-color:#667eea'/><stop offset='100%' style='stop-color:#764ba2'/></linearGradient></defs><rect width='160' height='90' fill='url(#g)'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='13' fill='white'>No Thumb</text></svg>`)}`;
        const thumbUrl = resolveThumbnail(v) || placeholderThumb;
        const item = document.createElement('div');
        item.className = 'video-item' + (state.currentVideo && String(state.currentVideo.id) === String(v.id) ? ' active' : '');
        item.dataset.videoId = v.id; // 添加视频ID用于标签系统
        const transcriptStatus = getTranscriptStatusText(v, t);

        // Only show edit/delete buttons if user is the owner
        // Use loose equality to handle number/string type differences
        const isOwner = currentUserId && v.uploader_id && String(v.uploader_id) === String(currentUserId);

        // Render difficulty badge
        const difficultyConfig = {
          a1: { icon: 'A1', name: 'A1', color: '#15803d', bg: '#f0fdf4' },
          a2: { icon: 'A2', name: 'A2', color: '#0f766e', bg: '#f0fdfa' },
          b1: { icon: 'B1', name: 'B1', color: '#1d4ed8', bg: '#eff6ff' },
          b2: { icon: 'B2', name: 'B2', color: '#6d28d9', bg: '#f5f3ff' },
          c1: { icon: 'C1', name: 'C1', color: '#7e22ce', bg: '#faf5ff' },
          c2: { icon: 'C2', name: 'C2', color: '#9f1239', bg: '#fff1f2' },
          beginner: { icon: 'A1', name: 'A1', color: '#15803d', bg: '#f0fdf4' },
          intermediate: { icon: 'B1', name: 'B1', color: '#1d4ed8', bg: '#eff6ff' },
          advanced: { icon: 'C1', name: 'C1', color: '#7e22ce', bg: '#faf5ff' }
        };
        const diffLevel = String(v.difficulty_level || '').toLowerCase();
        const diffConfig = difficultyConfig[diffLevel];
        const diffBadgeHtml = diffConfig ? `
          <span class="video-badge" style="background:${diffConfig.bg}; color:${diffConfig.color}; border-color:${diffConfig.color}40;">
            ${diffConfig.name}
          </span>
        ` : '';

        const previewText = getPreviewText(v);
        const previewHtml = previewText ? `<div class="video-preview">${esc(previewText)}</div>` : '';
        const progressPercent = getVideoProgressPercent(v.id);
        const isComplete = progressPercent >= 90;
        const progressBadge = progressPercent > 0 ? `
          <span class="video-badge ${isComplete ? 'complete' : 'progress'}">
            ${isComplete ? '已完成' : `已学 ${progressPercent}%`}
          </span>
        ` : '';
        const visibilityBadge = v.is_featured ? `
          <span class="video-badge complete">精选</span>
        ` : v.is_public === false ? `
          <span class="video-badge">私有</span>
        ` : `
          <span class="video-badge progress">公开</span>
        `;
        const wpm = getVideoWpm(v);
        const wpmBadge = wpm ? `<span class="video-badge">⚡ ${wpm} WPM</span>` : '';
        const analysis = analyzeTextSample(getTextSample(v));
        const speedLabel = getSpeedLabel(wpm);
        const densityLabel = analysis && analysis.total >= 40 ? getDensityLabel(analysis.uniqueRatio) : null;
        const complexityLabel = analysis && analysis.total >= 40 ? getComplexityLabel(analysis.avgSentenceLen) : null;
        const insightBadges = [speedLabel, densityLabel, complexityLabel]
          .filter(Boolean)
          .map(label => `<span class="video-badge">${label}</span>`)
          .join('');

        // Render tags
        let tagsHtml = '';
        if (window.VideoTagSystem) {
          const tagIds = window.VideoTagSystem.getVideoTags(v.id);
          const visibleTags = window.VideoTagSystem.getVisibleTags ? window.VideoTagSystem.getVisibleTags() : [];
          // Map IDs to full tag objects
          const tags = tagIds.map(tid => {
            // Try to find in visible tags first (which handles aliases/hiding preference)
            const found = visibleTags.find(t => String(t.id) === String(tid));
            if (found) return found;
            // Fallback to getAllTags if available, or just placeholder
            return { id: tid, name: tid.startsWith('u:') ? 'Tag' : tid, color: '#94a3b8' };
          }).filter(t => t); // Filter out nulls

          // Deduplicate tags by name (keep first occurrence)
          const seenNames = new Set();
          const uniqueTags = tags.filter(t => {
            const name = (t.name || t.displayName || t.id).toLowerCase();
            if (seenNames.has(name)) return false;
            seenNames.add(name);
            return true;
          });

          if (uniqueTags.length > 0) {
            tagsHtml = `<div class="video-tags" style="display:flex; flex-wrap:wrap; gap:4px; margin-top:4px;">
              ${uniqueTags.map(t => `
                <span class="video-tag-badge" style="
                  font-size: 0.65rem;
                  padding: 1px 5px;
                  border-radius: 4px;
                  background: ${t.color || '#e2e8f0'}20;
                  color: ${t.color || '#64748b'};
                  border: 1px solid ${t.color || '#cbd5e1'}40;
                ">
                  ${t.icon ? t.icon + ' ' : ''}${esc(t.name || t.displayName || t.id)}
                </span>
              `).join('')}
            </div>`;
          }
        }

        const isAdmin = state.user && state.user.is_admin;
        const actionButtons = `
            <div class="video-actions" style="display:flex; gap:0.3rem; margin-top:0.4rem;">
              <button type="button" class="icon-btn tag-video-btn" data-action="tag" data-video-id="${v.id}" title="管理标签" style="padding:0.25rem 0.45rem; font-size:0.8rem;">🏷️</button>
              ${isOwner ? `
                ${v.is_public === false ? `<button type="button" class="icon-btn" data-action="share" data-video-id="${v.id}" title="申请公开" style="padding:0.25rem 0.45rem; font-size:0.8rem;">↗</button>` : ''}
                ${!v.is_featured ? `<button type="button" class="icon-btn" data-action="feature" data-video-id="${v.id}" title="${isAdmin ? '设为精选' : '申请精选'}" style="padding:0.25rem 0.45rem; font-size:0.8rem;">★</button>` : ''}
                <button type="button" class="icon-btn" data-action="rename" data-video-id="${v.id}" title="${t('video.rename')}" style="padding:0.25rem 0.45rem; font-size:0.8rem;">✏️</button>
                <button type="button" class="icon-btn danger" data-action="delete" data-video-id="${v.id}" title="${t('video.delete')}" style="padding:0.25rem 0.45rem; font-size:0.8rem;">🗑️</button>
              ` : ''}
              ${!isOwner && isAdmin && !v.is_featured ? `<button type="button" class="icon-btn" data-action="feature" data-video-id="${v.id}" title="设为精选" style="padding:0.25rem 0.45rem; font-size:0.8rem;">★</button>` : ''}
            </div>
          `;

        item.innerHTML = `
            <div class="video-thumb-wrap">
              <img src="${esc(thumbUrl)}" class="video-thumb" alt="thumb" loading="lazy">
              ${previewHtml}
            </div>
            <div style="flex:1; display:flex; flex-direction:column; gap:0.2rem;">
              <p class="video-title" title="${esc(title)}">${esc(title)}</p>
              <div class="video-meta">
                <span>${duration}</span>
                <span>${transcriptStatus}</span>
              </div>
              <div class="video-badges">
                ${diffBadgeHtml}
                ${visibilityBadge}
                ${wpmBadge}
                ${insightBadges}
                ${progressBadge}
              </div>
              ${progressPercent > 0 ? `<div class="video-progress-bar"><span style="width:${progressPercent}%;"></span></div>` : ''}
              ${tagsHtml}
              ${actionButtons}
            </div>
          `;

        const thumbnailImage = item.querySelector('.video-thumb');
        if (thumbnailImage) {
          thumbnailImage.dataset.vbFallback = placeholderThumb;
          thumbnailImage.onerror = () => vbOnThumbError(thumbnailImage);
        }

        // Handle video selection
        item.addEventListener('click', (e) => {
          // Don't select video if clicking on action buttons
          if (e.target.closest('[data-action]')) return;
          selectVideo(v);
        });

        frag.appendChild(item);
      });
      videoListEl.appendChild(frag);
      updateNextVideoCard();
      updateTodayRecoCard();
      // Keep the YouTube-style browser grid in sync when it's open
      try { if (window.__vbOpen && typeof renderVideoBrowser === 'function') renderVideoBrowser(); } catch (_) { }

      // Wire up action buttons
      videoListEl.querySelectorAll('[data-action="tag"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const videoId = Number(btn.dataset.videoId);
          // 触发标签选择器（通过自定义事件通知标签系统）
          if (window.showDesktopVideoTagSelector) {
            window.showDesktopVideoTagSelector(videoId);
          }
        });
      });

      videoListEl.querySelectorAll('[data-action="rename"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const videoId = Number(btn.dataset.videoId);
          handleVideoRename(videoId);
        });
      });

      videoListEl.querySelectorAll('[data-action="share"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const videoId = Number(btn.dataset.videoId);
          handleVideoShare(videoId);
        });
      });

      videoListEl.querySelectorAll('[data-action="feature"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const videoId = Number(btn.dataset.videoId);
          handleVideoFeature(videoId);
        });
      });

      videoListEl.querySelectorAll('[data-action="delete"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const videoId = Number(btn.dataset.videoId);
          handleVideoDelete(videoId);
        });
      });
    }

    // ============================================================
    // YouTube-style Video Library Browser
    // ============================================================
    const vbState = { status: '', scope: 'all', channelKey: '', filtersOpen: false, libraryView: 'videos' };
    const CHANNEL_STORE_KEY = 'linglish_channels_v1';
    const PODCAST_STORE_KEY = 'linglish_podcasts_v1';
    const MEDIA_DEFAULTS_VERSION_KEY = 'linglish_media_defaults_version';
    const MEDIA_STORE_LIMIT = 120;
    const mediaDefaults = window.LinglishMediaLibraryDefaults || null;
    const podState = { feedUrl: '' };
    let podcastDialogMode = 'search';
    const channelHydratePromises = new Map();
    const podcastHydratePromises = new Map();

    function ensureDefaultMediaLibraries() {
      if (!mediaDefaults) return;
      try {
        const version = localStorage.getItem(MEDIA_DEFAULTS_VERSION_KEY);
        let podcasts = mediaDefaults.mergeDefaults(
          readStore(PODCAST_STORE_KEY),
          mediaDefaults.buildPodcastDefaults(),
          'feedUrl'
        );
        let channels = mediaDefaults.mergeDefaults(
          readStore(CHANNEL_STORE_KEY),
          mediaDefaults.buildChannelDefaults(),
          'channelId'
        );
        if (mediaDefaults.patchMissingImages) {
          podcasts = mediaDefaults.patchMissingImages(podcasts, mediaDefaults.buildPodcastDefaults(), 'feedUrl');
          channels = mediaDefaults.patchMissingImages(channels, mediaDefaults.buildChannelDefaults(), 'channelId');
        }
        writeStore(PODCAST_STORE_KEY, podcasts.slice(0, MEDIA_STORE_LIMIT));
        writeStore(CHANNEL_STORE_KEY, channels.slice(0, MEDIA_STORE_LIMIT));
        if (version !== mediaDefaults.VERSION) {
          localStorage.setItem(MEDIA_DEFAULTS_VERSION_KEY, mediaDefaults.VERSION);
        }
      } catch (_) { }
      hydrateMediaCovers();
    }

    let coverHydratePromise = null;
    async function hydrateMediaCovers() {
      if (coverHydratePromise) return coverHydratePromise;
      coverHydratePromise = (async () => {
        try {
          const channels = readStore(CHANNEL_STORE_KEY);
          const podcasts = readStore(PODCAST_STORE_KEY);
          const items = [];
          channels.forEach((ch) => {
            if (!ch || ch.image) return;
            items.push({
              key: `ch:${ch.channelId}`,
              title: ch.title || '',
              query: ch.title || ch.handle || '',
            });
          });
          podcasts.forEach((pod) => {
            if (!pod || pod.image) return;
            items.push({
              key: `pod:${pod.feedUrl}`,
              title: pod.title || '',
              query: pod.query || pod.title || '',
            });
          });
          if (!items.length) return;
          const data = await postMedia('covers/resolve', { items });
          const images = data.images || {};
          let channelChanged = false;
          let podcastChanged = false;
          const nextChannels = channels.map((ch) => {
            const image = images[`ch:${ch.channelId}`];
            if (!image || ch.image) return ch;
            channelChanged = true;
            return { ...ch, image };
          });
          const nextPodcasts = podcasts.map((pod) => {
            const image = images[`pod:${pod.feedUrl}`];
            if (!image || pod.image) return pod;
            podcastChanged = true;
            return { ...pod, image };
          });
          if (channelChanged) writeStore(CHANNEL_STORE_KEY, nextChannels.slice(0, MEDIA_STORE_LIMIT));
          if (podcastChanged) writeStore(PODCAST_STORE_KEY, nextPodcasts.slice(0, MEDIA_STORE_LIMIT));
          if ((channelChanged || podcastChanged) && window.__vbOpen) {
            renderVideoBrowser();
          }
        } catch (_) { }
        finally {
          coverHydratePromise = null;
        }
      })();
      return coverHydratePromise;
    }

    // Build an SVG data URI with a per-card gradient + big initial + play icon.
    // IMPORTANT: encodeURIComponent does NOT encode apostrophes, so always use
    // double quotes inside SVG attributes and then encode. Previously single
    // quotes leaked into inline onerror attributes and silently broke fallback.
    function vbBuildPlaceholder(seedStr, initialChar) {
      const palettes = [
        ['#0ea5e9', '#6366f1'], ['#2dd4bf', '#ef4444'], ['#10b981', '#38bdf8'],
        ['#a855f7', '#ec4899'], ['#f59e0b', '#2dd4bf'], ['#3b82f6', '#8b5cf6'],
        ['#06b6d4', '#3b82f6'], ['#fb7185', '#f43f5e'], ['#84cc16', '#22c55e']
      ];
      let hash = 0;
      const s = String(seedStr || '?');
      for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) & 0xffff;
      const [a, b] = palettes[hash % palettes.length];
      const letter = String(initialChar || s.charAt(0) || '•').toUpperCase().slice(0, 1);
      const safeLetter = letter.replace(/[<>&"]/g, '');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${a}"/><stop offset="100%" stop-color="${b}"/></linearGradient></defs><rect width="480" height="270" fill="url(#g)"/><circle cx="240" cy="115" r="46" fill="rgba(255,255,255,0.18)"/><polygon points="228,95 228,135 262,115" fill="rgba(255,255,255,0.85)"/><text x="50%" y="205" dominant-baseline="middle" text-anchor="middle" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="54" font-weight="700" fill="rgba(255,255,255,0.92)">${safeLetter}</text></svg>`;
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg).replace(/'/g, '%27')}`;
    }

    // Generic fallback (used before a card-specific one is available).
    const VB_PLACEHOLDER_THUMB = vbBuildPlaceholder('linglish', 'L');

    // Safer than inline onerror="this.src='...'": avoids quoting pitfalls with
    // data URIs. Attached as an element property at render time.
    function vbOnThumbError(imgEl) {
      try {
        imgEl.onerror = null;
        const fallback = imgEl.dataset.vbFallback;
        imgEl.src = fallback || VB_PLACEHOLDER_THUMB;
      } catch (_) { }
    }
    window.vbOnThumbError = vbOnThumbError;

    function vbGetAvatarGradient(seedStr) {
      const palettes = [
        ['#0ea5e9', '#6366f1'], ['#2dd4bf', '#ef4444'], ['#10b981', '#38bdf8'],
        ['#a855f7', '#ec4899'], ['#f59e0b', '#2dd4bf'], ['#3b82f6', '#8b5cf6']
      ];
      let hash = 0;
      const s = String(seedStr || '?');
      for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) & 0xffff;
      const [a, b] = palettes[hash % palettes.length];
      return `linear-gradient(135deg, ${a}, ${b})`;
    }

    // LibraryFilter context: injects tag/progress lookups so filtering stays pure & local.
    function vbGetFilterContext() {
      const ts = window.VideoTagSystem;
      return {
        currentUserId: state.user?.id,
        getVideoTags: ts ? (id) => { try { return ts.getVideoTags(id) || []; } catch (_) { return []; } } : undefined,
        getTagName: ts ? (tid) => {
          try {
            const visible = ts.getVisibleTags ? ts.getVisibleTags() : ts.getAllTags();
            const t = visible.find(x => String(x.id) === String(tid));
            return t ? (t.name || t.displayName || '') : '';
          } catch (_) { return ''; }
        } : undefined,
        getProgressPercent: (id) => getVideoProgressPercent(id) || 0
      };
    }

    // 弹窗内的标签筛选行：与侧栏共享同一 tag 筛选状态（通过 setLibraryFilter 双向同步）。
    function renderVbTagChips() {
      const wrap = document.getElementById('vb-tag-chips');
      if (!wrap) return;
      const ts = window.VideoTagSystem;
      const shared = window.getLibraryFilterState ? window.getLibraryFilterState() : { tagId: null };
      const activeTag = shared.tagId == null ? '' : String(shared.tagId);
      const frag = document.createDocumentFragment();
      const mkChip = (id, label, count) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'vb-chip' + (String(id || '') === activeTag ? ' active' : '');
        b.setAttribute('aria-pressed', String(String(id || '') === activeTag));
        b.textContent = count == null ? label : `${label} (${count})`;
        b.addEventListener('click', () => {
          if (window.setLibraryFilter) window.setLibraryFilter({ tagId: id || null });
          else renderVideoBrowser();
        });
        return b;
      };
      frag.appendChild(mkChip('', '全部'));
      if (ts) {
        try {
          const tagStats = ts.getTagStatistics(state.videos || []);
          const visible = ts.getVisibleTags ? ts.getVisibleTags() : ts.getAllTags();
          visible
            .map(t => ({ t, count: (tagStats[String(t.id)] || { count: 0 }).count }))
            .filter(x => x.count > 0)
            .sort((a, b) => b.count - a.count)
            .forEach(x => frag.appendChild(mkChip(
              String(x.t.id),
              `${x.t.icon ? x.t.icon + ' ' : ''}${x.t.name || x.t.displayName || x.t.id}`,
              x.count
            )));
          const un = tagStats['_untagged'];
          if (un && un.count > 0) frag.appendChild(mkChip('_untagged', '📋 未标记', un.count));
        } catch (_) { }
      }
      wrap.innerHTML = '';
      wrap.appendChild(frag);
    }

    function readStore(key) {
      try {
        const data = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(data) ? data : [];
      } catch (_) { return []; }
    }
    function writeStore(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { }
    }
    async function postMedia(path, body) {
      const res = await fetch(`${API_BASE}/media/${path}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.error || '请求失败');
      return data;
    }
    function parseDurationSec(value) {
      const raw = String(value || '').trim();
      if (!raw) return 0;
      if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
      const parts = raw.split(':').map(Number);
      if (parts.some((n) => !Number.isFinite(n))) return 0;
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      return 0;
    }
    function feedMeta(v) {
      const raw = v.published || v.created_at || v.uploaded_at || '';
      const date = raw ? new Date(raw) : null;
      const dateText = date && !Number.isNaN(date.getTime())
        ? `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
        : '';
      const duration = Number(v.duration_sec) > 0 ? fmtSec(v.duration_sec) : '';
      return [dateText, duration].filter(Boolean).join(' · ');
    }
    function materializeChannelVideo(channelTitle, item) {
      const existing = (state.videos || []).find((v) => v.youtube_video_id && v.youtube_video_id === item.videoId);
      if (existing) return existing;
      return {
        id: `yt:${item.videoId}`,
        title: item.title,
        original_filename: item.title,
        youtube_video_id: item.videoId,
        thumbnail_path: item.thumbnail,
        collection_name: channelTitle,
        published: item.published,
        duration_sec: 0,
        external_youtube: true,
        language: 'en',
      };
    }
    function isMemberVideo(video) {
      const uid = state.user && state.user.id;
      if (uid === null || uid === undefined || uid === '') return false;
      return Boolean(video && video.uploader_id !== null && video.uploader_id !== undefined
        && String(video.uploader_id) === String(uid));
    }
    function activeLibraryView() {
      const key = String(vbState.channelKey || '');
      if (key.startsWith('import:') || key.startsWith('local:')) return 'channels';
      if (vbState.libraryView === 'channels' || vbState.libraryView === 'podcasts') return vbState.libraryView;
      return 'videos';
    }
    function syncLibraryChrome(filtering) {
      const chips = document.getElementById('vb-chip-rows');
      const hero = document.getElementById('vb-channel-hero');
      const title = document.getElementById('vb-title');
      const hint = document.getElementById('vb-hint');
      const inChannel = Boolean(vbState.channelKey);
      const view = activeLibraryView();
      const inChannels = view === 'channels';
      const inPodcasts = view === 'podcasts';
      const inShow = inPodcasts && Boolean(podState.feedUrl);
      const userLibrary = view === 'videos';
      const pop = document.getElementById('vb-filter-pop');
      const categoryBtn = document.getElementById('vb-view-mine');
      const podPanel = document.getElementById('pod-panel');
      const videoGrid = document.getElementById('vb-grid');
      if (categoryBtn) categoryBtn.hidden = !userLibrary || inChannel;
      if (pop) pop.hidden = !userLibrary || inChannel || !vbState.filtersOpen;
      if (chips) chips.hidden = false;
      if (hero) hero.hidden = !inChannel;
      if (podPanel) podPanel.hidden = !inPodcasts;
      if (videoGrid) videoGrid.hidden = inPodcasts;
      if (title && !inChannel) title.textContent = inPodcasts ? '播客' : (inChannels ? '频道库' : '视频库');
      if (hint) {
        const picking = userLibrary && new URLSearchParams(location.search).get('returnTo') === 'coach';
        hint.hidden = !picking;
        if (picking) {
          const label = new URLSearchParams(location.search).get('mode') === 'dialogue' ? '实战场' : 'AI陪练';
          hint.textContent = `选中一条后，会进入${label}。`;
        }
      }
      const filterBtn = document.getElementById('vb-filter-toggle');
      if (filterBtn) filterBtn.hidden = true;
      const addBtn = document.getElementById('vb-add-channel');
      if (addBtn) addBtn.hidden = !inChannels || inChannel;
      const podAdd = document.getElementById('pod-add-wrap');
      if (podAdd) podAdd.hidden = !inPodcasts || inShow;
      const search = document.getElementById('vb-search');
      if (search) {
        search.placeholder = inPodcasts
          ? (inShow ? '搜索这一档的单集' : '搜索已添加的播客')
          : (inChannels && !inChannel ? '搜索频道名称…' : '搜索视频标题 / 合集 / 标签…');
      }
      document.querySelectorAll('[data-vb-view]').forEach((btn) => {
        const isCategory = btn.dataset.vbView === 'mine';
        const on = isCategory
          ? (userLibrary && vbState.filtersOpen && !inChannel)
          : btn.dataset.vbView === view;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', String(on));
      });
    }
    function renderShelfCard(item, onOpen) {
      const card = document.createElement('article');
      card.className = 'vb-card';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', item.title);
      const initial = String(item.title || 'V').trim().charAt(0).toUpperCase() || 'V';
      const fallback = item.square
        ? vbBuildPlaceholder(item.title, initial).replace('width="480" height="270" viewBox="0 0 480 270"', 'width="480" height="480" viewBox="0 0 480 480"')
        : vbBuildPlaceholder(item.title, initial);
      card.innerHTML = `<div class="vb-thumb-wrap"><img class="vb-thumb" alt=""></div><h3 class="vb-shelf-name">${esc(item.title)}</h3>`;
      const img = card.querySelector('img');
      img.dataset.vbFallback = fallback;
      img.onerror = function () { vbOnThumbError(this); };
      img.src = item.thumb || fallback;
      const open = () => onOpen(item);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      return card;
    }
    function renderFeedVideoCard(v, onPlay) {
      const title = v.title || v.original_filename || '视频';
      const channel = v.collection_name || v.showTitle || '视频';
      const initial = String(channel).trim().charAt(0).toUpperCase() || 'V';
      const fallback = vbBuildPlaceholder(`${channel}|${title}`, initial);
      const card = document.createElement('article');
      card.className = 'vb-card vb-feed-card';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `播放：${title}`);
      const duration = Number(v.duration_sec) > 0 ? `<span class="vb-duration">${fmtSec(v.duration_sec)}</span>` : '';
      card.innerHTML = `<div class="vb-thumb-wrap"><img class="vb-thumb" alt="">${duration}</div><div class="vb-card-body"><div class="vb-card-info"><h3 class="vb-card-title">${esc(title)}</h3><div class="vb-card-channel">${esc(feedMeta(v) || channel)}</div></div></div>`;
      const img = card.querySelector('img');
      img.dataset.vbFallback = fallback;
      img.onerror = function () { vbOnThumbError(this); };
      img.src = resolveThumbnail(v) || v.thumbnail_path || fallback;
      const play = () => onPlay(v);
      card.addEventListener('click', play);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); }
      });
      return card;
    }
    function findOpenChannel() {
      const key = vbState.channelKey || '';
      if (key.startsWith('import:')) {
        return readStore(CHANNEL_STORE_KEY).find((ch) => ch.channelId === key.slice(7)) || null;
      }
      if (key.startsWith('local:')) {
        const name = key.slice(6);
        const list = (state.videos || []).filter((v) => !isMemberVideo(v) && (v.collection_name || v.collection || v.series || '精选') === name);
        return { local: true, title: name, description: `本库收录 ${list.length} 个视频，点开就能学习。`, videos: list };
      }
      return null;
    }
    function importedChannelItems() {
      return readStore(CHANNEL_STORE_KEY).map((ch) => ({
        key: `import:${ch.channelId}`,
        title: ch.title || 'YouTube 频道',
        thumb: ch.image
          || (ch.videos && ch.videos[0] && ch.videos[0].thumbnail)
          || '',
      }));
    }
    function renderChannelShelf(grid, empty, stats, videos) {
      const items = importedChannelItems();
      const seen = new Set();
      const groups = new Map();
      (videos || []).forEach((video) => {
        const name = video.collection_name || video.collection || video.series || '精选';
        if (!groups.has(name)) groups.set(name, video);
      });
      groups.forEach((video, name) => {
        if (seen.has(String(name).toLowerCase())) return;
        items.push({ key: `local:${name}`, title: name, thumb: resolveThumbnail(video) || '' });
      });
      const query = ((document.getElementById('vb-search') || {}).value || '').trim().toLowerCase();
      const visible = query
        ? items.filter((item) => String(item.title || '').toLowerCase().includes(query))
        : items;
      if (stats) stats.textContent = `${visible.length} 个频道`;
      if (!visible.length) {
        grid.innerHTML = '';
        if (empty) {
          empty.hidden = false;
          const title = empty.querySelector('.vb-empty-title');
          const hint = empty.querySelector('.vb-empty-hint');
          if (title) title.textContent = items.length ? '没有找到这个频道' : '还没有频道';
          if (hint) hint.textContent = items.length ? '换个频道名称试试' : '点「添加频道」，粘贴 YouTube 频道链接';
          const reset = empty.querySelector('#vb-reset-btn');
          if (reset) reset.hidden = true;
          const addEmpty = empty.querySelector('#vb-channel-empty-add');
          if (addEmpty) addEmpty.hidden = items.length > 0;
        }
        return;
      }
      const addWhenFilled = document.getElementById('vb-channel-empty-add');
      if (addWhenFilled) addWhenFilled.hidden = true;
      if (empty) empty.hidden = true;
      const addEmpty = document.getElementById('vb-channel-empty-add');
      if (addEmpty) addEmpty.hidden = true;
      const frag = document.createDocumentFragment();
      visible.forEach((item) => frag.appendChild(renderShelfCard(item, () => {
        if (item.key.startsWith('import:')) {
          const channelId = item.key.slice(7);
          const stored = readStore(CHANNEL_STORE_KEY).find((ch) => ch.channelId === channelId);
          if (stored && stored.hydrateFailed) {
            updateChannelInStore(channelId, { hydrateFailed: false, hydrateError: '' });
          }
        }
        vbState.channelKey = item.key;
        renderVideoBrowser();
      })));
      grid.innerHTML = '';
      grid.appendChild(frag);
    }
    function updateChannelInStore(channelId, patch) {
      const list = readStore(CHANNEL_STORE_KEY);
      const next = list.map((item) => (item.channelId === channelId ? { ...item, ...patch } : item));
      writeStore(CHANNEL_STORE_KEY, next.slice(0, MEDIA_STORE_LIMIT));
      return next.find((item) => item.channelId === channelId) || null;
    }
    async function hydrateChannelIfNeeded(channel) {
      if (!channel || channel.local || (Array.isArray(channel.videos) && channel.videos.length)) return channel;
      const url = channel.pageUrl || (channel.handle ? `https://www.youtube.com/@${channel.handle}` : '');
      if (!url) return channel;
      const key = String(channel.channelId || url);
      if (channelHydratePromises.has(key)) return channelHydratePromises.get(key);
      const pending = (async () => {
        try {
          const data = await postMedia('channels/preview', { url });
          const live = data.channel || {};
          return updateChannelInStore(channel.channelId, {
            title: live.title || channel.title,
            handle: live.handle || channel.handle,
            pageUrl: live.pageUrl || channel.pageUrl,
            youtubeChannelId: live.channelId || channel.youtubeChannelId || '',
            description: `来自 YouTube · ${(live.videos || []).length} 个视频`,
            videos: live.videos || [],
            seeded: channel.seeded === true,
            defaultId: channel.defaultId || '',
            hydrateFailed: false,
            hydrateError: '',
          }) || channel;
        } catch (err) {
          const message = err.message || '频道读取失败';
          showToast(message, 'warn');
          return updateChannelInStore(channel.channelId, {
            hydrateFailed: true,
            hydrateError: message,
          }) || channel;
        } finally {
          channelHydratePromises.delete(key);
        }
      })();
      channelHydratePromises.set(key, pending);
      return pending;
    }
    function renderChannelFeed(grid, empty, stats, q) {
      const channel = findOpenChannel();
      if (!channel) {
        vbState.channelKey = '';
        renderVideoBrowser();
        return;
      }
      if (!channel.local && !(channel.videos || []).length) {
        grid.innerHTML = '';
        if (channel.hydrateFailed) {
          if (stats) stats.textContent = '0 个视频';
          if (empty) {
            empty.hidden = false;
            const title = empty.querySelector('.vb-empty-title');
            const hint = empty.querySelector('.vb-empty-hint');
            if (title) title.textContent = '暂时读不到这个频道';
            if (hint) hint.textContent = channel.hydrateError || '当前网络读不到 YouTube，稍后重试或配置代理';
            const reset = empty.querySelector('#vb-reset-btn');
            if (reset) {
              reset.hidden = false;
              reset.textContent = '重新读取';
              reset.onclick = () => {
                updateChannelInStore(channel.channelId, { hydrateFailed: false, hydrateError: '' });
                renderVideoBrowser();
              };
            }
            const addEmpty = empty.querySelector('#vb-channel-empty-add');
            if (addEmpty) addEmpty.hidden = true;
          }
          return;
        }
        if (stats) stats.textContent = '读取中…';
        if (empty) {
          empty.hidden = false;
          const title = empty.querySelector('.vb-empty-title');
          const hint = empty.querySelector('.vb-empty-hint');
          if (title) title.textContent = '正在读取频道…';
          if (hint) hint.textContent = '第一次打开会多花十几秒';
          const reset = empty.querySelector('#vb-reset-btn');
          if (reset) reset.hidden = true;
          const addEmpty = empty.querySelector('#vb-channel-empty-add');
          if (addEmpty) addEmpty.hidden = true;
        }
        hydrateChannelIfNeeded(channel).then((next) => {
          if (vbState.channelKey === `import:${channel.channelId}`) renderVideoBrowser();
          return next;
        });
        return;
      }
      const nameEl = document.getElementById('vb-channel-name');
      const descEl = document.getElementById('vb-channel-desc');
      const avatar = document.getElementById('vb-channel-avatar');
      const title = document.getElementById('vb-title');
      if (nameEl) nameEl.textContent = channel.title || '频道';
      if (descEl) descEl.textContent = channel.description || `来自 YouTube · ${(channel.videos || []).length} 个视频`;
      if (title) title.textContent = channel.title || '频道';
      if (avatar) {
        const initial = String(channel.title || 'V').trim().charAt(0).toUpperCase() || 'V';
        avatar.style.background = vbGetAvatarGradient(channel.title || 'V');
        avatar.textContent = initial;
      }
      const subBtn = document.getElementById('vb-channel-sub');
      if (subBtn) subBtn.hidden = !!channel.local;
      let list = channel.local ? channel.videos : (channel.videos || []).map((item) => materializeChannelVideo(channel.title, item));
      if (q) {
        const query = q.toLowerCase();
        list = list.filter((v) => String(v.title || v.original_filename || '').toLowerCase().includes(query));
      }
      if (stats) stats.textContent = `${list.length} 个视频`;
      if (!list.length) {
        grid.innerHTML = '';
        if (empty) empty.hidden = false;
        return;
      }
      if (empty) empty.hidden = true;
      const frag = document.createDocumentFragment();
      list.forEach((v) => frag.appendChild(renderFeedVideoCard(v, (video) => {
        closeVideoBrowser();
        selectVideo(video);
      })));
      grid.innerHTML = '';
      grid.appendChild(frag);
    }
    function closeChannelDialog() {
      const dialog = document.getElementById('channel-dialog');
      if (dialog) dialog.hidden = true;
    }
    function openChannelDialog() {
      const error = document.getElementById('channel-dialog-error');
      if (error) error.textContent = '';
      const dialog = document.getElementById('channel-dialog');
      if (dialog) dialog.hidden = false;
      setTimeout(() => document.getElementById('channel-url')?.focus(), 30);
    }
    async function submitChannelUrl() {
      const input = document.getElementById('channel-url');
      const error = document.getElementById('channel-dialog-error');
      const button = document.getElementById('channel-submit');
      const url = input ? input.value.trim() : '';
      if (error) error.textContent = '';
      if (!url) {
        if (error) error.textContent = '请填写频道链接';
        return;
      }
      if (button) {
        button.disabled = true;
        button.textContent = '正在读取…';
      }
      try {
        const data = await postMedia('channels/preview', { url });
        const channel = data.channel;
        const existing = mediaDefaults
          ? mediaDefaults.findChannelDuplicate(readStore(CHANNEL_STORE_KEY), channel)
          : readStore(CHANNEL_STORE_KEY).find((item) => item.channelId === channel.channelId);
        if (existing) {
          if (error) error.textContent = '这个频道已经在库里了';
          return;
        }
        const list = readStore(CHANNEL_STORE_KEY);
        list.unshift({
          channelId: channel.channelId,
          youtubeChannelId: channel.channelId,
          handle: channel.handle,
          title: channel.title,
          pageUrl: channel.pageUrl,
          description: `来自 YouTube · ${channel.videos.length} 个视频`,
          videos: channel.videos,
        });
        writeStore(CHANNEL_STORE_KEY, list.slice(0, MEDIA_STORE_LIMIT));
        closeChannelDialog();
        if (input) input.value = '';
        openVideoBrowser();
        vbState.libraryView = 'channels';
        vbState.channelKey = `import:${channel.channelId}`;
        renderVideoBrowser();
        showToast('频道已添加，点开即可选择视频', 'info');
      } catch (err) {
        if (error) error.textContent = err.message || '添加失败';
      } finally {
        if (button) {
          button.disabled = false;
          button.textContent = '添加';
        }
      }
    }
    function rememberPodcast(podcast, options = {}) {
      const allowReplace = options.allowReplace === true;
      const existing = mediaDefaults
        ? mediaDefaults.findPodcastDuplicate(readStore(PODCAST_STORE_KEY), podcast)
        : readStore(PODCAST_STORE_KEY).find((item) => item.feedUrl === podcast.feedUrl);
      if (existing && !allowReplace) {
        const err = new Error('这个播客已经在库里了');
        err.code = 'PODCAST_DUPLICATE';
        throw err;
      }
      const list = readStore(PODCAST_STORE_KEY).filter((item) => {
        if (existing && item === existing) return false;
        if (item.feedUrl === podcast.feedUrl) return false;
        if (podcast.defaultId && item.defaultId === podcast.defaultId) return false;
        return true;
      });
      list.unshift({
        defaultId: podcast.defaultId || (existing && existing.defaultId) || '',
        feedUrl: podcast.feedUrl,
        title: podcast.title,
        author: podcast.author || '',
        image: podcast.image || '',
        description: podcast.description || podcast.author || '',
        query: podcast.query || (existing && existing.query) || podcast.title,
        episodes: podcast.episodes || [],
        seeded: Boolean(podcast.seeded || (existing && existing.seeded)),
      });
      writeStore(PODCAST_STORE_KEY, list.slice(0, MEDIA_STORE_LIMIT));
      return list[0];
    }
    function openLibrary(library) {
      const next = library === 'channels' || library === 'podcasts' ? library : 'videos';
      vbState.libraryView = next;
      vbState.channelKey = '';
      vbState.filtersOpen = false;
      podState.feedUrl = '';
      openVideoBrowser();
    }
    function openPodcastBrowser() {
      openLibrary('podcasts');
    }
    function closePodcastBrowser() {
      window.__podOpen = false;
      const menu = document.getElementById('pod-add-menu');
      if (menu) menu.hidden = true;
      closeVideoBrowser();
    }
    function updatePodcastInStore(feedUrl, patch) {
      const list = readStore(PODCAST_STORE_KEY);
      const next = list.map((item) => (item.feedUrl === feedUrl ? { ...item, ...patch } : item));
      writeStore(PODCAST_STORE_KEY, next.slice(0, MEDIA_STORE_LIMIT));
      const nextFeed = patch.feedUrl || feedUrl;
      return next.find((item) => item.feedUrl === nextFeed) || null;
    }
    async function hydratePodcastIfNeeded(show) {
      if (!show) return show;
      const seeded = String(show.feedUrl || '').startsWith('seed:podcast:');
      if (!seeded && Array.isArray(show.episodes) && show.episodes.length) return show;
      const seedKey = show.feedUrl;
      if (podcastHydratePromises.has(seedKey)) return podcastHydratePromises.get(seedKey);
      const pending = (async () => {
        try {
          const data = await postMedia('podcasts/preview', {
            url: show.feedUrl,
            query: show.query || show.title,
            collectionId: show.collectionId || '',
          });
          const live = data.podcast || {};
          const saved = updatePodcastInStore(seedKey, {
            feedUrl: live.feedUrl || show.feedUrl,
            title: live.title || show.title,
            author: live.author || show.author || '',
            image: live.image || show.image || '',
            description: live.description || show.description || show.author || '',
            episodes: live.episodes || [],
            collectionId: live.collectionId || show.collectionId || '',
            seeded: true,
            defaultId: show.defaultId || '',
            query: show.query || show.title,
            hydrateFailed: false,
            hydrateError: '',
          });
          if (podState.feedUrl === seedKey && saved) podState.feedUrl = saved.feedUrl;
          return saved || show;
        } catch (err) {
          const message = err.message || '播客读取失败';
          showToast(message, 'warn');
          return updatePodcastInStore(seedKey, {
            hydrateFailed: true,
            hydrateError: message,
          }) || show;
        } finally {
          podcastHydratePromises.delete(seedKey);
        }
      })();
      podcastHydratePromises.set(seedKey, pending);
      return pending;
    }
    function renderPodcastBrowser() {
      const grid = document.getElementById('pod-grid');
      const empty = document.getElementById('pod-empty');
      const hero = document.getElementById('pod-show-hero');
      const search = document.getElementById('vb-search');
      if (!grid) return;
      syncLibraryChrome(false);
      const q = ((search && search.value) || '').trim().toLowerCase();
      const shows = readStore(PODCAST_STORE_KEY);
      const show = shows.find((item) => item.feedUrl === podState.feedUrl) || null;
      if (hero) hero.hidden = !show;
      if (!show) {
        const visible = shows.filter((item) => !q || String(item.title || '').toLowerCase().includes(q) || String(item.author || '').toLowerCase().includes(q));
        grid.classList.add('pod-grid');
        if (!visible.length) {
          grid.innerHTML = '';
          if (empty) empty.hidden = false;
          return;
        }
        if (empty) empty.hidden = true;
        const frag = document.createDocumentFragment();
        visible.forEach((item) => frag.appendChild(renderShelfCard({
          title: item.title,
          thumb: item.image,
          feedUrl: item.feedUrl,
          square: true,
        }, (picked) => {
          const stored = readStore(PODCAST_STORE_KEY).find((show) => show.feedUrl === picked.feedUrl);
          if (stored && stored.hydrateFailed) {
            updatePodcastInStore(picked.feedUrl, { hydrateFailed: false, hydrateError: '' });
          }
          podState.feedUrl = picked.feedUrl;
          renderVideoBrowser();
        })));
        grid.innerHTML = '';
        grid.appendChild(frag);
        return;
      }
      if (!(show.episodes || []).length || String(show.feedUrl || '').startsWith('seed:podcast:')) {
        grid.innerHTML = '';
        if (show.hydrateFailed) {
          if (empty) {
            empty.hidden = false;
            const title = empty.querySelector('.vb-empty-title');
            const hint = empty.querySelector('.vb-empty-hint');
            if (title) title.textContent = '暂时读不到这个播客';
            if (hint) hint.textContent = show.hydrateError || '请稍后重试，或用右上角「添加播客」换一个源';
          }
          return;
        }
        if (empty) {
          empty.hidden = false;
          const title = empty.querySelector('.vb-empty-title');
          const hint = empty.querySelector('.vb-empty-hint');
          if (title) title.textContent = '正在读取播客…';
          if (hint) hint.textContent = '第一次打开会多花十几秒';
        }
        hydratePodcastIfNeeded(show).then(() => renderVideoBrowser());
        return;
      }
      const nameEl = document.getElementById('pod-show-name');
      const descEl = document.getElementById('pod-show-desc');
      const avatar = document.getElementById('pod-show-avatar');
      if (nameEl) nameEl.textContent = show.title || '播客';
      if (descEl) descEl.textContent = show.description || show.author || '';
      if (avatar) {
        avatar.textContent = '';
        avatar.style.backgroundImage = '';
        avatar.style.backgroundSize = 'cover';
        if (/^https?:\/\//i.test(show.image || '')) {
          avatar.style.backgroundImage = `url("${String(show.image).replace(/["\\)]/g, '')}")`;
        } else {
          avatar.textContent = String(show.title || 'P').trim().charAt(0).toUpperCase();
        }
      }
      let episodes = show.episodes || [];
      if (q) episodes = episodes.filter((ep) => String(ep.title || '').toLowerCase().includes(q));
      grid.classList.remove('pod-grid');
      if (!episodes.length) {
        grid.innerHTML = '';
        if (empty) empty.hidden = false;
        return;
      }
      if (empty) empty.hidden = true;
      const frag = document.createDocumentFragment();
      episodes.forEach((episode) => {
        const card = renderFeedVideoCard({
          title: episode.title,
          thumbnail_path: episode.image || show.image,
          duration_sec: parseDurationSec(episode.duration),
          published: episode.published,
          showTitle: show.title,
        }, () => playPodcastEpisode(show, episode));
        frag.appendChild(card);
      });
      grid.innerHTML = '';
      grid.appendChild(frag);
    }
    function closePodcastDialog() {
      const dialog = document.getElementById('podcast-dialog');
      if (dialog) dialog.hidden = true;
    }
    function openPodcastDialog(mode) {
      podcastDialogMode = mode === 'rss' ? 'rss' : 'search';
      const title = document.getElementById('podcast-dialog-title');
      const label = document.getElementById('podcast-dialog-label');
      const input = document.getElementById('podcast-query');
      const results = document.getElementById('podcast-search-results');
      const error = document.getElementById('podcast-dialog-error');
      const submit = document.getElementById('podcast-submit');
      if (title) title.textContent = podcastDialogMode === 'rss' ? '通过 RSS 链接添加' : '搜索播客';
      if (label) label.textContent = podcastDialogMode === 'rss' ? 'RSS 链接' : '节目名称';
      if (input) {
        input.value = '';
        input.placeholder = podcastDialogMode === 'rss' ? 'https://example.com/feed.xml' : '例如 Spotlight English';
      }
      if (results) results.innerHTML = '';
      if (error) error.textContent = '';
      if (submit) submit.textContent = podcastDialogMode === 'rss' ? '添加' : '搜索';
      const menu = document.getElementById('pod-add-menu');
      if (menu) menu.hidden = true;
      const dialog = document.getElementById('podcast-dialog');
      if (dialog) dialog.hidden = false;
      setTimeout(() => input && input.focus(), 30);
    }
    async function subscribePodcastFeed(url) {
      const data = await postMedia('podcasts/preview', { url });
      try {
        const saved = rememberPodcast(data.podcast);
        closePodcastDialog();
        openPodcastBrowser();
        podState.feedUrl = saved.feedUrl;
        renderPodcastBrowser();
        showToast('播客已添加', 'info');
      } catch (err) {
        if (err && err.code === 'PODCAST_DUPLICATE') {
          const error = document.getElementById('podcast-dialog-error');
          if (error) error.textContent = err.message;
          showToast(err.message, 'warn');
          return;
        }
        throw err;
      }
    }
    async function submitPodcastDialog() {
      const input = document.getElementById('podcast-query');
      const error = document.getElementById('podcast-dialog-error');
      const button = document.getElementById('podcast-submit');
      const value = input ? input.value.trim() : '';
      if (error) error.textContent = '';
      if (!value) {
        if (error) error.textContent = podcastDialogMode === 'rss' ? '请填写 RSS 链接' : '请输入节目名称';
        return;
      }
      if (button) button.disabled = true;
      try {
        if (podcastDialogMode === 'rss') {
          await subscribePodcastFeed(value);
          return;
        }
        const data = await postMedia('podcasts/search', { query: value });
        const results = document.getElementById('podcast-search-results');
        const shows = data.podcasts || [];
        if (!shows.length) {
          if (error) error.textContent = '没有找到这个播客';
          if (results) results.innerHTML = '';
          return;
        }
        if (results) {
          results.innerHTML = '';
          shows.forEach((show) => {
            const buttonEl = document.createElement('button');
            buttonEl.type = 'button';
            buttonEl.className = 'pod-hit';
            buttonEl.innerHTML = `<img alt="" src="${esc(show.image)}"><span><strong>${esc(show.title)}</strong><small>${esc(show.author || '')}</small></span>`;
            buttonEl.addEventListener('click', async () => {
              buttonEl.disabled = true;
              try { await subscribePodcastFeed(show.feedUrl); }
              catch (err) { if (error) error.textContent = err.message || '添加失败'; }
              finally { buttonEl.disabled = false; }
            });
            results.appendChild(buttonEl);
          });
        }
      } catch (err) {
        if (error) error.textContent = err.message || '添加失败';
      } finally {
        if (button) button.disabled = false;
      }
    }
    async function playPodcastEpisode(show, episode) {
      const id = `pod:${episode.id || episode.audioUrl}`;
      const media = {
        id,
        title: episode.title || show.title,
        audioUrl: episode.audioUrl,
        image: episode.image || show.image,
        notes: episode.description || show.description || '',
        cues: [],
      };
      window.LinglishStudyMedia = media;
      window.LinglishStudyVideoId = '';
      if (coachReturnActive()) {
        if (episode.transcriptUrl) {
          try {
            const data = await postMedia('cues', { url: episode.transcriptUrl });
            media.cues = (data.cues || []).map((cue, index) => ({
              index,
              text: cue.text,
              start: cue.start,
              end: cue.end,
            }));
          } catch (_) {}
        }
        closePodcastBrowser();
        try { sessionStorage.setItem('linglish.coach.media', JSON.stringify(media)); } catch (_) {}
        location.href = `./practice-session-desktop.html?source=external&mode=${coachReturnMode()}`;
        return;
      }
      closePodcastBrowser();
      const video = {
        id,
        title: media.title,
        original_filename: episode.title || show.title,
        thumbnail_path: episode.image || show.image,
        collection_name: show.title,
        duration_sec: parseDurationSec(episode.duration),
        external_podcast: true,
        language: 'en',
        episode_notes: episode.description || show.description || '',
        audioUrl: episode.audioUrl,
        transcriptUrl: episode.transcriptUrl || '',
      };
      state.currentVideo = video;
      clearTranscriptCues();
      rememberStudyVideo(video);
      if (currentTitleEl) currentTitleEl.textContent = video.title;
      try { if (typeof renderVideoIntro === 'function') renderVideoIntro(video); } catch (_) { }
      updateVideoMeta(video);
      if (youtubePlayer) {
        try { youtubePlayer.destroy(); } catch (_) { }
        youtubePlayer = null;
      }
      if (youtubePlayerEl) youtubePlayerEl.style.display = 'none';
      if (playerEl) {
        playerEl.style.display = 'block';
        playerEl.poster = video.thumbnail_path || '';
        currentPlayerType = 'local';
        playerEl.src = episode.audioUrl;
        playerEl.load();
        stopSpokenAudio();
        playerEl.play().catch(() => { });
      }
      setPlayerOverlay('loading', {
        titleKey: 'video.overlay.loading_title',
        descKey: 'video.overlay.loading_desc',
        tips: ['音频准备好后会自动开始。'],
      });
      const ready = () => setPlayerOverlay('ready');
      playerEl?.addEventListener('canplay', ready, { once: true });
      renderTranscript();
      if (!episode.transcriptUrl) return;
      try {
        const data = await postMedia('cues', { url: episode.transcriptUrl });
        if (!state.currentVideo || state.currentVideo.id !== id) return;
        const cues = (data.cues || []).map((cue, index) => ({ index, text: cue.text, start: cue.start, end: cue.end }));
        applyTranscriptCues(cues, { persistOnVideo: true });
        if (window.LinglishStudyMedia && window.LinglishStudyMedia.id === id) {
          window.LinglishStudyMedia.cues = state.rawSegments;
        }
        video.episode_notes = '';
        renderTranscript();
        syncActive();
      } catch (_) { }
    }

    const LAST_STUDY_MEDIA_KEY = 'linglish.last_study_media.v1';

    function readLastStudyMediaSnap() {
      try {
        const data = JSON.parse(localStorage.getItem(LAST_STUDY_MEDIA_KEY) || 'null');
        return data && data.id != null ? data : null;
      } catch (_) {
        return null;
      }
    }

    function videoFromStudyMediaSnap(snap) {
      if (!snap || snap.id == null || snap.id === '') return null;
      const id = String(snap.id);
      const ytFromId = (id.match(/^yt:([\w-]{6,})$/i) || [])[1] || '';
      const youtubeId = String(snap.youtube_video_id || ytFromId || '').trim();
      if (snap.external_podcast || snap.audioUrl) {
        return {
          id,
          title: snap.title || '播客',
          original_filename: snap.title || '播客',
          audioUrl: snap.audioUrl || '',
          transcriptUrl: snap.transcriptUrl || '',
          external_podcast: true,
          thumbnail_path: snap.thumbnail_path || '',
          collection_name: snap.collection_name || '',
          status: 'ready',
          duration_sec: 0,
        };
      }
      if (youtubeId) {
        return {
          id: id.startsWith('yt:') ? id : ('yt:' + youtubeId),
          title: snap.title || ('YouTube ' + youtubeId),
          original_filename: snap.title || ('YouTube ' + youtubeId),
          youtube_video_id: youtubeId,
          external_youtube: true,
          thumbnail_path: snap.thumbnail_path || ('https://i.ytimg.com/vi/' + youtubeId + '/hqdefault.jpg'),
          collection_name: snap.collection_name || '',
          status: 'ready',
          duration_sec: 0,
        };
      }
      if (/^\d+$/.test(id)) {
        return {
          id: Number(id) || id,
          title: snap.title || '',
          original_filename: snap.title || '',
          thumbnail_path: snap.thumbnail_path || '',
          status: 'ready',
        };
      }
      return null;
    }

    function syncStudyVideoUrl(v) {
      if (!v || v.id == null) return;
      try {
        const url = new URL(window.location.href);
        const id = String(v.id);
        url.searchParams.set('videoId', id);
        if (v.youtube_video_id) url.searchParams.set('yt', String(v.youtube_video_id));
        else url.searchParams.delete('yt');
        // Keep refresh/share links on the learning page, not a stale level picker.
        url.searchParams.delete('level');
        url.searchParams.delete('difficulty');
        window.history.replaceState({}, '', url.pathname + url.search + url.hash);
      } catch (_) {}
    }

    function rememberPlaybackSeconds(seconds, percent) {
      const video = state.currentVideo;
      if (!video || video.id == null) return;
      const sec = Math.max(0, Math.round(Number(seconds) || 0));
      if (sec < 1) return;
      try {
        const snap = readLastStudyMediaSnap() || { id: String(video.id) };
        if (String(snap.id) !== String(video.id)) return;
        snap.seconds = sec;
        if (Number.isFinite(Number(percent)) && Number(percent) > 0) {
          snap.percent = Math.max(0, Math.min(100, Math.round(Number(percent))));
        }
        snap.updatedAt = Date.now();
        localStorage.setItem(LAST_STUDY_MEDIA_KEY, JSON.stringify(snap));
      } catch (_) {}
      if (window.LinglishStudyRecent) {
        try {
          window.LinglishStudyRecent.touch(String(video.id), {
            seconds: sec,
            percent: Number.isFinite(Number(percent)) ? Number(percent) : undefined,
          });
        } catch (_) {}
      }
    }

    function rememberStudyVideo(v) {
      if (!v || v.id == null || v.id === '') return;
      const id = String(v.id);
      if (/^\d+$/.test(id)) {
        try { localStorage.setItem('last_video_id', id); } catch (_) {}
      }
      const snap = {
        id,
        title: v.title || v.original_filename || ('视频 ' + id),
        youtube_video_id: v.youtube_video_id || '',
        audioUrl: v.audioUrl || '',
        transcriptUrl: v.transcriptUrl || '',
        external_podcast: Boolean(v.external_podcast || v.audioUrl),
        external_youtube: Boolean(v.external_youtube || v.youtube_video_id),
        thumbnail_path: v.thumbnail_path || '',
        collection_name: v.collection_name || v.show_title || '',
        updatedAt: Date.now(),
      };
      try {
        const prevSnap = readLastStudyMediaSnap();
        if (prevSnap && String(prevSnap.id) === id) {
          snap.seconds = Number(prevSnap.seconds) || 0;
          snap.percent = Number(prevSnap.percent) || 0;
        }
        localStorage.setItem(LAST_STUDY_MEDIA_KEY, JSON.stringify(snap));
      } catch (_) {}
      try { syncStudyVideoUrl(v); } catch (_) {}
      try {
        if (!window.LinglishStudyRecent) return;
        const prev = window.LinglishStudyRecent.get(id);
        const percent = typeof getVideoProgressPercent === 'function' ? getVideoProgressPercent(id) : 0;
        let thumb = '';
        try { thumb = resolveThumbnail(v) || v.thumbnail_path || ''; } catch (_) { thumb = v.thumbnail_path || ''; }
        window.LinglishStudyRecent.record({
          id,
          title: snap.title,
          thumb,
          seconds: prev ? prev.seconds : 0,
          percent: percent || (prev ? prev.percent : 0),
          audioUrl: snap.audioUrl,
          transcriptUrl: snap.transcriptUrl,
          youtube_video_id: snap.youtube_video_id,
          showTitle: snap.collection_name,
        });
        try { renderStudyRecent(); } catch (_) {}
      } catch (_) {}
    }

    function findPodcastFromRecent(entry) {
      const id = String(entry && entry.id || '');
      if (!id) return null;
      const rawId = id.startsWith('pod:') ? id.slice(4) : id;
      const shows = typeof readStore === 'function' ? readStore(PODCAST_STORE_KEY) : [];
      for (let i = 0; i < shows.length; i += 1) {
        const show = shows[i];
        const episodes = Array.isArray(show && show.episodes) ? show.episodes : [];
        const episode = episodes.find((ep) => {
          if (!ep) return false;
          const epId = String(ep.id || '');
          const audio = String(ep.audioUrl || '');
          return epId === rawId || epId === id || `pod:${epId}` === id
            || audio === rawId || `pod:${audio}` === id;
        });
        if (episode) return { show, episode };
      }
      let audioUrl = entry.audioUrl || '';
      let transcriptUrl = entry.transcriptUrl || '';
      let title = entry.title || '';
      let thumb = entry.thumb || '';
      try {
        const last = JSON.parse(localStorage.getItem('linglish.last_study_media.v1') || 'null');
        if (last && String(last.id) === id) {
          audioUrl = audioUrl || last.audioUrl || '';
          transcriptUrl = transcriptUrl || last.transcriptUrl || '';
          title = title || last.title || '';
          thumb = thumb || last.thumbnail_path || '';
        }
      } catch (_) {}
      if (!audioUrl) return null;
      return {
        show: { title: entry.showTitle || title || '播客', image: thumb, description: '', author: '' },
        episode: {
          id: rawId,
          title: title || '播客单集',
          audioUrl,
          transcriptUrl,
          image: thumb,
          description: '',
          duration: '',
          published: '',
        },
      };
    }

    async function openRecentVideo(entry) {
      if (!entry || entry.id == null) return;
      const id = String(entry.id);
      if (id.startsWith('pod:') || entry.audioUrl) {
        const hit = findPodcastFromRecent(entry);
        if (hit && hit.episode && hit.episode.audioUrl) {
          if (Number(entry.seconds) > 1) {
            pendingSeek = { videoId: `pod:${hit.episode.id || hit.episode.audioUrl}`, startSec: Number(entry.seconds) };
          }
          closeVideoBrowser();
          await playPodcastEpisode(hit.show, hit.episode);
          return;
        }
      }
      let found = (state.videos || []).find((item) => String(item.id) === id);
      if (!found && /^\d+$/.test(id)) {
        try {
          const res = await fetch(`${API_BASE}/video-resources/${id}`, { headers: headers() });
          if (res.ok) {
            const data = await res.json();
            const video = data?.video || data;
            if (video && video.id) {
              if (!(state.videos || []).some((item) => String(item.id) === String(video.id))) {
                state.videos = [video, ...(state.videos || [])];
              }
              state.filteredVideos = state.videos;
              found = video;
            }
          }
        } catch (_) {}
      }
      if (!found) {
        const ytMatch = id.match(/^yt:([A-Za-z0-9_-]{6,})$/)
          || String(entry.youtube_video_id || '').match(/^([A-Za-z0-9_-]{6,})$/)
          || String(entry.thumb || '').match(/\/vi\/([A-Za-z0-9_-]{6,})\//)
          || String(entry.title || '').match(/\bYouTube\s+([A-Za-z0-9_-]{6,})\b/i);
        const youtubeId = ytMatch && ytMatch[1];
        if (youtubeId) {
          found = {
            id: id.startsWith('yt:') ? id : `yt:${youtubeId}`,
            title: entry.title && !/^YouTube\s+/i.test(entry.title) ? entry.title : `YouTube ${youtubeId}`,
            youtube_video_id: youtubeId,
            external_youtube: true,
            status: 'ready',
            thumbnail_path: entry.thumb || `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`,
          };
        }
      }
      if (!found) {
        showToast('这条记录对应的视频暂时打不开', 'warn');
        return;
      }
      if (Number(entry.seconds) > 1) pendingSeek = { videoId: found.id, startSec: Number(entry.seconds) };
      closeVideoBrowser();
      await selectVideo(found);
    }

    function renderStudyRecent() {
      const api = window.LinglishStudyRecent;
      const modal = document.getElementById('vb-recent');
      if (!api || !modal) return;
      // Keep recent history visible across 视频库 / 频道库 / 播客.
      api.render(modal, (entry) => {
        openRecentVideo(entry);
      }, { previewCount: 6 });
    }

    function renderVideoBrowser() {
      const grid = document.getElementById('vb-grid');
      if (!grid) return;
      const empty = document.getElementById('vb-empty');
      const stats = document.getElementById('vb-stats');
      const vbSearch = document.getElementById('vb-search');
      try { renderStudyRecent(); } catch (_) {}

      // Keep chip selected states in sync with the shared sidebar filter state.
      vbSyncChipsFromSidebar();

      // Start from the globally filtered list (sidebar scope/diff/scene/tag already applied),
      // then apply browser-local status / text search via the pure LibraryFilter module.
      // scope 现由共享闭包状态统一处理；这里再传一次保持幂等（闭包未初始化时兜底 vbState.scope）。
      const sharedNow = window.getLibraryFilterState ? window.getLibraryFilterState() : null;
      const view = activeLibraryView();
      if (view === 'podcasts') {
        syncLibraryChrome(false);
        if (empty) empty.hidden = true;
        window.__podOpen = true;
        renderPodcastBrowser();
        return;
      }
      window.__podOpen = false;
      const catalog = Array.isArray(state.videos) ? state.videos : [];
      const userLibrary = view === 'videos';
      let videos = catalog.filter((video) => userLibrary ? isMemberVideo(video) : !isMemberVideo(video));
      const q = ((vbSearch && vbSearch.value) || '').trim();
      const mineFilters = userLibrary;
      if (window.LibraryFilter) {
        videos = window.LibraryFilter.filterVideos(
          videos,
          {
            query: q,
            status: mineFilters ? vbState.status : '',
            scope: 'all',
            difficulty: mineFilters && sharedNow ? (sharedNow.difficulty || '') : '',
            scene: mineFilters && sharedNow ? (sharedNow.scene || '') : '',
            tagId: mineFilters && sharedNow ? (sharedNow.tagId || '') : '',
          },
          vbGetFilterContext()
        );
      }

      if (stats) {
        const total = Array.isArray(state.videos) ? state.videos.length : 0;
        stats.textContent = `${videos.length} / ${total}`;
      }

      // 清除全部筛选按钮：任一筛选生效时显示。
      const clearBtn = document.getElementById('vb-clear-all-btn');
      const shared = sharedNow || {};
      const filtering = userLibrary && Boolean(q || vbState.status
        || shared.difficulty || shared.scene || shared.tagId);
      if (clearBtn) clearBtn.hidden = !filtering;
      syncLibraryChrome(filtering);
      if (vbState.channelKey) {
        renderChannelFeed(grid, empty, stats, q);
        return;
      }
      if (view === 'channels') {
        renderChannelShelf(grid, empty, stats, videos);
        return;
      }
      const emptyTitle = document.querySelector('#vb-empty .vb-empty-title');
      const emptyHint = document.querySelector('#vb-empty .vb-empty-hint');
      if (emptyTitle) {
        emptyTitle.textContent = q ? '没有找到你的视频' : '还没有你导入的视频';
      }
      if (emptyHint) {
        emptyHint.textContent = q
          ? '换个关键词，或调整难度、场景、状态、标签'
          : '上传或导入的视频会出现在这里。点「选择分类」，按难度、场景、状态和标签筛选';
      }
      const resetInEmpty = document.getElementById('vb-reset-btn');
      if (resetInEmpty) resetInEmpty.hidden = !userLibrary;
      const addEmpty = document.getElementById('vb-channel-empty-add');
      if (addEmpty) addEmpty.hidden = true;
      if (stats) stats.textContent = `${videos.length} 个视频`;

      if (!videos.length) {
        grid.innerHTML = '';
        if (empty) empty.hidden = false;
        return;
      }
      if (empty) empty.hidden = true;

      const frag = document.createDocumentFragment();
      const currentId = state.currentVideo ? String(state.currentVideo.id) : null;
      const currentUserId = state.user?.id;

      videos.forEach(v => {
        const isOwner = currentUserId && v.uploader_id && String(v.uploader_id) === String(currentUserId);
        const title = v.title || v.original_filename || `视频 ${v.id}`;
        const duration = fmtSec(v.duration_sec);
        const channel = v.collection_name || v.collection || v.series || '视频';
        const initial = String(channel || title || 'V').trim().charAt(0).toUpperCase() || 'V';
        const cardPlaceholder = vbBuildPlaceholder(channel + '|' + title, initial);
        const thumb = resolveThumbnail(v) || cardPlaceholder;
        const progress = Math.round(getVideoProgressPercent(v.id) || 0);
        const isComplete = progress >= 90;

        const diffCfg = {
          a1: { icon: '', label: 'A1', bg: 'rgba(22,163,74,0.92)' },
          a2: { icon: '', label: 'A2', bg: 'rgba(13,148,136,0.92)' },
          b1: { icon: '', label: 'B1', bg: 'rgba(37,99,235,0.92)' },
          b2: { icon: '', label: 'B2', bg: 'rgba(109,40,217,0.92)' },
          c1: { icon: '', label: 'C1', bg: 'rgba(126,34,206,0.92)' },
          c2: { icon: '', label: 'C2', bg: 'rgba(159,18,57,0.92)' },
          beginner: { icon: '', label: 'A1', bg: 'rgba(22,163,74,0.92)' },
          intermediate: { icon: '', label: 'B1', bg: 'rgba(37,99,235,0.92)' },
          advanced: { icon: '', label: 'C1', bg: 'rgba(126,34,206,0.92)' }
        }[String(v.difficulty_level || '').toLowerCase()];
        const levelBadge = diffCfg
          ? `<span class="vb-level-badge" style="background:${diffCfg.bg}; color:#fff;">${diffCfg.label}</span>`
          : '';

        const progressBar = progress > 0
          ? `<div class="vb-progress-track"><div class="vb-progress-bar${isComplete ? ' complete' : ''}" style="width:${Math.min(100, progress)}%"></div></div>`
          : '';

        let tagsHtml = '';
        try {
          if (window.VideoTagSystem) {
            const tagIds = window.VideoTagSystem.getVideoTags(v.id) || [];
            const visible = window.VideoTagSystem.getVisibleTags ? window.VideoTagSystem.getVisibleTags() : [];
            const tags = tagIds.map(tid => visible.find(t => String(t.id) === String(tid))).filter(Boolean).slice(0, 3);
            if (tags.length) {
              tagsHtml = '<div class="vb-card-tags">' + tags.map(t => `
                <span class="vb-tag" style="background:${(t.color || '#94a3b8')}22; color:${t.color || '#64748b'}; border-color:${(t.color || '#cbd5e1')}55;">
                  ${t.icon ? t.icon + ' ' : ''}${esc(t.name || t.displayName || t.id)}
                </span>`).join('') + '</div>';
            }
          }
        } catch (_) { }

        let statusLabel;
        if (isComplete) statusLabel = '✅ 已完成';
        else if (progress > 0) statusLabel = `▶ 已学 ${progress}%`;
        else if (hasTranscriptData(v)) statusLabel = '📝 字幕就绪';
        else statusLabel = '⏳ 待转录';

        const card = document.createElement('article');
        card.className = 'vb-card' + (currentId === String(v.id) ? ' active' : '');
        card.dataset.videoId = v.id;
        card.setAttribute('tabindex', '0');
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', `选择视频：${title}`);
        card.innerHTML = `
          <div class="vb-thumb-wrap">
            <img class="vb-thumb" loading="lazy" alt="">
            ${levelBadge}
            ${isOwner ? `<button type="button" class="vb-manage-btn" title="管理标签与难度">⚙️ 管理</button>` : ''}
            <span class="vb-duration">${duration}</span>
            ${progressBar}
          </div>
          <div class="vb-card-body">
            <div class="vb-avatar" style="background:${vbGetAvatarGradient(channel)}">${esc(initial)}</div>
            <div class="vb-card-info">
              <h3 class="vb-card-title" title="${esc(title)}">${esc(title)}</h3>
              <div class="vb-card-channel">${esc(channel)}</div>
              <div class="vb-card-meta">
                <span>${esc(statusLabel)}</span>
              </div>
              ${tagsHtml}
            </div>
          </div>
        `;

        // Wire thumbnail: assign src + error handler as properties (no inline
        // onerror so the data-URI fallback can safely contain any chars).
        const imgEl = card.querySelector('.vb-thumb');
        if (imgEl) {
          imgEl.dataset.vbFallback = cardPlaceholder;
          imgEl.onerror = function () { vbOnThumbError(this); };
          imgEl.src = thumb;
        }

        const pick = () => { closeVideoBrowser(); selectVideo(v); };
        card.addEventListener('click', (e) => {
          if (e.target.closest('.vb-manage-btn')) return;
          pick();
        });
        card.addEventListener('keydown', (e) => {
          if (e.target.closest('.vb-manage-btn')) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
        });

        const manageBtn = card.querySelector('.vb-manage-btn');
        if (manageBtn) {
          manageBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (window.showDesktopVideoTagSelector) {
              window.showDesktopVideoTagSelector(v.id);
            }
          });
        }

        frag.appendChild(card);
      });

      grid.innerHTML = '';
      grid.appendChild(frag);
      grid.parentElement && grid.parentElement.scrollTo({ top: 0 });
    }

    function vbSyncChipsFromSidebar() {
      // Prefer the shared closure state exposed by the tag-integration script;
      // fall back to reading the sidebar DOM before that script initializes.
      const shared = window.getLibraryFilterState ? window.getLibraryFilterState() : null;
      const activeDiff = shared
        ? (shared.difficulty || '')
        : (document.querySelector('#difficulty-filters .difficulty-chip.active')?.dataset.difficulty || '');
      document.querySelectorAll('#vb-diff-chips .vb-chip').forEach(c => {
        const active = (c.dataset.diff || '') === activeDiff;
        c.classList.toggle('active', active);
        c.setAttribute('aria-pressed', String(active));
      });
      const activeScene = shared
        ? (shared.scene || '')
        : (document.querySelector('#scene-filters .scene-chip.active')?.dataset.scene || '');
      document.querySelectorAll('#vb-scene-chips .vb-chip').forEach(c => {
        const active = (c.dataset.scene || '') === activeScene;
        c.classList.toggle('active', active);
        c.setAttribute('aria-pressed', String(active));
      });
      document.querySelectorAll('#vb-status-chips .vb-chip').forEach(c => {
        const active = (c.dataset.status || '') === (vbState.status || '');
        c.classList.toggle('active', active);
        c.setAttribute('aria-pressed', String(active));
      });
      const activeScope = shared ? (shared.scope || 'all') : (vbState.scope || 'all');
      vbState.scope = activeScope; // 与共享状态保持一致，供闭包未初始化时兜底
      document.querySelectorAll('#vb-scope-chips .vb-chip').forEach(c => {
        const active = (c.dataset.scope || 'all') === activeScope;
        c.classList.toggle('active', active);
        c.setAttribute('aria-pressed', String(active));
      });
      renderVbTagChips();
    }

    function openVideoBrowser() {
      const modal = document.getElementById('video-browser-modal');
      if (!modal) return;
      modal.hidden = false;
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('vb-open');
      window.__vbOpen = true;
      renderVideoBrowser(); // 内部会先同步 chips 选中态
      setTimeout(() => {
        const s = document.getElementById('vb-search');
        if (s) s.focus();
      }, 60);
    }

    function openChannelBrowser() {
      vbState.libraryView = 'channels';
      vbState.channelKey = '';
      openVideoBrowser();
    }

    function closeVideoBrowser() {
      const modal = document.getElementById('video-browser-modal');
      if (!modal) return;
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('vb-open');
      window.__vbOpen = false;
    }

    window.openVideoBrowser = openVideoBrowser;
    window.closeVideoBrowser = closeVideoBrowser;
    window.renderVideoBrowser = renderVideoBrowser;

    // Wire trigger, close, keyboard, chip & search interactions once DOM is ready for these IDs.
    (function wireVideoBrowser() {
      ensureDefaultMediaLibraries();
      document.getElementById('nav-library-switch')?.addEventListener('click', (event) => {
        const choice = event.target.closest('[data-library]');
        if (!choice) return;
        event.preventDefault();
        openLibrary(choice.dataset.library);
      });
      document.getElementById('vb-channel-empty-add')?.addEventListener('click', openChannelDialog);
      document.querySelectorAll('[data-vb-close]').forEach(el => el.addEventListener('click', closeVideoBrowser));
      const closeBtn = document.getElementById('vb-close-btn');
      if (closeBtn) closeBtn.addEventListener('click', closeVideoBrowser);

      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const channelDialog = document.getElementById('channel-dialog');
        const podcastDialog = document.getElementById('podcast-dialog');
        if (channelDialog && !channelDialog.hidden) { closeChannelDialog(); return; }
        if (podcastDialog && !podcastDialog.hidden) { closePodcastDialog(); return; }
        if (window.__podOpen) { closePodcastBrowser(); return; }
        if (vbState.filtersOpen) {
          vbState.filtersOpen = false;
          const pop = document.getElementById('vb-filter-pop');
          if (pop) pop.hidden = true;
          return;
        }
        if (window.__vbOpen) closeVideoBrowser();
      });
      document.getElementById('vb-filter-pop')?.addEventListener('click', (e) => e.stopPropagation());
      document.addEventListener('click', (e) => {
        const pop = document.getElementById('vb-filter-pop');
        const trigger = document.getElementById('vb-view-mine');
        if (!pop || pop.hidden) return;
        if (pop.contains(e.target) || trigger?.contains(e.target)) return;
        vbState.filtersOpen = false;
        pop.hidden = true;
      });
      document.getElementById('vb-add-channel')?.addEventListener('click', openChannelDialog);
      document.querySelectorAll('[data-vb-view]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const nextView = btn.dataset.vbView;
          if (nextView === 'mine') {
            vbState.libraryView = 'videos';
            vbState.channelKey = '';
            vbState.filtersOpen = !vbState.filtersOpen;
            e.stopPropagation();
            renderVideoBrowser();
            return;
          }
          vbState.filtersOpen = false;
          vbState.libraryView = nextView === 'channels' || nextView === 'podcasts' ? nextView : 'videos';
          vbState.channelKey = '';
          if (nextView !== 'podcasts') podState.feedUrl = '';
          renderVideoBrowser();
        });
      });
      document.getElementById('vb-channel-back')?.addEventListener('click', () => {
        vbState.channelKey = '';
        renderVideoBrowser();
      });
      document.getElementById('vb-channel-sub')?.addEventListener('click', () => {
        const key = vbState.channelKey || '';
        if (!key.startsWith('import:')) return;
        writeStore(CHANNEL_STORE_KEY, readStore(CHANNEL_STORE_KEY).filter((ch) => ch.channelId !== key.slice(7)));
        vbState.channelKey = '';
        renderVideoBrowser();
        showToast('已取消这个频道', 'info');
      });
      document.getElementById('channel-cancel')?.addEventListener('click', closeChannelDialog);
      document.getElementById('channel-dialog-x')?.addEventListener('click', closeChannelDialog);
      document.getElementById('channel-submit')?.addEventListener('click', submitChannelUrl);
      document.getElementById('channel-url')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitChannelUrl();
      });
      document.getElementById('channel-dialog')?.addEventListener('click', (e) => {
        if (e.target.id === 'channel-dialog') closeChannelDialog();
      });
      document.getElementById('pod-back')?.addEventListener('click', () => {
        podState.feedUrl = '';
        renderVideoBrowser();
      });
      document.getElementById('pod-unsubscribe')?.addEventListener('click', () => {
        writeStore(PODCAST_STORE_KEY, readStore(PODCAST_STORE_KEY).filter((item) => item.feedUrl !== podState.feedUrl));
        podState.feedUrl = '';
        renderPodcastBrowser();
        showToast('已取消这个播客', 'info');
      });
      document.getElementById('pod-add-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = document.getElementById('pod-add-menu');
        if (menu) menu.hidden = !menu.hidden;
      });
      document.getElementById('pod-add-menu')?.addEventListener('click', (e) => e.stopPropagation());
      document.addEventListener('click', () => {
        const menu = document.getElementById('pod-add-menu');
        if (menu) menu.hidden = true;
      });
      document.getElementById('pod-add-search')?.addEventListener('click', () => openPodcastDialog('search'));
      document.getElementById('pod-add-rss')?.addEventListener('click', () => openPodcastDialog('rss'));
      document.getElementById('podcast-cancel')?.addEventListener('click', closePodcastDialog);
      document.getElementById('podcast-dialog-x')?.addEventListener('click', closePodcastDialog);
      document.getElementById('podcast-submit')?.addEventListener('click', submitPodcastDialog);
      document.getElementById('podcast-query')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitPodcastDialog();
      });
      document.getElementById('podcast-dialog')?.addEventListener('click', (e) => {
        if (e.target.id === 'podcast-dialog') closePodcastDialog();
      });

      const vbSearch = document.getElementById('vb-search');
      const vbSearchClear = document.getElementById('vb-search-clear');
      let vbSearchTimer = null;
      if (vbSearch) {
        vbSearch.addEventListener('input', () => {
          if (vbSearchClear) vbSearchClear.hidden = !vbSearch.value;
          clearTimeout(vbSearchTimer);
          vbSearchTimer = setTimeout(renderVideoBrowser, 120);
        });
      }
      if (vbSearchClear) {
        vbSearchClear.addEventListener('click', () => {
          if (vbSearch) vbSearch.value = '';
          vbSearchClear.hidden = true;
          renderVideoBrowser();
          vbSearch && vbSearch.focus();
        });
      }

      // Difficulty chips — set the shared filter state directly (no sidebar.click() proxy).
      document.querySelectorAll('#vb-diff-chips .vb-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const diff = chip.dataset.diff || '';
          if (window.setLibraryFilter) window.setLibraryFilter({ difficulty: diff || null });
          else renderVideoBrowser();
        });
      });

      // Scene chips — same direct state update.
      document.querySelectorAll('#vb-scene-chips .vb-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const scene = chip.dataset.scene || '';
          if (window.setLibraryFilter) window.setLibraryFilter({ scene: scene || null });
          else renderVideoBrowser();
        });
      });

      // Status chips (local only).
      document.querySelectorAll('#vb-status-chips .vb-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          vbState.status = chip.dataset.status || '';
          renderVideoBrowser();
        });
      });

      // Scope chips: 全部视频 / 我的视频 — 与左侧导航共享状态，双向同步。
      document.querySelectorAll('#vb-scope-chips .vb-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const scope = chip.dataset.scope || 'all';
          if (window.VideoBrowserScopeSync) {
            window.VideoBrowserScopeSync.applyScopeSelection(scope, {
              browserState: vbState,
              setLibraryFilter: window.setLibraryFilter,
              renderVideoBrowser
            });
            return;
          }
          vbState.scope = scope === 'mine' ? 'mine' : 'all';
          if (window.setLibraryFilter) window.setLibraryFilter({ scope: vbState.scope });
          renderVideoBrowser();
        });
      });

      function vbClearAllFilters() {
        vbState.channelKey = '';
        vbState.filtersOpen = false;
        const vbSearch2 = document.getElementById('vb-search');
        if (vbSearch2) vbSearch2.value = '';
        const vbSearchClear2 = document.getElementById('vb-search-clear');
        if (vbSearchClear2) vbSearchClear2.hidden = true;
        if (window.VideoBrowserScopeSync) {
          window.VideoBrowserScopeSync.clearScopeSelection({
            browserState: vbState,
            setLibraryFilter: window.setLibraryFilter,
            renderVideoBrowser
          });
          return;
        }
        vbState.status = '';
        vbState.scope = 'all';
        if (window.setLibraryFilter) {
          window.setLibraryFilter({ difficulty: null, scene: null, tagId: null, scope: 'all' });
        }
        renderVideoBrowser();
      }

      const resetBtn = document.getElementById('vb-reset-btn');
      if (resetBtn) resetBtn.addEventListener('click', vbClearAllFilters);
      const clearAllBtn = document.getElementById('vb-clear-all-btn');
      if (clearAllBtn) clearAllBtn.addEventListener('click', vbClearAllFilters);
    })();

    function needsToken(u) {
      try {
        const uStr = String(u || '');
        return uStr.includes('/videos/') || uStr.includes('/recordings/');
      } catch (_) { return false; }
    }

    async function setProtectedMediaSource(element, rawUrl, isCurrent) {
      if (!needsToken(rawUrl)) {
        if (typeof isCurrent === 'function' && !isCurrent()) return null;
        element.src = rawUrl;
        return rawUrl;
      }
      const accountToken = getToken();
      const mediaSession = window.LinglishMediaSession;
      if (!accountToken || !mediaSession) throw new Error('MEDIA_SESSION_UNAVAILABLE');
      return mediaSession.authorizeElementSource(element, rawUrl, {
        token: accountToken,
        legacyToken: accountToken,
        isCurrent,
      });
    }

    window.LinglishMediaSession?.bindLifecycle({
      getToken,
      onError: () => showToast('媒体授权已失效，请重试', 'warn'),
    });

    // ===== Transcript refinement =====
    // Some videos have very coarse transcript_segments (e.g. only 2 segments for a 1-min video),
    // which makes the timeline feel “messy”. We refine overly-long segments on the client side
    // by splitting text on punctuation and distributing timestamps proportionally.
    function normalizeSegTime(v) {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    function segStart(seg) { return normalizeSegTime(seg?.start_sec ?? seg?.start ?? seg?.startTime); }
    function segEnd(seg) { return normalizeSegTime(seg?.end_sec ?? seg?.end ?? seg?.endTime); }
    function getSegText(seg) { return String(seg?.text ?? seg?.transcript ?? seg?.line ?? '').trim(); }

    /**
     * Merge segments that are incorrectly split mid-sentence.
     * e.g. "Today we have another episode of my fabulous" + "5 Common British Expressions"
     * should be merged into a single segment.
     */
    function mergeIncompleteSentences(segments) {
      if (!Array.isArray(segments) || segments.length <= 1) return segments;

      const MAX_GAP_SEC = 2.5;        // 最大合并间隙
      const SHORT_GAP_SEC = 0.5;      // 短间隙强制合并阈值
      const MAX_WORDS = 24;           // 合并后最大词数
      const MAX_DURATION_SEC = 8.0;   // 合并后最大时长

      // Words that typically need something after them (adjectives, determiners, etc.)
      const needsFollowingWord = new Set([
        // Adjectives commonly used before nouns
        'fabulous', 'wonderful', 'amazing', 'beautiful', 'great', 'good', 'bad',
        'new', 'old', 'big', 'small', 'long', 'short', 'first', 'last', 'next',
        'common', 'popular', 'important', 'interesting', 'different', 'special',
        'best', 'worst', 'favorite', 'favourite', 'main', 'real', 'true', 'false',
        'more', 'less', 'most', 'least', 'very', 'really', 'quite', 'rather',
        // Determiners and articles
        'my', 'your', 'his', 'her', 'our', 'their', 'its',
        'a', 'an', 'the', 'this', 'that', 'these', 'those',
        'some', 'any', 'no', 'every', 'each', 'all', 'both', 'few', 'many', 'much',
        // Prepositions (when at end of segment, likely incomplete)
        'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'about',
        'into', 'through', 'during', 'before', 'after', 'above', 'below',
        // Conjunctions
        'and', 'or', 'but', 'so', 'because', 'although', 'while', 'when', 'if',
        // Auxiliaries
        'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
        'do', 'does', 'did', 'have', 'has', 'had',
        'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
        // Numbers/ordinals (expect a noun)
        'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
        'another', 'other',
      ]);

      const countWords = (s) => (String(s || '').match(/\b[\w']+\b/g) || []).length;

      // Check if text ends with a word that needs continuation
      function endsIncomplete(text) {
        const t = String(text || '').trim();
        // If ends with sentence-ending punctuation, it's complete
        if (/[.!?。！？]\s*$/.test(t)) return false;
        // Get the last word
        const words = t.split(/\s+/).filter(Boolean);
        if (words.length === 0) return false;
        const lastWord = words[words.length - 1].toLowerCase().replace(/[^a-z]/g, '');
        return needsFollowingWord.has(lastWord);
      }

      // Check if text starts with something that looks like continuation (not a new sentence)
      function startsAsContinuation(text) {
        const t = String(text || '').trim();
        if (!t) return false;
        // Starts with a number or digit - likely continuation after adjective
        if (/^[0-9]/.test(t)) return true;
        // Starts with lowercase - definitely continuation
        const firstChar = t[0];
        if (firstChar && firstChar === firstChar.toLowerCase() && /[a-z]/.test(firstChar)) return true;
        // Common continuation words (conjunctions at start)
        const firstWord = t.split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, '');
        const continuationWords = new Set(['and', 'or', 'but', 'because', 'so', 'which', 'who', 'that', 'where', 'when']);
        if (continuationWords.has(firstWord)) return true;
        // Starts with a noun phrase (capital letter, but not typical sentence starters)
        const sentenceStarters = new Set([
          'i', 'we', 'you', 'he', 'she', 'it', 'they', 'there', 'here',
          'what', 'when', 'where', 'why', 'how', 'who', 'which',
          'now', 'so', 'and', 'but', 'well', 'ok', 'okay', 'yes', 'no',
          'hello', 'hi', 'hey', 'bye', 'goodbye',
          'today', 'tomorrow', 'yesterday', 'first', 'finally', 'next',
        ]);
        // If it's a common sentence starter, don't merge
        if (sentenceStarters.has(firstWord)) return false;
        // Otherwise, it might be a proper noun/title that should be merged
        return true;
      }

      const merged = [];
      let i = 0;
      while (i < segments.length) {
        const current = { ...segments[i] };
        current.text = getSegText(current);
        const currentStart = segStart(current);
        let currentEnd = segEnd(current);
        let currentText = current.text;

        // Try to merge with following segments
        while (i + 1 < segments.length) {
          const next = segments[i + 1];
          const nextText = getSegText(next);
          const nextStart = segStart(next);
          const nextEnd = segEnd(next);
          const gap = (nextStart != null && currentEnd != null) ? (nextStart - currentEnd) : 0;
          const shortGap = gap <= SHORT_GAP_SEC;

          // Check limits
          const mergedWords = countWords(currentText) + countWords(nextText);
          const mergedDuration = (nextEnd || currentEnd) - currentStart;
          if (mergedWords > MAX_WORDS || mergedDuration > MAX_DURATION_SEC) break;

          // Check time gap
          if (gap > MAX_GAP_SEC) break;

          // Check if current ends with sentence punctuation
          const curEndsSentence = /[.!?。！？]\s*$/.test(String(currentText || '').trim());
          if (curEndsSentence && !shortGap) break;

          // Determine if we should merge
          let shouldMerge = false;
          if (endsIncomplete(currentText)) {
            // Current ends with incomplete structure - force merge
            shouldMerge = true;
          } else if (startsAsContinuation(nextText)) {
            // Next looks like continuation
            shouldMerge = true;
          } else if (shortGap && !curEndsSentence) {
            // Very short gap and no sentence end - likely same sentence
            shouldMerge = true;
          } else if (countWords(currentText) < 4 && !curEndsSentence) {
            // Current is very short and no punctuation - merge
            shouldMerge = true;
          }

          if (!shouldMerge) break;

          // Merge the segments
          currentText = `${currentText} ${nextText}`.replace(/\s+/g, ' ').trim();
          currentEnd = nextEnd != null ? nextEnd : currentEnd;
          i++;
        }

        // Update the merged segment
        current.text = currentText;
        current.end = currentEnd;
        current.end_sec = currentEnd;
        merged.push(current);
        i++;
      }

      console.log(`[MergeIncomplete] Merged ${segments.length} segments into ${merged.length}`);
      return merged;
    }

    console.log('[VR-Desktop] build:', '2026-01-03-translate-align-v4');

    function splitTextForTimeline(text) {
      const t = String(text || '').replace(/\s+/g, ' ').trim();
      if (!t) return [];

      // Prefer hard boundaries first, then softer ones for long lines.
      // NOTE: Keep line-break semantics by NOT merging short fragments too aggressively.
      // Many kid/story videos have captions like:
      // "illustrated by Damien Ward
      //  my cake
      //  my cookie"
      // These should remain separate chunks.
      let parts = t
        .split(/\n+/g)
        .flatMap(s => s.split(/(?<=[.!?。！？])\s+/g))
        .map(s => s.trim())
        .filter(Boolean);

      // If still very long (common for comma-separated captions), split on commas.
      // IMPORTANT: do NOT split numeric groups like "3,000" or "1,234,567".
      function splitOnSoftPunctPreservingNumbers(str) {
        const s = String(str || '');
        const parts = [];
        let buf = '';
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          const isSep = ch === ',' || ch === '，' || ch === ';' || ch === '；';
          if (!isSep) {
            buf += ch;
            continue;
          }
          const prev = s[i - 1] || '';
          const next = s[i + 1] || '';
          const betweenDigits = /\d/.test(prev) && /\d/.test(next);
          if (betweenDigits) {
            buf += ch;
            continue;
          }
          const trimmed = buf.trim();
          if (trimmed) parts.push(trimmed);
          buf = '';
        }
        const last = buf.trim();
        if (last) parts.push(last);
        return parts;
      }
      const out = [];
      for (const p of parts) {
        const wordCount = (p.match(/\b[\w']+\b/g) || []).length;
        if (p.length > 80 || wordCount > 14) {
          const sub = splitOnSoftPunctPreservingNumbers(p);
          if (sub.length > 1) out.push(...sub);
          else out.push(p);
        } else {
          out.push(p);
        }
      }

      // Further split for “phrase list” captions that often lack commas, e.g.:
      // "My cupcake My ice cream My pie My brownie"
      // Only apply when we detect repeated determiners and the chunk is short (to avoid damaging normal sentences).
      const determiners = new Set(['my', 'your', 'his', 'her', 'our', 'their']);
      const splitPhraseList = (p) => {
        const words = String(p || '').trim().split(/\s+/g).filter(Boolean);
        if (words.length < 4 || words.length > 12) return [p];
        const detCount = words.filter(w => determiners.has(String(w).toLowerCase())).length;
        if (detCount < 2) return [p];
        // Allow splitting when it looks like a list, e.g. "my sister, my grandfather, ..."
        // This avoids over-splitting normal sentences like "My mother and my father are ...".
        const listLike =
          /,\s*(my|your|his|her|our|their)\b/i.test(p) ||
          // repeated determiner with very short noun phrases tends to be list-like
          detCount >= 3;
        if (!listLike) return [p];

        const chunks = [];
        let buf = [];
        for (let i = 0; i < words.length; i++) {
          const w = words[i];
          const lw = String(w).toLowerCase();
          const isDet = determiners.has(lw);
          // Start a new chunk at each determiner after the first one, as long as current buffer has content.
          if (isDet && buf.length >= 2) {
            chunks.push(buf.join(' ').trim());
            buf = [w];
          } else {
            buf.push(w);
          }
        }
        if (buf.length) chunks.push(buf.join(' ').trim());
        // If we produced too many micro chunks, keep original.
        return chunks.length >= 2 && chunks.length <= 8 ? chunks : [p];
      };

      const out2 = [];
      for (const p of out) {
        out2.push(...splitPhraseList(p));
      }

      // Merge tiny fragments into previous to avoid micro segments.
      const merged = [];
      for (const p of out2) {
        const wc = (p.match(/\b[\w']+\b/g) || []).length;
        const bare = String(p || '').toLowerCase().replace(/[^a-z']/g, '');
        const keepAlone = new Set(['me', 'you', 'him', 'her', 'us', 'them']);
        // Keep 1-word pronoun list items (e.g. "me") as standalone chunks.
        if (keepAlone.has(bare)) {
          merged.push(p);
          continue;
        }
        // Keep 2-word phrases like "my cake" / "my cookie" as standalone chunks.
        if (merged.length && (p.length < 8 || wc <= 1)) {
          merged[merged.length - 1] = `${merged[merged.length - 1]} ${p}`.trim();
        } else {
          merged.push(p);
        }
      }
      return merged;
    }

    const waveformOriginalCache = new Map();

    function splitTextByPunctuationForWaveform(text) {
      const raw = String(text || '').trim();
      if (!raw) return [];
      const out = [];
      let buffer = '';
      for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        buffer += ch;
        if (/[.!?。！？]/.test(ch)) {
          const next = raw[i + 1];
          if (!next || /\s/.test(next)) {
            out.push(buffer.trim());
            buffer = '';
          }
        }
      }
      if (buffer.trim()) out.push(buffer.trim());
      return out.length ? out : [raw];
    }

    function splitTextByWords(text, parts) {
      const words = String(text || '').trim().split(/\s+/).filter(Boolean);
      if (!words.length || parts <= 1) return [String(text || '').trim()];
      const out = [];
      const per = Math.max(1, Math.ceil(words.length / parts));
      for (let i = 0; i < words.length; i += per) {
        out.push(words.slice(i, i + per).join(' ').trim());
      }
      return out.length ? out : [String(text || '').trim()];
    }

    function getWaveformPeak(samples) {
      if (!samples || !samples.length) return 0;
      let peak = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const v = Math.abs(samples[i]);
        if (v > peak) peak = v;
      }
      return peak;
    }

    function isWaveformUsable(samples) {
      if (!samples || !samples.length) return false;
      return getWaveformPeak(samples) >= 0.005;
    }

    async function fetchOriginalWaveformFromServer(videoId, startSec, endSec, points = 240, timeoutMs = 2000) {
      if (!videoId || typeof AbortController === 'undefined') return null;
      if (!waveformSegmentationConfig.enabled) return null;
      const key = `${videoId}:${Number(startSec || 0).toFixed(2)}:${Number(endSec || 0).toFixed(2)}:${Number(points || 240)}`;
      if (waveformOriginalCache.has(key)) {
        return waveformOriginalCache.get(key);
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const params = new URLSearchParams();
        params.set('start', String(startSec || 0));
        params.set('end', String(endSec || 0));
        params.set('points', String(points || 240));
        const res = await fetch(`${API_BASE}/video-resources/${encodeURIComponent(String(videoId))}/waveform?${params.toString()}`, {
          headers: headers(),
          signal: controller.signal
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || !Array.isArray(data.samples)) return null;
        const arr = Float32Array.from(data.samples);
        waveformOriginalCache.set(key, arr);
        return arr;
      } catch (_) {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    }

    function getWaveformSilenceSplits(samples, startSec, endSec) {
      if (!samples || samples.length < 8) return [];
      const duration = endSec - startSec;
      if (!Number.isFinite(duration) || duration <= 0) return [];
      const peak = getWaveformPeak(samples);
      if (peak <= 0) return [];
      const threshold = Math.max(waveformSegmentationConfig.minThreshold, peak * waveformSegmentationConfig.silenceThresholdRatio);
      const timePerSample = duration / Math.max(1, samples.length - 1);
      const minSilenceSec = waveformSegmentationConfig.minSilenceSec;
      const minEdgeSec = waveformSegmentationConfig.minEdgeSec;
      const candidates = [];
      let silentStart = null;
      for (let i = 0; i < samples.length; i += 1) {
        const v = Math.abs(samples[i]);
        if (v < threshold) {
          if (silentStart == null) silentStart = i;
        } else if (silentStart != null) {
          const silentEnd = i - 1;
          const silentDur = (silentEnd - silentStart + 1) * timePerSample;
          if (silentDur >= minSilenceSec) {
            const mid = (silentStart + silentEnd) / 2;
            const t = startSec + mid * timePerSample;
            if (t - startSec > minEdgeSec && endSec - t > minEdgeSec) {
              candidates.push({ time: t, duration: silentDur });
            }
          }
          silentStart = null;
        }
      }
      if (silentStart != null) {
        const silentEnd = samples.length - 1;
        const silentDur = (silentEnd - silentStart + 1) * timePerSample;
        if (silentDur >= minSilenceSec) {
          const mid = (silentStart + silentEnd) / 2;
          const t = startSec + mid * timePerSample;
          if (t - startSec > minEdgeSec && endSec - t > minEdgeSec) {
            candidates.push({ time: t, duration: silentDur });
          }
        }
      }
      return candidates;
    }

    async function splitSegmentsByWaveformSilence(raw, videoId, { skipIfTranslated = false } = {}) {
      const segs = Array.isArray(raw) ? raw.slice() : [];
      if (segs.length <= 1) return segs;
      if (!waveformSegmentationConfig.enabled || skipIfTranslated) return segs;
      const maxSplitsPerVideo = waveformSegmentationConfig.maxSplits;
      const minDuration = waveformSegmentationConfig.minDurationSec;
      const minWords = waveformSegmentationConfig.minWords;

      const candidates = segs
        .map((seg, idx) => {
          const start = Number(segStart(seg));
          const end = Number(segEnd(seg));
          const duration = end - start;
          const text = getSegText(seg);
          const wordCount = (String(text || '').match(/\b[\w']+\b/g) || []).length;
          return { seg, idx, start, end, duration, text, wordCount };
        })
        .filter(item => item.text && item.duration >= minDuration && item.wordCount >= minWords);

      if (!candidates.length) return segs;

      candidates.sort((a, b) => b.duration - a.duration);
      const picked = new Map();
      const limit = Math.min(maxSplitsPerVideo, candidates.length);
      // Optional timing refinement must not delay the learning workspace indefinitely.
      const deadline = Date.now() + 2000;

      for (let i = 0; i < limit; i += 1) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const item = candidates[i];
        const points = Math.max(180, Math.min(360, Math.round(item.duration * 60)));
        const samples = await fetchOriginalWaveformFromServer(videoId, item.start, item.end, points, remainingMs);
        if (!isWaveformUsable(samples)) continue;
        const splits = getWaveformSilenceSplits(samples, item.start, item.end);
        if (!splits.length) continue;
        splits.sort((a, b) => b.duration - a.duration);
        const chosen = splits
          .slice(0, Math.min(waveformSegmentationConfig.maxSplitsPerSegment, splits.length))
          .sort((a, b) => a.time - b.time);
        const splitTimes = chosen.map(s => s.time);
        if (!splitTimes.length) continue;
        const desiredChunks = splitTimes.length + 1;
        let chunks = splitTextByPunctuationForWaveform(item.text);
        if (chunks.length !== desiredChunks) {
          chunks = splitTextByWords(item.text, desiredChunks);
        }
        if (chunks.length !== desiredChunks) continue;
        const times = [item.start, ...splitTimes, item.end];
        const minChunkSec = waveformSegmentationConfig.minChunkSec;
        let valid = true;
        for (let t = 0; t < desiredChunks; t += 1) {
          if (times[t + 1] - times[t] < minChunkSec) {
            valid = false;
            break;
          }
        }
        if (!valid) continue;
        const translation = String(item.seg.translation || item.seg.cn || item.seg.zh || item.seg.text_cn || '').trim();
        const result = [];
        for (let c = 0; c < chunks.length; c += 1) {
          const text = String(chunks[c] || '').trim();
          if (!text) {
            valid = false;
            break;
          }
          result.push({
            ...item.seg,
            text,
            start: times[c],
            end: times[c + 1],
            start_sec: times[c],
            end_sec: times[c + 1],
            translation: c === 0 ? translation : '',
          });
        }
        if (!valid || result.length <= 1) continue;
        picked.set(item.idx, result);
      }

      if (!picked.size) return segs;
      const out = [];
      for (let i = 0; i < segs.length; i += 1) {
        const replacement = picked.get(i);
        if (replacement && replacement.length) {
          replacement.forEach((seg) => out.push(seg));
        } else {
          out.push(segs[i]);
        }
      }
      out.forEach((s, idx) => { s.index = idx; });
      return out;
    }

    function coalesceToMaxCount(chunks, maxCount) {
      const arr = Array.isArray(chunks) ? chunks.filter(Boolean) : [];
      if (maxCount <= 0 || arr.length <= maxCount) return arr;
      // Preserve original order by merging consecutive chunks.
      // Example: 9 chunks with maxCount=4 => groupSize=3 => [0..2],[3..5],[6..8]
      const groupSize = Math.ceil(arr.length / maxCount);
      const out = [];
      for (let i = 0; i < arr.length; i += groupSize) {
        out.push(arr.slice(i, i + groupSize).join(', ').trim());
      }
      return out.filter(Boolean);
    }

    function refineTranscriptSegments(rawSegments) {
      const segs = Array.isArray(rawSegments) ? rawSegments : [];
      if (segs.length === 0) return [];

      // Only refine when backend segments are truly "too coarse".
      // This avoids damaging good server-side segmentation (e.g. splitting "3,000" into "3" + "000").
      const starts = segs.map(segStart).filter(v => Number.isFinite(v));
      const ends = segs.map(segEnd).filter(v => Number.isFinite(v));
      const span = (starts.length && ends.length) ? (Math.max(...ends) - Math.min(...starts)) : null;
      const segsPerMinute = (span && span > 0) ? (segs.length / (span / 60)) : null;
      const avgDur = (span && span > 0) ? (span / segs.length) : null;
      const maxDur = (() => {
        let m = 0;
        for (const s of segs) {
          const a = segStart(s);
          const b = segEnd(s);
          if (a == null || b == null) continue;
          const d = b - a;
          if (Number.isFinite(d) && d > m) m = d;
        }
        return m || null;
      })();

      // Heuristic thresholds:
      // - Very small segment count, or
      // - Low density (< 2 seg/min), or
      // - High average duration (> 9s), or
      // - Any segment too long (> 18s)
      //
      // This is intentionally permissive: refineTranscriptSegments has its own shouldSplit guard,
      // so enabling refine here won't affect already-fine segments (e.g. 2-5s lines).
      const allowRefine =
        segs.length <= 12 ||
        (segsPerMinute != null && segsPerMinute < 2) ||
        (avgDur != null && avgDur > 9) ||
        (maxDur != null && maxDur > 18);

      if (!allowRefine) {
        console.log('[DEBUG] refineTranscriptSegments skipped:', { count: segs.length, span, segsPerMinute, avgDur, maxDur });
        return segs;
      }
      console.log('[DEBUG] refineTranscriptSegments enabled:', { count: segs.length, span, segsPerMinute, avgDur, maxDur });

      const refined = [];
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i] || {};
        const start = segStart(seg);
        const end = segEnd(seg);
        const text = getSegText(seg);
        const translation = String(seg.translation || seg.cn || seg.zh || seg.text_cn || '').trim();

        // If missing timing or text, keep as-is.
        if (start == null || end == null || !Number.isFinite(end - start) || (end - start) <= 0.2 || !text) {
          refined.push(seg);
          continue;
        }

        const duration = end - start;
        const wordCount = (text.match(/\b[\w']+\b/g) || []).length;
        const hasSplitHints = /[，,;；.!?。！？]/.test(text);

        const hasRepeatedDeterminer = (() => {
          const m = text.match(/\b(my|your|his|her|our|their)\b/gi) || [];
          return m.length >= 2;
        })();

        // Heuristic: only split when the segment is long enough to feel "coarse".
        // Also handle very coarse timings like "My pie My brownie" spanning many seconds.
        const shouldSplit =
          (duration >= 8 && (wordCount >= 8 || text.length >= 50) && (hasSplitHints || hasRepeatedDeterminer)) ||
          (duration >= 6 && wordCount <= 10 && hasRepeatedDeterminer);
        if (!shouldSplit) {
          refined.push(seg);
          continue;
        }

        let chunks = splitTextForTimeline(text);
        // Cap chunk count by available duration (avoid segments shorter than ~1.2s).
        // Short phrase videos benefit from more granular splitting.
        const maxCount = Math.max(2, Math.floor(duration / 1.2));
        chunks = coalesceToMaxCount(chunks, maxCount);
        if (chunks.length <= 1) {
          refined.push(seg);
          continue;
        }

        // Distribute time proportionally by chunk length (better than equal split for mixed lengths).
        const weights = chunks.map(c => Math.max(1, String(c).replace(/\s+/g, '').length));
        const total = weights.reduce((a, b) => a + b, 0) || 1;

        let cursor = start;
        for (let j = 0; j < chunks.length; j++) {
          const w = weights[j] / total;
          const isLast = j === chunks.length - 1;
          const nextEnd = isLast ? end : (cursor + duration * w);
          const sub = {
            ...seg,
            text: chunks[j],
            start_sec: cursor,
            end_sec: nextEnd,
          };
          // Only show the original translation on the first chunk to reduce repetition.
          if (translation) sub.translation = (j === 0) ? translation : '';
          refined.push(sub);
          cursor = nextEnd;
        }
      }
      return refined;
    }

    function rememberVideoWords(videoId, segments) {
      if (!videoId) return;
      const words = new Set();
      (segments || []).forEach((seg) => {
        const text = String(seg?.text || seg?.transcript || '').toLowerCase();
        const found = text.match(/[a-z][a-z'-]*/g) || [];
        found.forEach((word) => { if (word.length > 1) words.add(word); });
      });
      try {
        sessionStorage.setItem(`linglish-video-words:${videoId}`, JSON.stringify(Array.from(words)));
      } catch (_) { }
    }

    function coerceSegmentList(raw) {
      let segs = raw;
      if (typeof segs === 'string') {
        const trimmed = segs.trim();
        if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return [];
        try { segs = JSON.parse(trimmed); } catch (_) { return []; }
      }
      if (Array.isArray(segs)) return segs.filter(Boolean);
      if (segs && Array.isArray(segs.segments)) return segs.segments.filter(Boolean);
      if (segs && typeof segs === 'object') {
        const vals = Object.keys(segs)
          .filter((k) => /^\d+$/.test(k))
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => segs[k])
          .filter((v) => v && typeof v === 'object');
        if (vals.length) return vals;
      }
      return [];
    }

    function normalizeDisplayedSegments(rawSegments) {
      const segArray = coerceSegmentList(rawSegments);
      if (!segArray.length) return [];
      let nextSegments = segArray;
      try {
        if (window.LinglishSentenceSegments?.toDisplayedSentences) {
          nextSegments = window.LinglishSentenceSegments.toDisplayedSentences(segArray);
        } else if (window.LinglishSentenceSegments?.toCompleteSentences) {
          nextSegments = window.LinglishSentenceSegments.toCompleteSentences(segArray);
        }
      } catch (err) {
        console.warn('[Transcript] sentence normalize failed, using raw segments:', err);
        nextSegments = segArray;
      }
      // Never wipe a usable transcript if sentence rebuild drops everything.
      if ((!Array.isArray(nextSegments) || !nextSegments.length) && segArray.length) {
        return segArray.map((seg, index) => ({
          ...seg,
          index,
          source_indices: Array.isArray(seg.source_indices) ? seg.source_indices : [index],
        }));
      }
      return Array.isArray(nextSegments) ? nextSegments : segArray;
    }

    // Keep original timed cues immutable; display cards are derived only.
    function clearTranscriptCues() {
      state.rawSegments = [];
      state.currentSegments = [];
    }

    let transcriptFetchKey = '';
    let transcriptFetchPromise = null;
    function beginTranscriptLoad(v, selectionToken) {
      const key = `${selectionToken?.generation ?? ''}:${v && v.id != null ? v.id : ''}`;
      if (transcriptFetchKey === key && transcriptFetchPromise) return transcriptFetchPromise;
      transcriptFetchKey = key;
      state.isLoadingTranscript = true;
      clearTranscriptCues();
      try { renderTranscript(); } catch (_) { }
      try { renderActiveSubtitle(-1); } catch (_) { }
      transcriptFetchPromise = loadCurrentTranscript(v, selectionToken).finally(() => {
        const stillCurrent = v
          && state.currentVideo
          && String(state.currentVideo.id) === String(v.id)
          && (!selectionToken || videoSelectionGuard.isCurrent(selectionToken, v.id));
        if (!stillCurrent || transcriptFetchKey !== key) return;
        state.isLoadingTranscript = false;
        try { renderTranscript(); } catch (_) { }
        try { syncActive(); } catch (_) { }
        if (state.showBilingual) ensureDesktopBilingualTranslations().catch(() => { });
      });
      return transcriptFetchPromise;
    }

    function applyTranscriptCues(rawCues, options) {
      const raw = coerceSegmentList(rawCues).map((seg, index) => ({
        ...(seg || {}),
        index,
        source_indices: [index],
      }));
      const display = normalizeDisplayedSegments(raw);
      state.rawSegments = raw;
      state.currentSegments = display;
      if (options && options.persistOnVideo && state.currentVideo) {
        // Persist RAW cues only — never overwrite with display rewrite.
        state.currentVideo.transcript_segments = raw;
      }
      return display;
    }

    async function loadCurrentTranscript(v, selectionToken) {
      if (v && v.external_youtube && v.youtube_video_id) {
        return loadExternalTranscript(v, selectionToken);
      }
      if (v && /^\d+$/.test(String(v.id))) {
        await loadVideoDetails(v.id, selectionToken);
        const stillEmpty = !Array.isArray(state.currentSegments) || !state.currentSegments.length;
        if (stillEmpty && v.youtube_video_id) {
          return loadExternalTranscript(v, selectionToken);
        }
        return;
      }
      if (v && v.youtube_video_id) {
        return loadExternalTranscript(v, selectionToken);
      }
    }
    async function loadExternalTranscript(v, selectionToken) {
      const isExpected = () => {
        const currentId = state.currentVideo && state.currentVideo.id;
        if (currentId == null || String(currentId) !== String(v.id)) return false;
        return !selectionToken || videoSelectionGuard.isCurrent(selectionToken, v.id);
      };
      if (!v || !v.youtube_video_id) return;
      try {
        const res = await fetch(`${API_BASE}/youtube/transcript`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${v.youtube_video_id}`, language: 'en' }),
        });
        const data = await res.json().catch(() => ({}));
        if (!isExpected()) return;
        if (!res.ok || data.success === false) throw new Error(data.error || '这一集暂时没有字幕');
        const raw = Array.isArray(data.segments) ? data.segments : [];
        if (!isExpected()) return;
        // Refine once, then paint once — double apply/render reshuffles the right rail.
        const refined = refineTranscriptSegments(raw);
        if (!isExpected()) return;
        applyTranscriptCues(refined, { persistOnVideo: true });
        rememberVideoWords(v.id, state.currentSegments);
        state.isLoadingTranscript = false;
        renderTranscript();
        if (typeof syncModeButtons === 'function') syncModeButtons();
        if (state.showBilingual) ensureDesktopBilingualTranslations().catch(() => { });
        try {
          if (youtubePlayer && typeof youtubePlayer.disableNativeCaptions === 'function') {
            youtubePlayer.disableNativeCaptions();
          }
        } catch (_) { }
      } catch (error) {
        if (!isExpected()) return;
        if (!Array.isArray(state.currentSegments) || !state.currentSegments.length) {
          clearTranscriptCues();
          state.isLoadingTranscript = false;
          renderTranscript();
          showToast(error.message || '这一集暂时没有字幕', 'warn');
          try {
            if (youtubePlayer && typeof youtubePlayer.enableNativeCaptions === 'function') {
              youtubePlayer.enableNativeCaptions('en');
            }
          } catch (_) { }
        }
      }
    }
    async function loadVideoDetails(id, selectionToken = null) {
      const isExpectedVideo = () => {
        const currentId = state.currentVideo && state.currentVideo.id;
        if (currentId == null || String(currentId) !== String(id)) return false;
        return !selectionToken || videoSelectionGuard.isCurrent(selectionToken, id);
      };
      if (!isExpectedVideo()) return;
      try {
        const res = await fetch(`${API_BASE}/video-resources/${id}`, { headers: headers() });
        const data = await res.json();
        if (!isExpectedVideo()) return;
        if (!res.ok) throw new Error(data?.message || '加载视频详情失败');
        const video = data?.video || {};
        let segs = coerceSegmentList(video.transcript_segments);

        // Enhanced debug logging
        console.log('[DEBUG] ========== Video Details Debug ==========');
        console.log('[DEBUG] Video ID:', id);
        console.log('[DEBUG] Video status:', video.status);
        console.log('[DEBUG] Video has_subtitles:', video.has_subtitles);
        console.log('[DEBUG] Raw transcript length:', video.transcript?.length || 0);
        console.log('[DEBUG] Coerced segments length:', segs.length);
        if (segs.length > 0) console.log('[DEBUG] First segment:', segs[0]);
        console.log('[DEBUG] =====================================');

        // Detail payload sometimes omits segments (cache / processing). Try dedicated transcript route.
        if (!segs.length && /^\d+$/.test(String(id))) {
          try {
            const trRes = await fetch(`${API_BASE}/video-resources/${id}/transcript`, { headers: headers() });
            const trData = trRes.ok ? await trRes.json().catch(() => ({})) : null;
            if (!isExpectedVideo()) return;
            const fetched = coerceSegmentList(trData?.segments);
            if (fetched.length) segs = fetched;
          } catch (_) { /* keep empty; YouTube fallback may still help */ }
        }

        const resolvedSegs = segs;
        const hasTranslations = resolvedSegs.some(s => {
          const t = String(s?.translation || s?.cn || s?.zh || s?.text_cn || '').trim();
          return t.length > 0;
        });
        // Keep youtube_video_id on current video so loadCurrentTranscript can live-fetch captions.
        if (video.youtube_video_id && state.currentVideo && String(state.currentVideo.id) === String(id)) {
          state.currentVideo.youtube_video_id = state.currentVideo.youtube_video_id || video.youtube_video_id;
          if (video.has_subtitles != null) state.currentVideo.has_subtitles = video.has_subtitles;
        }

        // Guided practice needs its committed sentence immediately. Ordinary reading
        // still waits for refinement so display identity is committed only once.
        let rawForSync = resolvedSegs;
        if (!firstLessonSession.isActive()) {
          try {
            rawForSync = refineTranscriptSegments(resolvedSegs);
            rawForSync = await splitSegmentsByWaveformSilence(rawForSync, video.id, { skipIfTranslated: hasTranslations });
            if (!isExpectedVideo()) return;
          } catch (refineErr) {
            console.warn('[DEBUG] segment refine failed, using raw segments:', refineErr);
            rawForSync = resolvedSegs;
          }
        }
        if (!isExpectedVideo()) return;
        applyTranscriptCues(rawForSync, { persistOnVideo: true });
        rememberVideoWords(state.currentVideo.id, state.currentSegments);
        state.isLoadingTranscript = false;
        renderTranscript();
        if (state.currentSegments.length && youtubePlayer && typeof youtubePlayer.disableNativeCaptions === 'function') {
          try { youtubePlayer.disableNativeCaptions(); } catch (_) { }
        }
        syncModeButtons();
        if (state.showBilingual) ensureDesktopBilingualTranslations().catch(() => { });
        if (!isExpectedVideo()) return;
        startFirstLessonProgress(state.currentVideo, state.currentSegments);
        if (firstLessonSession.isActive()) {
          const readiness = firstLessonReadiness.markReady({
            videoId: state.currentVideo.id,
            segmentCount: state.currentSegments.length,
          });
          if (readiness) {
            postEvent('today_first_lesson_workspace_ready', readiness);
            firstLessonLifecycle.ready(readiness);
          }
        }
      } catch (e) {
        console.warn('[DEBUG] loadVideoDetails error:', e);
        if (!isExpectedVideo()) return;
        // Do not clobber captions that may already be on screen / in memory.
        if (!Array.isArray(state.currentSegments) || !state.currentSegments.length) {
          clearTranscriptCues();
          state.isLoadingTranscript = false;
          renderTranscript();
        }
        syncModeButtons(); // 更新双语按钮状态
      }
    }
    // Auto-import vocabulary from video (runs in background)
    async function autoImportVocabulary(videoId) {
      if (!/^\d+$/.test(String(videoId || ''))) return;
      // Check if already processed
      if (processedVideos.has(Number(videoId))) {
        debugLog(`Video ${videoId} already processed, skipping auto-import`);
        return;
      }

      debugLog(`Auto-importing vocabulary from video ${videoId}...`);
      try {
        // Skip for guests (no token) to avoid noisy 401s
        const tk = getToken() || '';
        if (!tk || tk === 'null' || tk === 'undefined') { debugLog('Guest session: skip auto-import'); return; }
        const res = await fetch(`${API_BASE}/video-resources/${videoId}/import-words`, { method: 'POST', headers: headers() });
        const data = await res.json();

        if (!res.ok) {
          console.warn(`Auto-import failed for video ${videoId}:`, data?.message);
          return;
        }

        // Mark as processed
        markVideoProcessed(videoId);
        processedVideos.add(Number(videoId));

        // Silently refresh vocabulary stats
        await Promise.all([loadVocab(), loadVocabStats()]);

        // Show subtle notification only if new words were imported
        if (data?.imported > 0) {
          showToast(`自动导入了 ${data.imported} 个新词汇 📚`, 'success');
          debugLog(`Auto-imported ${data.imported} words from video ${videoId}`);
        } else {
          debugLog(`No new words to import from video ${videoId}`);
        }
      } catch (err) {
        console.warn(`Auto-import error for video ${videoId}:`, err);
      }
    }

    function renderVideoIntro(v) {
      const thumb = document.getElementById('intro-thumb');
      const titleEl = document.getElementById('intro-title');
      const metaEl = document.getElementById('intro-meta');
      const aboutEl = document.getElementById('intro-about');
      if (!titleEl) return;
      if (!v) {
        if (thumb) {
          thumb.hidden = true;
          thumb.removeAttribute('src');
        }
        titleEl.textContent = '还没有选择视频';
        if (metaEl) metaEl.textContent = '';
        if (aboutEl) aboutEl.textContent = '打开顶部「视频库」，\n选中一个视频后，\n这里会显示封面、\n标题和简介。';
        return;
      }
      const name = v.title || v.original_filename || `视频 ${v.id}`;
      titleEl.textContent = name;
      const channel = v.collection_name || v.collection || v.series || v.channel || 'Linglish';
      const metaText = [channel, feedMeta(v)].filter(Boolean).join(' · ');
      if (metaEl) metaEl.textContent = metaText;
      const desc = String(v.description || v.episode_notes || v.summary || '').trim();
      if (aboutEl) aboutEl.textContent = desc || '这段视频还没有简介。播放时看右侧字幕，点一句就能跳到对应位置。';
      if (thumb) {
        const src = resolveThumbnail(v);
        if (src) {
          thumb.hidden = false;
          thumb.alt = name;
          thumb.src = src;
        } else {
          thumb.hidden = true;
        }
      }
    }

    document.getElementById('intro-back')?.addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else window.location.href = './index-desktop.html';
    });

    let coachPickReady = false;

    function coachReturnActive() {
      return coachPickReady && new URLSearchParams(location.search).get('returnTo') === 'coach';
    }

    function coachReturnMode() {
      return new URLSearchParams(location.search).get('mode') === 'dialogue' ? 'dialogue' : 'shadowing';
    }

    function leaveForCoach(videoId) {
      if (!coachReturnActive() || !/^\d+$/.test(String(videoId || ''))) return false;
      location.href = `./practice-session-desktop.html?videoId=${encodeURIComponent(videoId)}&mode=${coachReturnMode()}`;
      return true;
    }

    async function selectVideo(v) {
      rememberStudyVideo(v);
      if (leaveForCoach(v && v.id)) return;
      if (v && /^\d+$/.test(String(v.id))) {
        window.LinglishStudyVideoId = String(v.id);
        window.LinglishStudyMedia = null;
      } else if (v && v.id != null) {
        window.LinglishStudyVideoId = '';
        window.LinglishStudyMedia = {
          id: String(v.id),
          title: v.title || v.original_filename || '',
          youtube_video_id: v.youtube_video_id || '',
          audioUrl: v.audioUrl || '',
          transcriptUrl: v.transcriptUrl || '',
          external_podcast: Boolean(v.external_podcast),
          external_youtube: Boolean(v.external_youtube || v.youtube_video_id),
          thumbnail_path: v.thumbnail_path || '',
          collection_name: v.collection_name || '',
        };
      } else {
        window.LinglishStudyVideoId = '';
        window.LinglishStudyMedia = null;
      }
      try {
        window.LinglishVideoReaderState = window.LinglishVideoReaderState || {};
        window.LinglishVideoReaderState.selectedVideoId = v && v.id != null ? v.id : null;
        window.LinglishVideoReaderState.currentVideo = v || null;
      } catch (_) {}
      teardownFirstLessonRecording('video-selection');
      firstLessonGoal = null;
      firstLessonGoalCard.hide();
      const selectionToken = videoSelectionGuard.begin(v.id);
      currentDesktopSelectionToken = selectionToken;
      if (pendingSeek && String(pendingSeek.videoId) !== String(v.id)) pendingSeek = null;
      const isCurrentSelection = () => {
        return videoSelectionGuard.isCurrent(selectionToken, v.id) &&
          state.currentVideo && String(state.currentVideo.id) === String(v.id);
      };
      const isNewVideo = !state.currentVideo || state.currentVideo.id !== v.id;
      state.currentVideo = v; renderVideoList();
      try {
        if (isNewVideo) {
          state.lastRecordingBlob = null;
          if (state.lastRecordingUrl) {
            try { URL.revokeObjectURL(state.lastRecordingUrl); } catch (_) {}
          }
          state.lastRecordingUrl = null;
          state.lastRecordingSegmentIndex = null;
          window.__lastShadowBlob = null;
          window.__lastShadowUrl = '';
          window.__lastShadowIndex = null;
          if (typeof window.hydrateShadowRecording === 'function') {
            window.hydrateShadowRecording(v.id).catch(() => {});
          }
        }
      } catch (_) {}
      let lastLoadedUrl = '';

      // Always show friendly loading overlay immediately (covers YouTube API wait too)
      setPlayerOverlay('loading', {
        titleKey: 'video.overlay.loading_title',
        descKey: 'video.overlay.loading_desc',
        tips: [
          tOverlay('video.overlay.tip_switch', '加载期间仍可从左侧切换其它视频。'),
          tOverlay('video.overlay.tip_subtitle', '字幕与视频并行加载；右侧会先显示「字幕加载中…」。'),
        ]
      });

      // Start transcript ASAP in parallel with player/proxy init (do not await).
      beginTranscriptLoad(v, selectionToken);

      // 自动滚动到播放器位置，让视频完整显示（标题可以被遮住）
      const playerBox = document.querySelector('.player');
      const contentEl = document.getElementById('view-video');
      if (playerBox && contentEl) {
        // 计算播放器相对于content容器的偏移
        const playerRect = playerBox.getBoundingClientRect();
        const contentRect = contentEl.getBoundingClientRect();
        const scrollOffset = contentEl.scrollTop + (playerRect.top - contentRect.top) - 5;
        contentEl.scrollTo({ top: scrollOffset, behavior: 'smooth' });
      }

      // 增加视频浏览量（仅在选择新视频时）
      if (playerEl) playerEl.poster = '';
      if (isNewVideo && v.id && /^\d+$/.test(String(v.id))) {
        fetch(`${API_BASE}/video-resources/${v.id}/increment-view`, {
          method: 'POST',
          headers: headers()
        }).catch(err => {
          console.log('[Video] Failed to increment view count:', err);
          // 静默失败，不影响用户体验
        });
      }

      // 性能优化：切换视频时重置缓存
      _lastActiveIdx = -1;
      _lastActiveElement = null;
      // Only save valid IDs (within PostgreSQL INTEGER range)
      try {
        const numId = Number(v.id);
        if (numId > 0 && numId <= 2147483647) {
          localStorage.setItem('last_video_id', String(v.id));
        }
      } catch (_) { }
      const title = v.title || v.original_filename || `视频 ${v.id}`;
      currentTitleEl.textContent = title;
      renderVideoIntro(v);
      updateVideoMeta(v);
      updateVideoProgress(0, v.duration_sec || 0);
      progressSaveState.lastAt = 0;
      progressSaveState.lastPercent = 0;
      setExtractButtonState(false);

      stopWatchTimer(false);

      // Check if this is a YouTube video
      const isYouTube = !!v.youtube_video_id;

      if (isYouTube) {
        // YouTube video - determine playback strategy
        try {
          debugLog(`Loading YouTube video: ${v.youtube_video_id}`);

          // Check if proxy is needed (mainland China user)
          let needsProxy = false;
          try {
            const proxyCheck = await fetch('/youtube-proxy/check');
            const proxyData = await proxyCheck.json();
            needsProxy = proxyData.needsProxy || false;
            state.isMainlandUser = needsProxy; // 保存到 state 供发音功能使用
            debugLog(`Proxy check: ${needsProxy ? 'NEEDS PROXY (mainland China)' : 'Direct access'}`);
          } catch (e) {
            debugLog('Failed to check proxy need, assuming direct access:', e);
            needsProxy = false;
          }
          if (!isCurrentSelection()) return;

          // Strategy: Mainland users use local video if available, otherwise use YouTube iframe / proxy
          const hasLocalVideo = v.local_video_path && v.local_video_status === 'completed';

          if (needsProxy && hasLocalVideo) {
            // Mainland user with local video available - use HTML5 player
            debugLog(`Using local video for mainland user: ${v.local_video_path}`);

            // Hide YouTube player, show HTML5 player
            youtubePlayerEl.style.display = 'none';
            playerEl.style.display = 'block';
            currentPlayerType = 'local';
            activeLocalSelectionToken = selectionToken;

            // Clean up YouTube player if exists
            if (youtubePlayer) {
              try {
                youtubePlayer.destroy();
              } catch (e) {
                debugLog('Error destroying YouTube player:', e);
              }
              youtubePlayer = null;
            }

            // Load local video
            const localUrl = v.local_video_path.startsWith('http')
              ? v.local_video_path
              : `${API_BASE}${v.local_video_path.startsWith('/') ? '' : '/'}${v.local_video_path}`;

            const playable = await setProtectedMediaSource(playerEl, localUrl, isCurrentSelection);
            if (!playable || !isCurrentSelection()) return;
            playerEl.load();
            applyPendingSeekToLocal(selectionToken);
            debugLog('Local protected video loaded');
            // Overlay will hide on canplay/playing; keep during loadstart.

            openSourceBtn.disabled = false;
            openSourceBtn.onclick = () => window.open(`https://www.youtube.com/watch?v=${v.youtube_video_id}`, '_blank');
            importWordsBtn.disabled = false;
            setExtractButtonState(true);

            // Auto-import vocabulary in background (non-blocking)
            autoImportVocabulary(v.id).catch(err => debugLog('Auto-import failed:', err));

          } else if (needsProxy && !hasLocalVideo) {
            // Mainland user but local video not available yet
            debugLog(`Local video status: ${v.local_video_status}`);

            if (v.local_video_status === 'downloading') {
              showToast('视频正在下载中，请稍候刷新页面...', 'info');
            } else if (v.local_video_status === 'failed') {
              showToast('视频下载失败，请联系管理员', 'warn');
            } else if (v.local_video_status === 'pending') {
              showToast('视频下载队列中，请稍候刷新页面...', 'info');
            } else {
              showToast('本地视频尚未下载，请稍候刷新页面...', 'info');
            }

            // Still try to load with YouTube player (might fail but worth trying)
            playerEl.style.display = 'none';
            youtubePlayerEl.style.display = 'block';
            currentPlayerType = 'youtube';

            if (youtubePlayer) {
              try {
                youtubePlayer.destroy();
              } catch (e) {
                debugLog('Error destroying previous YouTube player:', e);
              }
            }

            youtubePlayer = new YouTubePlayer('youtube-player');
            await youtubePlayer.init(v.youtube_video_id);
            if (!isCurrentSelection()) return;
            applyPendingSeekToYouTube();
            // Player is ready; underlying thumbnail/controls should appear now.
            setPlayerOverlay('ready');

            youtubePlayer.on('statechange', (event) => {
              if (!isCurrentSelection()) return;
              const suppressing = youtubePlayer && typeof youtubePlayer.isOverlaySuppressionActive === 'function' && youtubePlayer.isOverlaySuppressionActive();
              if (suppressing) return;
              if (event.data === YT.PlayerState.PLAYING) {
                if (firstLessonPlaybackLocked) {
                  try { youtubePlayer.pause(); } catch (_) { }
                  return;
                }
                noteLearningVideoStarted();
                setPlayerOverlay('ready');
                startWatchTimer();
                syncActive();
                isVideoPlaying = true;
              } else if (event.data === YT.PlayerState.BUFFERING) {
                // User requested to remove the "black screen explanation" on buffer/pause
                setPlayerOverlay('ready');
              } else if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
                setPlayerOverlay('ready');
                stopWatchTimer(true);
                isVideoPlaying = false;
                if (event.data === YT.PlayerState.ENDED) highlightNextVideoCard();
              }
              updateShellCollapse();
            });

            youtubePlayer.on('timeupdate', (currentTime) => {
              if (!isCurrentSelection()) return;
              if (!watchTimer && currentTime > 0.5) startWatchTimer();
              syncActive();
            });

            openSourceBtn.disabled = false;
            openSourceBtn.onclick = () => window.open(`https://www.youtube.com/watch?v=${v.youtube_video_id}`, '_blank');
            importWordsBtn.disabled = false;
            setExtractButtonState(true);

            // Auto-import vocabulary in background (non-blocking)
            autoImportVocabulary(v.id).catch(err => debugLog('Auto-import failed:', err));

          } else {
            // Non-mainland user - use YouTube iframe player directly
            debugLog('Using YouTube iframe player for non-mainland user');

            // Hide HTML5 player, show YouTube player
            playerEl.style.display = 'none';
            youtubePlayerEl.style.display = 'block';
            currentPlayerType = 'youtube';

            // Clean up previous YouTube player if exists
            if (youtubePlayer) {
              try {
                youtubePlayer.destroy();
              } catch (e) {
                debugLog('Error destroying previous YouTube player:', e);
              }
            }

            // Create new YouTube player
            youtubePlayer = new YouTubePlayer('youtube-player');
            await youtubePlayer.init(v.youtube_video_id);
            if (!isCurrentSelection()) return;
            applyPendingSeekToYouTube();
            // Player is ready; underlying thumbnail/controls should appear now.
            setPlayerOverlay('ready');

            // Set up event handlers for YouTube player
            youtubePlayer.on('statechange', (event) => {
              if (!isCurrentSelection()) return;
              const suppressing = youtubePlayer && typeof youtubePlayer.isOverlaySuppressionActive === 'function' && youtubePlayer.isOverlaySuppressionActive();
              if (suppressing) return;
              if (event.data === YT.PlayerState.PLAYING) {
                if (firstLessonPlaybackLocked) {
                  try { youtubePlayer.pause(); } catch (_) { }
                  return;
                }
                noteLearningVideoStarted();
                setPlayerOverlay('ready');
                startWatchTimer();
                syncActive(); // Sync subtitle on play
                isVideoPlaying = true;
              } else if (event.data === YT.PlayerState.BUFFERING) {
                // User requested to remove the "black screen explanation" on buffer/pause
                setPlayerOverlay('ready');
              } else if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
                setPlayerOverlay('ready');
                stopWatchTimer(true);
                isVideoPlaying = false;
                if (event.data === YT.PlayerState.ENDED) highlightNextVideoCard();
              }
              updateShellCollapse();
            });

            youtubePlayer.on('timeupdate', (currentTime) => {
              if (!isCurrentSelection()) return;
              // Trigger syncActive for subtitle synchronization
              if (!watchTimer && currentTime > 0.5) startWatchTimer();
              syncActive(); // Sync subtitle on time update
            });

            openSourceBtn.disabled = false;
            openSourceBtn.onclick = () => window.open(`https://www.youtube.com/watch?v=${v.youtube_video_id}`, '_blank');
            importWordsBtn.disabled = false;
            setExtractButtonState(true);

            // Auto-import vocabulary in background (non-blocking)
            autoImportVocabulary(v.id).catch(err => debugLog('Auto-import failed:', err));
          }

        } catch (error) {
          if (!isCurrentSelection()) return;
          if (youtubePlayer) {
            try { youtubePlayer.destroy(); } catch (_) { }
            youtubePlayer = null;
          }
          console.error('Failed to load YouTube video:', error);
          showToast('YouTube视频加载失败', 'warn');
          playerEl.style.display = 'block';
          youtubePlayerEl.style.display = 'none';
          currentPlayerType = null;
          setPlayerOverlay('error', {
            titleKey: 'video.overlay.error_title',
            desc: error?.message ? String(error.message) : tOverlay('video.overlay.error_desc', '视频加载失败，请稍后重试。'),
            tips: [tOverlay('video.overlay.tip_retry', '可以尝试重试加载，或切换到其它视频。')]
          });
        }
      } else {
        // Local video - use HTML5 player
        const src = v.video_path || '';

        // Hide YouTube player, show HTML5 player
        youtubePlayerEl.style.display = 'none';
        playerEl.style.display = 'block';
        currentPlayerType = 'local';
        activeLocalSelectionToken = selectionToken;

        // Clean up YouTube player if exists
        if (youtubePlayer) {
          try {
            youtubePlayer.destroy();
          } catch (e) {
            debugLog('Error destroying YouTube player:', e);
          }
          youtubePlayer = null;
        }

        if (src) {
          const url = src.startsWith('http') ? src : `${API_BASE}${src.startsWith('/') ? '' : '/'}${src}`;
          try {
            const playable = await setProtectedMediaSource(playerEl, url, isCurrentSelection);
            if (!playable || !isCurrentSelection()) return;
            try { lastLoadedUrl = new URL(playable, location.href).href; } catch (_) { lastLoadedUrl = playable; }
          } catch (_) {
            if (!isCurrentSelection()) return;
            setPlayerOverlay('error', {
              titleKey: 'video.overlay.error_title',
              desc: '媒体授权失败，请重试。',
              tips: [tOverlay('video.overlay.tip_retry', '可以尝试重试加载，或切换到其它视频。')]
            });
            return;
          }

          // graceful 404 handling
          playerEl.onerror = () => {
            if (!isCurrentSelection() || !isActiveLocalSelection()) return;
            if (playerEl.src !== lastLoadedUrl) return; // ignore stale
            showToast('视频文件不存在或已删除 (404)', 'warn');
            debugLog('Local video load failed', { code: playerEl.error?.code || 'MEDIA_LOAD_ERROR' });
            playerEl.pause();
            playerEl.removeAttribute('src');
            openSourceBtn.disabled = true;
            importWordsBtn.disabled = true;
            setExtractButtonState(false);
          };

          playerEl.load();
          applyPendingSeekToLocal(selectionToken);
          openSourceBtn.disabled = false;
          openSourceBtn.onclick = () => window.open(lastLoadedUrl, '_blank');
          importWordsBtn.disabled = false;
          setExtractButtonState(true);

          // Auto-import vocabulary in background (non-blocking)
          autoImportVocabulary(v.id).catch(err => debugLog('Auto-import failed:', err));
        } else {
          playerEl.removeAttribute('src');
          openSourceBtn.disabled = true;
          importWordsBtn.disabled = true;
          setExtractButtonState(false);
          clearTranscriptCues();
          state.isLoadingTranscript = false;
          renderTranscript();
          setPlayerOverlay('idle', {
            titleKey: 'video.overlay.empty_title',
            descKey: 'video.overlay.empty_desc',
            tips: [
              tOverlay('video.overlay.tip_pick', '打开顶部「视频库」，选一个视频开始学习。'),
              getUploadTip(),
            ]
          });
        }
      }
      updateNextVideoCard();
    }
    // Manual import button - allows re-importing even if already processed
    importWordsBtn.addEventListener('click', async () => {
      const v = state.currentVideo; if (!v) return;
      // Require auth for manual import
      const tk = getToken() || '';
      if (!tk || tk === 'null' || tk === 'undefined') { showToast('请先登录后再提取词汇', 'warn'); return; }
      const importWordsLabel = importWordsBtn.querySelector('[data-i18n="video.extract_words"]');
      const oldLabel = importWordsLabel ? importWordsLabel.textContent : importWordsBtn.textContent;
      importWordsBtn.disabled = true;
      if (importWordsLabel) importWordsLabel.textContent = '提取中…';
      try {
        const res = await fetch(`${API_BASE}/video-resources/${v.id}/import-words`, { method: 'POST', headers: headers() });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || '提取失败');

        // Mark as processed
        markVideoProcessed(v.id);
        processedVideos.add(Number(v.id));

        // Show detailed success message
        const message = data?.message || '已从视频提取词汇';
        const details = data?.imported > 0
          ? `成功导入 ${data.imported} 个新词汇${data.skipped > 0 ? `，跳过 ${data.skipped} 个已知词汇` : ''}`
          : '没有发现新词汇';
        showToast(`${message}\n${details}`, 'success');

        // Reload vocabulary and switch to vocabulary tab
        await Promise.all([loadVocab(), loadVocabStats()]);
        location.hash = '#vocabulary'; setHashView('#vocabulary');
      } catch (err) { showToast(err.message || '提取失败', 'warn'); }
      finally {
        importWordsBtn.disabled = false;
        setExtractButtonState(true);
        if (importWordsLabel) importWordsLabel.textContent = oldLabel;
      }
    });
    refreshVideosBtn.addEventListener('click', () => loadVideos().catch(e => showToast(e.message || '加载失败', 'warn')));

    // ===== Video Actions (Rename/Delete) =====
    async function handleVideoRename(videoId) {
      const t = (key) => typeof i18n !== 'undefined' ? i18n.t(key) : key;
      if (!Number.isFinite(videoId) || videoId <= 0) {
        showToast(t('video.invalid_id') || '无效的视频ID');
        return;
      }

      const video = state.videos.find(v => v.id === videoId);
      if (!video) {
        showToast('未找到视频');
        return;
      }

      const currentTitle = video.title || video.original_filename || '';
      const nextTitle = window.prompt(t('video.rename_prompt') || '请输入新的视频标题:', currentTitle);

      if (nextTitle === null) {
        return;
      }

      const trimmedTitle = nextTitle.trim();
      if (!trimmedTitle.length) {
        showToast(t('video.title_empty') || '标题不能为空');
        return;
      }

      if (trimmedTitle === currentTitle) {
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/video-resources/${videoId}`, {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({ title: trimmedTitle })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || '重命名失败');

        // Update local state
        video.title = trimmedTitle;
        if (state.currentVideo && state.currentVideo.id === videoId) {
          state.currentVideo.title = trimmedTitle;
          currentTitleEl.textContent = trimmedTitle;
        }

        renderVideoList();
        showToast(t('video.rename_success') || '重命名成功', 'success');
      } catch (err) {
        console.error('Failed to rename video:', err);
        showToast(err.message || t('video.rename_error') || '重命名失败', 'warn');
      }
    }

    async function submitVideoReviewRequest(videoId, requestType) {
      if (!getToken()) {
        showToast('请先登录后再提交审核', 'warn');
        return null;
      }
      const res = await fetch(`${API_BASE}/api/video-share-requests`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          video_id: videoId,
          request_type: requestType
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || '审核请求提交失败');
      return data;
    }

    async function handleVideoShare(videoId) {
      const video = state.videos.find(v => String(v.id) === String(videoId));
      if (!video) return;
      try {
        if (state.user && state.user.is_admin) {
          const res = await fetch(`${API_BASE}/video-resources/${videoId}`, {
            method: 'PATCH',
            headers: headers(),
            body: JSON.stringify({ is_public: true })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.message || '公开失败');
          if (data.video) Object.assign(video, data.video);
          renderVideoList();
          showToast('已设为公开视频', 'success');
          return;
        }
        const data = await submitVideoReviewRequest(videoId, 'public');
        if (!data) return;
        if (data.already_public) {
          video.is_public = true;
          renderVideoList();
          showToast('这个视频已经公开', 'success');
          return;
        }
        showToast(data?.request?.already_pending ? '公开申请已在审核中' : '公开申请已提交', 'success');
      } catch (err) {
        showToast(err.message || '公开申请提交失败', 'warn');
      }
    }

    async function handleVideoFeature(videoId) {
      const video = state.videos.find(v => String(v.id) === String(videoId));
      if (!video) return;
      try {
        if (state.user && state.user.is_admin) {
          const res = await fetch(`${API_BASE}/video-resources/${videoId}`, {
            method: 'PATCH',
            headers: headers(),
            body: JSON.stringify({ is_featured: true })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.message || '设为精选失败');
          if (data.video) Object.assign(video, data.video);
          renderVideoList();
          showToast('已设为精选公开视频', 'success');
          return;
        }
        const data = await submitVideoReviewRequest(videoId, 'featured');
        if (!data) return;
        if (data.already_featured) {
          video.is_featured = true;
          video.is_public = true;
          renderVideoList();
          showToast('这个视频已经是精选', 'success');
          return;
        }
        showToast(data?.request?.already_pending ? '精选申请已在审核中' : '精选申请已提交', 'success');
      } catch (err) {
        showToast(err.message || '精选申请提交失败', 'warn');
      }
    }

    async function handleVideoDelete(videoId) {
      const t = (key) => typeof i18n !== 'undefined' ? i18n.t(key) : key;
      if (!Number.isFinite(videoId) || videoId <= 0) {
        showToast(t('video.invalid_id') || '无效的视频ID');
        return;
      }

      const confirmed = window.confirm(t('video.delete_confirm') || '确定要删除这个视频吗？');
      if (!confirmed) {
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/video-resources/${videoId}`, {
          method: 'DELETE',
          headers: headers()
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.message || '删除失败');
        }

        // Remove from local state
        state.videos = state.videos.filter(v => v.id !== videoId);
        state.filteredVideos = state.filteredVideos.filter(v => v.id !== videoId);

        // Clear current video if it was deleted
        if (state.currentVideo && state.currentVideo.id === videoId) {
          videoSelectionGuard.invalidate();
          state.currentVideo = null;
          playerEl.removeAttribute('src');
          currentTitleEl.textContent = t('video.select') || '请选择左侧视频';
          updateVideoMeta(null);
          openSourceBtn.disabled = true;
          importWordsBtn.disabled = true;
          setExtractButtonState(false);
          clearTranscriptCues();
          renderTranscript();
          updateNextVideoCard();
        }

        renderVideoList();
        showToast(t('video.delete_success') || '删除成功', 'success');
      } catch (err) {
        console.error('Failed to delete video:', err);
        showToast(err.message || t('video.delete_error') || '删除失败', 'warn');
      }
    }
    // Video element analytics listeners
    try {
      playerEl.addEventListener('play', () => {
        startWatchTimer();
        if (state.currentVideo) {
          firstLessonLifecycle.playback({ video_resource_id: state.currentVideo.id });
        }
      });
      playerEl.addEventListener('pause', () => stopWatchTimer(true));
      playerEl.addEventListener('ended', () => { stopWatchTimer(true); highlightNextVideoCard(); });

      // 视频开始播放时收起侧边栏，之后保持收起状态（暂停时不自动展开）
      // 用户需要手动点击按钮才能展开侧边栏
      const shellEl = document.querySelector('.shell');
      const updateSidebarToggleA11y = () => {
        if (!toggleSidebarBtn || !shellEl) return;
        const expanded = !document.body.classList.contains('focus-mode')
          && !shellEl.classList.contains('sidebar-collapsed');
        toggleSidebarBtn.setAttribute('aria-expanded', String(expanded));
        toggleSidebarBtn.title = expanded ? '收起视频列表' : '展开视频列表';
      };

      const setFocusMode = (enabled, options = {}) => {
        if (!enabled && firstLessonSession.isActive()) {
          firstLessonSession.deactivate('focus-exit');
        }
        document.body.classList.toggle('focus-mode', !!enabled);
        if (focusToggleBtn) {
          focusToggleBtn.classList.toggle('is-active', !!enabled);
          focusToggleBtn.setAttribute('aria-pressed', String(!!enabled));
          const label = focusToggleBtn.querySelector('.focus-toggle__label');
          if (label) label.textContent = enabled ? '专注中' : '专注';
        }
        updateSidebarToggleA11y();
        if (options.persist !== false) {
          try { localStorage.setItem('linglish_focus_mode', enabled ? 'true' : 'false'); } catch (_) { }
        }
      };

      if (shellEl) {
        playerEl.addEventListener('play', () => {
          shellEl.classList.add('sidebar-collapsed');
          updateSidebarToggleA11y();
        });
        // 暂停时不自动展开，保持收起状态
      }

      // Manual toggle sidebar button
      if (toggleSidebarBtn && shellEl) {
        toggleSidebarBtn.addEventListener('click', () => {
          const current = {
            focusMode: document.body.classList.contains('focus-mode'),
            sidebarCollapsed: shellEl.classList.contains('sidebar-collapsed'),
          };
          const next = window.LinglishReaderLayoutState
            ? window.LinglishReaderLayoutState.toggleVideoLibrary(current)
            : {
              focusMode: false,
              sidebarCollapsed: current.focusMode ? false : !current.sidebarCollapsed,
            };
          setFocusMode(next.focusMode);
          shellEl.classList.toggle('sidebar-collapsed', next.sidebarCollapsed);
          updateSidebarToggleA11y();
        });
      }

      const requestPageFullscreen = () => {
        const root = document.documentElement;
        const request = root.requestFullscreen || root.webkitRequestFullscreen;
        if (!request || document.fullscreenElement || document.webkitFullscreenElement) return;
        Promise.resolve(request.call(root)).catch(() => {});
      };
      const exitPageFullscreen = () => {
        if (!(document.fullscreenElement || document.webkitFullscreenElement)) return;
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) Promise.resolve(exit.call(document)).catch(() => {});
      };

      if (focusToggleBtn) {
        focusToggleBtn.addEventListener('click', () => {
          const enabled = !document.body.classList.contains('focus-mode');
          setFocusMode(enabled);
          if (enabled) requestPageFullscreen();
          else exitPageFullscreen();
        });
      }

      document.getElementById('focus-video-entry')?.addEventListener('click', (event) => {
        event.preventDefault();
        vbState.libraryView = 'videos';
        vbState.channelKey = '';
        openVideoBrowser();
      });

      const keepFocusIfFullscreenEnds = () => {
        // 触控屏幕、Esc 或浏览器自己退出全屏时，页面仍停在专注。
        // 只有再点「专注中」才会回到普通页面。
      };
      document.addEventListener('fullscreenchange', keepFocusIfFullscreenEnds);
      document.addEventListener('webkitfullscreenchange', keepFocusIfFullscreenEnds);

      try {
        const savedPreference = localStorage.getItem('linglish_focus_mode');
        const firstLessonFocus = firstLessonSession.isActive();
        const startFocused = window.LinglishReaderLayoutState.shouldStartFocused({
          savedPreference,
          hasVideo: Boolean(new URLSearchParams(window.location.search).get('videoId')),
          firstLesson: firstLessonFocus,
        });
        if (firstLessonFocus) {
          setFocusMode(true, { persist: false });
          if (shellEl) shellEl.classList.add('sidebar-collapsed');
        } else if (startFocused) setFocusMode(true, { persist: false });
      } catch (_) { }

      // Back to video list button
      const backToListBtn = document.getElementById('back-to-list');
      if (backToListBtn) {
        backToListBtn.addEventListener('click', (e) => {
          e.preventDefault();
          // Clear current video state
          videoSelectionGuard.invalidate();
          state.currentVideo = null;
          clearTranscriptCues();
          // Reset UI
          if (currentTitleEl) currentTitleEl.textContent = '请选择左侧视频';
          updateVideoMeta(null);
          if (transcriptListEl) transcriptListEl.innerHTML = '';
          renderActiveSubtitle(-1);
          if (openSourceBtn) openSourceBtn.disabled = true;
          if (importWordsBtn) importWordsBtn.disabled = true;
          setExtractButtonState(false);
          updateNextVideoCard();
          setPlayerOverlay('idle', {
            titleKey: 'video.overlay.empty_title',
            descKey: 'video.overlay.empty_desc',
            tips: [
              tOverlay('video.overlay.tip_pick', '打开顶部「视频库」，选一个视频开始学习。'),
              getUploadTip(),
            ]
          });
          // Show sidebar if collapsed
          if (shellEl) {
            setFocusMode(false);
            shellEl.classList.remove('sidebar-collapsed');
            updateSidebarToggleA11y();
          }
          // Clear video item selection
          document.querySelectorAll('.video-item.active').forEach(el => el.classList.remove('active'));
          // Show toast
          showToast('已返回视频列表', 'info');
        });
      }
      // Ensure timer starts even if 'play' doesn't fire (some browsers)
      playerEl.addEventListener('timeupdate', () => {
        try {
          if (!watchTimer && (playerEl.currentTime || 0) > 0.5) startWatchTimer();
        } catch (_) { }
      });
      document.addEventListener('visibilitychange', () => { if (document.hidden) stopWatchTimer(true); });
      window.addEventListener('beforeunload', () => { stopWatchTimer(true); vocabStudyStop(); });
    } catch (_) { }
    videoSearchEl.addEventListener('input', applyVideoFilter);

    // ===== Vocabulary =====
    // Load vocabulary map for word coloring (lightweight, 10000 words)
    async function loadVocabMap() {
      try {
        if (!getToken()) {
          console.log('[VocabMap] No auth token, skipping vocab map load');
          return;
        }

        console.log('[VocabMap] Starting to load vocabulary...');
        const res = await fetch(`${API_BASE}/vocab?limit=10000`, {
          headers: headers()
        });

        if (res.ok) {
          const data = await res.json();
          const items = data.items || [];
          state.vocabMap.clear();
          items.forEach(function (item) {
            if (item.lemma) {
              state.vocabMap.set(item.lemma.toLowerCase(), item.state || 'encountered');
            }
          });
          console.log('[VocabMap] ✓ Loaded', state.vocabMap.size, 'words for color highlighting');
          console.log('[VocabMap] Sample words:', Array.from(state.vocabMap.entries()).slice(0, 5));
        } else {
          console.warn('[VocabMap] Failed to load, status:', res.status);
        }
      } catch (err) {
        console.warn('[VocabMap] Failed to load:', err);
      }
    }

    async function loadVocab() {
      try {
        // 使用新的 vocabulary-v2 API
        const res = await fetch(`${API_BASE}/vocabulary/v2/my`, { headers: headers() });
        if (!res.ok) {
          if (res.status === 401) { // guest: treat as empty
            state.vocab = [];
            ownedLemmaSet = new Set();
            renderVocab();
            return;
          }
          const data = await res.json();
          throw new Error(data?.error || '加载词汇失败');
        }
        const data = await res.json();
        const raw = Array.isArray(data?.words) ? data.words : [];
        // Normalize server fields to UI state: known/learning/new
        // V2 uses: status (unknown/learning/known)
        state.vocab = raw.map(it => {
          const s = String(it.status || '').toLowerCase();
          let ui = 'new';
          if (s === 'known') ui = 'known';
          else if (s === 'learning') ui = 'learning';
          else ui = 'new'; // unknown
          return { ...it, lemma: it.word || it.lemma, state: ui };
        });
        // Apply local overrides so user's explicit choice persists across reloads
        try {
          if (knownOverrides.size) {
            state.vocab.forEach(item => {
              const n = normalizeLemma(item.lemma);
              if (knownOverrides.has(n)) item.state = 'known';
            });
          }
        } catch (_) { }
        debugLog('loadVocab items:', state.vocab.length);
        ownedLemmaSet = new Set((state.vocab || []).map(it => normalizeLemma(it.lemma)));
        renderVocab();
      } catch (e) {
        throw e;
      }
    }
    async function loadVocabStats() {
      try {
        const res = await fetch(`${API_BASE}/vocab/stats-summary`, { headers: headers() });
        if (!res.ok) { vocabStatsEl.textContent = ''; return; }
        const data = await res.json();
        state.vocabStats = data || null; debugLog('loadVocabStats:', data); renderVocabStats();
      } catch (_) { vocabStatsEl.textContent = ''; }
    }
    function renderVocabStats() {
      // 始终基于本地列表计算，避免后端延迟/统计口径导致显示为0
      const list = Array.isArray(state.vocab) ? state.vocab : [];
      const total = list.length;
      const learning = list.filter(i => String(i.state || '').toLowerCase() === 'learning').length;
      const known = list.filter(i => String(i.state || '').toLowerCase() === 'known').length;
      const newly = list.filter(i => !i.state || String(i.state).toLowerCase() === 'new').length;
      vocabStatsEl.innerHTML = '';
      const items = [
        { key: 'all', label: '总词数', value: total },
        { key: 'learning', label: '学习中', value: learning },
        { key: 'known', label: '已掌握', value: known },
        { key: 'new', label: '新词', value: newly },
      ];
      for (const it of items) {
        const el = document.createElement('div');
        el.className = 'stat' + (state.vocabFilter === (it.key === 'all' ? null : it.key) ? ' active' : '');
        el.textContent = `${it.label}: ${it.value}`;
        el.dataset.filter = it.key;
        el.addEventListener('click', (event) => {
          // A second click belongs to word lookup, not another playback command.
          if (event.detail > 1 || event.target.closest?.('button, a, input')) return;
          const next = it.key === 'all' ? null : it.key;
          state.vocabFilter = next;
          renderVocabStats();
          renderVocab();
        });
        vocabStatsEl.appendChild(el);
      }
    }
    function applyVocabFilter(items) {
      let res = Array.isArray(items) ? items.slice() : [];
      // state filter
      const f = state.vocabFilter;
      if (f) {
        if (f === 'new') res = res.filter(it => !it.state || it.state === 'new');
        else res = res.filter(it => it.state === f);
      }
      // text query
      const q = (vocabSearchEl.value || '').trim().toLowerCase();
      if (q) {
        res = res.filter(it => (it.lemma || '').toLowerCase().includes(q) || (it.translation || '').toLowerCase().includes(q));
      }
      return res;
    }

    const vocabSearchHistoryKey = `vocab_search_history_${getUserKey()}`;
    const HOT_WORDS = ['agenda', 'presentation', 'feedback', 'strategy', 'negotiate', 'deadline', 'collaborate', 'impact', 'prioritize', 'optimize'];

    function loadSearchHistory() {
      try {
        const raw = localStorage.getItem(vocabSearchHistoryKey);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch (_) { return []; }
    }

    function saveSearchHistory(list) {
      try { localStorage.setItem(vocabSearchHistoryKey, JSON.stringify(list)); } catch (_) { }
    }

    function addSearchHistory(term) {
      const text = String(term || '').trim();
      if (!text) return;
      const history = loadSearchHistory();
      const next = [text, ...history.filter(x => x !== text)].slice(0, 8);
      saveSearchHistory(next);
      renderSearchSuggestions();
    }

    function renderSearchSuggestions() {
      if (!vocabSuggestionsEl) return;
      const history = loadSearchHistory();
      if (vocabHistoryEl) vocabHistoryEl.innerHTML = '';
      if (vocabHotEl) vocabHotEl.innerHTML = '';

      const buildChip = (text) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'suggestion-chip';
        chip.textContent = text;
        chip.addEventListener('click', () => {
          if (vocabSearchEl) vocabSearchEl.value = text;
          renderVocab();
          addSearchHistory(text);
        });
        return chip;
      };

      if (vocabHistoryEl) {
        history.forEach(term => vocabHistoryEl.appendChild(buildChip(term)));
      }
      if (vocabHotEl) {
        HOT_WORDS.forEach(term => vocabHotEl.appendChild(buildChip(term)));
      }

      vocabSuggestionsEl.style.display = history.length || HOT_WORDS.length ? '' : 'none';
    }

    function renderVocab() {
      const items = applyVocabFilter(state.vocab);
      vocabListEl.innerHTML = '';
      if (!items.length) { vocabEmptyEl.style.display = ''; return; }
      vocabEmptyEl.style.display = 'none';
      const t = (key) => typeof i18n !== 'undefined' ? i18n.t(key) : key;
      const frag = document.createDocumentFragment();
      items.forEach((it) => {
        const row = document.createElement('div'); row.className = 'vocab-item';
        const stateLabel = it.state === 'known' ? t('vocab.known') : (it.state === 'learning' ? t('vocab.learning') : t('vocab.new'));
        const stateChip = `<span class=\"chip ${it.state === 'known' ? 'known' : 'learning'}\">${stateLabel}</span>`;
        row.innerHTML = `
            <div style=\"display:flex; align-items:center; gap:0.6rem;\">
              ${stateChip}
              <span class=\"vocab-word\">${esc(it.lemma)}</span>
              <span class=\"vocab-translation\">${esc(it.translation || '')}</span>
            </div>
            <div class=\"vocab-actions\">
              <button class=\"icon-btn\" data-act=\"learn\">${t('vocab.learning')}</button>
              <button class=\"icon-btn\" data-act=\"known\">${t('vocab.known')}</button>
              <button class=\"icon-btn\" data-act=\"edit\">${t('vocab.edit_translation')}</button>
              <button class=\"icon-btn danger\" data-act=\"del\">${t('common.delete')}</button>
            </div>`;
        row.querySelector('[data-act="learn"]').addEventListener('click', () => markState(it.lemma, 'learning'));
        row.querySelector('[data-act="known"]').addEventListener('click', () => markState(it.lemma, 'known'));
        row.querySelector('[data-act="edit"]').addEventListener('click', () => editTranslation(it.lemma, it.translation || ''));
        row.querySelector('[data-act="del"]').addEventListener('click', () => delVocab(it.lemma));
        frag.appendChild(row);
      });
      vocabListEl.appendChild(frag);
    }
    function commitVocabSearch() {
      const term = (vocabSearchEl.value || '').trim();
      if (term) addSearchHistory(term);
    }
    vocabSearchEl.addEventListener('input', renderVocab);
    vocabSearchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitVocabSearch();
    });
    vocabSearchEl.addEventListener('blur', commitVocabSearch);
    reloadVocabBtn.addEventListener('click', () => Promise.all([loadVocab(), loadVocabStats()]).catch(e => showToast(e.message || '加载失败', 'warn')));
    renderSearchSuggestions();

    // ===== Transcript =====
    function normalizeLemma(w) {
      try {
        return String(w || '').toLowerCase().replace(/^\W+|\W+$/g, '');
      } catch (_) { return String(w || '').toLowerCase(); }
    }

    // Helper function for escaping HTML (compatible with mobile version)
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Word coloring function (from mobile version)
    function wordHtml(text) {
      let coloredWords = 0;
      const result = text
        .split(/(\s+)/)
        .map(function (part) {
          if (part.match(/\s+/)) return part;

          // Clean word: remove all non-letter, non-hyphen, non-apostrophe characters
          const clean = part
            .replace(/['']/g, "'")  // Normalize quotes
            .replace(/[^a-z'-]/gi, '') // Remove non-letter characters (keep hyphens and apostrophes)
            .replace(/^['\-]+|['\-]+$/g, ''); // Remove leading/trailing hyphens and apostrophes

          // If empty or too short after cleaning, return original text (without wrapping)
          if (!clean || clean.length < 2 || !/[a-z]/i.test(clean)) {
            return escapeHtml(part);
          }

          // Check word's learning state and add corresponding CSS class
          const wordLower = clean.toLowerCase();
          const vocabState = state.vocabMap.get(wordLower);
          let stateClass = '';

          if (vocabState) {
            // Learned words
            if (vocabState === 'mastered') {
              stateClass = ' word-mastered';
            } else if (vocabState === 'learning' || vocabState === 'reviewing') {
              stateClass = ' word-learning';
            } else {
              stateClass = ' word-encountered';
            }
            coloredWords++;
          }

          return `<span class="transcript-word${stateClass}" data-word="${escapeHtml(clean)}">${escapeHtml(part)}</span>`;
        })
        .join('');

      if (coloredWords > 0 && !wordHtml._logged) {
        console.log('[WordColor] Applied colors to', coloredWords, 'words in this segment. VocabMap size:', state.vocabMap.size);
        wordHtml._logged = true;
      }

      return result;
    }

    function missedWordsForSegment(segmentKey) {
      if (!window.LinglishMissedWords) return new Set();
      const videoId = state.currentVideo && state.currentVideo.id;
      return new Set(window.LinglishMissedWords.wordsFor(localStorage, videoId, segmentKey));
    }

    function wrapWordsToHTML(text, missedSet) {
      const s = String(text || '');
      const parts = [];
      let i = 0;
      const len = s.length;
      const isWordChar = c => /[A-Za-z]/.test(c);
      while (i < len) {
        if (isWordChar(s[i])) {
          let j = i + 1;
          while (j < len && /[A-Za-z\-''·]/.test(s[j])) j++;
          const token = s.slice(i, j);
          const lemma = normalizeLemma(token);
          const owned = ownedLemmaSet.has(lemma);

          // Add vocabulary color classes based on learning state
          const vocabState = state.vocabMap.get(lemma);
          let stateClass = '';
          if (vocabState) {
            if (vocabState === 'mastered') {
              stateClass = ' word-mastered';
            } else if (vocabState === 'learning' || vocabState === 'reviewing') {
              stateClass = ' word-learning';
            } else {
              stateClass = ' word-encountered';
            }
          }

          const missingClass = missedSet && (missedSet.has(token.toLowerCase()) || missedSet.has(lemma)) ? ' word-missing' : '';
          parts.push(`<span class="word${owned ? ' owned' : ''}${stateClass}${missingClass}" data-lemma="${esc(lemma)}">${esc(token)}</span>`);
          i = j;
        } else {
          // emit single char, escaped
          const ch = s[i];
          parts.push(esc(ch));
          i += 1;
        }
      }
      return parts.join('');
    }
    function renderTranscript() {
      const segs = Array.isArray(state.currentSegments) ? state.currentSegments : [];
      transcriptListEl.innerHTML = '';
      if (!segs.length) {
        const notes = state.currentVideo && state.currentVideo.episode_notes;
        if (notes) {
          transcriptListEl.innerHTML = `<div class="seg"><div class="time">节目简介</div><div class="text">${esc(notes)}</div></div>`;
        } else if (state.isLoadingTranscript) {
          transcriptListEl.innerHTML = `<div class="empty">字幕加载中…</div>`;
        } else {
          const noSubText = typeof i18n !== 'undefined' ? i18n.t('video.no_subtitle') : '暂无字幕';
          transcriptListEl.innerHTML = `<div class="empty">${noSubText}</div>`;
        }
        renderLyricStage(-1);
        return;
      }
      const frag = document.createDocumentFragment();
      segs.forEach((s, i) => {
        const el = document.createElement('div');
        el.className = 'seg';
        // 支持多种字段名: start_sec/start/startTime
        const startTime = s.start_sec ?? s.start ?? s.startTime ?? 0;
        const endTime = s.end_sec ?? s.end ?? s.endTime ?? 0;
        const start = fmtSec(startTime);
        const end = fmtSec(endTime);
        const speaker = (s.speaker || '').trim();
        const translation = (s.translation || s.cn || s.zh || s.text_cn || '').trim();
        el.dataset.index = String(i);
        el.dataset.start = String(startTime);
        el.dataset.end = String(endTime);
        const textHTML = wrapWordsToHTML(s.text || '', missedWordsForSegment(i));
        const hasZh = translation && /[\u4e00-\u9fa5]/.test(translation);
        // Only paint Chinese when ready — do not reserve a "翻译中…" row for every cue
        // (that stacks hundreds of placeholders and makes the right rail look piled up).
        const showTransLine = state.showBilingual && hasZh;
        el.innerHTML = `
            <div class="time">${start} – ${end}</div>
            <div class="text">${speaker ? `<span class=\"speaker\">${esc(speaker)}:</span>` : ''}${textHTML}</div>
            ${showTransLine ? `<div class="translation">${esc(translation)}</div>` : ''}
          `;
        el.addEventListener('click', () => {
          if (!Number.isFinite(Number(startTime))) return;
          try {
            const seekTime = Math.max(0, Number(startTime) + 0.01);
            stopSpokenAudio();
            if (currentPlayerType === 'youtube' && youtubePlayer) {
              youtubePlayer.seekTo(seekTime);
              youtubePlayer.play();
            } else {
              playerEl.currentTime = seekTime;
              playerEl.play();
            }
          } catch (_) { }
          highlightActiveSegment(i, true);
        });
        frag.appendChild(el);
      });
      transcriptListEl.appendChild(frag);
      highlightActiveSegment(-1, false);
      if (state.showBilingual) {
        queueVisibleBilingualTranslations();
        ensureDesktopBilingualTranslations().catch(() => { });
      }
    }
    function currentSegmentIndexByTime(t) {
      const display = state.currentSegments || [];
      if (!display.length) return -1;
      const raw = state.rawSegments || [];
      const api = window.LinglishSentenceSegments;
      // Source-anchored clock: raw cue by time → display card via source_indices.
      if (api && typeof api.displayIndexForTime === 'function' && raw.length) {
        try {
          return api.displayIndexForTime(display, raw, t, 0.1);
        } catch (_) { /* fall through */ }
      }
      if (api && typeof api.findIndexByTime === 'function') {
        try {
          return api.findIndexByTime(display, t, 0.1);
        } catch (_) { /* fall through */ }
      }
      const tolerance = 0.1;
      const matchingSegments = [];
      for (let i = 0; i < display.length; i++) {
        const s = display[i];
        const startTime = Number(s.start_sec ?? s.start ?? s.startTime ?? 0);
        const endTime = Number(s.end_sec ?? s.end ?? s.endTime ?? Infinity);
        if (t >= (startTime - tolerance) && t < (endTime + tolerance)) {
          matchingSegments.push({
            index: i,
            distanceFromStart: Math.abs(t - startTime),
            distanceFromMid: Math.abs(t - (startTime + endTime) / 2)
          });
        }
      }
      if (matchingSegments.length > 0) {
        matchingSegments.sort((a, b) => {
          const startDiff = a.distanceFromStart - b.distanceFromStart;
          if (Math.abs(startDiff) > 0.5) return startDiff;
          return a.distanceFromMid - b.distanceFromMid;
        });
        return matchingSegments[0].index;
      }
      let idx = -1;
      let minDiff = Infinity;
      for (let i = 0; i < display.length; i++) {
        const startTime = Number(display[i].start_sec ?? display[i].start ?? display[i].startTime ?? 0);
        const diff = t - startTime;
        if (diff >= -tolerance && diff < minDiff && diff < 3.0) {
          minDiff = diff;
          idx = i;
        }
      }
      return idx;
    }
    let _lastActiveIdx = -1;
    let _lastActiveElement = null; // 性能优化：缓存上一个激活的元素
    let _lastAutoScrollAt = 0;
    function ensureVisible(el) {
      if (!el || !transcriptListEl) return;
      // Respect manual scrolling
      if (Date.now() < __userScrollLockUntil) return;
      const container = transcriptListEl;
      const elTop = el.offsetTop;
      const elBottom = elTop + el.offsetHeight;
      const viewTop = container.scrollTop;
      const viewBottom = viewTop + container.clientHeight;
      const marginTop = 40;
      const marginBottom = 60;
      let targetScroll = null;

      // Only scroll enough to reveal the item, don't re-center
      if (elTop < viewTop + marginTop) {
        targetScroll = elTop - marginTop;
      } else if (elBottom > viewBottom - marginBottom) {
        targetScroll = elBottom - container.clientHeight + marginBottom;
      }

      if (targetScroll !== null) {
        const now = Date.now();
        if (!window.__lastAutoScrollAt || (now - window.__lastAutoScrollAt) > 200) {
          const clamped = Math.max(0, Math.round(targetScroll));
          if (Math.abs(clamped - container.scrollTop) > 4) {
            window.__lastAutoScrollAt = now;
            __isAutoScrolling = true;
            container.scrollTo({ top: clamped, behavior: 'auto' });
            setTimeout(() => { __isAutoScrolling = false; }, 300);
          }
        }
      }
    }
    function highlightActiveSegment(idx, scroll, updateLesson = true) {
      // 性能优化：只在索引改变时才更新DOM
      if (idx === _lastActiveIdx) {
        if (updateLesson && firstLessonSession.isActive()) renderActiveSubtitle(idx);
        return;
      }

      // 性能优化：只移除上一个active元素，不遍历所有
      if (_lastActiveElement) {
        _lastActiveElement.classList.remove('active');
        _lastActiveElement = null;
      }

      if (idx < 0) {
        _lastActiveIdx = -1;
        renderActiveSubtitle(-1);
        return;
      }

      const el = transcriptListEl.querySelector(`.seg[data-index="${idx}"]`);
      if (!el) return;

      el.classList.add('active');
      _lastActiveElement = el;
      _lastActiveIdx = idx;
      renderActiveSubtitle(idx, updateLesson);

      if (scroll) {
        ensureVisible(el);
      }
    }

    function startSubtitleDemo() {
      const raw = [
        { start: 0, end: 2.2, text: 'Welcome back. Today we are' },
        { start: 2.2, end: 5.4, text: 'looking at how a clear paragraph helps you follow a story.' },
        { start: 5.6, end: 8.1, text: 'Mr. Smith arrived at 3.14 and sat by the window.' },
        { start: 8.3, end: 11.2, text: 'He opened his notebook and waited for the meeting to begin.' },
        { start: 14, end: 16.4, text: 'The client walked in a little early.' },
        { start: 16.5, end: 19.8, text: 'She smiled, put her bag down, and asked if everyone was ready.' },
        { start: 20, end: 23.5, text: 'They started with the first question instead of the long introduction.' },
        { start: 26.2, end: 29, text: 'Listen for the pause between ideas.' },
        { start: 29.1, end: 32.4, text: 'A short pause stays in the same paragraph.' },
        { start: 32.6, end: 36, text: 'A longer pause starts the next one, so each block is a complete thought.' },
        { start: 39, end: 42.2, text: 'When the line under the video changes, the card on the right changes with it.' },
        { start: 42.4, end: 46, text: 'You can read the whole paragraph, not a fragment cut in the middle.' },
        { start: 48.5, end: 51.4, text: 'Try clicking a paragraph.' },
        { start: 51.5, end: 55, text: 'The highlight follows that thought, and the words stay together until the idea is finished.' },
      ];
      applyTranscriptCues(raw);
      const sentences = state.currentSegments;
      renderTranscript();
      let index = 0;
      const show = () => {
        highlightActiveSegment(index, true);
        index = (index + 1) % Math.max(1, sentences.length);
      };
      show();
      if (window.__subtitleDemoTimer) clearInterval(window.__subtitleDemoTimer);
      window.__subtitleDemoTimer = window.setInterval(show, 3200);
    }

    if (new URLSearchParams(location.search).has('subtitle-demo')) {
      startSubtitleDemo();
    } else if (window.__subtitleDemoTimer) {
      clearInterval(window.__subtitleDemoTimer);
      window.__subtitleDemoTimer = null;
    }
    // Unified sync function that works with both local and YouTube players
    const syncActive = () => {
      let currentTime = 0;
      if (currentPlayerType === 'youtube' && youtubePlayer) {
        currentTime = youtubePlayer.getCurrentTime() || 0;
      } else {
        currentTime = playerEl.currentTime || 0;
      }
      updateVideoProgress(currentTime, getActiveDuration());
      if (!state.currentSegments || !state.currentSegments.length) return;
      const idx = currentSegmentIndexByTime(currentTime);
      highlightActiveSegment(idx, true, false);
    };

    // Add event listeners for local video player
    if (playerEl) {
      playerEl.addEventListener('timeupdate', syncActive);
      playerEl.addEventListener('seeked', syncActive);
      playerEl.addEventListener('loadedmetadata', syncActive);
      playerEl.addEventListener('play', syncActive);
    }

    if (scrollActiveBtn) {
      scrollActiveBtn.addEventListener('click', () => {
        let currentTime = 0;
        if (currentPlayerType === 'youtube' && youtubePlayer) {
          currentTime = youtubePlayer.getCurrentTime() || 0;
        } else {
          currentTime = playerEl.currentTime || 0;
        }
        const idx = currentSegmentIndexByTime(currentTime);
        highlightActiveSegment(idx, true);
      });
    }

    // Click to lookup word (mobile-like UX)
    const handleLookupEvent = async (e) => {
      const target = e.target;
      // Case 1: wrapped word span (.word / .transcript-word / .coach-word)
      const wordEl = target && target.closest
        ? target.closest('.word, .transcript-word, .coach-word')
        : null;
      if (wordEl) {
        const lemma = normalizeLemma(
          wordEl.dataset.lemma
          || wordEl.dataset.word
          || wordEl.getAttribute('data-word')
          || wordEl.textContent
          || ''
        );
        if (!lemma) return;
        // Check if video is playing before pausing (Case 1: marked words)
        try {
          if (currentPlayerType === 'youtube' && youtubePlayer) {
            const playerState = youtubePlayer.getPlayerState();
            wasPlayingBeforeLookup = (playerState === 1); // 1 = playing
            console.log('[查词-Case1] YouTube播放器状态:', playerState, '是否播放中:', wasPlayingBeforeLookup);
            youtubePlayer.pause();
          } else {
            wasPlayingBeforeLookup = !playerEl.paused;
            console.log('[查词-Case1] HTML5播放器 paused:', playerEl.paused, '是否播放中:', wasPlayingBeforeLookup);
            playerEl.pause();
          }
        } catch (err) {
          console.log('[查词-Case1] 检查播放状态出错:', err);
          wasPlayingBeforeLookup = false;
        }
        const segEl = wordEl.closest('.seg') || wordEl.closest('#active-subtitle') || wordEl.closest('.subtitle-text');
        const index = Number(segEl?.dataset?.index);
        const seg = Array.isArray(state.currentSegments) && Number.isFinite(index) ? state.currentSegments[index] : null;
        const startSec = segEl?.dataset?.start ? Number(segEl.dataset.start) : (seg?.start_sec ?? seg?.start ?? seg?.startTime ?? null);
        const endSec = segEl?.dataset?.end ? Number(segEl.dataset.end) : (seg?.end_sec ?? seg?.end ?? seg?.endTime ?? null);
        e.stopPropagation();
        const lookupCtx = { index, startSec, endSec, sentence: seg?.text || activeSubtitleEl?.textContent || '' };
        openDrawerLookup(lemma, lookupCtx);
        return;
      }

      // Case 2: clicked plain text; derive word under cursor
      const textEl = target.closest && target.closest('.text');
      if (!textEl) return;

      function getWordAtPoint(container, x, y) {
        try {
          let range, node, offset;
          if (document.caretRangeFromPoint) {
            range = document.caretRangeFromPoint(x, y);
            node = range?.startContainer; offset = range?.startOffset ?? 0;
          } else if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(x, y);
            node = pos?.offsetNode; offset = pos?.offset ?? 0;
            if (node) { range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset); }
          }
          if (!node) return null;
          if (node.nodeType !== Node.TEXT_NODE) {
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
            node = walker.nextNode(); offset = 0; if (!node) return null;
          }
          const str = node.textContent || '';
          const idx = Math.max(0, Math.min(offset, str.length - 1));
          const isW = (ch) => /[A-Za-z\-’']/.test(ch);
          let s = idx, e2 = idx;
          while (s > 0 && isW(str[s - 1])) s--;
          while (e2 < str.length && isW(str[e2])) e2++;
          const raw = str.slice(s, e2);
          const lemma = normalizeLemma(raw);
          if (!lemma || lemma.length < 2) return null;
          const r2 = document.createRange();
          r2.setStart(node, s); r2.setEnd(node, e2);
          const rect = r2.getBoundingClientRect();
          return { lemma, rect };
        } catch (_) { return null; }
      }

      const got = getWordAtPoint(textEl, e.clientX, e.clientY);
      if (!got) return;
      // Check if video is playing before pausing (Case 2: plain text)
      try {
        if (currentPlayerType === 'youtube' && youtubePlayer) {
          const playerState = youtubePlayer.getPlayerState();
          wasPlayingBeforeLookup = (playerState === 1); // 1 = playing
          console.log('[查词-Case2] YouTube播放器状态:', playerState, '是否播放中:', wasPlayingBeforeLookup);
          youtubePlayer.pause();
        } else {
          wasPlayingBeforeLookup = !playerEl.paused;
          console.log('[查词-Case2] HTML5播放器 paused:', playerEl.paused, '是否播放中:', wasPlayingBeforeLookup);
          playerEl.pause();
        }
      } catch (err) {
        console.log('[查词-Case2] 检查播放状态出错:', err);
        wasPlayingBeforeLookup = false;
      }
      const segEl = target.closest('.seg') || target.closest('#active-subtitle') || target.closest('.subtitle-text');
      const index = Number(segEl?.dataset?.index);
      const seg = Array.isArray(state.currentSegments) && Number.isFinite(index) ? state.currentSegments[index] : null;
      const startSec = segEl?.dataset?.start ? Number(segEl.dataset.start) : (seg?.start_sec ?? seg?.start ?? seg?.startTime ?? null);
      const endSec = segEl?.dataset?.end ? Number(segEl.dataset.end) : (seg?.end_sec ?? seg?.end ?? seg?.endTime ?? null);
      const lookupCtx = { index, startSec, endSec, sentence: seg?.text || activeSubtitleEl?.textContent || '' };
      openDrawerLookup(got.lemma, lookupCtx);
    };

    function bindSubtitleAssist(card) {
      const closeBtn = card.querySelector('[data-assist="close"]');
      const sayBtn = card.querySelector('[data-assist="say"]');
      if (closeBtn) closeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        card.hidden = true;
        activeSubtitleEl?.querySelectorAll('.word-lookup').forEach((el) => el.classList.remove('word-lookup'));
      });
      if (sayBtn) sayBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        card.hidden = true;
        const record = document.getElementById('first-lesson-record');
        if (record) record.click();
      });
    }

    async function showSubtitleAssist(word, ctx, wordEl) {
      const card = document.getElementById('subtitle-assist');
      const assist = window.LinglishSentenceAssist;
      if (!card || !assist) {
        openDrawerLookup(word, ctx);
        return;
      }
      if (dictDrawer && dictDrawer.classList.contains('show')) {
        dictDrawer.classList.remove('show');
        dictDrawer.setAttribute('aria-hidden', 'true');
        isLookupOpen = false;
      }
      const sentence = (ctx && ctx.sentence) || activeSubtitleEl?.textContent || '';
      card.dataset.word = word;
      card.dataset.segment = Number.isFinite(Number(ctx && ctx.index)) ? String(ctx.index) : (activeSubtitleEl?.dataset.index || '');
      card.hidden = false;
      card.innerHTML = assist.cardHTML({ word, gloss: '正在查这个词…', sentence });
      bindSubtitleAssist(card);
      activeSubtitleEl?.querySelectorAll('.word-lookup').forEach((el) => el.classList.remove('word-lookup'));
      if (wordEl) wordEl.classList.add('word-lookup');
      let entry = null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const res = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(word)}`, { headers: headers(), signal: controller.signal });
        if (res.ok) entry = (await res.json())?.entry || null;
      } catch (_) { }
      finally { clearTimeout(timer); }
      if (card.hidden || card.dataset.word !== word) return;
      card.innerHTML = assist.cardHTML({
        word,
        phonetic: assist.phoneticOf(entry),
        gloss: assist.shortGloss(entry),
        sentence,
      });
      bindSubtitleAssist(card);
      try { ensureLearning(word, ctx || {}, true); } catch (_) { }
    }
    // Shared hook for coaching-dock / voice-chat word taps → full 生词 drawer card.
    window.linglishShowSubtitleWordCard = function linglishShowSubtitleWordCard(word, ctx) {
      const lemma = normalizeLemma(word || '');
      if (!lemma) return;
      openDrawerLookup(lemma, ctx || {});
    };

    // Click / tap a word → word card. Click the line (not a word) → replay that cue.
    transcriptListEl?.addEventListener('click', (e) => {
      const tw = e.target.closest('.transcript-word, .word');
      if (!tw) return;
      e.preventDefault();
      e.stopPropagation();
      handleLookupEvent(e);
    }, true);
    transcriptListEl?.addEventListener('dblclick', handleLookupEvent);
    activeSubtitleEl?.addEventListener('click', handleLookupEvent, true);
    document.getElementById('lyric-current')?.addEventListener('click', handleLookupEvent, true);
    document.getElementById('lyric-stage')?.addEventListener('click', (e) => {
      if (e.target.closest('.word')) return;
      const line = e.target.closest('.lyric-line');
      const start = Number(line?.dataset?.start);
      if (!line || !Number.isFinite(start)) return;
      const seekTime = Math.max(0, start + 0.01);
      try {
        stopSpokenAudio();
        if (currentPlayerType === 'youtube' && youtubePlayer) {
          youtubePlayer.seekTo(seekTime);
          youtubePlayer.play();
        } else if (playerEl) {
          playerEl.currentTime = seekTime;
          playerEl.play();
        }
      } catch (_) { }
      const idx = Number(line.dataset.index);
      if (Number.isFinite(idx)) highlightActiveSegment(idx, true);
    });
    activeSubtitleEl?.addEventListener('dblclick', handleLookupEvent);
    activeSubtitleEl?.addEventListener('touchstart', (e) => handleLookupEvent(e.changedTouches ? { ...e, clientX: e.changedTouches[0].clientX, clientY: e.changedTouches[0].clientY, target: e.target } : e), { passive: true });

    // Dictionary popover logic
    const ipaCache = new Map();
    const audioCache = new Map();
    // One audible source: word, definition, sentence, or the learning video.
    let currentAudioPlayer = null;
    const dictVoiceSlot = (window.LinglishVoiceSlot
      ? window.LinglishVoiceSlot.createVoiceSlot()
      : { claim() { return 1; }, release() {}, isCurrent() { return true; } });
    function haltSpokenOutput() {
      if (currentAudioPlayer) {
        try {
          currentAudioPlayer.pause();
          currentAudioPlayer.currentTime = 0;
        } catch (_) { }
        currentAudioPlayer = null;
      }
      try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) { }
    }
    let learningVideoYieldUntil = 0;
    function stopSpokenAudio() {
      learningVideoYieldUntil = 0;
      dictVoiceSlot.release();
      haltSpokenOutput();
    }
    function pauseLearningVideoNow() {
      try {
        if (currentPlayerType === 'youtube' && youtubePlayer && typeof youtubePlayer.getPlayerState === 'function' && youtubePlayer.getPlayerState() === 1) {
          youtubePlayer.pause();
        } else if (playerEl && !playerEl.paused) {
          playerEl.pause();
        }
      } catch (_) { }
    }
    function pauseLearningVideo() {
      learningVideoYieldUntil = Date.now() + 250;
      pauseLearningVideoNow();
    }
    function noteLearningVideoStarted() {
      if (Date.now() < learningVideoYieldUntil) {
        pauseLearningVideoNow();
        return;
      }
      stopSpokenAudio();
    }

    // SpeechSynthesis voices load asynchronously on Android — cache them and
    // listen for voiceschanged so the fallback never runs with an empty list
    let cachedTtsVoices = [];
    function refreshTtsVoices() {
      try {
        const v = window.speechSynthesis?.getVoices() || [];
        if (v.length > 0) cachedTtsVoices = v;
      } catch (_) { }
    }
    refreshTtsVoices();
    try {
      window.speechSynthesis?.addEventListener?.('voiceschanged', refreshTtsVoices);
    } catch (_) { }
    function waitForTtsVoices(timeoutMs = 1000) {
      if (cachedTtsVoices.length > 0) return Promise.resolve(cachedTtsVoices);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(cachedTtsVoices), timeoutMs);
        const onChanged = () => {
          refreshTtsVoices();
          if (cachedTtsVoices.length > 0) {
            clearTimeout(timer);
            window.speechSynthesis?.removeEventListener?.('voiceschanged', onChanged);
            resolve(cachedTtsVoices);
          }
        };
        try {
          window.speechSynthesis?.addEventListener?.('voiceschanged', onChanged);
        } catch (_) {
          clearTimeout(timer);
          resolve(cachedTtsVoices);
        }
        refreshTtsVoices();
        if (cachedTtsVoices.length > 0) {
          clearTimeout(timer);
          resolve(cachedTtsVoices);
        }
      });
    }
    async function speak(word, directUrl = null) {
      const text = String(word || '').trim();
      if (!text) return;
      const speakToken = dictVoiceSlot.claim(word);
      if (!speakToken) return;
      const alive = () => dictVoiceSlot.isCurrent(speakToken);
      haltSpokenOutput();
      pauseLearningVideo();

      const playUrl = (url) => new Promise((resolve) => {
        if (!alive()) { resolve('stale'); return; }
        const audio = new Audio();
        audio.src = url;
        currentAudioPlayer = audio;
        if (!alive()) {
          try { audio.pause(); } catch (_) { }
          if (currentAudioPlayer === audio) currentAudioPlayer = null;
          resolve('stale');
          return;
        }
        const finish = (result) => {
          if (!alive()) {
            try { audio.pause(); } catch (_) { }
            if (currentAudioPlayer === audio) currentAudioPlayer = null;
            resolve('stale');
            return;
          }
          if (result === false && currentAudioPlayer === audio) currentAudioPlayer = null;
          resolve(result);
        };
        audio.onended = () => {
          if (currentAudioPlayer === audio) currentAudioPlayer = null;
        };
        audio.onerror = () => finish(false);
        audio.play().then(() => finish(true)).catch(() => finish(false));
      });

      async function useBackendTTS() {
        const token = getToken();
        if (!token) throw new Error('No token');
        if (!alive()) return 'stale';

        console.log('[Audio] Using backend TTS for:', word);
        const res = await fetch(`${API_BASE}/tts/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({
            text: word,
            lang: 'en',
            provider: 'edge',
            voice: (window.LinglishTtsVoice ? LinglishTtsVoice.current() : 'en-US-AvaMultilingualNeural')
          })
        });
        if (!alive()) return 'stale';

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          console.error('[Audio] TTS API failed:', res.status, errText);
          throw new Error('TTS API failed: ' + res.status);
        }
        const data = await res.json();
        console.log('[Audio] TTS API response received:', Boolean(data));
        if (!alive()) return 'stale';
        if (data.audioUrl) {
          const fullUrl = API_BASE + data.audioUrl;
          console.log('[Audio] Playing TTS audio');
          return playUrl(fullUrl);
        }
        throw new Error('No audio URL returned');
      }

      async function useBrowserTTS() {
        console.log('[Audio] Falling back to browser SpeechSynthesis for:', word);
        try {
          const voices = await waitForTtsVoices(1000);
          if (!alive()) return;
          const preferredNames = [
            'Jenny', 'Aria', 'Emma', 'Ava', 'Samantha', 'Victoria',
            'Allison', 'Moira', 'Tessa', 'Karen',
            'Google US English', 'Google UK English Female', 'Zira'
          ];
          const preferredVoice = voices.find(v =>
            v.lang.startsWith('en') &&
            preferredNames.some(name => v.name.toLowerCase().includes(name.toLowerCase()))
          ) || voices.find(v => v.lang === 'en-US') || voices.find(v => v.lang.startsWith('en'));

          if (!preferredVoice) {
            console.warn('[Audio] No English voice available, skipping browser TTS');
            try { showToast('设备缺少英文语音，请检查系统 TTS 设置', 'warn'); } catch (_) { }
            return;
          }
          if (!alive()) return;

          const u = new SpeechSynthesisUtterance(word);
          u.lang = 'en-US';
          u.rate = 0.85;
          u.pitch = 1.0;
          u.volume = 0.8;
          u.voice = preferredVoice;
          console.log('[Audio] Using voice:', preferredVoice.name);
          speechSynthesis.cancel();
          if (!alive()) return;
          speechSynthesis.speak(u);
        } catch (e) {
          console.error('[Audio] SpeechSynthesis also failed:', e);
        }
      }

      const keepPlaying = (result) => result === true || result === 'stale';

      try {
        if (state.isMainlandUser) {
          console.log('[Audio] Mainland user detected, using backend TTS directly');
          try {
            const result = await useBackendTTS();
            if (keepPlaying(result) || !alive()) return;
          } catch (err) {
            console.warn('[Audio] Backend TTS failed for mainland user:', err);
          }
          if (alive()) await useBrowserTTS();
          return;
        }

        let url = directUrl || audioCache.get(word);
        const allowPublicDictionaryAudio = !!window.__ALLOW_PUBLIC_DICT_AUDIO__ ||
          location.hostname === 'localhost' || location.hostname === '127.0.0.1';

        const candidates = [];
        if (!url) {
          if (allowPublicDictionaryAudio) {
            candidates.push(`https://ssl.gstatic.com/dictionary/static/sounds/oxford/${word}--_us_1.mp3`);
            candidates.push(`https://ssl.gstatic.com/dictionary/static/sounds/oxford/${word}--_gb_1.mp3`);
          }
        } else {
          if (url.startsWith('//')) url = 'https:' + url;
          const sameOrigin = url.startsWith(API_BASE) || url.startsWith(window.location.origin);
          if (allowPublicDictionaryAudio || sameOrigin) candidates.push(url);
        }

        for (const src of candidates) {
          if (!alive()) return;
          const result = await playUrl(src);
          if (keepPlaying(result)) return;
          console.warn('[Audio] Failed:', { code: 'AUDIO_PLAYBACK_ERROR' });
        }

        if (!alive()) return;
        try {
          const result = await useBackendTTS();
          if (keepPlaying(result) || !alive()) return;
        } catch (err) {
          console.warn('[Audio] Backend TTS failed:', err);
        }

        if (!alive()) return;
        throw new Error('All audio candidates failed');
      } catch (err) {
        if (!alive()) return;
        console.warn('[Audio] All fallbacks failed, using browser TTS:', err);
        await useBrowserTTS();
      }
    }
    async function fetchDefinition(word) {
      try {
        const r = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(word)}`, { headers: headers() });
        if (!r.ok) return null; const { entry } = await r.json(); return entry;
      } catch (_) { return null; }
    }
    function positionPopover(pop, anchor, rectOverride) {
      const containerRect = transcriptListEl.getBoundingClientRect();
      const r = rectOverride || anchor.getBoundingClientRect();
      const top = r.bottom - containerRect.top + transcriptListEl.scrollTop + 6;
      let left = r.left - containerRect.left + transcriptListEl.scrollLeft;
      const maxLeft = containerRect.width - pop.offsetWidth - 8;
      if (left > maxLeft) left = Math.max(8, maxLeft);
      pop.style.top = `${top}px`;
      pop.style.left = `${left}px`;
    }
    // Drawer helpers
    const shellEl = document.querySelector('.shell');
    let wasPlayingBeforeLookup = false; // Track if video was playing before dictionary lookup
    let dictLangMode = (() => { try { return localStorage.getItem('dict_lang_mode') || 'en'; } catch (_) { return 'en'; } })();
    let dictAccentMode = (() => { try { return localStorage.getItem('dict_accent_mode') || 'us'; } catch (_) { return 'us'; } })();
    if (dictAccentMode !== 'uk') dictAccentMode = 'us';
    let lastLookup = { word: null, ctx: null };
    let isLookupOpen = false;
    let isVideoPlaying = false;
    let collapseUpdateTimer = null;

    // Auto-collapse sidebar when video starts playing; never auto-expand on pause.
    const updateShellCollapse = () => {
      if (!shellEl || !isVideoPlaying) return;
      if (!shellEl.classList.contains('sidebar-collapsed')) {
        shellEl.classList.add('sidebar-collapsed');
      }
    };
    function showDrawer() { if (dictDrawer) { dictDrawer.classList.add('show'); dictDrawer.setAttribute('aria-hidden', 'false'); } isLookupOpen = true; updateShellCollapse(); }
    function hideDrawer() {
      stopSpokenAudio();
      try { clearDictTranslatePoll(); } catch (_) { }
      console.log('[关闭查词] wasPlayingBeforeLookup =', wasPlayingBeforeLookup);
      if (dictDrawer) {
        dictDrawer.classList.remove('show');
        dictDrawer.setAttribute('aria-hidden', 'true');
        // Resume video playback if it was playing before lookup
        if (wasPlayingBeforeLookup) {
          console.log('[关闭查词] 尝试恢复播放, 播放器类型:', currentPlayerType);
          try {
            if (currentPlayerType === 'youtube' && youtubePlayer) {
              console.log('[关闭查词] 调用 youtubePlayer.play()');
              youtubePlayer.play();
            } else {
              console.log('[关闭查词] 调用 playerEl.play()');
              playerEl.play();
            }
            console.log('[关闭查词] ✓ 播放恢复成功');
          } catch (err) {
            console.error('[关闭查词] ✗ 播放恢复失败:', err);
          }
          wasPlayingBeforeLookup = false;
        } else {
          console.log('[关闭查词] 视频原本就是暂停的，不恢复播放');
        }
      }
      isLookupOpen = false;
      updateShellCollapse();
    }
    document.addEventListener('keydown', (ev) => {
      // Pro controls handle playback in capture phase; retain this as a fallback.
      if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      // Ignore if user is typing in an input/textarea
      const target = ev.target;
      const isInputField = target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.tagName === 'SUMMARY' ||
        target.closest?.('.topbar') ||
        target.closest?.('.goal-studio') ||
        target.getAttribute?.('role') === 'slider' ||
        target.isContentEditable
      );

      // ESC key - close drawer
      if (ev.key === 'Escape') {
        hideDrawer();
        return;
      }

      // Don't handle other shortcuts if user is typing
      if (isInputField) return;

      // Space key - toggle play/pause
      if (ev.code === 'Space') {
        ev.preventDefault();
        if (ev.repeat) return;
        try {
          if (currentPlayerType === 'youtube' && youtubePlayer) {
            const state = youtubePlayer.getPlayerState();
            if (state === 1) { // Playing
              youtubePlayer.pause();
            } else {
              stopSpokenAudio();
              youtubePlayer.play();
            }
          } else if (playerEl) {
            if (playerEl.paused) {
              stopSpokenAudio();
              playerEl.play();
            } else {
              playerEl.pause();
            }
          }
        } catch (err) {
          console.error('[Keyboard] Failed to toggle play/pause:', err);
        }
        return;
      }

      // Left/Right — jump sentence and always play (avoid seek-only frozen video).
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        ev.preventDefault();
        try {
          if (window.VRP && typeof window.VRP.jumpSegments === 'function') {
            window.VRP.jumpSegments(ev.key === 'ArrowRight' ? +1 : -1);
            return;
          }
          const segs = state.currentSegments || [];
          if (!segs.length) return;
          let currentTime = 0;
          if (currentPlayerType === 'youtube' && youtubePlayer) {
            currentTime = youtubePlayer.getCurrentTime() || 0;
          } else {
            currentTime = playerEl.currentTime || 0;
          }
          const currentIdx = currentSegmentIndexByTime(currentTime);
          const targetIdx = ev.key === 'ArrowRight'
            ? Math.min(segs.length - 1, currentIdx + 1)
            : Math.max(0, currentIdx - 1);
          const seg = segs[targetIdx];
          if (!seg) return;
          const startTime = Math.max(0, Number(seg.start_sec ?? seg.start ?? seg.startTime ?? 0) + 0.01);
          stopSpokenAudio();
          if (currentPlayerType === 'youtube' && youtubePlayer) {
            youtubePlayer.seekTo(startTime);
            try { youtubePlayer.play(); } catch (_) {}
          } else if (playerEl) {
            playerEl.currentTime = startTime;
            const p = playerEl.play();
            if (p && p.catch) p.catch(() => {});
          }
          highlightActiveSegment(targetIdx, true);
        } catch (err) {
          console.error('[Keyboard] Failed to jump segment:', err);
        }
        return;
      }

      // Up/Down arrows - keep current behavior (scrolling)
    });
    // Wire dict tab buttons
    const _tabDictBtn = document.getElementById('dict-tab-dict');
    const _tabDeepBtn = document.getElementById('dict-tab-deep');
    if (_tabDictBtn) _tabDictBtn.addEventListener('click', () => switchDictTab('dict'));
    if (_tabDeepBtn) _tabDeepBtn.addEventListener('click', () => switchDictTab('deep'));

    // Click outside (blank area) closes the drawer
    document.addEventListener('click', (ev) => {
      if (!dictDrawer || !dictDrawer.classList.contains('show')) return;
      const el = ev.target;
      if (el && el.closest && (el.closest('#dict-drawer') || el.closest('.word'))) return;
      hideDrawer();
    }, true);

    function pickAccentPhonetics(entry) {
      const list = Array.isArray(entry && entry.phonetics) ? entry.phonetics : [];
      let us = null;
      let uk = null;
      list.forEach((p) => {
        if (!p) return;
        const audio = String(p.audio || '').toLowerCase();
        const text = String(p.text || p.phonetic || '').trim();
        if (!text && !audio) return;
        const item = { text, audio: p.audio || '' };
        if (/uk|gb|british/.test(audio)) uk = uk || item;
        else if (/us|american/.test(audio)) us = us || item;
        else if (!us) us = item;
        else if (!uk) uk = item;
      });
      const fallbackText = String((entry && entry.phonetic) || (us && us.text) || (uk && uk.text) || '').trim();
      return {
        us: us || { text: fallbackText, audio: '' },
        uk: uk || { text: fallbackText, audio: (us && us.audio) || '' },
      };
    }

    function buildDictCardHTML(word, entry, zh, ctx) {
      const defs = [];
      if (entry && Array.isArray(entry.meanings)) {
        entry.meanings.forEach(m => {
          const pos = m.partOfSpeech || '';
          (m.definitions || []).forEach(d => {
            defs.push({ pos, def: d.definition || '', example: d.example || '', zh: d.zh || '', exampleZh: d.exampleZh || '' });
          });
        });
      }

      const accents = pickAccentPhonetics(entry);
      const activeAccent = dictAccentMode === 'uk' ? accents.uk : accents.us;
      const phon = String((activeAccent && activeAccent.text) || '').replace(/^\/+|\/+$/g, '');
      const accentLabel = dictAccentMode === 'uk' ? '英' : '美';
      const primaryPos = (defs[0] && defs[0].pos) || (entry && Array.isArray(entry.meanings) && entry.meanings[0] && entry.meanings[0].partOfSpeech) || '';
      const posZhMap = { noun: '名词', verb: '动词', adjective: '形容词', adverb: '副词', pronoun: '代词', preposition: '介词', conjunction: '连词', interjection: '感叹词' };
      const primaryPosZh = posZhMap[String(primaryPos || '').toLowerCase()] || primaryPos;
      const zhGloss = String(zh || (defs[0] && defs[0].zh) || '').trim();
      const zhLine = zhGloss
        ? `<div class="dict-zh-gloss">${primaryPosZh ? `(${esc(primaryPosZh)}) ` : ''}${esc(zhGloss)}</div>`
        : '';

      const defsHTML = defs.slice(0, 4).map((d, idx) => `
	          <div class="dict-def-row" data-def-idx="${idx}">
	            <div class="def-header">
	              <div class="pos">${esc(d.pos)}</div>
	              <button class="dict-def-speak" data-text="${esc(d.def || '')}" aria-label="朗读释义" style="border:none;background:transparent;cursor:pointer;font-size:1rem;padding:.2rem;opacity:.8;flex-shrink:0;-webkit-tap-highlight-color:transparent;">🔊</button>
	            </div>
	            <div class="def-text">${esc(d.def)}</div>
	            ${dictLangMode === 'zh' ? `<div class="def-text zh">${d.zh ? esc(d.zh) : '翻译中...'}</div>` : ''}
	          </div>
	        `).join('') || '';

      const ctxSentence = (ctx?.sentence || '').trim();
      const ctxZh = (ctx?.translation || '').trim();
      const startSec = ctx?.startSec ?? ctx?.start ?? ctx?.start_sec;
      const ctxVideoId = ctx?.videoId ?? ctx?.video_id ?? ctx?.video_resource_id;
      const ctxTime = Number.isFinite(Number(startSec)) ? fmtSec(Number(startSec)) : '';
      const ctxJumpHref = (ctxVideoId && Number.isFinite(Number(startSec)))
        ? `./video-reader-desktop.html?videoId=${encodeURIComponent(ctxVideoId)}&startSec=${encodeURIComponent(Number(startSec))}`
        : '';

      const exampleList = [];
      if (ctxSentence) {
        exampleList.push({
          meta: `${esc(ctxTime || '语境')}${ctxJumpHref ? ` <a href="${esc(ctxJumpHref)}">跳回</a>` : ''}`,
          en: ctxSentence,
          zh: ctxZh,
          idx: 'ctx',
        });
      }
      defs.filter(d => d.example).slice(0, 3).forEach((d, i) => {
        exampleList.push({ meta: esc('例句'), en: d.example, zh: d.exampleZh || '', idx: `def-${i}` });
      });

      const examplesHTML = exampleList.length
        ? exampleList.map(ex => `
	            <div class="dict-example">
	              <div class="dict-example-meta">${ex.meta || esc('例句')}</div>
	              <div class="lines">
	                <div style="display:flex;align-items:flex-start;gap:.45rem;">
	                  <button class="dict-def-speak" data-text="${esc(ex.en || '')}" aria-label="朗读例句" style="border:none;background:transparent;cursor:pointer;font-size:1rem;padding:.1rem;opacity:.8;flex-shrink:0;-webkit-tap-highlight-color:transparent;">🔊</button>
	                  <span>${esc(ex.en)}</span>
	                </div>
	                ${dictLangMode === 'zh'
            ? `<div class="zh" data-ex-idx="${esc(ex.idx || '')}">${ex.zh ? esc(ex.zh) : '翻译暂不可用'}</div>`
            : ''}
	              </div>
	            </div>
	          `).join('')
        : `<div class="dict-zh" style="padding:.2rem 0 1rem;">暂无例句</div>`;

      return `
        <div class="dict-card">
          <div class="dict-header">
            <div class="dict-title-row">
              <div class="dict-meta">
                <div class="dict-word">${esc(word)}</div>
                ${primaryPos ? `<div class="dict-pos">${esc(primaryPos)}</div>` : ''}
              </div>
              <div class="dict-actions">
                <div class="dict-lang-toggle" aria-label="切换翻译语言">
                  <button type="button" data-lang="en" class="${dictLangMode === 'en' ? 'active' : ''}">EN</button>
                  <button type="button" data-lang="zh" class="${dictLangMode === 'zh' ? 'active' : ''}">中</button>
                </div>
              </div>
            </div>
            <div class="dict-phon-row">
              <button class="dict-btn speak" id="dict-speak-btn" aria-label="朗读单词" data-audio="${esc((activeAccent && activeAccent.audio) || (ctx && ctx.audioUrl) || '')}">🔊</button>
              <span class="dict-phon-label">${accentLabel}</span>
              ${phon ? `<span class="dict-phon">/${esc(phon)}/</span>` : ''}
              <div class="dict-accent-toggle" aria-label="切换美式/英式读音">
                <button type="button" data-accent="us" class="${dictAccentMode === 'us' ? 'active' : ''}">US</button>
                <button type="button" data-accent="uk" class="${dictAccentMode === 'uk' ? 'active' : ''}">UK</button>
              </div>
            </div>
            ${zhLine}
            <div class="dict-add-row">
              <button class="dict-btn primary" id="dict-add-btn">加入生词本</button>
            </div>
          </div>
          <div class="dict-definitions">
            ${defsHTML || (exampleList.length ? '' : `<div class="dict-empty">暂无释义</div>`)}
          </div>
          ${exampleList.length ? `
          <div class="dict-section-title">${defs.length ? '详细释义' : '语境例句'}</div>
          <div class="dict-example-list">
            ${examplesHTML}
          </div>` : (defs.length ? '' : `<div class="dict-example-list"><div class="dict-zh">暂无例句</div></div>`)}
        </div>
      `;
    }

    // ── Deep Word Analysis ───────────────────────────────────────────────────
    const _deepCache = new Map(); // word -> parsed data (in-memory)
    let _deepCurrentWord = '';
    let _deepLoaded = false; // has deep panel been loaded for current word

    // Initialize Mermaid once (lazy)
    let _mermaidReady = false;
    function ensureMermaid() {
      if (_mermaidReady) return;
      try {
        mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });
        _mermaidReady = true;
      } catch (_) { }
    }

    function normalizeDeepMermaidCode(raw) {
      let code = String(raw || '');
      if (!code.trim()) return '';
      code = code.replace(/(?<!-)->/g, '-->');
      code = code.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      code = code.replace(/\['([^']*(?:[\r\n][^']*)*?)'\]/g, (_, inner) => `["${inner.replace(/"/g, '')}"]`);
      code = code.replace(/\["([^"]*)"\]/g, (_, inner) => {
        const normalized = inner
          .replace(/\\n/g, '·')
          .replace(/\r?\n/g, '·')
          .replace(/<br\s*\/?>/gi, '·')
          .replace(/"/g, '');
        return `["${normalized}"]`;
      });
      const nodeMap = {};
      let nodeCount = 0;
      code = code.replace(/'([^']*)'/g, (_, inner) => {
        const key = inner
          .replace(/\\n/g, '·')
          .replace(/\r?\n/g, '·')
          .replace(/<br\s*\/?>/gi, '·')
          .replace(/"/g, '');
        if (!key.trim()) return "''";
        if (!nodeMap[key]) nodeMap[key] = `n${nodeCount++}`;
        return `${nodeMap[key]}["${key}"]`;
      });
      return /-->|->|==>|-\.->/.test(code) ? code : '';
    }

    function switchDictTab(tab) {
      const bodyEl = document.getElementById('dict-body');
      const deepEl = document.getElementById('dict-deep');
      const tabDict = document.getElementById('dict-tab-dict');
      const tabDeep = document.getElementById('dict-tab-deep');
      if (!bodyEl || !deepEl) return;
      if (tab === 'deep') {
        bodyEl.hidden = true;
        deepEl.hidden = false;
        tabDict && tabDict.classList.remove('active');
        tabDeep && tabDeep.classList.add('active');
        const word = (lastLookup && lastLookup.word) || '';
        if (word && (_deepCurrentWord !== word || !_deepLoaded)) {
          _deepCurrentWord = word;
          _deepLoaded = false;
          loadDeepAnalysis(word);
        }
      } else {
        deepEl.hidden = true;
        bodyEl.hidden = false;
        tabDeep && tabDeep.classList.remove('active');
        tabDict && tabDict.classList.add('active');
      }
    }

    async function loadDeepAnalysis(word) {
      const loadingEl = document.getElementById('dict-deep-loading');
      const contentEl = document.getElementById('dict-deep-content');
      if (!loadingEl || !contentEl) return;

      loadingEl.hidden = false;
      contentEl.hidden = true;
      contentEl.innerHTML = '';

      try {
        let data;
        if (_deepCache.has(word.toLowerCase())) {
          data = _deepCache.get(word.toLowerCase());
        } else {
          const res = await fetch(`${API_BASE}/api/word/deep/${encodeURIComponent(word)}`, { headers: headers() });
          if (!res.ok) {
            const errorData = await res.json().catch(async () => {
              const text = await res.text().catch(() => '');
              return { message: text };
            });
            if (res.status === 402 && errorData.code === 'WORD_DEEP_DAILY_LIMIT_REACHED') {
              const quota = errorData.quota || {};
              const tier = String(quota.tier || 'free').toLowerCase();
              const paywall = errorData.paywall || null;
              const quotaError = new Error(paywall?.message || (tier === 'free'
                ? `今日免费深度解析 ${quota.limit || 0} 次已用完，升级会员可继续生成。`
                : '今日深度解析生成额度已用完，明天会自动恢复。'));
              quotaError.paywall = paywall;
              throw quotaError;
            }
            throw new Error(errorData.message || `解析失败: ${res.status}`);
          }
          const json = await res.json();
          data = json.data || json;
          _deepCache.set(word.toLowerCase(), data);
        }

        contentEl.innerHTML = renderDeepCard(word, data);
        _deepLoaded = true;
        loadingEl.hidden = true;
        contentEl.hidden = false;

        // Render Mermaid diagram after content is visible (rAF + 80ms, same as shared module)
        const mermaidDiv = contentEl.querySelector('.deep-mermaid-src');
        if (mermaidDiv && data.mermaid) {
          requestAnimationFrame(() => {
            setTimeout(async () => {
              try {
                ensureMermaid();
                if (typeof mermaid === 'undefined') throw new Error('mermaid not loaded');
                const id = 'mermaid-' + Date.now();
                const normalizedCode = normalizeDeepMermaidCode(data.mermaid);
                if (!normalizedCode) throw new Error('invalid mermaid');
                const { svg } = await mermaid.render(id, normalizedCode);
                const wrap = mermaidDiv.closest('.deep-mermaid-wrap') || mermaidDiv;
                const tmp = document.createElement('div');
                tmp.innerHTML = svg;
                tmp.querySelectorAll('text, tspan').forEach((el) => {
                  if (!el.children.length) {
                    el.textContent = el.textContent.replace(/\\n/g, ' ').replace(/^'+|'+$/g, '');
                  }
                });
                wrap.innerHTML = tmp.innerHTML;
              } catch (e) {
                console.error('[Mermaid] render failed for', word, ':', e);
                const wrap = mermaidDiv.closest('.deep-mermaid-wrap') || mermaidDiv;
                wrap.innerHTML = '<div style="font-size:.78rem;color:#94a3b8;padding:.3rem 0;">词根扩散图加载失败</div>';
              }
            }, 80);
          });
        }
      } catch (err) {
        loadingEl.hidden = true;
        if (err && err.paywall) {
          const paywall = err.paywall;
          contentEl.innerHTML = `
            <div style="padding:1.5rem;text-align:center;border:1px solid rgba(15,118,110,.2);border-radius:14px;background:#f0fdfa;">
              <div style="font-weight:850;color:#0f766e;font-size:1rem;margin-bottom:.45rem;">${esc(paywall.title || '今日额度已用完')}</div>
              <p style="color:#0f172a;font-size:.86rem;line-height:1.55;margin:0 0 .9rem;">${esc(paywall.message || err.message || '升级会员可获得更高频训练额度。')}</p>
              ${paywall.reset_hint ? `<div style="color:#64748b;font-size:.78rem;margin-bottom:1rem;">${esc(paywall.reset_hint)}</div>` : ''}
              <a href="${esc(paywall.upgrade_url || '/pricing.html?from=quota#plans')}" style="display:inline-flex;align-items:center;justify-content:center;padding:.55rem 1.1rem;border-radius:999px;background:#0f766e;color:#fff;font-size:.82rem;font-weight:800;text-decoration:none;">${esc(paywall.action_label || '查看会员方案')}</a>
            </div>`;
        } else {
          contentEl.innerHTML = `<div style="padding:1.5rem;color:#ef4444;text-align:center;">解析失败: ${esc(err.message || 'error')}</div>`;
        }
        contentEl.hidden = false;
      }
    }

    /* ── GPT-4 Dict book-style renderer (gpt4dict source) ── */
    const _DBKICONS = [
      { k: ['例句', '例子'], v: '💬' },
      { k: ['词义', '词意', '分析词义', '词的意思'], v: '📖' },
      { k: ['词根'], v: '🌱' },
      { k: ['词缀'], v: '🔤' },
      { k: ['历史', '背景', '文化'], v: '📜' },
      { k: ['变形', '单词变形', '形式'], v: '🔄' },
      { k: ['记忆', '辅助'], v: '💡' },
      { k: ['故事'], v: '✨' },
    ];
    function _dbkIcon(t) {
      for (const e of _DBKICONS) for (const k of e.k) if (t.includes(k)) return e.v;
      return '·';
    }

    function _bkBodyToHtml(text, isEg) {
      return text.split('\n').map(function(line) {
        line = line.trim();
        if (!line) return '';
        let escaped = esc(line).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        if (/^\d+\.\s/.test(line)) {
          if (isEg) {
            // Try parenthesised translation: "1. English sentence. （中文）"
            const pm = line.match(/^(\d+)\.\s+(.*?)\s*[（(]([^）)]+)[）)]\s*$/);
            if (pm) {
              const n = pm[1].length < 2 ? '0' + pm[1] : pm[1];
              return `<div class="dbk-eg"><span class="dbk-eg-num">${n}</span><div class="dbk-eg-en">${esc(pm[2].replace(/\.\s*$/, '').trim())}</div><div class="dbk-eg-zh">${esc(pm[3].trim())}</div></div>`;
            }
            // Fallback: split at first Chinese character
            const zm = line.match(/^(\d+)\.\s+(.+)$/);
            if (zm) {
              const zi = zm[2].search(/[\u4e00-\u9fa5]/);
              if (zi > 2) {
                const n = zm[1].length < 2 ? '0' + zm[1] : zm[1];
                return `<div class="dbk-eg"><span class="dbk-eg-num">${n}</span><div class="dbk-eg-en">${esc(zm[2].slice(0, zi).replace(/[（(]$/, '').trim())}</div><div class="dbk-eg-zh">${esc(zm[2].slice(zi).replace(/[）)]$/, '').trim())}</div></div>`;
              }
            }
          }
          return `<div class="dbk-item">${escaped}</div>`;
        }
        if (/^[-*]\s/.test(line))  return `<div class="dbk-item">${escaped.substring(2)}</div>`;
        return `<div class="dbk-para">${escaped}</div>`;
      }).filter(Boolean).join('');
    }

    function renderDeepCardGpt4Dict(word, d) {
      const content = d.content_md || '';
      if (!content) {
        return `<div class="dbk-wrap"><div class="dbk-title">${esc(word)}</div><div class="dbk-para" style="color:rgba(255,255,255,.4);">暂无内容</div></div>`;
      }
      // Parse ## / ### sections
      const sections = [];
      const lines = content.split('\n');
      let curTitle = null, curLines = [];
      for (const ln of lines) {
        const hm = ln.match(/^#{2,3}\s+(.+)/);
        if (hm) {
          if (curTitle !== null && curLines.join('').trim()) sections.push({ title: curTitle, body: curLines.join('\n').trim() });
          curTitle = hm[1].trim(); curLines = [];
        } else if (curTitle !== null) { curLines.push(ln); }
      }
      if (curTitle !== null && curLines.join('').trim()) sections.push({ title: curTitle, body: curLines.join('\n').trim() });

      if (!sections.length) {
        return `<div class="dbk-wrap"><div class="dbk-header"><div class="dbk-title">${esc(word)}</div></div><div class="dbk-content"><div class="dbk-section"><div class="dbk-body">${_bkBodyToHtml(content, false)}</div></div></div></div>`;
      }
      const sectionsHTML = sections.map(s => {
        const icon = _dbkIcon(s.title);
        const isEg = s.title.includes('例');
        return `<div class="dbk-section"><div class="dbk-section-title"><span class="dbk-section-icon">${icon}</span>${esc(s.title)}</div><div class="dbk-body">${_bkBodyToHtml(s.body, isEg)}</div></div>`;
      }).join('');
      return `<div class="dbk-wrap"><div class="dbk-header"><div class="dbk-title">${esc(word)}</div><div class="dbk-badge">GPT 词典</div></div><div class="dbk-content">${sectionsHTML}</div></div>`;
    }

    function renderDeepCard(word, d) {
      if (d && (d.source === 'gpt4dict' || d.content_md)) return renderDeepCardGpt4Dict(word, d);

      const etym    = d.etymology   || {};
      const roots   = Array.isArray(etym.roots)    ? etym.roots    : [];
      const cogs    = Array.isArray(etym.cognates) ? etym.cognates : [];
      const coreImg = d.core_image  || {};
      const comps   = Array.isArray(d.comparisons) ? d.comparisons : [];
      const mermaidCode = d.mermaid || '';
      const [philoEN, philoZH] = (d.philosophy || '').split('\n');

      /* ── root chip colour by language ── */
      function rootColor(lang) {
        const l = (lang || '').toLowerCase();
        if (l.includes('latin'))   return '#7c3aed';
        if (l.includes('greek'))   return '#2563eb';
        if (l.includes('french'))  return '#db2777';
        if (l.includes('germani') || l.includes('old english') || l.includes('proto')) return '#059669';
        if (l.includes('arabic'))  return '#d97706';
        return '#475569';
      }

      /* ── DNA formula row ── */
      const dnaHTML = roots.length ? `
        <div class="deep-dna">
          ${roots.map((r, i) => `
            ${i > 0 ? '<span class="deep-dna-plus">+</span>' : ''}
            <div class="deep-dna-chip" style="background:${rootColor(r.lang)};" title="${esc(r.meaning || '')}">
              ${esc(r.root || '')}
              <small>${esc(r.lang || '')}</small>
            </div>`).join('')}
          ${roots.length ? `<span class="deep-dna-arrow">→</span><span class="deep-dna-result">${esc(word)}</span>` : ''}
        </div>` : '';

      /* ── cognate pills ── */
      const cogHTML = cogs.length
        ? `<div class="deep-cognates">${cogs.map(c => `<span class="deep-cognate">${esc(c)}</span>`).join('')}</div>`
        : '';

      /* ── confusable cards ── */
      const cfHTML = comps.length ? `
        <div class="deep-cf-list">
          ${comps.map(c => `
            <div class="deep-cf-card">
              <div class="deep-cf-head">
                <span class="deep-cf-word">${esc(c.word || '')}</span>
                <span class="deep-cf-vs">vs ${esc(word)}</span>
              </div>
              <div class="deep-cf-body">
                <div class="deep-cf-col">
                  <div class="deep-cf-col-label">✓ 相同</div>
                  ${esc(c.similarity || '')}
                </div>
                <div class="deep-cf-col">
                  <div class="deep-cf-col-label">✕ 区别</div>
                  ${esc(c.difference || '')}
                </div>
              </div>
            </div>`).join('')}
        </div>` : '';

      /* ── mermaid section ── */
      const mermaidSection = mermaidCode ? `
        <div class="deep-s">
          <div class="deep-s-label"><span>🌳</span> 词根扩散图</div>
          <div class="deep-mermaid-wrap"><div class="deep-mermaid-src">${esc(mermaidCode)}</div></div>
        </div>` : '';

      return `
        <div>
          <!-- Hero: word name -->
          <div class="deep-hero">
            <div class="deep-hero-word">${esc(word)}</div>
            <div class="deep-hero-badge">✦ AI 深度解析</div>
          </div>

          <!-- 词源 DNA -->
          <div class="deep-s">
            <div class="deep-s-label"><span>🧬</span> 词源 DNA</div>
            ${dnaHTML}
            ${cogHTML ? `<div style="margin-top:.55rem;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:.3rem;">同根词族</div>${cogHTML}` : ''}
            ${etym.evolution ? `<div class="deep-evolution">${esc(etym.evolution)}</div>` : ''}
          </div>

          <!-- 核心意象 -->
          ${(coreImg.formula || coreImg.metaphor) ? `
          <div class="deep-s">
            <div class="deep-s-label"><span>💡</span> 记忆锚点</div>
            <div class="deep-anchor">
              ${coreImg.formula ? `<div class="deep-anchor-formula">${esc(coreImg.formula)}</div>` : ''}
              ${coreImg.metaphor ? `<div class="deep-anchor-metaphor">${esc(coreImg.metaphor)}</div>` : ''}
            </div>
          </div>` : ''}

          <!-- 易混词 -->
          ${comps.length ? `
          <div class="deep-s">
            <div class="deep-s-label"><span>⚖️</span> 易混词对比</div>
            ${cfHTML}
          </div>` : ''}

          <!-- 词根扩散图 -->
          ${mermaidSection}

          <!-- 哲学金句 -->
          ${philoEN ? `
          <div class="deep-s">
            <div class="deep-s-label"><span>🔮</span> 哲学金句</div>
            <div class="deep-quote">
              <div class="deep-quote-en">${esc(philoEN)}</div>
              ${philoZH ? `<div class="deep-quote-zh">${esc(philoZH)}</div>` : ''}
            </div>
          </div>` : ''}
        </div>
      `;
    }
    // ─────────────────────────────────────────────────────────────────────────

    const desktopTranslateCache = new Map();
    const desktopTranslateInflight = new Map();
    const desktopTranslateFailed = new Set();

    function bilingualCacheKey(text) {
      return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    }

    async function translateText(text) {
      const source = String(text || '').trim();
      if (!source) return '';
      const key = bilingualCacheKey(source);
      if (desktopTranslateCache.has(key)) return desktopTranslateCache.get(key) || '';
      if (desktopTranslateFailed.has(key)) return '';
      if (desktopTranslateInflight.has(key)) return desktopTranslateInflight.get(key);

      const job = (async () => {
        try {
          const res = await fetch(`${API_BASE}/dictionary/translate-text`, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
            body: JSON.stringify({ text: source })
          });
          if (res.status === 401 || res.status === 403) return '';
          if (!res.ok) {
            desktopTranslateFailed.add(key);
            return '';
          }
          const j = await res.json().catch(() => ({}));
          const zh = String(j?.translation || j?.zh || '').trim();
          if (zh && /[\u4e00-\u9fa5]/.test(zh) && (j.success !== false)) {
            desktopTranslateCache.set(key, zh);
            desktopTranslateFailed.delete(key);
            return zh;
          }
          desktopTranslateFailed.add(key);
          return '';
        } catch (_) {
          desktopTranslateFailed.add(key);
          return '';
        }
      })();

      desktopTranslateInflight.set(key, job);
      try {
        return await job;
      } finally {
        desktopTranslateInflight.delete(key);
      }
    }

    function shouldAutoTranslateSegment(text, translation) {
      const en = String(text || '').trim();
      const zh = String(translation || '').trim();
      if (!en || !zh) return false;
      const enLen = en.length;
      const zhChars = (zh.match(/[\u4e00-\u9fa5]/g) || []).length;
      if (enLen < 50 || zhChars === 0) return false;
      return (zhChars / enLen) < 0.2;
    }

    function patchDesktopTranslationDom(index, zh) {
      const segEl = transcriptListEl && transcriptListEl.querySelector(`.seg[data-index="${index}"]`);
      const text = String(zh || '').trim();
      const hasZh = text && /[\u4e00-\u9fa5]/.test(text);
      if (segEl) {
        let el = segEl.querySelector('.translation');
        if (hasZh) {
          if (!el) {
            el = document.createElement('div');
            el.className = 'translation';
            segEl.appendChild(el);
          }
          el.textContent = text;
        } else if (el) {
          // Keep the rail clean when translation is unavailable.
          el.remove();
        }
      }
      if (activeSubtitleEl && Number(activeSubtitleEl.dataset.index) === Number(index) && activeTranslationEl) {
        if (hasZh) {
          activeTranslationEl.textContent = text;
          activeTranslationEl.style.display = 'block';
        } else if (state.showBilingual) {
          activeTranslationEl.textContent = '';
          activeTranslationEl.style.display = 'none';
        }
      }
    }

    let desktopBilingualToken = 0;
    let desktopBilingualDrainTimer = null;
    async function ensureDesktopBilingualTranslations(indices) {
      if (!state.showBilingual) return;
      const segments = Array.isArray(state.currentSegments) ? state.currentSegments : [];
      if (!segments.length) return;
      const tokenAtStart = ++desktopBilingualToken;
      let targets = (Array.isArray(indices) ? indices : [])
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n >= 0 && n < segments.length);
      if (!targets.length) {
        // Prefer active cue + nearby lines first, then fill more of the list.
        const active = Number(document.querySelector('.seg.active')?.dataset?.index);
        const prefer = Number.isFinite(active)
          ? [active - 1, active, active + 1, active + 2, active + 3, active + 4]
          : [0, 1, 2, 3, 4, 5];
        targets = prefer.filter((n) => n >= 0 && n < segments.length);
        for (let i = 0; i < segments.length && targets.length < 24; i += 1) {
          if (!targets.includes(i)) targets.push(i);
        }
      }
      // Unique preserve order
      targets = Array.from(new Set(targets));

      const CONCURRENCY = 4;
      for (let offset = 0; offset < targets.length; offset += CONCURRENCY) {
        if (tokenAtStart !== desktopBilingualToken) return;
        const batch = targets.slice(offset, offset + CONCURRENCY);
        await Promise.all(batch.map(async (index) => {
          const seg = segments[index];
          if (!seg) return;
          const existing = String(seg.translation || seg.cn || seg.zh || seg.text_cn || '').trim();
          if (existing && /[\u4e00-\u9fa5]/.test(existing) && !shouldAutoTranslateSegment(seg.text || '', existing)) return;
          const en = String(seg.text || '').trim();
          if (!en || seg._autoTranslatePending) return;
          const key = bilingualCacheKey(en);
          if (desktopTranslateFailed.has(key) && !desktopTranslateCache.has(key)) {
            patchDesktopTranslationDom(index, '');
            return;
          }
          seg._autoTranslatePending = true;
          try {
            const zh = await translateText(en);
            if (tokenAtStart !== desktopBilingualToken) return;
            if (zh && /[\u4e00-\u9fa5]/.test(zh)) {
              seg.translation = zh;
              seg.cn = zh;
              seg._autoTranslated = true;
              patchDesktopTranslationDom(index, zh);
            } else {
              patchDesktopTranslationDom(index, '');
            }
          } catch (_) {
            patchDesktopTranslationDom(index, '');
          } finally {
            seg._autoTranslatePending = false;
          }
        }));
      }

      if (tokenAtStart !== desktopBilingualToken) return;
      // Keep draining remaining untranslated lines without blocking playback.
      scheduleDesktopBilingualDrain();
    }

    function scheduleDesktopBilingualDrain() {
      if (!state.showBilingual) return;
      if (desktopBilingualDrainTimer) return;
      desktopBilingualDrainTimer = setTimeout(() => {
        desktopBilingualDrainTimer = null;
        if (!state.showBilingual) return;
        const segments = Array.isArray(state.currentSegments) ? state.currentSegments : [];
        const missing = [];
        for (let i = 0; i < segments.length && missing.length < 16; i += 1) {
          const seg = segments[i];
          if (!seg) continue;
          const en = String(seg.text || '').trim();
          if (!en) continue;
          const existing = String(seg.translation || seg.cn || seg.zh || seg.text_cn || '').trim();
          const hasZh = existing && /[\u4e00-\u9fa5]/.test(existing) && !shouldAutoTranslateSegment(en, existing);
          if (!hasZh && !seg._autoTranslatePending) missing.push(i);
        }
        if (missing.length) ensureDesktopBilingualTranslations(missing).catch(() => { });
      }, 350);
    }

    function queueVisibleBilingualTranslations() {
      if (!state.showBilingual || !transcriptListEl) return;
      try {
        if (!transcriptListEl._lxBiObserver) {
          transcriptListEl._lxBiObserver = new IntersectionObserver((entries) => {
            if (!state.showBilingual) return;
            const idxs = [];
            entries.forEach((entry) => {
              if (!entry.isIntersecting) return;
              const idx = Number(entry.target && entry.target.dataset && entry.target.dataset.index);
              if (Number.isFinite(idx)) idxs.push(idx);
            });
            if (idxs.length) ensureDesktopBilingualTranslations(idxs).catch(() => { });
          }, { root: transcriptListEl, rootMargin: '80px 0px', threshold: 0.01 });
        }
        transcriptListEl.querySelectorAll('.seg[data-index]').forEach((node) => {
          try { transcriptListEl._lxBiObserver.observe(node); } catch (_) { }
        });
      } catch (_) { }
    }

    let dictTranslatePollTimer = null;
    function clearDictTranslatePoll() {
      if (dictTranslatePollTimer) {
        try { clearTimeout(dictTranslatePollTimer); } catch (_) { }
        dictTranslatePollTimer = null;
      }
    }

    function hasMissingDefinitionZh(entry) {
      try {
        if (!entry || !Array.isArray(entry.meanings)) return false;
        for (const meaning of entry.meanings) {
          const defs = Array.isArray(meaning.definitions) ? meaning.definitions : [];
          for (const def of defs) {
            const zh = (def && def.zh) ? String(def.zh) : '';
            const hasZh = zh && /[\u4e00-\u9fa5]/.test(zh);
            if (def && def.definition && !hasZh) return true;
          }
        }
      } catch (_) { }
      return false;
    }

    async function openDrawerLookup(word, ctx) {
      if (!dictBody) return;
      clearDictTranslatePoll();
      const assistCard = document.getElementById('subtitle-assist');
      if (assistCard) {
        assistCard.hidden = true;
        activeSubtitleEl?.querySelectorAll('.word-lookup').forEach((el) => el.classList.remove('word-lookup'));
      }
      try {
        const vcCard = document.querySelector('[data-vc-word-card]');
        if (vcCard) vcCard.hidden = true;
      } catch (_) { }
      const ctxLocal = Object.assign({}, ctx || {});
      if (!ctxLocal.videoId && state.currentVideo?.id) {
        ctxLocal.videoId = state.currentVideo.id;
      }
      lastLookup = { word, ctx: ctxLocal };
      showDrawer();
      // Reset to dict tab on each new word lookup
      switchDictTab('dict');
      dictBody.innerHTML = `<div style="padding:1rem;color:#64748b;">查词中...</div>`;
      // Auto add to user's vocabulary as 'learning' for later review (静默添加，不显示toast)
      ensureLearning(word, ctxLocal || {}, true).catch(e => console.warn('auto-add failed', e?.message || e));

      try {
        // Dictionary API now includes both entry and translation (zh)
        const res = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(word)}`, { headers: headers() });
        let entry = null;
        let zh = '';
        if (res.ok) {
          const data = await res.json();
          entry = data?.entry || null;
          zh = data?.zh || ''; // Translation is included in same response
        }

        function resolveAccentAudio(currentEntry) {
          const accents = pickAccentPhonetics(currentEntry);
          const active = dictAccentMode === 'uk' ? accents.uk : accents.us;
          if (active && active.audio) return active.audio;
          if (entry && Array.isArray(entry.phonetics)) {
            const ph = entry.phonetics.find(p => p && p.audio && String(p.audio).trim());
            if (ph) return ph.audio;
          }
          return '';
        }

        let audioSrc = resolveAccentAudio(entry);

        function wireDrawerHandlers() {
          const speakBtn = dictBody.querySelector('#dict-speak-btn');
          if (speakBtn) {
            speakBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              const fromBtn = speakBtn.getAttribute('data-audio') || '';
              speak(word, fromBtn || audioSrc || null);
            });
          }

          const addBtn = dictBody.querySelector('#dict-add-btn');
          if (addBtn) addBtn.addEventListener('click', () => addToVocab(word, ctxLocal || {}));

          const closeInline = dictBody.querySelector('#dict-close-inline');
          if (closeInline) closeInline.addEventListener('click', hideDrawer);

          // 释义/例句朗读，复用全局 speak 以避免叠音
          dictBody.querySelectorAll('.dict-def-speak').forEach(btn => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const txt = btn.getAttribute('data-text') || word;
              speak(txt);
            });
          });

          const langToggle = dictBody.querySelector('.dict-lang-toggle');
          if (langToggle) {
            langToggle.querySelectorAll('button').forEach(btn => {
              btn.addEventListener('click', () => {
                const mode = btn.dataset.lang;
                if (mode && mode !== dictLangMode) {
                  dictLangMode = mode;
                  try { localStorage.setItem('dict_lang_mode', mode); } catch (_) { }
                  openDrawerLookup(word, ctxLocal || {});
                }
              });
            });
          }

          const accentToggle = dictBody.querySelector('.dict-accent-toggle');
          if (accentToggle) {
            accentToggle.querySelectorAll('button').forEach(btn => {
              btn.addEventListener('click', () => {
                const mode = btn.dataset.accent === 'uk' ? 'uk' : 'us';
                if (mode === dictAccentMode) {
                  speak(word, resolveAccentAudio(entry) || audioSrc || null);
                  return;
                }
                dictAccentMode = mode;
                try { localStorage.setItem('dict_accent_mode', mode); } catch (_) { }
                audioSrc = resolveAccentAudio(entry);
                renderDrawer(entry, zh);
                speak(word, audioSrc || null);
              });
            });
          }
        }

        function renderDrawer(currentEntry, currentZh) {
          const prevScrollTop = dictBody.scrollTop || 0;
          audioSrc = resolveAccentAudio(currentEntry);
          dictBody.innerHTML = buildDictCardHTML(word, currentEntry, currentZh, Object.assign({}, ctxLocal, { audioUrl: audioSrc }));
          try { dictBody.scrollTop = prevScrollTop; } catch (_) { }
          wireDrawerHandlers();
        }

        renderDrawer(entry, zh);

        // If user is in Chinese mode, translate transcript context sentence (if missing)
        try {
          if (dictLangMode === 'zh') {
            const ctxSentence = (ctxLocal?.sentence || '').trim();
            const ctxTranslation = (ctxLocal?.translation || '').trim();
            if (ctxSentence && !ctxTranslation) {
              const node = dictBody.querySelector('.zh[data-ex-idx="ctx"]');
              if (node && (!node.textContent || node.textContent.includes('翻译暂不可用'))) {
                node.textContent = '翻译中...';
                const translated = await translateText(ctxSentence);
                ctxLocal.translation = translated || '';
                node.textContent = translated || '翻译暂不可用';
              }
            }
          }
        } catch (_) { }

        // If user is in Chinese mode and definition translations are missing, poll until async translation completes.
        try {
          if (dictLangMode === 'zh' && hasMissingDefinitionZh(entry)) {
            let attempts = 0;
            const maxAttempts = 10;
            const interval = 2000;
            const poll = async () => {
              attempts++;
              if (!dictDrawer || !dictDrawer.classList.contains('show')) return;
              if (!lastLookup || lastLookup.word !== word) return;
              if (dictLangMode !== 'zh') return;

              try {
                const res2 = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(word)}?t=${Date.now()}`, {
                  headers: Object.assign({ 'Cache-Control': 'no-cache' }, headers())
                });
                if (res2.ok) {
                  const data2 = await res2.json();
                  const entry2 = data2?.entry || null;
                  const zh2 = data2?.zh || '';
                  renderDrawer(entry2, zh2);
                  if (!hasMissingDefinitionZh(entry2)) {
                    clearDictTranslatePoll();
                    return;
                  }
                }
              } catch (_) { }

              if (attempts >= maxAttempts) {
                try {
                  dictBody.querySelectorAll('.def-text.zh').forEach(n => {
                    if (String(n.textContent || '').includes('翻译中')) n.textContent = '翻译暂不可用';
                  });
                } catch (_) { }
                clearDictTranslatePoll();
                return;
              }
              dictTranslatePollTimer = setTimeout(poll, interval);
            };
            dictTranslatePollTimer = setTimeout(poll, interval);
          }
        } catch (_) { }

      } catch (err) {
        dictBody.innerHTML = `<div style="padding:1rem;color:#ef4444;">Lookup failed: ${esc(err?.message || 'error')}</div>`;
      }
    }
    async function addToVocab(lemma, ctx) {
      try {
        const payload = { word: lemma, context: { videoId: state.currentVideo?.id || null, sentence: ctx.sentence || null } };
        const res = await fetch(`${API_BASE}/vocabulary/v2/add`, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
        const data = await res.json(); if (!res.ok) throw new Error(data?.error || '添加失败');
        ownedLemmaSet.add(lemma);
        document.querySelectorAll(`.word[data-lemma="${CSS.escape(lemma)}"]`).forEach(el => el.classList.add('owned'));
        // 立即显示toast，提升响应速度
        showToast(`已加入生词本：${lemma}`, 'success');
        try { localStorage.setItem('vocab_update', JSON.stringify({ ts: Date.now(), lemma: String(lemma || '').toLowerCase(), state: 'learning' })); } catch (_) { }
        // 异步更新词汇列表，不阻塞用户操作
        Promise.all([loadVocabStats(), loadVocab()]).catch(() => { });
      } catch (err) { showToast(err.message || '添加失败', 'warn'); }
    }
    // Ensure a lemma is tracked as 'learning' silently when needed
    async function ensureLearning(lemma, ctx = {}, silent = true) {
      const norm = normalizeLemma(lemma || '');
      if (!norm) return false;
      try {
        // 使用 V2 API 添加词汇到"我的词汇"
        const payload = { word: norm, context: { videoId: state.currentVideo?.id || null, sentence: ctx.sentence || null } };
        const res = await fetch(`${API_BASE}/vocabulary/v2/add`, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
        const data = await res.json(); if (!res.ok) throw new Error(data?.error || '添加失败');
        ownedLemmaSet.add(norm);
        document.querySelectorAll(`.word[data-lemma="${CSS.escape(norm)}"]`).forEach(el => el.classList.add('owned'));
        // 立即显示toast，提升响应速度
        if (!silent) showToast(`已添加 "${norm}" 到词汇表`, 'success');
        try { localStorage.setItem('vocab_update', JSON.stringify({ ts: Date.now(), lemma: norm, state: 'learning' })); } catch (_) { }
        // 异步更新词汇列表，不阻塞用户操作
        Promise.all([loadVocabStats(), loadVocab()]).catch(() => { });
        return true;
      } catch (err) {
        if (!silent) showToast(err.message || '添加失败', 'warn');
        return false;
      }
    }
    // Simple cache and backoff for dictionary lookups to avoid 429
    const dictCache = new Map();
    const dictInFlight = new Map();
    async function fetchDefinitionSafe(word) {
      const k = String(word || '').toLowerCase();
      if (!k) return null;
      if (dictCache.has(k)) return dictCache.get(k);
      if (dictInFlight.has(k)) return dictInFlight.get(k);
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const p = (async () => {
        let attempt = 0, data = null;
        while (attempt < 3) {
          attempt++;
          let res;
          try { res = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(k)}`, { headers: headers() }); }
          catch (_) { res = null; }
          if (res && res.status === 429) { await sleep(400 * attempt); continue; }
          if (!res || !res.ok) break;
          data = await res.json().catch(() => null);
          break;
        }
        dictCache.set(k, data?.entry || null);
        dictInFlight.delete(k);
        return data?.entry || null;
      })();
      dictInFlight.set(k, p);
      return p;
    }

    async function showDictionaryPopover(lemma, ctx, anchor, rectOverride) {
      dictPop.style.display = 'block';
      dictPop.innerHTML = `<div class="title">${esc(lemma)}</div><div class="phon">Loading...</div>`;
      positionPopover(dictPop, anchor, rectOverride);
      const entry = await fetchDefinitionSafe(lemma);
      let phon = '';
      let defsHTML = '';
      if (entry) {
        phon = entry.phonetic || '';
        if ((!phon || phon.trim() === '') && Array.isArray(entry.phonetics)) {
          const p = entry.phonetics.find(p => p && (p.text || p.phonetic));
          phon = p?.text || p?.phonetic || '';
        }
        if (Array.isArray(entry.meanings)) {
          entry.meanings.slice(0, 2).forEach(m => {
            (m.definitions || []).slice(0, 2).forEach(d => {
              defsHTML += `<div class=\"def\"><span class=\"pos\">${esc(m.partOfSpeech || '')}</span>${esc(d.definition || '')}</div>`;
            });
          });
        }
      }
      let audioSrc = '';
      if (entry && Array.isArray(entry.phonetics)) {
        const ph = entry.phonetics.find(p => p.audio && p.audio.trim() !== '');
        if (ph) audioSrc = ph.audio;
      }
      if (window.DictionaryRender) {
        const norm = normalizeLemma(lemma);
        let s = 'new';
        try {
          const found = (state.vocab || []).find(it => normalizeLemma(it.lemma) === norm);
          if (found && found.state) s = String(found.state);
          else if (ownedLemmaSet.has(norm)) s = 'learning';
        } catch (_) { }
        const label = s === 'known' ? (typeof i18n !== 'undefined' ? (i18n.t('vocab.known') || '已掌握') : '已掌握') : (s === 'learning' ? (typeof i18n !== 'undefined' ? (i18n.t('vocab.learning') || '学习中') : '学习中') : (typeof i18n !== 'undefined' ? (i18n.t('vocab.new') || '新词') : '新词'));
        const cls = s === 'known' ? 'mastered' : (s === 'learning' ? 'learning' : 'new');
        dictPop.innerHTML = DictionaryRender.build(lemma, entry, '', { statusText: label, statusClass: cls, audioUrl: audioSrc });
        try {
          const headerBtn = dictPop.querySelector('.dict-speak-btn');
          if (headerBtn) headerBtn.addEventListener('click', () => speak(lemma, audioSrc));
          dictPop.querySelectorAll('.dict-def-speak').forEach(btn => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const txt = btn.getAttribute('data-text') || lemma;
              speak(txt);
            });
          });
          // Attach translate button handlers
          if (window.DictionaryLookup && window.DictionaryLookup.attachTranslateButtonHandlers) {
            window.DictionaryLookup.attachTranslateButtonHandlers(dictPop, lemma);
          }
          // Auto-add to study on drawer dictionary too
          try { await addToVocab(lemma, ctx || {}); } catch (_) { }
        } catch (_) { }
      } else {
        dictPop.innerHTML = `<div class="title">${esc(lemma)}</div>`;
      }
      // Keep add-to-vocab as separate action if needed
      // document.getElementById('dp-add')?.addEventListener('click', () => addToVocab(lemma, ctx));
    }

    // Selection-based lookup fallback: enables lookup even if spans are not rendered
    transcriptListEl?.addEventListener('mouseup', (ev) => {
      if (ev.detail > 1) return;
      try {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const text = String(sel.toString() || '').replace(/[^A-Za-z''-]/g, '').replace(/^['']+|['']+$/g, '');
        if (!text || text.length < 2) return;
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const lemma = normalizeLemma(text);
        // Check if video is playing before pausing (Case 3: selection)
        try {
          if (currentPlayerType === 'youtube' && youtubePlayer) {
            const playerState = youtubePlayer.getPlayerState();
            wasPlayingBeforeLookup = (playerState === 1); // 1 = playing
            console.log('[查词-Case3] YouTube播放器状态:', playerState, '是否播放中:', wasPlayingBeforeLookup);
            youtubePlayer.pause();
          } else {
            wasPlayingBeforeLookup = !playerEl.paused;
            console.log('[查词-Case3] HTML5播放器 paused:', playerEl.paused, '是否播放中:', wasPlayingBeforeLookup);
            playerEl.pause();
          }
        } catch (err) {
          console.log('[查词-Case3] 检查播放状态出错:', err);
          wasPlayingBeforeLookup = false;
        }
        // Clear selection to avoid accidental overwrite while interacting
        sel.removeAllRanges();
        openDrawerLookup(lemma, { index: null, startSec: null, endSec: null, sentence: '' });
      } catch (_) { }
    });

    // simple toast (delegates to feedback.js when available)
    function showToast(message, type = 'info') {
      if (window.Feedback) { Feedback.showToast(type, message); return; }
      try {
        const box = document.getElementById('toast-container');
        if (!box) return alert(message);
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = message;
        box.appendChild(el);
        setTimeout(() => { el.style.opacity = '0.0'; el.style.transition = 'opacity .3s'; }, 1800);
        setTimeout(() => { el.remove(); }, 2300);
      } catch (_) { try { alert(message); } catch (__) { } }
    }
    async function markState(lemma, stateName) {
      const norm = normalizeLemma(lemma || '');
      if (!norm) return;
      // Optimistic UI update
      try {
        const i = (state.vocab || []).findIndex(it => normalizeLemma(it.lemma) === norm);
        const prev = i >= 0 ? state.vocab[i].state : null;
        if (i >= 0) {
          state.vocab[i].state = stateName;
          renderVocabStats();
          renderVocab();
        }
        debugLog('POST /vocab/mark', { lemma, norm, state: stateName });
        // Backend expects `state` to be 'known'/'learning'/'new'.
        const payload = { lemma: lemma, state: stateName };
        // Some deployments also read review_state/mastered — include as hints.
        if (stateName === 'known') { payload.review_state = 'mastered'; payload.mastered = true; }
        if (stateName === 'learning') { payload.review_state = 'learning'; }
        debugLog('POST /vocab/mark payload=', payload);
        const res = await fetch(`${API_BASE}/vocab/mark`, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
        const data = await res.json(); if (!res.ok) throw new Error(data?.message || '标记失败');
        // 成功后，维护 ownedLemmaSet 以保持字幕高亮与状态一致
        try {
          if (stateName === 'learning' || stateName === 'known') {
            ownedLemmaSet.add(norm);
          } else if (stateName === 'new') {
            ownedLemmaSet.delete(norm);
          }
        } catch (_) { }
        // Maintain local override to persist user's explicit decision
        try {
          if (stateName === 'known') { knownOverrides.add(norm); saveKnownOverrides(knownOverrides); }
          else if (stateName !== 'known' && knownOverrides.has(norm)) { knownOverrides.delete(norm); saveKnownOverrides(knownOverrides); }
        } catch (_) { }
        debugLog('markState success', data);
        try { if (data && data.item) debugLog('markState item snapshot', data.item); } catch (_) { }
        // 不立即重新拉取列表，避免后端延迟导致状态被覆盖
        const label = stateName === 'known' ? '已掌握' : (stateName === 'learning' ? '学习中' : '新词');
        showToast(`“${lemma}” 已标记为 ${label}`, 'success');
        try { if (window.Feedback) Feedback.playSfx('success'); } catch (_) { }
        // 轻微延迟后后台再拉一次，确保持久化已生效
        setTimeout(() => { loadVocab().catch(() => { }); }, 800);
      } catch (e) { debugLog('markState error', e); showToast(e.message || '标记失败', 'warn'); }
    }
    async function editTranslation(lemma, current) {
      const t = (key) => typeof i18n !== 'undefined' ? i18n.t(key) : key;
      const next = window.prompt(t('vocab.edit_translation'), current || ''); if (next == null) return;
      try {
        const res = await fetch(`${API_BASE}/vocab/translation`, { method: 'PATCH', headers: headers(), body: JSON.stringify({ lemma, translation: String(next || '').trim() }) });
        const data = await res.json(); if (!res.ok) throw new Error(data?.message || t('vocab.save_error'));
        await loadVocab();
        showToast(t('vocab.save_success'), 'success');
        try { if (window.Feedback) Feedback.playSfx('success'); } catch (_) { }
      } catch (e) { showToast(e.message || t('vocab.save_error'), 'warn'); }
    }
    async function delVocab(lemma) {
      const t = (key) => typeof i18n !== 'undefined' ? i18n.t(key) : key;
      if (!window.confirm(`${t('vocab.delete_word_confirm')}${lemma}?`)) return;
      try {
        const res = await fetch(`${API_BASE}/vocab/${encodeURIComponent(lemma)}`, { method: 'DELETE', headers: headers() });
        if (!res.ok) throw new Error(await res.text());
        await Promise.all([loadVocab(), loadVocabStats()]);
        showToast(`${t('vocab.delete_word_success')} "${lemma}"`, 'success');
        try { if (window.Feedback) Feedback.playSfx('success'); } catch (_) { }
      } catch (e) { showToast(e.message || t('video.delete_error'), 'warn'); }
    }

    // ===== 多语言初始化 =====
    if (typeof i18n !== 'undefined') {
      i18n.init();

      const currentLangEl = document.getElementById('current-lang-video');
      const langBtn = document.getElementById('lang-btn-video');
      const langDropdown = document.getElementById('lang-dropdown-video');
      const langNames = { zh: '中文', en: 'English' };

      if (currentLangEl) {
        currentLangEl.textContent = langNames[i18n.currentLang] || '中文';
      }

      langBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (langDropdown) {
          langDropdown.style.display = langDropdown.style.display === 'none' ? 'block' : 'none';
        }
      });

      document.addEventListener('click', () => {
        if (langDropdown) langDropdown.style.display = 'none';
      });

      langDropdown?.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      document.querySelectorAll('#lang-dropdown-video .lang-option').forEach(option => {
        option.addEventListener('click', () => {
          const lang = option.dataset.lang;
          if (lang) {
            i18n.setLang(lang);
            if (currentLangEl) {
              currentLangEl.textContent = langNames[lang] || lang;
            }
            document.querySelectorAll('#lang-dropdown-video .lang-option').forEach(opt => {
              opt.classList.toggle('active', opt.dataset.lang === lang);
              opt.style.background = opt.dataset.lang === lang ? '#0ea5e9' : '';
              opt.style.color = opt.dataset.lang === lang ? 'white' : '';
            });
            if (langDropdown) langDropdown.style.display = 'none';
            // 重新渲染词汇表以更新按钮文本
            renderVocab();
            // Refresh overlay copy in the new language (if visible)
            refreshPlayerOverlayCopy();
          }
        });
      });

      document.querySelectorAll('#lang-dropdown-video .lang-option').forEach(opt => {
        const isActive = opt.dataset.lang === i18n.currentLang;
        opt.classList.toggle('active', isActive);
        opt.style.background = isActive ? '#0ea5e9' : '';
        opt.style.color = isActive ? 'white' : '';
      });
    }

    // ===== Smart Review Nudge & Discover Panel (移动端卡片设计) =====
    (function () {
      function getQuery(name) { try { const p = new URLSearchParams(location.search || ''); return p.get(name); } catch (_) { return null; } }
      function readToken() { const ks = ['linglish_token', 'authToken']; for (const k of ks) { try { const v = localStorage.getItem(k) || sessionStorage.getItem(k); if (v && v !== 'null' && v !== 'undefined') return v; } catch (_) { } } return null; }

      // Quick Review Manager (移动端卡片设计)
      const QRManager = {
        overlay: null,
        flashcard: null,
        reviewQueue: [],
        currentIndex: 0,
        currentItem: null,
        isFlipped: false,
        dictLang: 'zh',
        totalCount: 0,

        init() {
          this.overlay = document.getElementById('qr-overlay');
          this.flashcard = document.getElementById('qr-flashcard');
          try {
            this.dictLang = localStorage.getItem('dict_lang_mode') || 'zh';
          } catch (_) { }
          this.bindEvents();
          this.updateLangButtons();
        },

        bindEvents() {
          // Close button
          document.getElementById('qr-close')?.addEventListener('click', () => this.close());

          // Overlay (backdrop) click — the old .qr-review-backdrop div is display:none,
          // so bind on the overlay itself and only close on direct background clicks
          this.overlay?.addEventListener('click', (ev) => {
            if (ev.target === this.overlay) this.close();
          });

          // Esc closes the review
          document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && this.overlay && this.overlay.style.display === 'flex') {
              this.close();
            }
          });

          // Flashcard click to flip
          this.flashcard?.addEventListener('click', () => {
            if (!this.isFlipped && this.currentItem) {
              this.flipCard();
            }
          });

          // Speak button
          document.getElementById('qr-speak-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.currentItem) speak(this.currentItem.lemma);
          });

          // Quality buttons
          document.querySelectorAll('.qr-quality-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              const quality = btn.getAttribute('data-quality');
              this.submitReview(quality);
            });
          });

          // Language toggle (header)
          document.getElementById('qr-lang-zh')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.setDictLang('zh');
          });
          document.getElementById('qr-lang-en')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.setDictLang('en');
          });

          // Language toggle (on card)
          document.getElementById('qr-card-lang-zh')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.setDictLang('zh');
          });
          document.getElementById('qr-card-lang-en')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.setDictLang('en');
          });
        },

        setDictLang(lang) {
          this.dictLang = lang;
          try { localStorage.setItem('dict_lang_mode', lang); } catch (_) { }
          this.updateLangButtons();
          this.updateHeaderTranslation();
          if (this.currentItem) this.loadDefinitions(this.currentItem.lemma);
        },

        updateLangButtons() {
          // Header buttons
          const langZh = document.getElementById('qr-lang-zh');
          const langEn = document.getElementById('qr-lang-en');
          if (langZh) langZh.classList.toggle('active', this.dictLang === 'zh');
          if (langEn) langEn.classList.toggle('active', this.dictLang === 'en');

          // Card buttons
          const cardLangZh = document.getElementById('qr-card-lang-zh');
          const cardLangEn = document.getElementById('qr-card-lang-en');
          if (cardLangZh) cardLangZh.classList.toggle('active', this.dictLang === 'zh');
          if (cardLangEn) cardLangEn.classList.toggle('active', this.dictLang === 'en');
        },

        updateHeaderTranslation() {
          const headerTranslation = document.getElementById('qr-header-translation');
          const translation = this.currentItem?.translation || '';
          if (headerTranslation && this.currentItem) {
            if (this.dictLang === 'zh' && translation) {
              headerTranslation.textContent = translation;
              headerTranslation.style.display = 'block';
            } else {
              headerTranslation.style.display = 'none';
            }
          }
          // Also update front card translation
          const translationFront = document.getElementById('qr-translation-front');
          if (translationFront && this.currentItem) {
            translationFront.textContent = '';
            translationFront.style.display = 'none';
          }
          // Also update back card translation
          const translationBack = document.getElementById('qr-translation-back');
          if (translationBack && this.currentItem) {
            if (this.isFlipped && this.dictLang === 'zh' && translation) {
              translationBack.textContent = translation;
              translationBack.style.display = 'block';
            } else {
              translationBack.style.display = 'none';
            }
          }
        },

        async start() {
          try {
            const res = await fetch(`${API_BASE}/vocab/review-queue?limit=10`, { headers: headers() });
            const data = await res.json();
            const rawItems = Array.isArray(data.items) ? data.items : [];

            this.reviewQueue = rawItems.filter(item => item.lemma && item.lemma.trim().length > 0);
            this.totalCount = this.reviewQueue.length;

            if (this.reviewQueue.length === 0) {
              showToast('暂无待复习词汇', 'info');
              return;
            }

            this.currentIndex = 0;
            this.showOverlay();
            await this.showNext();
          } catch (err) {
            console.error('[QRManager] Start failed:', err);
            showToast('加载复习队列失败', 'warn');
          }
        },

        showOverlay() {
          if (this.overlay) {
            this.overlay.style.display = 'flex';
            document.body.style.overflow = 'hidden';
          }
        },

        hideOverlay() {
          if (this.overlay) {
            this.overlay.style.display = 'none';
            document.body.style.overflow = '';
          }
        },

        async showNext() {
          if (this.currentIndex >= this.reviewQueue.length) {
            this.finish();
            return;
          }

          const item = this.reviewQueue[this.currentIndex];
          this.currentItem = item;
          this.isFlipped = false;

          // Reset card
          if (this.flashcard) this.flashcard.classList.remove('flipped');
          const qualityBtns = document.getElementById('qr-quality-buttons');
          if (qualityBtns) qualityBtns.style.display = 'none';

          // Fetch translation
          try {
            const tr = await fetch(`${API_BASE}/vocab/item?lemma=${encodeURIComponent(item.lemma)}`, { headers: headers() });
            if (tr.ok) {
              const tj = await tr.json();
              const raw = tj?.item?.translation || '';
              item.translation = this.normalizeTranslation(item.lemma, raw);
            }
          } catch (_) { }

          // Update progress
          this.updateProgress();

          // Render front
          this.renderCard();

          // Load definitions
          await this.loadDefinitions(item.lemma);
        },

        updateProgress() {
          const progressText = document.getElementById('qr-progress-text');
          if (progressText) {
            progressText.textContent = `${this.currentIndex + 1} / ${this.totalCount}`;
          }
        },

        renderCard() {
          const word = this.currentItem?.lemma || '';
          const translation = this.currentItem?.translation || '';

          // Header
          const headerWord = document.getElementById('qr-header-word');
          const headerTranslation = document.getElementById('qr-header-translation');
          if (headerWord) headerWord.textContent = word;
          if (headerTranslation) {
            if (this.dictLang === 'zh' && translation) {
              headerTranslation.textContent = translation;
              headerTranslation.style.display = 'block';
            } else {
              headerTranslation.style.display = 'none';
            }
          }

          // Card front
          const wordFront = document.getElementById('qr-word-front');
          if (wordFront) wordFront.textContent = word;

          // Card front translation (show in Chinese mode)
          const translationFront = document.getElementById('qr-translation-front');
          if (translationFront) {
            translationFront.textContent = '';
            translationFront.style.display = 'none';
          }

          // Card back
          const wordBack = document.getElementById('qr-word-back');
          if (wordBack) wordBack.textContent = word;
          const translationBack = document.getElementById('qr-translation-back');
          if (translationBack) {
            if (this.isFlipped && this.dictLang === 'zh' && translation) {
              translationBack.textContent = translation;
              translationBack.style.display = 'block';
            } else {
              translationBack.style.display = 'none';
            }
          }
        },

        async loadDefinitions(word) {
          try {
            const res = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(word)}`, { headers: headers() });
            if (!res.ok) {
              this.setDefinitionsHtml('<div style="color:#94a3b8;">暂无详细释义</div>');
              return;
            }

          const data = await res.json();
          const entry = data.entry;
          const dictWordZh = this.normalizeTranslation(this.currentItem?.lemma || word, data?.zh || '');
          if (!this.currentItem.translation && dictWordZh) {
            this.currentItem.translation = dictWordZh;
            this.updateHeaderTranslation();
          }

            // Phonetic
            let phonetic = entry?.phonetic || '';
            if (!phonetic && Array.isArray(entry?.phonetics)) {
              const p = entry.phonetics.find(p => p?.text || p?.phonetic);
              phonetic = p?.text || p?.phonetic || '';
            }
            const phoneticText = phonetic ? `/${phonetic}/` : '';

            const phoneticFront = document.getElementById('qr-phonetic-front');
            const phoneticBack = document.getElementById('qr-phonetic-back');
            if (phoneticFront) phoneticFront.textContent = phoneticText;
            if (phoneticBack) phoneticBack.textContent = phoneticText;

            // Definitions
            if (entry?.meanings) {
              const html = this.buildDefinitionsHtml(entry.meanings);
              this.setDefinitionsHtml(html || '<div style="color:#94a3b8;">暂无详细释义</div>');
            }
          } catch (err) {
            console.error('[QRManager] loadDefinitions error:', err);
            this.setDefinitionsHtml('<div style="color:#94a3b8;">加载释义失败</div>');
          }
        },

        setDefinitionsHtml(html) {
          const defsEl = document.getElementById('qr-definitions');
          if (defsEl) defsEl.innerHTML = html;
        },

        buildDefinitionsHtml(meanings) {
          if (!meanings || !meanings.length) return '';

          const showZh = this.dictLang === 'zh';
          let html = '';

          meanings.slice(0, 3).forEach(meaning => {
            const pos = meaning.partOfSpeech || '';
            const defs = (meaning.definitions || []).slice(0, 2);

            html += `<div style="margin-bottom:12px;">`;
            if (pos) {
              html += `<span style="display:inline-block;background:#e0e7ff;color:#0f5e52;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;margin-bottom:6px;">${pos}</span>`;
            }

            defs.forEach(def => {
              const enDef = def.definition || '';
              const zhDef = def.zh || '';

              if (showZh && zhDef && !zhDef.startsWith('[待翻译]') && !zhDef.includes('翻译中')) {
                html += `<div style="margin:4px 0;color:#334155;">${zhDef}</div>`;
                html += `<div style="margin:2px 0;color:#94a3b8;font-size:13px;">${enDef}</div>`;
              } else {
                html += `<div style="margin:4px 0;color:#334155;">${enDef}</div>`;
              }
            });

            html += `</div>`;
          });

          return html;
        },
        normalizeTranslation(lemma, translation) {
          if (!translation) return '';
          if (translation.startsWith('[待翻译]') || translation.startsWith('[译]')) return '';
          if (lemma && translation.toLowerCase() === lemma.toLowerCase()) return '';
          return translation;
        },

        flipCard() {
          this.isFlipped = true;
          if (this.flashcard) this.flashcard.classList.add('flipped');
          const qualityBtns = document.getElementById('qr-quality-buttons');
          if (qualityBtns) qualityBtns.style.display = 'block';
          this.updateHeaderTranslation();

          // Auto-play pronunciation
          setTimeout(() => {
            if (this.currentItem) speak(this.currentItem.lemma);
          }, 400);
        },

        async submitReview(quality) {
          if (!this.currentItem) return;

          try {
            const outcome = (quality === 'again') ? 'fail' : 'pass';
            await fetch(`${API_BASE}/vocab/review`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...headers() },
              body: JSON.stringify({ lemma: this.currentItem.lemma, outcome })
            });

            this.currentIndex++;
            setTimeout(() => this.showNext(), 300);
          } catch (err) {
            console.error('[QRManager] submitReview error:', err);
            showToast('提交失败', 'warn');
          }
        },

        finish() {
          this.close();
          showToast('本轮复习完成! 🎉', 'success');
        },

        close() {
          this.hideOverlay();
          this.reviewQueue = [];
          this.currentIndex = 0;
          this.currentItem = null;
          this.isFlipped = false;
        }
      };

      // Initialize QRManager
      QRManager.init();

      function openQuickReview() {
        QRManager.start();
      }
      function showReviewNudge(due) {
        try {
          if (document.getElementById('review-nudge')) return;
          const el = document.createElement('div'); el.id = 'review-nudge';
          el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:1600;background:#111827cc;color:#fff;padding:16px 18px;border-radius:12px;backdrop-filter:blur(8px);box-shadow:0 8px 24px rgba(0,0,0,.35);max-width:360px;';
          const count = Number(due) || 0;
          const title = (typeof i18n !== 'undefined' && i18n?.t) ? (i18n.t('review.today') || '今日复习') : '今日复习';
          el.innerHTML = `
              <div style="font-weight:700;margin-bottom:.25rem;display:flex;align-items:center;gap:.5rem;">🧠 ${title}</div>
              <div style="color:#cbd5e1;margin-bottom:.75rem;">还有 <strong style="color:#fff;">${count}</strong> 个词待复习。现在来一轮巩固吧？</div>
              <div style="display:flex;gap:.5rem;justify-content:flex-end;">
                <button id="nudge-later" style="background:#374151;color:#e5e7eb;border:none;border-radius:8px;padding:.4rem .7rem;cursor:pointer;">稍后</button>
                <button id="nudge-start" style="background:#0ea5e9;color:#fff;border:none;border-radius:8px;padding:.4rem .7rem;cursor:pointer;">开始复习</button>
              </div>`;
          document.body.appendChild(el);
          document.getElementById('nudge-later').onclick = () => el.remove();
          document.getElementById('nudge-start').onclick = () => { el.remove(); openQuickReview(); };
        } catch (_) { }
      }
      async function maybeNudgeReview() {
        const q = getQuery('review'); if (q === '1') { showReviewNudge(1); return; }
        const currentToken = getToken(); if (!currentToken) return;
        try { const r = await fetch(`${API_BASE}/vocab/stats-summary`, { headers: headers() }); if (!r.ok) return; const j = await r.json(); const due = Number(j?.due || 0); if (due > 0) showReviewNudge(due); } catch (_) { }
      }
      // 已禁用：精选推荐面板
      // function showDiscoverPanel(){
      //   try{
      //     if (state.currentVideo) return;
      //     if (!Array.isArray(state.filteredVideos) || state.filteredVideos.length===0) return;
      //     if (document.getElementById('discover-panel')) return;
      //     const topRight=document.createElement('div'); topRight.id='discover-panel';
      //     topRight.style.cssText='position:fixed;right:16px;top:88px;width:340px;max-width:45vw;background:#ffffff; color:#0f172a;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.15);z-index:1400;';
      //     const head=`<div style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-weight:700;">精选推荐</div>`;
      //     const items = state.filteredVideos.slice(0,3).map(v=>{
      //       const title = esc(v.title || v.original_filename || `视频 ${v.id}`);
      //       const dur = fmtSec(v.duration_sec);
      //       return `<div class="rec-item" data-id="${v.id}" style="padding:10px 12px;border-bottom:1px dashed #e5e7eb;display:flex;justify-content:space-between;align-items:center;gap:.5rem;">
      //                 <div style="min-width:0;flex:1;">${title}<div style=\"color:#64748b;font-size:.85rem;\">${dur}</div></div>
      //                 <button class="rec-play" style="background:#111827;color:#fff;border:none;border-radius:8px;padding:.35rem .6rem;cursor:pointer;">学习</button>
      //               </div>`; }).join('');
      //     const foot=`<div style="padding:8px 12px;text-align:right;"><button id="rec-close" style="background:#e5e7eb;border:none;border-radius:8px;padding:.35rem .6rem;cursor:pointer;">关闭</button></div>`;
      //     topRight.innerHTML = head + items + foot;
      //     document.body.appendChild(topRight);
      //     topRight.querySelectorAll('.rec-item .rec-play').forEach(btn=>{
      //       btn.addEventListener('click', (e)=>{
      //         const id = Number(btn.parentElement.getAttribute('data-id')); selectVideo((state.videos||[]).find(v=>Number(v.id)===id) || {id}); topRight.remove();
      //       });
      //     });
      //     document.getElementById('rec-close').onclick=()=>topRight.remove();
      //   }catch(_){ }
      // }
      // Trigger after initial data loads
      setTimeout(() => { try { maybeNudgeReview(); } catch (_) { } }, 500);
      // 已禁用：精选推荐面板
      // setTimeout(()=>{ try{ if(!state.currentVideo) showDiscoverPanel(); }catch(_){} }, 1200);
    })();
    // ===== Init =====
    (async function init() {
      function openCoachLibraryIfRequested() {
        const coachParams = new URLSearchParams(location.search);
        if (coachParams.get('returnTo') !== 'coach') return;
        coachPickReady = true;
        const library = coachParams.get('library');
        const label = coachParams.get('mode') === 'dialogue' ? '实战场' : 'AI陪练';
        const hint = document.getElementById('vb-hint');
        if (hint) hint.textContent = `选中一条内容后，会直接进入${label}。`;
        if (library === 'podcasts') openPodcastBrowser();
        else if (library === 'channels') openChannelBrowser();
        else openVideoBrowser();
        showToast(`选好内容后回到${label}`, 'info');
      }

      function normalizeLevel(raw) {
        const v = String(raw || '').trim().toLowerCase();
        return (v === 'beginner' || v === 'intermediate' || v === 'advanced') ? v : null;
      }
      function readLevelOverrideFromUrl() {
        try {
          const p = new URLSearchParams(location.search || '');
          return normalizeLevel(p.get('level') || p.get('difficulty'));
        } catch (_) { return null; }
      }
      openCoachLibraryIfRequested();
      const urlLevelOverride = readLevelOverrideFromUrl();
      if (urlLevelOverride) {
        // Persist so other parts (difficulty chips, vocab page) stay consistent.
        try { localStorage.setItem('linglish_active_level', urlLevelOverride); } catch (_) { }
        try { localStorage.setItem('vocab_difficulty_filter', urlLevelOverride); } catch (_) { }
      }

      function pickDefaultVideo(list, preferredLevel) {
        const videos = Array.isArray(list) ? list : [];
        if (videos.length === 0) return null;
        const isPlayable = (v) => v && (v.youtube_video_id || v.video_path || (v.local_video_path && v.local_video_status === 'completed'));
        const preferred = normalizeLevel(preferredLevel);
        const playable = preferred
          ? videos.find(v => isPlayable(v) && String(v.difficulty_level || '').toLowerCase() === preferred)
          : null;
        const anyPlayable = videos.find(v => isPlayable(v));
        return playable || anyPlayable || videos[0] || null;
      }

      try {
        // 页面加载时检测是否是国内用户（用于音频发音优化）
        try {
          const proxyCheck = await fetch('/youtube-proxy/check');
          const proxyData = await proxyCheck.json();
          state.isMainlandUser = proxyData.needsProxy || false;
          console.log('[Init] Mainland user check:', state.isMainlandUser ? 'YES' : 'NO');
        } catch (e) {
          console.warn('[Init] Failed to check mainland user status:', e);
          state.isMainlandUser = false;
        }

        // Load user first to enable ownership checks
        await loadUser();
        await Promise.all([loadVideos(), loadVocab(), loadVocabStats(), loadVocabMap()]);
      } catch (e) { console.error(e); }
      try { setHashView(location.hash); } catch (_) {}
      const params = new URLSearchParams(location.search);
      const vid = params.get('videoId') || params.get('id');
      const ytParam = String(params.get('yt') || '').trim();
      const startSec = readStartSecFromUrl();
      if (vid && startSec != null) {
        pendingSeek = { videoId: vid, startSec };
      }

      function resumeSecondsFor(video) {
        if (!video || video.id == null) return 0;
        if (startSec != null) return 0;
        try {
          const snap = readLastStudyMediaSnap();
          if (snap && String(snap.id) === String(video.id) && Number(snap.seconds) > 1) {
            return Number(snap.seconds);
          }
        } catch (_) {}
        try {
          const entry = videoProgressMap.get(String(video.id));
          if (entry && Number(entry.seconds) > 1) return Number(entry.seconds);
        } catch (_) {}
        return 0;
      }

      function resolveExternalFromUrlOrMemory(videoId) {
        const id = String(videoId || '');
        const ytFromId = (id.match(/^yt:([\w-]{6,})$/i) || [])[1] || '';
        const youtubeId = ytFromId || ytParam;
        if (youtubeId) {
          const snap = readLastStudyMediaSnap();
          const matched = snap && (
            String(snap.id) === id
            || String(snap.youtube_video_id || '') === youtubeId
            || String(snap.id) === ('yt:' + youtubeId)
          );
          return videoFromStudyMediaSnap(matched ? Object.assign({}, snap, {
            id: id.startsWith('yt:') ? id : ('yt:' + youtubeId),
            youtube_video_id: youtubeId,
            external_youtube: true,
          }) : {
            id: id.startsWith('yt:') ? id : ('yt:' + youtubeId),
            youtube_video_id: youtubeId,
            external_youtube: true,
            title: 'YouTube ' + youtubeId,
          });
        }
        if (/^pod:/.test(id)) {
          try {
            const recent = window.LinglishStudyRecent && window.LinglishStudyRecent.get(id);
            const pod = findPodcastFromRecent(recent || { id });
            if (pod && pod.episode) {
              return {
                id,
                title: pod.episode.title || (pod.show && pod.show.title) || '播客',
                original_filename: pod.episode.title || '',
                thumbnail_path: pod.episode.image || (pod.show && pod.show.image) || '',
                collection_name: (pod.show && pod.show.title) || '',
                external_podcast: true,
                audioUrl: pod.episode.audioUrl || '',
                transcriptUrl: pod.episode.transcriptUrl || '',
                status: 'ready',
                duration_sec: 0,
              };
            }
          } catch (_) {}
          return videoFromStudyMediaSnap(readLastStudyMediaSnap());
        }
        return null;
      }

      async function openRestoredVideo(video) {
        if (!video) return false;
        try {
          const resumeSec = resumeSecondsFor(video);
          if (resumeSec > 1 && !pendingSeek) {
            pendingSeek = { videoId: String(video.id), startSec: resumeSec };
          }
          await selectVideo(video);
          return Boolean(state.currentVideo);
        } catch (err) {
          console.warn('[Resume] openRestoredVideo failed', err);
          return false;
        }
      }

      async function restoreStudySelection() {
        if (state.currentVideo) return true;
        if (vid) {
          let found = (state.videos || []).find(v => String(v.id) === String(vid));
          if (!found && /^\d+$/.test(String(vid))) {
            try {
              const res = await fetch(`${API_BASE}/video-resources/${vid}`, { headers: headers() });
              if (res.ok) {
                const data = await res.json();
                const video = data?.video || data;
                if (video && video.id) {
                  if (!(state.videos || []).some(v => Number(v.id) === Number(video.id))) {
                    state.videos = [video, ...(state.videos || [])];
                  }
                  state.filteredVideos = state.videos;
                  renderVideoList();
                  found = video;
                }
              } else {
                const err = await res.json().catch(() => ({}));
                showToast(err?.message || '未找到该视频，可能已删除', 'warn');
              }
            } catch (_) {
              showToast('加载视频失败，请稍后再试', 'warn');
            }
          }
          if (!found) {
            try { found = resolveExternalFromUrlOrMemory(vid); }
            catch (err) { console.warn('[Resume] resolve external failed', err); }
          }
          if (found && await openRestoredVideo(found)) return true;
        }

        let restored = null;
        try {
          const restoreFromSnap = readLastStudyMediaSnap();
          if (restoreFromSnap && restoreFromSnap.id != null) {
            restored = (state.videos || []).find(v => String(v.id) === String(restoreFromSnap.id));
            if (!restored) restored = videoFromStudyMediaSnap(restoreFromSnap);
          }
        } catch (_) {}
        if (!restored) {
          try {
            const lastId = localStorage.getItem('last_video_id');
            const MAX_INTEGER = 2147483647;
            if (lastId) {
              const numId = Number(lastId);
              if (numId > 0 && numId <= MAX_INTEGER) {
                restored = (state.videos || []).find(v => String(v.id) === String(lastId));
              } else if (!/^yt:|^pod:/i.test(String(lastId))) {
                console.warn('[Init] Clearing invalid last_video_id:', lastId);
                localStorage.removeItem('last_video_id');
              }
            }
          } catch (_) {}
        }
        if (urlLevelOverride && restored && restored.difficulty_level
          && String(restored.difficulty_level).toLowerCase() !== urlLevelOverride) {
          restored = null;
        }
        if (restored && await openRestoredVideo(restored)) return true;
        const baseList = (state.filteredVideos && state.filteredVideos.length) ? state.filteredVideos : state.videos;
        const fallback = pickDefaultVideo(baseList, urlLevelOverride);
        if (fallback) {
          try { await selectVideo(fallback); } catch (_) {}
          return Boolean(state.currentVideo);
        }
        return false;
      }

      try {
        await restoreStudySelection();
      } catch (err) {
        console.warn('[Resume] restoreStudySelection failed', err);
      }
      if (!state.currentVideo) {
        window.setTimeout(() => {
          restoreStudySelection().catch((err) => console.warn('[Resume] delayed restore failed', err));
        }, 400);
      }
      coachPickReady = true;
    })();

    // 游客权限限制
    if (window.GuestCheck) {
      // 显示游客横幅
      GuestCheck.showGuestBanner();

      // 限制上传功能
      GuestCheck.restrictForGuest('a[href="./video-upload.html"]', '视频上传');

      // 监听上传按钮点击（额外保护）
      document.querySelectorAll('a[href="./video-upload.html"]').forEach(link => {
        link.addEventListener('click', (e) => {
          if (GuestCheck.isGuest()) {
            e.preventDefault();
            e.stopPropagation();
            GuestCheck.showGuestRestriction('视频上传');
            return false;
          }
        });
      });
    }

    // Focus first lesson recording: only a successful server assessment may
    // advance practiced progress. Playback/navigation remain listening tools.
    const firstLessonRecordBtn = document.getElementById('first-lesson-record');

    function currentFirstLessonSegment() {
      // The visible practice sentence owns recording identity; YouTube seek is asynchronous.
      if (firstLessonSession.isActive()) {
        const index = firstLessonGoalCard.getSentenceIndex();
        if (Number.isInteger(index) && state.currentSegments[index]) return { index, segment: state.currentSegments[index] };
      }
      let time = Number(playerEl.currentTime || 0);
      if (currentPlayerType === 'youtube' && youtubePlayer && typeof youtubePlayer.getCurrentTime === 'function') {
        time = Number(youtubePlayer.getCurrentTime() || 0);
      }
      const index = currentSegmentIndexByTime(time);
      return index >= 0 ? { index, segment: state.currentSegments[index] } : null;
    }

    function pauseFirstLessonSourcePlayback() {
      try { playerEl.pause(); } catch (_) { }
      try { if (youtubePlayer && typeof youtubePlayer.pause === 'function') youtubePlayer.pause(); } catch (_) { }
    }

    function createDesktopFirstLessonPreview() {
      let target = null;
      const getTime = () => currentPlayerType === 'youtube' && youtubePlayer
        ? Number(youtubePlayer.getCurrentTime() || 0) : Number(playerEl.currentTime || 0);
      const seek = (time) => {
        if (currentPlayerType === 'youtube' && youtubePlayer) youtubePlayer.seekTo(time);
        else playerEl.currentTime = time;
      };
      const controller = window.LinglishOriginalAudioReplay.createOriginalAudioReplayController({
        getTime, setTime: seek,
        play: () => currentPlayerType === 'youtube' && youtubePlayer ? youtubePlayer.play() : playerEl.play(),
        pause: pauseFirstLessonSourcePlayback,
        requestFrame: window.requestAnimationFrame.bind(window),
        cancelFrame: window.cancelAnimationFrame.bind(window),
        setTimer: window.setTimeout.bind(window), clearTimer: window.clearTimeout.bind(window),
        onStateChange: (playing) => {
          if (playing || !target || !firstLessonSession.isActive() || state.currentVideo?.id !== target.videoId) return;
          const time = getTime();
          // Keep the paused cursor inside this sentence rather than selecting its neighbour.
          if (time >= target.end && time < target.end + 0.5) seek(Math.max(target.start, target.end - 0.02));
          const index = getTime() >= target.start && getTime() < target.end ? target.index : null;
          if (index !== null) renderActiveSubtitle(index, false);
        },
        onError: () => firstLessonGoalCard.feedback('原音暂时没有播放出来，请再试一次。'),
      });
      function stop() { target = null; controller.stop(); }
      return {
        stop, isPlaying: controller.isPlaying,
        async play(index) {
          const line = state.currentSegments[index];
          if (!line || !firstLessonSession.isActive()) return false;
          stop(); stopSpokenAudio();
          const start = Number(line.start ?? line.start_sec ?? 0);
          const end = Number(line.end ?? line.end_sec) || start + 4;
          target = { index, start, end, videoId: state.currentVideo?.id };
          firstLessonPlaybackLocked = false;
          renderActiveSubtitle(index, false);
          try { return await controller.replay({ start, end, leadIn: 0, tailBuffer: 0 }); }
          catch (_) { firstLessonGoalCard.feedback('原音暂时没有播放出来，请再试一次。'); return false; }
        },
      };
    }

    function setFirstLessonRecordButtonState(buttonState) {
      firstLessonGoalCard.setState(buttonState);
      if (!firstLessonRecordBtn) return;
      const states = {
        requesting: [true, '⏳ 正在请求麦克风'],
        recording: [false, '⏹ 完成录音'],
        evaluating: [true, '⏳ AI 评估中'],
        idle: [false, '🎙 跟读当前句'],
      };
      const next = states[buttonState] || states.idle;
      firstLessonRecordBtn.disabled = next[0];
      firstLessonRecordBtn.textContent = next[1];
    }

    async function assessFirstLessonRecording(blob, context) {
      const currentToken = getToken();
      if (!currentToken || !context || !blob?.size) {
        throw new Error('录音或登录状态无效，请重试');
      }
      if (isDesktopAssessmentContextCurrent(context)) firstLessonGoalCard.setRecording(blob);
      return window.LinglishFirstLessonPractice.submitAssessment({
        fetch,
        url: `${API_BASE}/practice/evaluate`,
        token: currentToken,
        blob,
        context,
        isContextCurrent: isDesktopAssessmentContextCurrent,
      });
    }

    function advanceDesktopFirstLesson(context) {
      const nextIndex = context.displayIndex + 1;
      const next = state.currentSegments[nextIndex];
      if (!next) return false;
      const start = Number(next.start ?? next.start_sec ?? 0);
      renderActiveSubtitle(nextIndex);
      stopSpokenAudio();
      if (currentPlayerType === 'youtube' && youtubePlayer) {
        try {
          youtubePlayer.seekTo(start);
          youtubePlayer.play();
        } catch (_) { }
      } else {
        try {
          playerEl.currentTime = start;
          const playPromise = playerEl.play();
          if (playPromise?.catch) playPromise.catch(() => { });
        } catch (_) { }
      }
      return true;
    }

    firstLessonRecorderController = window.LinglishFirstLessonPractice.createDesktopRecorderController({
      MediaRecorder: window.MediaRecorder,
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      maxDurationMs: 20000,
      isActive: () => firstLessonSession.isActive(),
      isContextCurrent: isDesktopAssessmentContextCurrent,
      pausePlayback: pauseFirstLessonSourcePlayback,
      lockPlayback: (locked) => { firstLessonPlaybackLocked = locked; },
      setButtonState: setFirstLessonRecordButtonState,
      assess: assessFirstLessonRecording,
      accept: async (result, context) => {
        if (!result || !isDesktopAssessmentContextCurrent(context)) return null;
        const accepted = markFirstLessonPracticed(context, result, result.__assessmentId);
        if (!accepted) return null;
        return {
          accepted: accepted.accepted,
          snapshot: accepted.snapshot,
          feedback: accepted.accepted
            ? `AI 反馈 ${Math.round(accepted.score || 0)} 分 · 已练 ${accepted.snapshot.practicedCount}/${accepted.snapshot.total}`
            : '这次还没有通过，听原句后再录一次',
        };
      },
      renderFeedback: (feedback, _snapshot, result) => {
        const selected = currentFirstLessonSegment();
        const reference = result?.targetText || selected?.segment?.text || '';
        const recognized = result?.recognizedText || '';
        let missed = [];
        if (window.LinglishMissedWords && reference && selected) {
          missed = window.LinglishMissedWords.remember(
            localStorage,
            state.currentVideo && state.currentVideo.id,
            selected.index,
            reference,
            recognized
          );
          renderActiveSubtitle(selected.index);
          renderTranscript();
        }
        const note = window.LinglishFirstLessonGoal.sentenceResult(result?.success === true, missed);
        firstLessonGoalCard.settle(note, { success: result?.success === true, recognizedText: recognized, missedWords: missed });
      },
      advance: () => {},
      complete: () => {},
      onError: (error) => {
        firstLessonGoalCard.feedback(error?.message || '无法使用麦克风，请检查浏览器权限');
        showToast(error?.message || '无法使用麦克风，请检查浏览器权限', 'warn');
      },
    });

    playerEl.addEventListener('play', () => {
      if (firstLessonPlaybackLocked) {
        try { playerEl.pause(); } catch (_) { }
      }
    });

    async function toggleFirstLessonRecording() {
      if (!firstLessonSession.isActive() || !firstLessonRecordBtn || !firstLessonRecorderController) return;
      if (firstLessonRecorderController.isRecording()) {
        firstLessonRecorderController.stop('manual');
        return;
      }
      const selected = currentFirstLessonSegment();
      if (!selected) {
        showToast('请先播放并定位到一句字幕', 'warn');
        return;
      }
      const context = createDesktopAssessmentContext(selected);
      if (!context) return;
      await firstLessonRecorderController.start(context);
    }

    if (firstLessonRecordBtn) firstLessonRecordBtn.addEventListener('click', toggleFirstLessonRecording);

    // ---- VRP bridge: expose closure handles to pro-controls.js ----
    try {
      window.__vrdPro = {
        playerEl,
        getYouTubePlayer: () => (typeof youtubePlayer !== 'undefined' ? youtubePlayer : null),
        getPlayerType: () => (typeof currentPlayerType !== 'undefined' ? currentPlayerType : 'local'),
        stopDictAudio: () => { try { stopSpokenAudio(); } catch (_) { } },
        state,
        currentSegmentIndexByTime: (typeof currentSegmentIndexByTime === 'function') ? currentSegmentIndexByTime : null,
        highlightActiveSegment: (typeof highlightActiveSegment === 'function') ? highlightActiveSegment : null,
        firstLesson: {
          isActive: () => firstLessonSession.isActive(),
          snapshot: () => firstLessonPracticeSnapshot,
          markResume: (seconds) => {
            if (!firstLessonSession.isActive() || !firstLessonProgressSubject || !state.currentVideo) return null;
            return firstLessonProgressStore.markResume(firstLessonProgressSubject, state.currentVideo.id, seconds);
          },
          markHeard: (index, evidence) => {
            const segment = state.currentSegments[index];
            if (!firstLessonSession.isActive() || !firstLessonProgressSubject || !state.currentVideo || !segment) return null;
            const segmentId = window.LinglishFirstLessonProgress.stableSegmentId(state.currentVideo.id, segment, index);
            return firstLessonProgressStore.markHeard(firstLessonProgressSubject, state.currentVideo.id, segmentId, {
              source: evidence?.source,
              forward: evidence?.forward === true,
              fraction: evidence?.fraction,
            }).snapshot;
          },
        },
      };
    } catch (e) {
      console.warn('[VRP] bridge expose failed:', e);
    }
