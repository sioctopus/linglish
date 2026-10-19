/* Mobile Today Page - Kid-first daily plan */
(function () {
  'use strict';

  const API_BASE = (() => {
    if (typeof window !== 'undefined') {
      if (window.API_BASE) return window.API_BASE;
      if (window.API_PREFIX) return window.API_PREFIX;
    }
    if (window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.port === '4000') {
      return 'http://localhost:4000';
    }
    return '';
  })();

  const STORAGE = {
    profile: 'linglish_profile_mode', // 'student' | 'advanced' (legacy: 'kid' | 'adult')
    todayVideoKid: 'linglish_today_video_kid',
    todayVideoAdult: 'linglish_today_video_adult',
    dueBaseline: 'linglish_today_due_baseline',
    practiceProgress: 'linglish_today_practice_progress',
    autoNext: 'linglish_today_auto_next', // 'prompt' | 'review' | 'today'
    autoNextUserSet: 'linglish_today_auto_next_user_set', // '1' when user explicitly changed
    activeLevel: 'linglish_active_level',
    onboardingGoal: 'linglish_onboarding_goal',
    onboardingMinutes: 'linglish_onboarding_daily_minutes',
    pendingProfileSync: 'linglish_onboarding_pending_profile_sync',
    visitorId: 'linglish_visitor_id',
  };

  const DAILY_SENTENCE_TARGET = 5;
  const MODE = {
    student: { key: 'student', goalMin: 10, watchTargetSec: 120, reviewTargetDelta: 3, practiceHint: '跟读5句' },
    advanced: { key: 'advanced', goalMin: 15, watchTargetSec: 300, reviewTargetDelta: 5, practiceHint: '跟读5句' },
  };

  let serverGamify = { today: null, weeklyXp: null, leaderboard: [], achievements: [], selfUserId: null, dueCount: null };
  let pronunciationProfile = null;
  let pronunciationProfileController = null;
  let todayUserInfo = null;

  const FEEDBACK_QUEUE_KEY = 'plan_feedback_queue';
  const FEEDBACK_QUEUE_MAX = 50;

  function loadFeedbackQueue() {
    try { return JSON.parse(localStorage.getItem(FEEDBACK_QUEUE_KEY)) || []; }
    catch (_) { return []; }
  }

  function saveFeedbackQueue(q) {
    try { localStorage.setItem(FEEDBACK_QUEUE_KEY, JSON.stringify(q.slice(-FEEDBACK_QUEUE_MAX))); }
    catch (_) {}
  }

  // 幂等ID:请求已提交但响应丢失时重放不会被后端计成第二条
  // (一次"太难了"变两次刚好触到 HARD_THRESHOLD,会把难度降一档 14 天)
  function newFeedbackClientId() {
    return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  function withClientId(payload) {
    if (payload.action === 'rating') return payload; // rating 由后端"每日一条"唯一索引兜底
    return payload.clientId ? payload : { ...payload, clientId: newFeedbackClientId() };
  }

  function feedbackKey(p) {
    return p.clientId || `${p.itemType}|${p.action}|${p.rating ?? ''}`;
  }

  async function postFeedback(payload) {
    const token = localStorage.getItem('linglish_token');
    if (!token) return false;
    try {
      const r = await fetch(`${API_BASE}/api/learning/plan-feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      return r.ok || r.status === 409; // 409=当日已评分,视为已消费,不重试
    } catch (_) { return false; }
  }

  async function submitFeedback(rawPayload) {
    const payload = withClientId(rawPayload);
    const ok = await postFeedback(payload);
    if (!ok) saveFeedbackQueue([...loadFeedbackQueue(), payload]);
    return ok;
  }

  async function flushFeedbackQueue() {
    const snapshot = loadFeedbackQueue();
    if (!snapshot.length) return;
    const sent = new Set();
    for (const p of snapshot) {
      if (await postFeedback(withClientId(p))) sent.add(feedbackKey(p));
    }
    if (!sent.size) return;
    // 重新读取而不是覆盖快照:flush 期间新入队的反馈不能被丢掉
    saveFeedbackQueue(loadFeedbackQueue().filter(p => !sent.has(feedbackKey(p))));
  }

  const QUEST_FEEDBACK_MAP = {
    'quest-sentences': 'shadowing',
  };
  const LONG_PRESS_MS = 550;

  function bindQuestFeedback() {
    Object.entries(QUEST_FEEDBACK_MAP).forEach(([id, itemType]) => {
      const el = document.getElementById(id);
      if (!el) return;
      let timer = null;
      const start = () => {
        timer = setTimeout(() => showQuestFeedbackSheet(itemType), LONG_PRESS_MS);
      };
      const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
      el.addEventListener('touchstart', start, { passive: true });
      el.addEventListener('touchend', cancel);
      el.addEventListener('touchmove', cancel);
      el.addEventListener('contextmenu', e => e.preventDefault());
    });
  }

  function showQuestFeedbackSheet(itemType) {
    document.querySelectorAll('.quest-feedback-sheet').forEach(s => s.remove());
    const sheet = document.createElement('div');
    sheet.className = 'quest-feedback-sheet';
    const options = [
      { action: 'too_hard', label: '😵 太难了' },
      { action: 'too_easy', label: '😴 太简单' },
      { action: 'boring', label: '🥱 不感兴趣' },
    ];
    options.forEach(({ action, label }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', async () => {
        sheet.remove();
        await submitFeedback({ itemType, action });
        window.GlobalUI?.showToast('已收到反馈,明日计划会参考', 'success');
      });
      sheet.appendChild(b);
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sheet-cancel';
    close.textContent = '取消';
    close.addEventListener('click', () => sheet.remove());
    sheet.appendChild(close);
    document.body.appendChild(sheet);
  }

  async function loadDueCount() {
    const token = localStorage.getItem('linglish_token');
    if (!token) return null;
    try {
      const r = await fetch('/vocab/review-queue?limit=50', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return null;
      const d = await r.json();
      return Array.isArray(d.items) ? d.items.length : null;
    } catch (_) { return null; }
  }

  async function loadServerGamify(selfUserId) {
    const token = localStorage.getItem('linglish_token');
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };
    const safeJson = r => (r && r.ok ? r.json() : null);
    // Match on both the browser-local calendar date and the UTC date. The backend serializes
    // its DATE column via Postgres->JSON (UTC-based toISOString()), while the browser's own
    // "today" is local-calendar. In timezones ahead of UTC (e.g. Asia/Shanghai, UTC+8), local
    // activity between 00:00-08:00 local still serializes to the previous UTC date, so a
    // single-sided local-date comparison can silently miss today's row for that whole window.
    // Accepting a match on either avoids that miss without risking a match on yesterday's row
    // (which would need both TZ representations to equal today's, which they don't).
    const localTodayStr = getTodayStr();
    const utcTodayStr = new Date().toISOString().slice(0, 10);
    try {
      // days=7 matches the leaderboard's own "CURRENT_DATE - 6" weekly window, so summing
      // xp_earned here yields a weekly figure comparable to board[i].weekly_xp (same unit).
      const [daily, board, achievements, dueCount] = await Promise.all([
        fetch('/api/stats/daily?days=7', { headers }).then(safeJson).catch(() => null),
        fetch('/api/stats/leaderboard?limit=3', { headers }).then(safeJson).catch(() => null),
        window.gamificationSystem
          ? window.gamificationSystem.fetchServerAchievements()
          : Promise.resolve([]),
        loadDueCount(),
      ]);
      const dailyRows = (daily && Array.isArray(daily.data)) ? daily.data : [];
      const today = dailyRows.find(r => {
        const d = typeof r?.date === 'string' ? r.date.slice(0, 10) : null;
        return d === localTodayStr || d === utcTodayStr;
      }) || null;
      const weeklyXp = dailyRows.length
        ? dailyRows.reduce((sum, r) => sum + (Number(r.xp_earned) || 0), 0)
        : null;
      serverGamify = {
        today,
        weeklyXp,
        leaderboard: (board && board.leaderboard) || [],
        achievements: achievements || [],
        selfUserId: selfUserId ?? null,
        dueCount,
      };
    } catch (_) { /* 静默降级:保持空值,面板走原有本地逻辑 */ }
  }

  function readTodaySpokenLines() {
    const today = getTodayStr();
    let lines = 0;
    try {
      const saved = safeJsonParse(localStorage.getItem('linglish_first_lesson_completion'), null);
      if (saved && saved.date === today) lines = Math.max(lines, Number(saved.lines) || 0);
    } catch (_) { }
    try {
      const practice = safeJsonParse(localStorage.getItem(STORAGE.practiceProgress), null);
      if (practice && practice.date === today) {
        const done = Array.isArray(practice.done) ? practice.done.length : (Number(practice.doneCount) || 0);
        lines = Math.max(lines, done);
      }
    } catch (_) { }
    return lines;
  }

  function dailySentenceNote(spoken) {
    if (spoken >= DAILY_SENTENCE_TARGET) return '今天的 5 句说完了。可以停在这里。';
    if (spoken > 0) return `已开口 ${spoken} 句。再说一句，或今天到这。`;
    return '说完这一句，今天就算开始。说到 5 句可以停。';
  }

  function getTodayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function toLocalDateStr(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (!d || Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function getTodayLabel() {
    const d = new Date();
    const week = ['日', '一', '二', '三', '四', '五', '六'];
    return `${d.getMonth() + 1}月${d.getDate()}日 周${week[d.getDay()]}`;
  }

  function safeJsonParse(raw, fallback) {
    if (!raw || raw === 'null' || raw === 'undefined') return fallback;
    try { return JSON.parse(raw); } catch (_) { return fallback; }
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function getToken() {
    const keys = ['linglish_token', 'authToken'];
    for (const k of keys) {
      try {
        const v = localStorage.getItem(k);
        if (v && v !== 'null' && v !== 'undefined') return v;
      } catch (_) { }
    }
    for (const k of keys) {
      try {
        const v = sessionStorage.getItem(k);
        if (v && v !== 'null' && v !== 'undefined') return v;
      } catch (_) { }
    }
    try {
      const am = window.authManager;
      if (am && typeof am.getToken === 'function') {
        const v = am.getToken();
        if (v) return v;
      }
      if (am && typeof am.getUserInfo === 'function') {
        const info = am.getUserInfo();
        if (info && info.token) return info.token;
      }
    } catch (_) { }
    return null;
  }

  function headers(token) {
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }

  function getVisitorId() {
    try {
      const existing = localStorage.getItem(STORAGE.visitorId);
      if (/^llv_[a-zA-Z0-9_-]{12,64}$/.test(existing || '')) return existing;
      const random = window.crypto?.getRandomValues
        ? Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
        : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
      const visitorId = `llv_${random}`.slice(0, 68);
      localStorage.setItem(STORAGE.visitorId, visitorId);
      return visitorId;
    } catch (_) {
      return null;
    }
  }

  async function fetchJson(path, token) {
    const res = await fetch(`${API_BASE}${path}`, { headers: headers(token) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function postEvent(token, eventName, properties = {}) {
    if (!token) return;
    try {
      const visitorId = getVisitorId();
      fetch(`${API_BASE}/events`, {
        method: 'POST',
        headers: {
          ...headers(token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          event_name: eventName,
          visitor_id: visitorId,
          properties: {
            page: 'mobile-today',
            visitor_id: visitorId,
            ...properties,
          },
          source: 'mobile_web',
        }),
        keepalive: true,
      }).catch(() => { });
    } catch (_) { }
  }

  function getPronunciationProfileController(token) {
    if (pronunciationProfileController) return pronunciationProfileController;
    const profileUI = window.LinglishPronunciationProfile;
    const section = document.getElementById('pronunciation-profile-section');
    const container = document.getElementById('pronunciation-profile-mount');
    if (!profileUI?.createTodayProfileController
      || !profileUI?.createPronunciationEventTransport
      || !section || !container) {
      if (section) section.hidden = true;
      return null;
    }
    const emit = profileUI.createPronunciationEventTransport({
      fetch: (...args) => fetch(...args),
      getToken: () => token || getToken(),
      endpoint: `${API_BASE}/events`,
      source: 'mobile_web',
    });
    pronunciationProfileController = profileUI.createTodayProfileController({
      section,
      container,
      mobile: true,
      requestProfile: () => fetchJson('/pronunciation/profile?limit=3', token),
      emit,
    });
    return pronunciationProfileController;
  }

  function getDayOfYearIndex(size) {
    if (!size) return 0;
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    const diff = now - start;
    const oneDay = 1000 * 60 * 60 * 24;
    const dayOfYear = Math.floor(diff / oneDay);
    return dayOfYear % size;
  }

  function setProfileMode(modeKey) {
    try { localStorage.setItem(STORAGE.profile, modeKey); } catch (_) { }
  }

  function getLocalOnboardingProfile() {
    try {
      const rawLevel = localStorage.getItem(STORAGE.activeLevel) || localStorage.getItem('vocab_difficulty_filter') || '';
      const level = ['beginner', 'intermediate', 'advanced'].includes(rawLevel) ? rawLevel : null;
      const minutes = Number(localStorage.getItem(STORAGE.onboardingMinutes) || '');
      const goal = String(localStorage.getItem(STORAGE.onboardingGoal) || '').trim();
      return {
        level,
        dailyGoal: Number.isFinite(minutes) && minutes >= 5 && minutes <= 180 ? Math.round(minutes) : null,
        goal: goal || null,
        hasProfile: Boolean(level || goal || minutes),
      };
    } catch (_) {
      return { level: null, dailyGoal: null, goal: null, hasProfile: false };
    }
  }

  function profileToMode(profile) {
    if (!profile) return null;
    if (profile.level === 'advanced' || Number(profile.dailyGoal) >= 15) return MODE.advanced.key;
    if (profile.level === 'intermediate' && Number(profile.dailyGoal) > 10) return MODE.advanced.key;
    if (profile.level || profile.dailyGoal) return MODE.student.key;
    return null;
  }

  function getProfileMode() {
    try {
      const v = localStorage.getItem(STORAGE.profile);
      // Backward compatible: old values 'kid'/'adult'
      if (v === 'adult') return MODE.advanced.key;
      if (v === 'kid') return MODE.student.key;
      if (v === MODE.advanced.key) return MODE.advanced.key;
      if (v === MODE.student.key) return MODE.student.key;
    } catch (_) { }
    return profileToMode(getLocalOnboardingProfile()) || MODE.student.key;
  }

  function hasUserSetAutoNext() {
    try {
      return localStorage.getItem(STORAGE.autoNextUserSet) === '1';
    } catch (_) { }
    return false;
  }

  function getDefaultAutoNextForMode(modeKey) {
    return modeKey === MODE.advanced.key ? 'prompt' : 'review';
  }

  function getAutoNextSetting(modeKey) {
    try {
      const v = localStorage.getItem(STORAGE.autoNext);
      if (v === 'review' || v === 'today' || v === 'prompt') return v;
    } catch (_) { }
    return getDefaultAutoNextForMode(modeKey);
  }

  function setAutoNextSetting(value, { userSet = true } = {}) {
    try { localStorage.setItem(STORAGE.autoNext, value); } catch (_) { }
    if (userSet) {
      try { localStorage.setItem(STORAGE.autoNextUserSet, '1'); } catch (_) { }
    }
  }

  function updateAutoNextUI(value) {
    // Updated IDs: setting-prompt, setting-review, setting-today
    const promptBtn = document.getElementById('setting-prompt');
    const reviewBtn = document.getElementById('setting-review');
    const todayBtn = document.getElementById('setting-today');
    if (!promptBtn || !reviewBtn || !todayBtn) return;
    promptBtn.classList.toggle('active', value === 'prompt');
    reviewBtn.classList.toggle('active', value === 'review');
    todayBtn.classList.toggle('active', value === 'today');
  }

  function bindAutoNextSetting() {
    // Updated IDs: setting-prompt, setting-review, setting-today
    const promptBtn = document.getElementById('setting-prompt');
    const reviewBtn = document.getElementById('setting-review');
    const todayBtn = document.getElementById('setting-today');
    if (!promptBtn || !reviewBtn || !todayBtn) return;

    const set = (v) => {
      setAutoNextSetting(v, { userSet: true });
      updateAutoNextUI(v);
    };
    promptBtn.addEventListener('click', () => set('prompt'));
    reviewBtn.addEventListener('click', () => set('review'));
    todayBtn.addEventListener('click', () => set('today'));
  }

  function updateModeUI(modeKey) {
    const isStudent = modeKey === MODE.student.key;

    // Updated IDs: mode-student, mode-advanced (buttons)
    const studentBtn = document.getElementById('mode-student');
    const advancedBtn = document.getElementById('mode-advanced');
    if (studentBtn) studentBtn.classList.toggle('active', isStudent);
    if (advancedBtn) advancedBtn.classList.toggle('active', !isStudent);

    // Update hero goal text
    const heroGoal = document.querySelector('.hero-goal');
    if (heroGoal) {
      heroGoal.textContent = '说到 5 句可以停';
    }
  }

  async function loadUserHeader(token) {
    try {
      if (!token) return null;
      const info = await fetchJson('/users/me', token).catch(() => null);
      if (!info) return null;

      // Updated ID: hero-greeting for personalized greeting
      const greetingEl = document.getElementById('hero-greeting');
      if (greetingEl) {
        const hour = new Date().getHours();
        let timeGreeting = '早上好';
        if (hour >= 12 && hour < 18) timeGreeting = '下午好';
        else if (hour >= 18) timeGreeting = '晚上好';
        const name = info.username || info.email?.split('@')[0] || 'User';
        greetingEl.textContent = `${timeGreeting}, ${name}`;
      }

      const vipBadge = document.getElementById('mobile-vip-badge');
      if (vipBadge) {
        const tier = info.membership_tier || info.tier || null;
        if (tier && tier !== 'free') {
          vipBadge.style.display = 'inline-flex';
        }
      }
      return info;
    } catch (_) { }
    return null;
  }

  async function syncPendingOnboardingProfile(token) {
    const profile = getLocalOnboardingProfile();
    if (!token || !profile.hasProfile) return false;
    let shouldSync = false;
    try {
      shouldSync = localStorage.getItem(STORAGE.pendingProfileSync) === '1';
    } catch (_) { }
    if (!shouldSync) return false;

    const payload = {
      level: profile.level || 'beginner',
      daily_goal: profile.dailyGoal || undefined,
      interests: profile.goal ? [profile.goal] : undefined,
    };
    try {
      const res = await fetch(`${API_BASE}/auth/profile`, {
        method: 'PUT',
        headers: {
          ...headers(token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        try { localStorage.removeItem(STORAGE.pendingProfileSync); } catch (_) { }
        return true;
      }
    } catch (_) { }
    return false;
  }

  function getLevelLabel(level) {
    if (level === 'advanced') return '高级';
    if (level === 'intermediate') return '中级';
    return '初级';
  }

  function renderPrescription(user, modeKey) {
    const localProfile = getLocalOnboardingProfile();
    const userDailyGoal = Number(user?.daily_goal);
    const userInterests = Array.isArray(user?.interests) ? user.interests : [];
    const level = user?.current_vocabulary_level || user?.level || localProfile.level || (modeKey === MODE.advanced.key ? 'intermediate' : 'beginner');
    const dailyGoal = Number.isFinite(userDailyGoal) && userDailyGoal > 0
      ? Math.round(userDailyGoal)
      : (localProfile.dailyGoal || (modeKey === MODE.advanced.key ? MODE.advanced.goalMin : MODE.student.goalMin));
    const goal = userInterests[0] || localProfile.goal || (modeKey === MODE.advanced.key ? '真实场景表达' : '日常表达');
    const levelLabel = getLevelLabel(level);

    const title = document.getElementById('prescription-title');
    const copy = document.getElementById('prescription-copy');
    const badge = document.getElementById('prescription-badge');
    const rxLevel = document.getElementById('rx-level');
    const rxMinutes = document.getElementById('rx-minutes');
    const rxGoal = document.getElementById('rx-goal');
    const heroGoal = document.querySelector('.hero-goal');

    if (title) title.textContent = '今天的句子';
    if (copy) copy.textContent = '说完这一句，今天就算开始。说到 5 句可以停。';
    if (badge) badge.textContent = modeKey === MODE.advanced.key ? '进阶' : '轻量';
    if (rxLevel) rxLevel.textContent = levelLabel;
    if (rxMinutes) rxMinutes.textContent = `${dailyGoal} 分钟`;
    if (rxGoal) rxGoal.textContent = goal;
    if (heroGoal) heroGoal.textContent = '说到 5 句可以停';
  }

  function bindPrescriptionActions(token) {
    const upgrade = document.getElementById('rx-upgrade');
    const report = document.getElementById('rx-report');
    if (upgrade) {
      upgrade.addEventListener('click', () => postEvent(token, 'mobile_today_upgrade_click', { target: 'pricing' }));
    }
    if (report) {
      report.addEventListener('click', () => postEvent(token, 'mobile_today_report_click', { target: 'learning_reports' }));
    }
  }

  function parseEventSecondsToday(events, eventName, todayStr, videoId) {
    if (!Array.isArray(events)) return 0;
    let total = 0;
    for (const e of events) {
      if (!e || e.event_name !== eventName) continue;
      const t = e.event_time ? new Date(e.event_time) : null;
      const d = t ? toLocalDateStr(t) : null;
      if (!d || d !== todayStr) continue;
      const props = e.properties || {};
      if (videoId && String(props.video_resource_id || '') !== String(videoId)) continue;
      const s = Number(props.seconds) || 0;
      total += s;
    }
    return total;
  }

  function normalizeToken(s) {
    return String(s || '').trim().toLowerCase();
  }

  function extractTagTokens(video) {
    const tokens = [];
    const push = (x) => {
      const t = normalizeToken(x);
      if (t) tokens.push(t);
    };
    if (!video) return tokens;
    push(video.category);
    push(video.difficulty_level);
    push(video.title);
    push(video.description);
    const tags = Array.isArray(video.tags) ? video.tags : [];
    for (const t of tags) {
      if (typeof t === 'string') push(t);
      else if (t && typeof t === 'object' && typeof t.name === 'string') push(t.name);
    }
    return tokens;
  }

  function resolveThumbnail(video) {
    if (!video) return null;

    const normalizeUrl = (input) => {
      if (!input) return null;
      if (/^https?:\/\//i.test(input)) return input;
      const base = API_BASE || '';
      const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
      const normalizedPath = input.startsWith('/') ? input : `/${input}`;
      return `${normalizedBase}${normalizedPath}`;
    };

    // Prefer YouTube thumbnails when available (they tend to be stable)
    const youtubeId = video.youtube_video_id;
    if (youtubeId) {
      return `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`;
    }

    const candidateRaw = video.thumbnail_url || video.thumbnail_path || null;
    const candidateUrl = normalizeUrl(candidateRaw);
    if (candidateUrl) return candidateUrl;

    try {
      const raw = video.video_path || '';
      const base = raw.split('/').pop() || '';
      const stem = base ? base.replace(/\\.[^/.]+$/, '') : '';
      if (stem) return normalizeUrl(`/static/thumbnails/${stem}.jpg`);
    } catch (_) { }

    return null;
  }

  function formatDuration(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!s) return null;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function formatDifficulty(raw) {
    const v = normalizeToken(raw);
    if (!v) return null;
    if (v.includes('easy') || v.includes('begin') || v.includes('a1') || v.includes('初')) return { label: '简单', tone: 'success' };
    if (v.includes('hard') || v.includes('advanced') || v.includes('c1') || v.includes('c2') || v.includes('难')) return { label: '挑战', tone: 'warning' };
    if (v.includes('medium') || v.includes('intermediate') || v.includes('b1') || v.includes('b2') || v.includes('中')) return { label: '适中', tone: 'primary' };
    return { label: String(raw).slice(0, 12), tone: 'primary' };
  }

  function getThemeLabel(video) {
    const tokens = extractTagTokens(video);
    const themes = [
      { key: '动画', kws: ['动画', 'cartoon', 'animation'] },
      { key: '校园', kws: ['校园', '学校', 'classroom', 'school'] },
      { key: '亲子', kws: ['亲子', 'kids', 'kid', 'children', '儿童', '少儿'] },
      { key: '职场', kws: ['职场', 'work', 'workplace', 'office'] },
      { key: '商务', kws: ['商务', 'business', 'meeting', 'email', '邮件', '会议'] },
      { key: '面试', kws: ['面试', 'interview', 'resume', '简历'] },
      { key: '日常', kws: ['daily', 'conversation', '日常', '对话'] },
      { key: '旅行', kws: ['travel', 'trip', 'tour', '旅行'] },
    ];
    for (const t of themes) {
      if (matchesAny(tokens, t.kws)) return t.key;
    }
    const cat = (video && video.category) ? String(video.category).trim() : '';
    if (cat) return cat.slice(0, 10);
    return null;
  }

  function boundedRouteValue(raw, maxLength, pattern) {
    const value = String(raw || '')
      .replace(/[\u0000-\u001f\u007f<>"']/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);
    return value && (!pattern || pattern.test(value)) ? value : '';
  }

  function roleplayScenarioForTheme(theme, modeKey) {
    const normalized = String(theme || '').toLowerCase();
    if (/面试|interview|resume/.test(normalized)) return 'job-interview-b1';
    if (/会议|商务|职场|meeting|business|office|work/.test(normalized)) return 'meeting-clarify-b1';
    if (/酒店|hotel|check.?in/.test(normalized)) return 'hotel-checkin-a2';
    if (/旅行|改签|travel|trip|flight/.test(normalized)) return 'travel-rebook-a2';
    if (/咖啡|点单|coffee|order/.test(normalized)) return 'coffee-order-a1';
    return modeKey === MODE.advanced.key ? 'meeting-clarify-b1' : 'colleague-smalltalk-a1';
  }

  function getDisplayTags(video, limit = 5) {
    const tags = Array.isArray(video?.tags) ? video.tags : [];
    const out = [];
    for (const t of tags) {
      if (out.length >= limit) break;
      if (typeof t === 'string') {
        const s = t.trim();
        if (s) out.push(s);
      } else if (t && typeof t === 'object' && typeof t.name === 'string') {
        const s = t.name.trim();
        if (s) out.push(s);
      }
    }
    return out;
  }

  function renderVideoMeta(video) {
    // Simplified meta: only duration and theme in badges
    const durationEl = document.getElementById('meta-duration');
    const themeEl = document.getElementById('meta-theme');

    if (!video) return;

    // Update duration
    const duration = formatDuration(video.duration_sec);
    if (durationEl) {
      durationEl.textContent = duration || '1:30';
    }

    // Update theme
    const theme = getThemeLabel(video);
    if (themeEl) {
      themeEl.textContent = theme || '日常';
    }
  }

  function matchesAny(tokens, keywords) {
    if (!Array.isArray(tokens) || tokens.length === 0) return false;
    for (const k of keywords) {
      const kk = normalizeToken(k);
      if (!kk) continue;
      for (const t of tokens) {
        if (t.includes(kk)) return true;
      }
    }
    return false;
  }

  function buildTodayPool(items, modeKey) {
    const list = Array.isArray(items) ? items.slice() : [];
    if (list.length === 0) return [];
    const withDuration = list.filter(v => Number.isFinite(Number(v?.duration_sec)) && Number(v.duration_sec) > 0);
    const withoutDuration = list.filter(v => !(Number.isFinite(Number(v?.duration_sec)) && Number(v.duration_sec) > 0));

    const studentKeywords = [
      'kids', 'kid', 'cartoon', 'animation', 'phonics', 'alphabet',
      '儿童', '少儿', '动画', '亲子', '学校', '课堂', '学生'
    ];
    const advancedKeywords = [
      'business', 'work', 'workplace', 'office', 'meeting', 'email', 'interview', 'resume',
      '职场', '商务', '会议', '邮件', '面试', '简历'
    ];

    const scored = list.map(v => {
      const tokens = extractTagTokens(v);
      const studentHit = matchesAny(tokens, studentKeywords);
      const advancedHit = matchesAny(tokens, advancedKeywords);
      return { v, tokens, studentHit, advancedHit };
    });

    // Student: prefer tagged kids/cartoon, then easy/short
    if (modeKey === MODE.student.key) {
      const tagged = scored.filter(x => x.studentHit).map(x => x.v);
      const shortEnough = withDuration.filter(v => Number(v.duration_sec) <= 120);
      // Soft preference: start from tagged, but allow filling with short videos for variety.
      const poolBase = (tagged.length ? tagged : [])
        .concat(shortEnough.filter(v => !tagged.some(t => String(t?.id) === String(v?.id))))
        .concat(withDuration.filter(v => !tagged.some(t => String(t?.id) === String(v?.id))));
      const pool = (poolBase.length ? poolBase : (withDuration.length ? withDuration : withoutDuration))
        .slice()
        .sort((a, b) => {
          const da = Number(a?.duration_sec);
          const db = Number(b?.duration_sec);
          const aOk = Number.isFinite(da) && da > 0;
          const bOk = Number.isFinite(db) && db > 0;
          if (aOk && bOk) return da - db;
          if (aOk && !bOk) return -1;
          if (!aOk && bOk) return 1;
          return String(a?.id || '').localeCompare(String(b?.id || ''));
        })
        .slice(0, 50);
      return pool.length ? pool : list;
    }

    // Advanced: prefer workplace/business, then 90-300s
    const tagged = scored.filter(x => x.advancedHit).map(x => x.v);
    const mid = withDuration.filter(v => Number(v.duration_sec) >= 90 && Number(v.duration_sec) <= 300);
    // Soft preference: start from tagged, but allow filling with mid-length content.
    const poolBase = (tagged.length ? tagged : [])
      .concat(mid.filter(v => !tagged.some(t => String(t?.id) === String(v?.id))))
      .concat(withDuration.filter(v => !tagged.some(t => String(t?.id) === String(v?.id))));
    const pool = (poolBase.length ? poolBase : (withDuration.length ? withDuration : withoutDuration))
      .slice()
      .sort((a, b) => {
        const da = Number(a?.duration_sec);
        const db = Number(b?.duration_sec);
        const aOk = Number.isFinite(da) && da > 0;
        const bOk = Number.isFinite(db) && db > 0;
        if (aOk && bOk) return da - db;
        if (aOk && !bOk) return -1;
        if (!aOk && bOk) return 1;
        return String(a?.id || '').localeCompare(String(b?.id || ''));
      })
      .slice(0, 80);
    return pool.length ? pool : list;
  }

  // 后端推荐字段 → 本页使用的 video_resources 字段
  function normalizeRecommendedVideo(video) {
    return {
      ...video,
      duration_sec: video.duration_sec ?? video.duration ?? null,
      thumbnail_path: video.thumbnail_path ?? video.thumbnail ?? null,
      difficulty_level: video.difficulty_level ?? video.level ?? null,
    };
  }

  // 登录用户优先用后端个性化推荐(排除已看过、匹配目标与难度),失败回退本地轮换
  async function resolveRecommendedVideo(token) {
    const client = window.VideoRecommendationClient;
    if (!token || !client) return null;
    const videos = await client.fetchRecommendedVideos({ apiBase: API_BASE, limit: 1, token });
    const picked = videos.find(v => v && v.id && !v.watched);
    if (!picked) return null;
    postEvent(token, 'reco_impression', client.eventProps(picked, 'today', 0));
    return normalizeRecommendedVideo(picked);
  }

  async function resolveTodayVideo(token, modeKey, { preferRecommended = false } = {}) {
    if (preferRecommended) {
      const recommended = await resolveRecommendedVideo(token).catch(() => null);
      if (recommended) return recommended;
    }
    const todayStr = getTodayStr();
    const cacheKey = modeKey === MODE.advanced.key ? STORAGE.todayVideoAdult : STORAGE.todayVideoKid;
    const data = await fetchJson('/video-resources?lite=1', token);
    const items = Array.isArray(data?.videos) ? data.videos : (Array.isArray(data?.items) ? data.items : (Array.isArray(data) ? data : []));
    const usable = items.filter(v => v && v.id && (v.status === 'ready' || v.status === 'active' || !v.status));
    const pool = buildTodayPool(usable, modeKey);
    if (!pool.length) return null;

    const stored = safeJsonParse(localStorage.getItem(cacheKey), null);
    const hasStoredToday = stored && stored.date === todayStr && Number.isFinite(Number(stored.index));
    const startIndex = getDayOfYearIndex(pool.length);
    const nextIndex = hasStoredToday ? ((Number(stored.index) + 1) % pool.length) : startIndex;
    const picked = pool[nextIndex] || pool[0];
    try {
      localStorage.setItem(cacheKey, JSON.stringify({
        date: todayStr,
        index: nextIndex,
        videoId: picked?.id || null,
      }));
    } catch (_) { }
    return picked;
  }

  // Update circular progress ring animation
  function updateProgressRing(percent) {
    const circle = document.getElementById('progress-ring-fill');
    if (!circle) return;
    const radius = Number(circle.getAttribute('r')) || 70;
    const circumference = 2 * Math.PI * radius;
    circle.style.strokeDasharray = `${circumference}`;
    const offset = circumference - (percent / 100 * circumference);
    circle.style.strokeDashoffset = offset;
  }

  // Show celebration overlay
  function showCelebration() {
    const overlay = document.getElementById('celebration-overlay');
    if (!overlay) return;
    overlay.style.opacity = '1';
    overlay.style.pointerEvents = 'auto';
    setTimeout(() => {
      overlay.style.opacity = '0';
      overlay.style.pointerEvents = 'none';
    }, 3000);
  }

  async function refreshStats(token, video) {
    const todayStr = getTodayStr();

    const state = {
      watchSecondsTotal: 0,
      watchSecondsVideo: 0,
      due: 0,
      streak: 0,
      baselineDue: null,
      practiceDone: 0,
      practiceTarget: null,
    };

    let streak = 0;
    try {
      const stats = await fetchJson('/training/stats', token);
      streak = Number(stats?.streak_days) || 0;
    } catch (_) { }
    // Updated ID: streak-days
    const streakEl = document.getElementById('streak-days');
    if (streakEl) streakEl.textContent = String(streak);
    state.streak = streak;

    let due = 0;
    try {
      const v = await fetchJson('/vocab/stats-summary', token);
      due = Number(v?.due) || 0;
    } catch (_) { }
    // Updated ID: stat-review
    const dueEl = document.getElementById('stat-review');
    if (dueEl) dueEl.textContent = String(due);
    state.due = due;

    // Due baseline (for "完成X个复习就领奖" 的判断)
    try {
      const raw = localStorage.getItem(STORAGE.dueBaseline);
      const baseline = safeJsonParse(raw, null);
      if (!baseline || baseline.date !== todayStr) {
        localStorage.setItem(STORAGE.dueBaseline, JSON.stringify({ date: todayStr, due }));
        state.baselineDue = due;
      } else {
        state.baselineDue = Number(baseline?.due);
      }
    } catch (_) { }

    let watchSeconds = 0;
    try {
      const ev = await fetchJson('/events?name=video_watch&limit=300', token);
      const items = Array.isArray(ev?.items) ? ev.items : [];
      state.watchSecondsTotal = parseEventSecondsToday(items, 'video_watch', todayStr, null);
      state.watchSecondsVideo = parseEventSecondsToday(items, 'video_watch', todayStr, video?.id || null);
    } catch (_) { }
    const watchMin = Math.floor((state.watchSecondsTotal || 0) / 60);
    // Note: Removed stat-watch, stat-practice, stat-review from hero card
    // New design only shows circular progress ring

    // Practice progress is tracked client-side by practice-session.html (kid-friendly, low friction)
    try {
      const raw = localStorage.getItem(STORAGE.practiceProgress);
      const p = safeJsonParse(raw, null);
      if (p && p.date === todayStr && (!video?.id || String(p.videoId) === String(video.id))) {
        const done = Array.isArray(p.done) ? p.done.length : (Number(p.doneCount) || 0);
        state.practiceDone = done;
        state.practiceTarget = Number(p.targetLines) || null;
      }
    } catch (_) { }

    return state;
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function setCoachLink(id, href, label) {
    const el = document.getElementById(id);
    if (!el) return;
    el.setAttribute('href', href);
    if (label) el.textContent = label;
  }

  function renderCoachBrief(modeKey, video, statsState) {
    const targetLines = DAILY_SENTENCE_TARGET;
    const profileInterests = Array.isArray(todayUserInfo?.interests) ? todayUserInfo.interests : [];
    const localGoal = getLocalOnboardingProfile().goal;
    const theme = boundedRouteValue(
      profileInterests[0] || localGoal || getThemeLabel(video) || (modeKey === MODE.advanced.key ? '职场表达' : '日常表达'),
      48,
      /^[\p{L}\p{N}\s_-]+$/u,
    ) || (modeKey === MODE.advanced.key ? '职场表达' : '日常表达');
    const practiceUrl = video && video.id
      ? `./video-reader.html?videoId=${encodeURIComponent(String(video.id))}&from=today_first_lesson&focus=first_lesson&mode=shadowing`
      : './video-reader.html?mode=shadowing&from=today_first_lesson&focus=first_lesson';
    const roleplayParams = new URLSearchParams({
      scenario: roleplayScenarioForTheme(theme, modeKey),
      from: 'mobile_today_coach',
    });
    roleplayParams.set('theme', theme);
    const roleplayUrl = `./ai-roleplay.html?${roleplayParams.toString()}`;

    const spoken = Math.min(targetLines, Math.max(Number(statsState?.practiceDone) || 0, readTodaySpokenLines()));
    const practiceDoneEnough = spoken >= targetLines;

    let title = '先听，再开口说这一句。';
    let summary = '说完这一句，今天就算开始。说到 5 句可以停。';
    let chip = `${spoken}/${targetLines}`;
    let primaryHref = practiceUrl;
    let primaryLabel = spoken > 0 ? '再来一句' : '开始说这一句';

    if (practiceDoneEnough) {
      title = '今天的 5 句说完了。';
      summary = '可以停在这里。想再练，就再来一句。';
      chip = `${targetLines}/${targetLines}`;
      primaryLabel = '再来一句';
    } else if (spoken > 0) {
      title = `已开口 ${spoken} 句。`;
      summary = '再说一句，或今天到这。';
      primaryLabel = '再来一句';
    } else if (!video || !video.id) {
      summary = '先选一段真实内容，听一句，跟着说出来。';
      chip = '下一句';
      primaryHref = './video-reader.html?mode=shadowing&from=today_first_lesson&focus=first_lesson';
    }

    const speechFocus = '说到 5 句可以停';
    const personalizedSpeechFocus = window.LinglishPronunciationProfile?.buildCoachSpeechFocus
      ? window.LinglishPronunciationProfile.buildCoachSpeechFocus(pronunciationProfile, speechFocus)
      : speechFocus;
    const roleplayFocus = '说完再决定要不要再练一轮';
    const vocabFocus = '说完再决定要不要看词句';

    setText('coach-next-action', title);
    setText('coach-summary', summary);
    setText('coach-plan-chip', chip);
    setText('coach-roleplay', roleplayFocus);
    setText('coach-speech-focus', personalizedSpeechFocus);
    setText('coach-vocab-focus', vocabFocus);
    setCoachLink('coach-shadow-link', primaryHref, primaryLabel);
    setCoachLink('coach-roleplay-link', roleplayUrl, '开始 AI 场景对话');
  }

  // 推荐来的今日视频:点击缩略图/主按钮时上报 reco_click(每次渲染更新目标视频,监听只绑一次)
  let recoClickVideo = null;
  function bindRecoClick(video, elements) {
    recoClickVideo = video && video.slot === 'today' ? video : null;
    for (const el of elements) {
      if (!el || el.dataset.recoClickBound) continue;
      el.dataset.recoClickBound = '1';
      el.addEventListener('click', () => {
        const client = window.VideoRecommendationClient;
        if (!recoClickVideo || !client) return;
        postEvent(getToken(), 'reco_click', client.eventProps(recoClickVideo, 'today', 0));
      });
    }
  }

  function updateLearningEntryLinks(video) {
    const videoQuery = video && video.id ? `&videoId=${encodeURIComponent(String(video.id))}` : '';
    const shadowingLink = document.getElementById('learning-entry-shadowing');
    if (shadowingLink) {
      shadowingLink.setAttribute('href', `./video-reader.html?mode=shadowing&from=today_first_lesson&focus=first_lesson${videoQuery}`);
    }
    bindRecoClick(video, [shadowingLink]);
  }

  function wireActions(modeKey, video, statsState) {
    updateLearningEntryLinks(video);
    const mode = modeKey === MODE.advanced.key ? MODE.advanced : MODE.student;
    // Updated IDs: btn-primary, btn-secondary, btn-explore
    const startBtn = document.getElementById('btn-primary');
    const secondaryBtn = document.getElementById('btn-secondary');
    const exploreBtn = document.getElementById('btn-explore');
    const thumbnailLink = document.getElementById('mission-thumbnail-link');

    const targetLines = DAILY_SENTENCE_TARGET;
    const practiceDone = Math.max(Number(statsState?.practiceDone) || 0, readTodaySpokenLines());
    const practiceDoneEnough = practiceDone >= targetLines;

    const speakUrl = video && video.id
      ? `./video-reader.html?videoId=${encodeURIComponent(String(video.id))}&from=today_first_lesson&focus=first_lesson&mode=shadowing`
      : './video-reader.html?mode=shadowing&from=today_first_lesson&focus=first_lesson';

    if (thumbnailLink) {
      thumbnailLink.setAttribute('href', speakUrl);
    }
    bindRecoClick(video, [thumbnailLink, startBtn]);

    if (startBtn) {
      startBtn.setAttribute('href', speakUrl);
      startBtn.textContent = practiceDone > 0 ? '再来一句' : '开始说这一句';
    }

    if (secondaryBtn) {
      secondaryBtn.setAttribute('href', '#learning-details');
      secondaryBtn.textContent = '今天到这';
    }
    if (exploreBtn) exploreBtn.setAttribute('href', './mobile-explore.html');

    // Updated IDs: mission-title, mission-desc
    const titleEl = document.getElementById('mission-title');
    const descEl = document.getElementById('mission-desc');
    if (video && titleEl) titleEl.textContent = video.title || `视频 #${video.id}`;
    if (video && descEl) {
      const desc = video.recommendationReason
        ? `${video.recommendationReason} · 先看一遍再跟读`
        : (video.description || '建议：先看一遍再跟读，记住3个词就够了。');
      descEl.textContent = desc.length > 60 ? desc.slice(0, 60) + '...' : desc;
    }
    renderVideoMeta(video);

    // Updated: mission-thumbnail (new structure with container)
    try {
      const container = document.getElementById('mission-thumbnail-container');
      const img = document.getElementById('mission-thumbnail');
      const url = resolveThumbnail(video);

      if (img && url) {
        img.src = url;
        img.alt = (video && video.title) ? String(video.title) : '今日视频';
        img.style.display = 'block';
        img.onerror = function () {
          try { img.style.display = 'none'; } catch (_) { }
          try { img.removeAttribute('src'); } catch (_) { }
        };
        // Hide fallback emoji when image loads
        if (container) {
          const emoji = container.querySelector('span');
          if (emoji) emoji.style.display = 'none';
        }
      } else if (img) {
        try { img.style.display = 'none'; } catch (_) { }
        try { img.removeAttribute('src'); } catch (_) { }
        // Show fallback emoji
        if (container) {
          const emoji = container.querySelector('span');
          if (emoji) emoji.style.display = 'block';
        }
      }
    } catch (_) { }

    // Progress UI - Updated for circular progress ring and linear progress bar
    try {
      const watchPct = Math.max(0, Math.min(1, (statsState?.watchSecondsVideo || 0) / mode.watchTargetSec));
      const baselineDue = Number.isFinite(statsState?.baselineDue) ? statsState.baselineDue : null;
      const dueNow = Number.isFinite(statsState?.due) ? statsState.due : null;
      const reviewDone = (baselineDue != null && dueNow != null) ? Math.max(0, baselineDue - dueNow) : 0;
      const reviewPct = Math.max(0, Math.min(1, reviewDone / mode.reviewTargetDelta));
      const practicePct = Math.max(0, Math.min(1, practiceDone / targetLines));

      let pct = 0;
      let stepText = '先说这一句';
      if (practicePct < 1) {
        pct = practicePct;
        stepText = practiceDone > 0 ? `已说 ${practiceDone} / ${targetLines} 句` : '先说这一句';
      } else {
        pct = 1;
        stepText = '今天的句子说完了';
        // Show celebration when 100% complete
        showCelebration();
      }

      // Update circular progress ring (hero card)
      const progressPercent = document.getElementById('progress-percent');
      const progressLabel = document.getElementById('progress-label');
      if (progressPercent) progressPercent.textContent = `${Math.round(pct * 100)}%`;
      if (progressLabel) progressLabel.textContent = stepText.replace(/第\d步：/, ''); // Remove step number for hero
      updateProgressRing(pct * 100);

      // Update linear progress bar (mission card)
      const progressBarFill = document.getElementById('progress-bar-fill');
      const progressText = document.getElementById('progress-text');
      if (progressBarFill) progressBarFill.style.width = `${Math.round(pct * 100)}%`;
      if (progressText) progressText.textContent = stepText;

      updateGamifyPanels(modeKey, statsState, {
        reviewDone,
        practiceDone,
        targetLines,
        watchPct,
        reviewPct,
        practicePct
      });
      renderCoachBrief(modeKey, video, statsState, {
        reviewDone,
        practiceDone,
        targetLines,
        watchPct,
        reviewPct,
        practicePct
      });
    } catch (_) { }
  }

  function updateGamifyPanels(modeKey, statsState, progress) {
    const mode = modeKey === MODE.advanced.key ? MODE.advanced : MODE.student;
    const watchMin = Math.floor((statsState?.watchSecondsTotal || 0) / 60);
    const localReviewDone = Number(progress?.reviewDone) || 0;
    const localPracticeDone = Number(progress?.practiceDone) || 0;
    const reviewDone = serverGamify.today?.words_reviewed ?? localReviewDone;
    const practiceDone = Math.max(localPracticeDone, readTodaySpokenLines());
    const spoken = Math.min(DAILY_SENTENCE_TARGET, practiceDone);
    const watchDone = (statsState?.watchSecondsVideo || 0) >= mode.watchTargetSec;

    const setBar = (id, pct) => {
      const el = document.getElementById(id);
      if (el) el.style.width = `${Math.round(Math.min(100, Math.max(0, pct)))}%`;
    };

    const sentenceRow = document.getElementById('quest-sentences');
    const sentenceText = document.getElementById('quest-sentence-text');
    const sentenceNote = document.getElementById('daily-sentence-note');
    if (sentenceText) sentenceText.textContent = `${spoken}/${DAILY_SENTENCE_TARGET}`;
    if (sentenceNote) sentenceNote.textContent = dailySentenceNote(spoken);
    setBar('quest-sentence-bar', (spoken / DAILY_SENTENCE_TARGET) * 100);
    if (sentenceRow) sentenceRow.classList.toggle('done', spoken >= DAILY_SENTENCE_TARGET);

    const summary = document.getElementById('daily-quest-summary');
    if (summary) summary.textContent = `${spoken}/${DAILY_SENTENCE_TARGET}`;

    const gs = window.gamificationSystem && window.gamificationSystem.data ? window.gamificationSystem.data : null;
    const stats = gs?.stats || {};
    const wordsLearned = Number(stats.wordsLearned) || reviewDone;
    const videosWatched = Number(stats.videosWatched) || (watchDone ? 1 : 0);
    const sentencesRecorded = Number(stats.sentencesRecorded) || practiceDone;

    // 徽章解锁来自服务端真实成就(serverGamify.achievements),按 type 就近匹配目录;
    // 无对应类型时维持原有本地启发式判定(降级)
    const serverUnlockedTypes = new Set((serverGamify.achievements || []).map(a => a.type));
    const toggleBadge = (id, unlocked) => {
      const badge = document.getElementById(id);
      if (!badge) return 0;
      badge.classList.toggle('locked', !unlocked);
      return unlocked ? 1 : 0;
    };
    const badgeCount = [
      // first_session unlocks on ANY activity (video/vocab/etc — see services/achievements.js),
      // not video-specific, so it's not a valid signal for this badge. Keep the local
      // video-specific heuristic only.
      toggleBadge('badge-first-video', watchMin > 0 || watchDone),
      toggleBadge('badge-first-voice', practiceDone > 0),
      toggleBadge('badge-streak-7', serverUnlockedTypes.has('streak_7') || Number(statsState?.streak) >= 7),
      toggleBadge('badge-words-100', serverUnlockedTypes.has('words_200') || wordsLearned >= 100)
    ].reduce((a, b) => a + b, 0);
    const badgeCountEl = document.getElementById('badge-count');
    if (badgeCountEl) badgeCountEl.textContent = `${badgeCount}/4 解锁`;

    const lbYou = document.getElementById('leaderboard-you');

    const board = serverGamify.leaderboard;
    const leaderboardList = document.getElementById('leaderboard-list');
    // Exclude the current user's own row from the fetched board so they don't render
    // twice (once as their real username, once as "你"). Requires selfUserId to be known;
    // if it's not (e.g. /users/me failed), we can't reliably dedupe, so skip real-row
    // rendering below and keep the existing placeholder rows untouched.
    const selfId = serverGamify.selfUserId != null ? String(serverGamify.selfUserId) : null;
    const othersBoard = selfId
      ? board.filter(entry => String(entry.user_id) !== selfId)
      : board;

    if (selfId && othersBoard.length && leaderboardList && lbYou) {
      const medals = ['🥇', '🥈', '🥉'];
      leaderboardList.querySelectorAll('.leaderboard-row:not(.you)').forEach(row => row.remove());
      othersBoard.forEach((entry, idx) => {
        const row = document.createElement('div');
        row.className = 'leaderboard-row';
        const medal = medals[idx] || `#${idx + 1}`;
        row.innerHTML = `<span>${medal} ${escapeHtml(entry.username)} · ${entry.weekly_xp} XP</span><span></span>`;
        leaderboardList.insertBefore(row, lbYou);
      });
    } // 无法可靠去重或无数据时,保留现有占位渲染

    // Self XP/rank: weekly_xp on the board is a 7-day rolling sum, while gamificationSystem's
    // xp is cumulative all-time XP post-sync — comparing them directly would show #1 almost
    // unconditionally. Use serverGamify.weeklyXp (summed from /api/stats/daily?days=7) for a
    // like-for-like comparison. If that fetch failed (weeklyXp is null), keep the existing
    // placeholder rendering for both the "你" row and the rank badge instead of guessing.
    const weeklyXp = serverGamify.weeklyXp;
    if (weeklyXp != null && lbYou) {
      lbYou.innerHTML = `<span>你 · ${weeklyXp} XP</span><span>${Math.max(10, watchMin)}m</span>`;
    }
    const rankEl = document.getElementById('leaderboard-rank');
    if (rankEl && weeklyXp != null && othersBoard.length) {
      let rank = othersBoard.length + 1;
      for (let i = 0; i < othersBoard.length; i++) {
        if (weeklyXp >= othersBoard[i].weekly_xp) { rank = i + 1; break; }
      }
      rankEl.textContent = `#${rank}`;
    } // 数据不足时保留现有占位渲染(#--)

    const setMilestone = (textId, barId, value, target) => {
      const text = document.getElementById(textId);
      if (text) text.textContent = `${Math.min(value, target)}/${target}`;
      setBar(barId, (target ? (value / target) * 100 : 0));
      return value >= target;
    };

    const m1 = setMilestone('milestone-video-text', 'milestone-video-bar', videosWatched, 10);
    const m2 = setMilestone('milestone-vocab-text', 'milestone-vocab-bar', wordsLearned, 100);
    const m3 = setMilestone('milestone-voice-text', 'milestone-voice-bar', sentencesRecorded, 50);
    const milestoneSummary = document.getElementById('milestone-summary');
    if (milestoneSummary) milestoneSummary.textContent = `${[m1, m2, m3].filter(Boolean).length}/3 达成`;
  }

  function bindModeToggle(onChange) {
    // Updated IDs: mode-student, mode-advanced
    const studentBtn = document.getElementById('mode-student');
    const advancedBtn = document.getElementById('mode-advanced');
    if (studentBtn) {
      studentBtn.addEventListener('click', () => onChange(MODE.student.key));
    }
    if (advancedBtn) {
      advancedBtn.addEventListener('click', () => onChange(MODE.advanced.key));
    }
  }

  async function main() {
    const token = getToken();
    if (!token) {
      try { window.location.href = './mobile-auth.html'; } catch (_) { }
      return;
    }
    flushFeedbackQueue().catch(() => {});
    await syncPendingOnboardingProfile(token);
    const userInfo = await loadUserHeader(token);
    todayUserInfo = userInfo || null;
    const renderFirstLessonResume = () => {
      const currentToken = getToken();
      const currentUser = currentToken === token ? userInfo : null;
      window.LinglishFirstLessonGoal.renderResume(document.getElementById('first-lesson-resume'), {
      storage: localStorage,
      subject: window.LinglishFirstLessonProgress.resolveSubject({
        userId: currentUser?.id || currentUser?.user_id, token: currentToken,
        isGuest: Boolean(currentUser?.is_guest || currentUser?.isGuest || currentUser?.guest_id || currentUser?.guestId
          || (!currentUser && (localStorage.getItem('is_guest') === 'true' || sessionStorage.getItem('is_guest') === 'true'))),
        visitorId: getVisitorId(),
      }),
      mobile: true, emit: (name, properties) => postEvent(currentToken, name, properties),
    });
    };
    renderFirstLessonResume();
    window.addEventListener('pageshow', renderFirstLessonResume);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') renderFirstLessonResume();
    });

    let modeKey = getProfileMode();
    updateModeUI(modeKey);
    renderPrescription(userInfo, modeKey);
    bindPrescriptionActions(token);
    postEvent(token, 'mobile_today_workspace_view', {
      mode: modeKey,
      has_onboarding_profile: getLocalOnboardingProfile().hasProfile,
    });

    // Default: kid -> auto review; adult -> prompt, unless user has explicitly changed it before.
    const existingAutoNext = (() => {
      try { return localStorage.getItem(STORAGE.autoNext); } catch (_) { return null; }
    })();
    if (!hasUserSetAutoNext() && (existingAutoNext === null || existingAutoNext === 'null' || existingAutoNext === 'undefined')) {
      setAutoNextSetting(getDefaultAutoNextForMode(modeKey), { userSet: false });
    }
    const autoNext = getAutoNextSetting(modeKey);
    updateAutoNextUI(autoNext);
    bindAutoNextSetting();

    const selfUserId = userInfo?.id ?? null;
    const profileController = getPronunciationProfileController(token);
    const [resolvedVideo, profileRes] = await Promise.all([
      resolveTodayVideo(token, modeKey, { preferRecommended: true }).catch(() => null).then((video) => {
        wireActions(modeKey, video, null);
        return video;
      }),
      profileController ? profileController.load(userInfo).catch(() => null) : Promise.resolve(null),
    ]);
    let video = resolvedVideo;
    pronunciationProfile = profileRes?.data || profileRes || null;
    await loadServerGamify(selfUserId);
    let statsState = await refreshStats(token, video);
    wireActions(modeKey, video, statsState);

    // Auto-refresh stats when page becomes visible (e.g., returning from video player)
    const refreshOnVisible = async () => {
      if (document.visibilityState === 'visible') {
        try {
          await loadServerGamify(selfUserId);
          statsState = await refreshStats(token, video);
          wireActions(modeKey, video, statsState);
          updateXPDisplay();
        } catch (_) { }
      }
    };
    document.addEventListener('visibilitychange', refreshOnVisible);

    // Also refresh on pageshow for bfcache scenarios
    window.addEventListener('pageshow', async (event) => {
      if (event.persisted) {
        try {
          statsState = await refreshStats(token, video);
          wireActions(modeKey, video, statsState);
          updateXPDisplay();
        } catch (_) { }
      }
    });

    bindModeToggle(async (nextMode) => {
      modeKey = nextMode;
      setProfileMode(modeKey);
      updateModeUI(modeKey);
      renderPrescription(userInfo, modeKey);
      postEvent(token, 'mobile_today_mode_switch', { mode: modeKey });
      if (!hasUserSetAutoNext()) {
        const v = getDefaultAutoNextForMode(modeKey);
        setAutoNextSetting(v, { userSet: false });
        updateAutoNextUI(v);
      }
      video = await resolveTodayVideo(token, modeKey).catch(() => video);
      statsState = await refreshStats(token, video);
      wireActions(modeKey, video, statsState);
    });

    // Bind celebration overlay close on click
    const celebrationOverlay = document.getElementById('celebration-overlay');
    if (celebrationOverlay) {
      celebrationOverlay.addEventListener('click', () => {
        window.location.href = './mobile-treasure.html?action=claim_daily';
      });
    }

    // Update today's date label
    try {
      const dateEl = document.getElementById('hero-date');
      if (dateEl) dateEl.textContent = getTodayLabel();
    } catch (_) { }

    // Init XP Display
    updateXPDisplay();

    bindQuestFeedback();
  }

  function updateXPDisplay() {
    try {
      let xp = 0;
      // Try to get from global system first
      if (window.gamificationSystem) {
        xp = window.gamificationSystem.data.xp;
      } else {
        // Fallback to local storage read
        const stored = localStorage.getItem('linglish_gamification');
        if (stored) {
          const data = JSON.parse(stored);
          xp = data.xp || 0;
        }
      }

      const xpEl = document.getElementById('xp-value');
      if (xpEl) {
        animateValue(xpEl, 0, xp, 1000); // Smooth count up
      }
    } catch (_) { }
  }

  function animateValue(obj, start, end, duration) {
    if (!obj) return;
    let startTimestamp = null;
    const step = (timestamp) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);
      obj.innerHTML = Math.floor(progress * (end - start) + start);
      if (progress < 1) {
        window.requestAnimationFrame(step);
      } else {
        obj.innerHTML = end;
      }
    };
    window.requestAnimationFrame(step);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
