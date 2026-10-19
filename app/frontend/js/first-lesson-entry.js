(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LinglishFirstLessonEntry = api.createFirstLessonEntry(root);
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const VISITOR_ID_KEY = 'linglish_visitor_id';
  const TOKEN_KEYS = ['linglish_token', 'authToken'];

  function safeGet(storage, key) {
    try { return storage && storage.getItem(key); } catch (_) { return null; }
  }

  function safeSet(storage, key, value) {
    try { if (storage) storage.setItem(key, value); } catch (_) { }
  }

  function compact(value, fallback) {
    const text = String(value == null ? '' : value).trim();
    return text || fallback;
  }

  function normalizeLevel(value) {
    const level = compact(value, 'A1').toUpperCase();
    return /^(A1|A2|B1|B2|C1|C2)$/.test(level) ? level : 'A1';
  }

  function buildDestination(options) {
    const config = options || {};
    const route = config.mobile ? './video-reader.html' : './video-reader-desktop.html';
    const params = new URLSearchParams();
    params.set('from', compact(config.source, 'landing_first_lesson'));
    params.set('focus', 'first_lesson');
    params.set('level', normalizeLevel(config.level));
    if (config.videoId !== undefined && config.videoId !== null && compact(config.videoId, '')) {
      params.set('videoId', compact(config.videoId, ''));
    }
    return `${route}?${params.toString()}`;
  }

  function readRawToken(environment) {
    for (const storage of [environment.localStorage, environment.sessionStorage]) {
      for (const key of TOKEN_KEYS) {
        const token = safeGet(storage, key);
        if (token && token !== 'null' && token !== 'undefined') return token;
      }
    }
    return null;
  }

  function readUsableToken(environment) {
    const manager = environment.AuthManager;
    let token = null;
    try {
      if (manager && typeof manager.getToken === 'function') token = manager.getToken();
    } catch (_) { }
    if (!token) token = readRawToken(environment);
    try {
      if (token && manager && typeof manager.isTokenExpired === 'function' && manager.isTokenExpired(token)) {
        return null;
      }
    } catch (_) {
      return null;
    }
    return token;
  }

  async function clearToken(environment) {
    try {
      if (environment.AuthManager && typeof environment.AuthManager.clearToken === 'function') {
        await environment.AuthManager.clearToken();
      }
    } catch (_) { }
    for (const storage of [environment.localStorage, environment.sessionStorage]) {
      for (const key of TOKEN_KEYS) {
        try { if (storage) storage.removeItem(key); } catch (_) { }
      }
    }
  }

  function createVisitorId(environment) {
    try {
      const shared = environment.LinglishVisitor && environment.LinglishVisitor.getId
        ? environment.LinglishVisitor.getId()
        : null;
      if (shared) return shared;
    } catch (_) { }
    const existing = safeGet(environment.localStorage, VISITOR_ID_KEY);
    if (existing) return existing;
    let random = '';
    try {
      if (environment.crypto && typeof environment.crypto.randomUUID === 'function') {
        random = environment.crypto.randomUUID();
      }
    } catch (_) { }
    if (!random) random = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const visitorId = `llv_${random}`;
    safeSet(environment.localStorage, VISITOR_ID_KEY, visitorId);
    return visitorId;
  }

  async function saveGuestSession(environment, payload) {
    const data = payload || {};
    const token = data.access_token || data.token || data.accessToken;
    if (!token) throw new Error('GUEST_TOKEN_MISSING');
    if (environment.AuthManager && typeof environment.AuthManager.setToken === 'function') {
      await environment.AuthManager.setToken(token, true);
    }
    safeSet(environment.localStorage, 'linglish_token', token);
    safeSet(environment.localStorage, 'authToken', token);
    safeSet(environment.localStorage, 'is_guest', 'true');
    safeSet(environment.localStorage, 'guest_id', data.guest_id || '');
    return token;
  }

  function extractItems(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload && payload.items)) return payload.items;
    if (Array.isArray(payload && payload.videos)) return payload.videos;
    if (Array.isArray(payload && payload.data && payload.data.items)) return payload.data.items;
    if (Array.isArray(payload && payload.data && payload.data.videos)) return payload.data.videos;
    return [];
  }

  function pickFirstLessonVideo(payload) {
    return extractItems(payload).find(isPlayableFirstLessonVideo) || null;
  }

  function isPlayableFirstLessonVideo(video) {
    if (!video || !video.id || String(video.status || '').toLowerCase() !== 'ready') return false;
    const hasSource = Boolean(
      compact(video.youtube_video_id, '')
      || compact(video.video_path, '')
      || (compact(video.local_video_path, '') && String(video.local_video_status || '').toLowerCase() === 'completed')
    );
    const hasLearningContent = Boolean(
      video.has_subtitles
      || (Array.isArray(video.transcript_segments) && video.transcript_segments.length)
      || Number(video.total_segments || 0) > 0
      || Number(video.word_count || 0) > 0
    );
    return hasSource && hasLearningContent;
  }

  function isMobile(environment) {
    const agent = compact(environment.navigator && environment.navigator.userAgent, '').toLowerCase();
    const phone = /mobile|android|iphone|ipod|blackberry|iemobile|opera mini/i.test(agent);
    const tablet = /ipad|android(?!.*mobile)|tablet/i.test(agent);
    return (phone && !tablet) || Number(environment.innerWidth || 1024) < 768;
  }

  function setTriggerState(trigger, state, options) {
    if (!trigger) return;
    if (!trigger.dataset) trigger.dataset = {};
    if (state === 'loading') {
      trigger.dataset.firstLessonIdleText = trigger.textContent || '';
      trigger.textContent = '正在准备 AI 首课…';
      if (trigger.setAttribute) {
        trigger.setAttribute('aria-disabled', 'true');
        trigger.setAttribute('aria-busy', 'true');
      }
      return;
    }
    if (trigger.removeAttribute) {
      trigger.removeAttribute('aria-disabled');
      trigger.removeAttribute('aria-busy');
    }
    if ((state === 'no-video' || state === 'error') && options && options.quietFailure) {
      if (trigger.dataset.firstLessonIdleText) trigger.textContent = trigger.dataset.firstLessonIdleText;
      delete trigger.dataset.firstLessonIdleText;
      return;
    }
    if (state === 'no-video') trigger.textContent = '暂时没有可用视频，点此重试';
    else if (state === 'error') trigger.textContent = '准备失败，点此重试';
    else if (trigger.dataset.firstLessonIdleText) trigger.textContent = trigger.dataset.firstLessonIdleText;
    delete trigger.dataset.firstLessonIdleText;
  }

  function createFirstLessonEntry(environment) {
    if (!environment) throw new Error('WINDOW_ENVIRONMENT_REQUIRED');
    let inFlight = null;

    function acquisitionContext() {
      let captured = null;
      try {
        captured = environment.LinglishAcquisition && environment.LinglishAcquisition.capture
          ? environment.LinglishAcquisition.capture()
          : null;
      } catch (_) { }
      const params = new URLSearchParams(environment.location && environment.location.search || '');
      return Object.assign({}, captured || {}, {
        visitor_id: createVisitorId(environment),
        source: captured && captured.first_source || params.get('utm_source') || params.get('from') || 'direct',
        campaign: captured && captured.first_campaign || params.get('utm_campaign') || null,
        landing_path: captured && captured.first_landing_path || environment.location && environment.location.pathname || '/',
      });
    }

    function postEvent(eventName, properties) {
      if (typeof environment.fetch !== 'function') return;
      const context = acquisitionContext();
      const token = readUsableToken(environment);
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      environment.fetch('/track/event', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          event_name: eventName,
          visitor_id: context.visitor_id,
          properties: Object.assign({}, context, properties || {}),
        }),
        keepalive: true,
      }).catch(function () { });
    }

    async function requestJson(url, options) {
      const response = await environment.fetch(url, options);
      const payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        const error = new Error(payload.message || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return payload;
    }

    function loginRequiredError() {
      const error = new Error('LOGIN_REQUIRED');
      error.code = 'LOGIN_REQUIRED';
      error.status = 401;
      return error;
    }

    function anonymousStarterUrl(source) {
      const params = new URLSearchParams({ from: source, starter: '1' });
      return `./today.html?${params.toString()}`;
    }

    async function ensureToken() {
      const existing = readUsableToken(environment);
      if (existing) return existing;
      if (readRawToken(environment)) await clearToken(environment);
      throw loginRequiredError();
    }

    function authenticatedHeaders(token) {
      return { Authorization: `Bearer ${token}` };
    }

    async function validateToken(token) {
      await requestJson('/auth/profile', { headers: authenticatedHeaders(token) });
    }

    async function resolveVideoId(token, preferredVideoId) {
      await validateToken(token);
      const preferred = compact(preferredVideoId, '');
      if (preferred) {
        try {
          const payload = await requestJson(`/video-resources/${encodeURIComponent(preferred)}`, {
            headers: authenticatedHeaders(token),
          });
          if (isPlayableFirstLessonVideo(payload && payload.video)) return compact(payload.video.id, '');
        } catch (error) {
          if (!error || error.status !== 404) throw error;
        }
      }
      const payload = await requestJson('/video-resources?lite=1', {
        headers: authenticatedHeaders(token),
      });
      const video = pickFirstLessonVideo(payload);
      return video && video.id ? video.id : null;
    }

    function start(options) {
      if (inFlight) return inFlight;
      const config = options || {};
      const trigger = config.trigger || null;
      setTriggerState(trigger, 'loading');
      inFlight = (async function () {
        const context = acquisitionContext();
        const source = compact(config.source, 'landing_first_lesson');
        postEvent('first_lesson_entry_click', { source });
        try {
          let token = await ensureToken();
          let videoId;
          try {
            videoId = await resolveVideoId(token, config.videoId);
          } catch (error) {
            if (!error || error.status !== 401) throw error;
            await clearToken(environment);
            throw loginRequiredError();
          }
          if (!videoId) {
            const error = new Error('FIRST_LESSON_VIDEO_UNAVAILABLE');
            error.code = 'FIRST_LESSON_VIDEO_UNAVAILABLE';
            throw error;
          }
          const destination = buildDestination({
            mobile: config.mobile === undefined ? isMobile(environment) : Boolean(config.mobile),
            source,
            level: config.level,
            videoId,
          });
          postEvent('first_lesson_entry_ready', { source, video_resource_id: videoId });
          environment.location.assign(destination);
          return destination;
        } catch (error) {
          if (error && error.code === 'LOGIN_REQUIRED') {
            const destination = anonymousStarterUrl(source);
            postEvent('first_lesson_starter_ready', { source });
            environment.location.assign(destination);
            inFlight = null;
            return destination;
          }
          setTriggerState(trigger, error && error.code === 'FIRST_LESSON_VIDEO_UNAVAILABLE' ? 'no-video' : 'error', {
            quietFailure: config.quietFailure === true,
          });
          postEvent('first_lesson_entry_error', {
            source,
            status: error && error.status || null,
            code: compact(error && (error.code || error.message), 'unknown_error').slice(0, 120),
          });
          inFlight = null;
          throw error;
        }
      })();
      return inFlight;
    }

    return { buildDestination, start };
  }

  return { buildDestination, createFirstLessonEntry };
});
