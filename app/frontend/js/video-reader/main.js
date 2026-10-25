const API_BASE = '';
const LINGLISH_ENV = window.__LINGLISH_ENV__ || {};
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
const waveformOriginalCache = new Map();

function readCookieToken(name) {
  if (typeof document === 'undefined' || !document.cookie) return null;
  const pattern = new RegExp(`(?:^|; )${name}=([^;]*)`);
  const match = document.cookie.match(pattern);
  return match ? decodeURIComponent(match[1]) : null;
}

function resolveAuthToken() {
  const storageKeys = [
    function () { return localStorage.getItem('linglish_token'); },
    function () { return localStorage.getItem('authToken'); },
    function () { return sessionStorage.getItem('linglish_token'); },
    function () { return sessionStorage.getItem('authToken'); },
  ];
  for (const getter of storageKeys) {
    try {
      const value = getter();
      if (value && value !== 'null' && value !== 'undefined') {
        return value;
      }
    } catch (_err) {
      // ignore storage access errors (Safari private mode, etc.)
    }
  }
  const cookieCandidates = ['linglish_token', 'authToken', 'token'];
  for (const name of cookieCandidates) {
    const value = readCookieToken(name);
    if (value && value !== 'null' && value !== 'undefined') {
      return value;
    }
  }
  return null;
}

function parseJwtPayload(tokenValue) {
  try {
    if (!tokenValue || typeof tokenValue !== 'string') return null;
    const parts = tokenValue.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    let payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payloadB64.length % 4) payloadB64 += '=';
    const json = atob(payloadB64);
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function isTokenExpired(tokenValue) {
  const payload = parseJwtPayload(tokenValue);
  const exp = payload && typeof payload.exp === 'number' ? payload.exp : null;
  if (!exp) return false;
  return exp < Math.floor(Date.now() / 1000);
}

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

async function fetchOriginalWaveformFromServer(videoId, startSec, endSec, points) {
  if (!videoId || !waveformSegmentationConfig.enabled) return null;
  const safePoints = points || 240;
  const key = `${videoId}:${Number(startSec || 0).toFixed(2)}:${Number(endSec || 0).toFixed(2)}:${Number(safePoints || 240)}`;
  if (waveformOriginalCache.has(key)) {
    return waveformOriginalCache.get(key);
  }
  try {
    const params = new URLSearchParams();
    params.set('start', String(startSec || 0));
    params.set('end', String(endSec || 0));
    params.set('points', String(safePoints || 240));
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/video-resources/${encodeURIComponent(String(videoId))}/waveform?${params.toString()}`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.samples)) return null;
    const arr = Float32Array.from(data.samples);
    waveformOriginalCache.set(key, arr);
    return arr;
  } catch (_) {
    return null;
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

async function splitSegmentsByWaveformSilence(raw, videoId) {
  const segs = Array.isArray(raw) ? raw.slice() : [];
  if (segs.length <= 1 || !waveformSegmentationConfig.enabled) return segs;
  const maxSplitsPerVideo = waveformSegmentationConfig.maxSplits;
  const minDuration = waveformSegmentationConfig.minDurationSec;
  const minWords = waveformSegmentationConfig.minWords;

  const candidates = segs
    .map((seg, idx) => {
      const start = Number(seg.start || 0);
      const end = Number(seg.end != null ? seg.end : start);
      const duration = end - start;
      const text = String(seg.text || '').trim();
      const wordCount = (text.match(/\b[\w']+\b/g) || []).length;
      return { seg, idx, start, end, duration, text, wordCount };
    })
    .filter(item => item.text && item.duration >= minDuration && item.wordCount >= minWords);

  if (!candidates.length) return segs;

  candidates.sort((a, b) => b.duration - a.duration);
  const picked = new Map();
  const limit = Math.min(maxSplitsPerVideo, candidates.length);

  for (let i = 0; i < limit; i += 1) {
    const item = candidates[i];
    const points = Math.max(180, Math.min(360, Math.round(item.duration * 60)));
    const samples = await fetchOriginalWaveformFromServer(videoId, item.start, item.end, points);
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

async function ensureWaveformSegmentation(video) {
  if (!waveformSegmentationConfig.enabled) return false;
  if (!video || !Array.isArray(video.transcript_segments) || !video.transcript_segments.length) return false;
  if (video._waveformSegmentationApplied) return false;
  video._waveformSegmentationApplied = true;
  const nextSegments = await splitSegmentsByWaveformSilence(video.transcript_segments, video.id);
  if (nextSegments && nextSegments !== video.transcript_segments) {
    video.transcript_segments = nextSegments;
    return true;
  }
  return false;
}

let token = resolveAuthToken();
const isGuest = !token;

async function setProtectedMediaSource(element, rawPath, isCurrent) {
  const accountToken = resolveAuthToken();
  const mediaSession = window.LinglishMediaSession;
  if (!element || !rawPath || !accountToken || !mediaSession) {
    throw new Error('MEDIA_SESSION_UNAVAILABLE');
  }
  return mediaSession.authorizeElementSource(element, rawPath, {
    token: accountToken,
    legacyToken: accountToken,
    isCurrent,
  });
}

if (window.LinglishMediaSession) {
  window.LinglishMediaSession.bindLifecycle({
    getToken: resolveAuthToken,
    onError: () => showToast('媒体授权已失效，请重试', 'warn'),
  });
}

// ---- Today plan context ----
const todayPlan = (function () {
  let fromToday = false;
  try {
    const params = new URLSearchParams(window.location.search || '');
    fromToday = params.get('from') === 'today';
  } catch (_) { }

  function readProfileMode() {
    try {
      const v = localStorage.getItem('linglish_profile_mode');
      if (v === 'advanced' || v === 'adult') return 'advanced';
      return 'student';
    } catch (_) {
      return 'student';
    }
  }

  const once = { completionPromptShown: false };

  function buildUrl(path, query) {
    const q = new URLSearchParams();
    Object.entries(query || {}).forEach(([k, v]) => {
      if (v === null || v === undefined || v === '') return;
      q.set(k, String(v));
    });
    const suffix = q.toString();
    return suffix ? `${path}?${suffix}` : path;
  }

  function showCompletionPrompt(videoId) {
    if (!fromToday) return;
    if (!videoId) return;
    if (once.completionPromptShown) return;
    once.completionPromptShown = true;

    const mode = readProfileMode();
    const practiceLines = mode === 'advanced' ? 8 : 5;
    const reviewTarget = mode === 'advanced' ? 5 : 3;

    // Lightweight analytics
    try {
      postEvent('today_video_completed', { video_resource_id: videoId, mode });
    } catch (_) { }

    try {
      if (window.Feedback && typeof window.Feedback.playSfx === 'function') {
        window.Feedback.playSfx('success');
      }
    } catch (_) { }

    const overlay = document.createElement('div');
    overlay.id = 'today-next-step-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '99999';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'flex-end';
    overlay.style.justifyContent = 'center';
    overlay.style.padding = '16px';
    overlay.style.background = 'rgba(15, 23, 42, 0.55)';
    overlay.style.backdropFilter = 'blur(6px)';
    overlay.style.webkitBackdropFilter = 'blur(6px)';

    const card = document.createElement('div');
    card.style.width = 'min(520px, 100%)';
    card.style.borderRadius = '18px';
    card.style.background = '#ffffff';
    card.style.border = '1px solid rgba(226,232,240,1)';
    card.style.boxShadow = '0 20px 50px -20px rgba(2,6,23,0.45)';
    card.style.padding = '14px';

    const title = document.createElement('div');
    title.textContent = '视频看完啦！';
    title.style.fontWeight = '900';
    title.style.fontSize = '16px';
    title.style.color = '#0f172a';

    const subtitle = document.createElement('div');
    subtitle.textContent = `下一步：跟读 ${practiceLines} 句（先练会说）`;
    subtitle.style.marginTop = '6px';
    subtitle.style.fontWeight = '800';
    subtitle.style.fontSize = '13px';
    subtitle.style.color = '#475569';

    const btnRow = document.createElement('div');
    btnRow.style.display = 'grid';
    btnRow.style.gridTemplateColumns = '1fr';
    btnRow.style.gap = '10px';
    btnRow.style.marginTop = '12px';

    const primary = document.createElement('a');
    primary.href = buildUrl('./practice-session.html', { videoId, from: 'today', mode: 'shadowing', lines: practiceLines });
    primary.textContent = '开始跟读';
    primary.style.display = 'flex';
    primary.style.justifyContent = 'space-between';
    primary.style.alignItems = 'center';
    primary.style.gap = '10px';
    primary.style.padding = '12px 14px';
    primary.style.borderRadius = '16px';
    primary.style.fontWeight = '900';
    primary.style.textDecoration = 'none';
    primary.style.color = '#ffffff';
    primary.style.background = 'linear-gradient(135deg, #0f766e 0%, #f97316 100%)';
    primary.style.boxShadow = '0 16px 30px -18px rgba(99, 102, 241, 0.8)';
    primary.innerHTML = `<span>开始跟读</span><span style="font-size:12px; font-weight:800; opacity:.9;">${practiceLines}句</span>`;

    const secondary = document.createElement('a');
    secondary.href = buildUrl('./mobile-power.html', { from: 'today', startReview: 1, target: reviewTarget });
    secondary.textContent = '先去复习';
    secondary.style.display = 'flex';
    secondary.style.justifyContent = 'space-between';
    secondary.style.alignItems = 'center';
    secondary.style.gap = '10px';
    secondary.style.padding = '12px 14px';
    secondary.style.borderRadius = '16px';
    secondary.style.fontWeight = '900';
    secondary.style.textDecoration = 'none';
    secondary.style.color = '#0f172a';
    secondary.style.background = '#ffffff';
    secondary.style.border = '1px solid #e2e8f0';
    secondary.innerHTML = `<span>先去复习</span><span style="font-size:12px; font-weight:800; color:#64748b;">${reviewTarget}个</span>`;

    const later = document.createElement('button');
    later.type = 'button';
    later.textContent = '稍后再说';
    later.style.padding = '10px 14px';
    later.style.borderRadius = '14px';
    later.style.fontWeight = '900';
    later.style.border = '1px solid #e2e8f0';
    later.style.background = '#f8fafc';
    later.style.color = '#334155';

    function close() {
      try { overlay.remove(); } catch (_) { }
    }
    later.addEventListener('click', close);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });

    btnRow.appendChild(primary);
    btnRow.appendChild(secondary);
    btnRow.appendChild(later);
    card.appendChild(title);
    card.appendChild(subtitle);
    card.appendChild(btnRow);
    overlay.appendChild(card);

    document.body.appendChild(overlay);
  }

  return { fromToday, readProfileMode, showCompletionPrompt };
})();

// ---- 播完后的「下一个」推荐卡 ----
const nextVideoSheet = window.NextVideoSheet
  ? window.NextVideoSheet.create({
    apiBase: API_BASE,
    getToken: function () { return token; },
    postEvent: function (name, props) { postEvent(name, props); },
    onOpen: function (video) {
      const id = Number(video.id);
      if (state.videos.some(v => v.id === id)) {
        selectVideo(id);
        return;
      }
      window.location.href = `./video-reader.html?videoId=${encodeURIComponent(String(video.id))}&from=next`;
    },
  })
  : { showAfter() {}, hide() {} };

// ---- Analytics: generic event poster ----
function getAnalyticsContext() {
  const params = new URLSearchParams(window.location.search || '');
  return {
    page: 'video-reader',
    from: params.get('from') || null,
  };
}

async function postEvent(name, properties = {}) {
  try {
    const payload = { event_name: name, properties: { ...getAnalyticsContext(), ...properties } };
    const eventHeaders = { 'Content-Type': 'application/json' };
    if (token) eventHeaders.Authorization = `Bearer ${token}`;
    await fetch(`${API_BASE}${token ? '/events' : '/track/event'}`, {
      method: 'POST',
      headers: eventHeaders,
      body: JSON.stringify(window.LinglishVisitor.decorateEvent(payload)),
    });
  } catch (e) { console.warn('postEvent failed', e); }
}

const firstLessonInitialContext = window.LinglishFirstLessonFocus.readContext(window.location.search);
const readerEntry = firstLessonInitialContext.from;
const firstLessonSession = window.LinglishFirstLessonFocus.createSession({
  search: window.location.search,
  pathname: window.location.pathname,
  hash: window.location.hash,
  document,
  history: window.history,
  location: window.location,
  onClear: clearMobileFirstLessonState,
});
const firstLessonReadiness = window.LinglishFirstLessonReadiness.createFirstLessonReadiness({
  focus: firstLessonInitialContext.enabled ? 'first_lesson' : null,
  from: readerEntry,
  startedAt: (window.performance && window.performance.timeOrigin) || Date.now(),
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
let firstLessonGoalBusy = false;
const firstLessonGoalCard = window.LinglishFirstLessonGoal.createCard(document.getElementById('first-lesson-goal'), {
  mobile: true,
  listen: (index) => {
    if (!firstLessonSession.isActive() || firstLessonGoalBusy) return;
    const line = selectMobileGoalLine(index);
    if (!line) return;
    postEvent('first_lesson_goal_listen', { video_resource_id: state.selectedVideoId });
    state.practicePlaybackLock = false;
    if (youtubePlayer?.player) {
      state.segmentPlaybackEnd = Number(line.end) || Number(line.start) + 4;
      state.segmentPlaybackCallback = () => { state.practicePlaybackLock = true; };
      youtubePlayer.play();
    } else playSegmentSnippet(line, () => { state.practicePlaybackLock = true; });
  },
  record: (index) => {
    if (!firstLessonSession.isActive()) return;
    if (state.recorder?.state === 'recording') { stopPracticeRecording('manual'); return; }
    if (firstLessonGoalBusy || !selectMobileGoalLine(index)) return;
    startPracticeRecording();
  },
  next: () => {
    const index = (state.practiceIndex ?? 0) + 1;
    if (!selectMobileGoalLine(index)) {
      location.href = './mobile-today.html#learning-details';
      return;
    }
    firstLessonGoalCard.update(firstLessonGoal);
  },
});

function selectMobileGoalLine(index) {
  const segment = state.currentSegments[index];
  if (!segment) return null;
  state.practiceLines = state.currentSegments.map((item, displayIndex) => ({ ...item, index: displayIndex }));
  state.practiceIndex = index;
  state.segmentPlaybackEnd = null;
  state.segmentPlaybackCallback = null;
  videoPlayer.pause();
  renderPracticeCurrentLine();
  const start = Number(segment.start ?? segment.start_sec ?? 0);
  if (youtubePlayer?.player) { youtubePlayer.pause(); youtubePlayer.seekTo(start); }
  else videoPlayer.currentTime = start;
  mobileSegmentPosition = index;
  renderMobileTranscriptWindow(index);
  return state.practiceLines[index];
}

function clearMobileFirstLessonState() {
  firstLessonProgressSubject = null;
  firstLessonPracticeSnapshot = null;
  firstLessonGoal = null;
  firstLessonGoalBusy = false;
  firstLessonGoalCard.hide();
  const progress = document.getElementById('first-lesson-progress');
  if (progress) {
    progress.hidden = true;
    progress.textContent = '';
  }
}

function resolveMobileFirstLessonSubject() {
  const guestFlag = state.user
    ? Boolean(state.user.is_guest || state.user.isGuest || state.user.guest_id || state.user.guestId)
    : Boolean(localStorage.getItem('is_guest') === 'true' || sessionStorage.getItem('is_guest') === 'true');
  return window.LinglishFirstLessonProgress.resolveSubject({
    userId: state.user?.id || state.user?.user_id,
    token,
    isGuest: guestFlag,
    visitorId: window.LinglishVisitor.getId(),
  });
}

function renderMobileFirstLessonSnapshot(snapshot) {
  firstLessonPracticeSnapshot = snapshot;
  const progress = document.getElementById('first-lesson-progress');
  if (progress && firstLessonSession.isActive() && snapshot) {
    progress.hidden = false;
    progress.textContent = `已练 ${snapshot.practicedCount}/${snapshot.total} · ${snapshot.percentage}%`;
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

function startMobileFirstLessonProgress(video, segments) {
  if (!firstLessonSession.isActive() || !video || !Array.isArray(segments) || !segments.length) return null;
  firstLessonProgressSubject = resolveMobileFirstLessonSubject();
  const snapshot = firstLessonProgressStore.start(firstLessonProgressSubject, video.id, segments);
  renderMobileFirstLessonSnapshot(snapshot);
  if (firstLessonGoal) postEvent('first_lesson_goal_view', { video_resource_id: video.id, target_lines: firstLessonGoal.total, completed_lines: firstLessonGoal.completedCount });
  return snapshot;
}

function syncCompletedMobileFirstLesson(snapshot) {
  if (!snapshot?.complete) return false;
  return firstLessonProgressStore.syncCompleted(firstLessonProgressSubject, snapshot.videoId, (completed) => {
    try {
      localStorage.setItem(`video_progress_${completed.videoId}`, '100');
      const date = new Date();
      const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      localStorage.setItem('linglish_first_lesson_completion', JSON.stringify({
        date: dateKey,
        completed_at: new Date(completed.completedAt || Date.now()).toISOString(),
        video_id: completed.videoId,
        lines: completed.practicedCount,
        target_lines: completed.total,
        source: 'video-reader-mobile',
      }));
    } catch (_) { }
  });
}

function createMobileAssessmentContext(line) {
  if (!firstLessonSession.isActive() || !firstLessonProgressSubject || !state.selectedVideoId || !line) return null;
  const displayIndex = line.index != null ? Number(line.index) : state.practiceIndex;
  const segment = state.currentSegments[displayIndex];
  if (!segment) return null;
  const stableSegmentId = window.LinglishFirstLessonProgress.stableSegmentId(
    state.selectedVideoId,
    segment,
    displayIndex,
  );
  return window.LinglishFirstLessonPractice.createAssessmentContext({
    subject: firstLessonProgressSubject,
    videoId: state.selectedVideoId,
    stableSegmentId,
    sourceIndices: segment.source_indices,
    selectionGeneration: videoSelectionGeneration,
    displayIndex,
  });
}

function isMobileAssessmentContextCurrent(captured) {
  if (!captured || !firstLessonSession.isActive()) return false;
  const segment = state.currentSegments[captured.displayIndex];
  if (!segment || !state.selectedVideoId) return false;
  const current = window.LinglishFirstLessonPractice.createAssessmentContext({
    subject: resolveMobileFirstLessonSubject(),
    videoId: state.selectedVideoId,
    stableSegmentId: window.LinglishFirstLessonProgress.stableSegmentId(
      state.selectedVideoId,
      segment,
      captured.displayIndex,
    ),
    sourceIndices: segment.source_indices,
    selectionGeneration: videoSelectionGeneration,
    displayIndex: captured.displayIndex,
  });
  return window.LinglishFirstLessonPractice.assessmentContextMatches(captured, current);
}

function markPracticedMobileFirstLesson(context, result, assessmentId, evidenceKind) {
  if (!context || !isMobileAssessmentContextCurrent(context)) return null;
  const score = Number(result?.score ?? (Number(result?.similarity) * 100));
  const outcome = firstLessonProgressStore.markPracticed(
    context.subject,
    context.videoId,
    context.stableSegmentId,
    {
      success: result?.success === true,
      score,
      evidence: { kind: evidenceKind, assessmentId, recording: true },
    },
  );
  renderMobileFirstLessonSnapshot(outcome.snapshot);
  if (outcome.changed) {
    firstLessonLifecycle.practice(outcome.snapshot);
    firstLessonLifecycle.feedback({ score, segmentId: context.stableSegmentId });
    syncCompletedMobileFirstLesson(outcome.snapshot);
  }
  return outcome.snapshot;
}

function markFirstLessonReadyForCommittedTranscript(video, segments) {
  if (!firstLessonSession.isActive()) return;
  if (!video || !Array.isArray(segments) || segments.length === 0) return;
  if (state.selectedVideoId !== video.id || state.currentSegments !== segments) return;
  const readiness = firstLessonReadiness.markReady({
    videoId: video.id,
    segmentCount: segments.length,
  });
  if (readiness) {
    postEvent('today_first_lesson_workspace_ready', readiness);
    firstLessonLifecycle.ready(readiness);
  }
}

// ---- Analytics: video watch tracker ----
const EVENT_CHUNK_SECONDS = 15;
let watchTimer = null;
let lastTickAt = null;
function startWatchTimer() {
  if (!state.selectedVideoId || watchTimer) return;
  lastTickAt = Date.now();
  watchTimer = setInterval(function () {
    const now = Date.now();
    const delta = Math.max(1, Math.round((now - (lastTickAt || now)) / 1000));
    lastTickAt = now;
    postEvent('video_watch', { video_resource_id: state.selectedVideoId, seconds: Math.min(delta, EVENT_CHUNK_SECONDS) });
  }, EVENT_CHUNK_SECONDS * 1000);
}
function stopWatchTimer(flush = true) {
  if (flush && lastTickAt && state.selectedVideoId) {
    const now = Date.now();
    const delta = Math.round((now - lastTickAt) / 1000);
    if (delta > 0) postEvent('video_watch', { video_resource_id: state.selectedVideoId, seconds: Math.min(delta, EVENT_CHUNK_SECONDS) });
  }
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
  lastTickAt = null;
}

// ---- Analytics: vocab study timer ----
let vocabStudyStartedAt = null;
function vocabStudyStart() {
  if (!vocabStudyStartedAt) vocabStudyStartedAt = Date.now();
}
function vocabStudyStop() {
  if (!vocabStudyStartedAt) return;
  const secs = Math.round((Date.now() - vocabStudyStartedAt) / 1000);
  vocabStudyStartedAt = null;
  if (secs > 0) postEvent('vocab_study', { seconds: secs });
}

// 解析 URL 参数中的 videoId（若存在则用于初始选中）
const initialVideoIdFromURL = (function () {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const raw = params.get('videoId');
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch (_) {
    return null;
  }
})();

// Debug: Check token status
console.log('[Auth] Token resolved:', Boolean(token));
console.log('[Auth] localStorage available:', typeof (Storage) !== 'undefined');

// Guest mode: allow browsing/playing without login; auth-only actions will be skipped
if (!token) {
  console.log('[Auth] Guest mode: continuing without token');
}

// Ensure desktop/mobile storages stay in sync for future visits
try {
  const storedDesktopToken = localStorage.getItem('linglish_token');
  if (!storedDesktopToken || storedDesktopToken === 'null' || storedDesktopToken === 'undefined') {
    localStorage.setItem('linglish_token', token);
  }
} catch (_err) {
  // ignore sync errors
}

const state = {
  videos: [],
  selectedVideoId: null,
  currentSegments: [],
  lastLookupContext: null,
  lookupUiMode: null, // 'overlay' | 'sidebar' | null
  lookupUiOpen: false,
  currentLemma: null,
  currentVocabItem: null,
  reviewQueue: [],
  activeReview: null,
  speakers: [],
  selectedSpeaker: null,
  selectedSpeaker: null,
  user: null, // Add user field for ownership checks
  isMainlandUser: false, // User's geographic location (for regional playback)
  // metrics tracking
  _lastActiveSegmentIndex: null,
  _exposedSegments: new Set(),
  _readSegments: new Set(),
  practiceLines: [],
  practiceIndex: 0,
  practiceAttempts: 0,
  recorder: null,
  recordingChunks: [],
  lastRecordingBlob: null,
  mediaStream: null,
  recordingMonitor: null,
  practiceAssessmentContext: null,
  practiceLineResults: {},
  practiceLineWordResults: {},
  segmentPlaybackEnd: null,
  segmentPlaybackCallback: null,
  segmentSpeakerMap: {},
  activeSpeakerEditor: null,
  waitingForPractice: false,
  practicePlaybackLock: false,
  practiceArmed: false,
  tags: [],
  selectedTag: '',
  videoTags: {},
  processedVideos: new Set(), // 已处理词汇提取的视频ID集合
  vocabMap: new Map(), // 词汇状态快速查找表: lemma -> state
  segmentHtmlCache: new Map(), // 字幕HTML缓存: segmentIndex -> html
  transcriptFetchRequested: new Set(), // 防止重复请求字幕接口
  isLoadingTranscript: false, // 字幕是否正在加载中
  subtitleOffset: 0, // 字幕时间偏移（秒），正值=提前，负值=延迟
  showBilingual: false, // 移动端字幕显示模式：false=仅英文，true=双语
  // 智能导入状态
  smartImport: {
    sessionId: null,            // 当前会话ID
    isActive: false,            // 是否处于活跃状态
    videoId: null,              // 当前视频ID
    userLevel: 'intermediate',  // 用户等级
    importBudget: 12,           // 导入预算
    clickedLemmas: new Set(),   // 点击过的词（lemma）
    watchedSegments: new Set(), // 已观看的片段索引
    watchStartTime: null,       // 开始观看时间
    pendingOccurrences: [],     // 待上报的出现事件
    lastOccurrenceReport: 0,    // 上次上报时间
    pendingRecommendations: null, // 待确认的推荐列表
  },
};

firstLessonSession.addTeardown(teardownMobileFirstLessonRecording);
window.addEventListener('pagehide', () => teardownMobileFirstLessonRecording('pagehide'));

// 从 localStorage 读取字幕显示模式
try {
  const savedMode = localStorage.getItem('transcript_mode');
  if (savedMode === 'bi') {
    state.showBilingual = true;
  }
} catch (e) {
  console.warn('Failed to load transcript mode from localStorage:', e);
}

// YouTube player instance for API-based playback
let youtubePlayer = null;

// ---------- Lightweight metrics batching (exposure/read/interaction) ----------
const metrics = (function () {
  const q = { exposures: [], reads: [], interactions: [] };
  const MAX_QUEUE = 200;
  let flushing = false;

  function loadPersisted() {
    try {
      const raw = localStorage.getItem('vocab_event_queue');
      if (!raw || raw === 'undefined' || raw === 'null') return;
      const parsed = JSON.parse(raw);
      ['exposures', 'reads', 'interactions'].forEach(function (k) {
        if (Array.isArray(parsed && parsed[k])) {
          Array.prototype.push.apply(q[k], parsed[k]);
        }
      });
      localStorage.removeItem('vocab_event_queue');
    } catch (_) { }
  }

  function persist() {
    try {
      const slim = {
        exposures: q.exposures.slice(-MAX_QUEUE),
        reads: q.reads.slice(-MAX_QUEUE),
        interactions: q.interactions.slice(-MAX_QUEUE),
      };
      localStorage.setItem('vocab_event_queue', JSON.stringify(slim));
    } catch (_) { }
  }

  async function flush() {
    if (flushing) return;
    if (!token) return;
    const hasData = q.exposures.length || q.reads.length || q.interactions.length;
    if (!hasData) return;
    flushing = true;
    const payload = {
      exposures: q.exposures.splice(0, q.exposures.length),
      reads: q.reads.splice(0, q.reads.length),
      interactions: q.interactions.splice(0, q.interactions.length),
    };
    try {
      if (payload.exposures.length) {
        await fetch(`${API_BASE}/vocab/exposures`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ items: payload.exposures })
        }).catch(() => { });
      }
      if (payload.reads.length) {
        await fetch(`${API_BASE}/vocab/reads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ items: payload.reads })
        }).catch(() => { });
      }
      if (payload.interactions.length) {
        await fetch(`${API_BASE}/vocab/interaction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ items: payload.interactions })
        }).catch(() => { });
      }
    } catch (_) {
      // put back on failure
      Array.prototype.unshift.apply(q.exposures, payload.exposures);
      Array.prototype.unshift.apply(q.reads, payload.reads);
      Array.prototype.unshift.apply(q.interactions, payload.interactions);
    } finally {
      persist();
      flushing = false;
    }
  }

  function enqueue(kind, item) {
    if (!q[kind]) return;
    q[kind].push(item);
    if (q[kind].length > MAX_QUEUE) q[kind].splice(0, q[kind].length - MAX_QUEUE);
  }

  function logExposure(lemma, extra) {
    if (extra === undefined) extra = {};
    enqueue('exposures', Object.assign({ lemma: lemma, videoId: state.selectedVideoId, time: Date.now() }, extra));
  }
  function logRead(lemma, extra) {
    if (extra === undefined) extra = {};
    enqueue('reads', Object.assign({ lemma: lemma, videoId: state.selectedVideoId, time: Date.now() }, extra));
  }
  function logInteraction(type, lemma, extra) {
    if (extra === undefined) extra = {};
    enqueue('interactions', Object.assign({ type: type, lemma: lemma, videoId: state.selectedVideoId, time: Date.now() }, extra));
  }

  loadPersisted();
  setInterval(flush, 3000);
  window.addEventListener('beforeunload', persist);
  return { logExposure, logRead, logInteraction, flush };
})();

// ============================================================================
// 智能导入：会话完成处理
// ============================================================================

/**
 * 结束智能导入会话并显示推荐弹窗
 */
async function finishSmartImportSession() {
  if (!state.smartImport.isActive || !state.smartImport.sessionId) {
    console.log('[SmartImport] No active session to finish');
    return;
  }

  const sessionId = state.smartImport.sessionId;
  const watchedSegments = Array.from(state.smartImport.watchedSegments);
  const watchDurationSec = state.smartImport.watchStartTime
    ? Math.round((Date.now() - state.smartImport.watchStartTime) / 1000)
    : 0;

  console.log('[SmartImport] Finishing session:', sessionId, 'segments:', watchedSegments.length, 'duration:', watchDurationSec + 's');

  // 标记会话不再活跃，防止重复触发
  state.smartImport.isActive = false;

  try {
    if (!window.SmartImportAPI) {
      console.warn('[SmartImport] SmartImportAPI not available');
      return;
    }

    const result = await window.SmartImportAPI.finishSession(sessionId, watchedSegments, watchDurationSec);
    console.log('[SmartImport] Finish result:', result);

    if (result && result.recommendations && result.recommendations.length > 0) {
      // 保存推荐列表
      state.smartImport.pendingRecommendations = result.recommendations;
      // 显示导入确认弹窗
      showSmartImportDialog(result.recommendations, result.session);
    } else {
      console.log('[SmartImport] No recommendations, skipping dialog');
    }
  } catch (e) {
    console.error('[SmartImport] Failed to finish session:', e);
  }
}

/**
 * 处理用户离开页面时的会话保存
 */
function handleSmartImportBeforeUnload() {
  if (!state.smartImport.isActive || !state.smartImport.sessionId) {
    return;
  }

  // 使用 sendBeacon 在页面卸载时发送数据
  const sessionId = state.smartImport.sessionId;
  const watchedSegments = Array.from(state.smartImport.watchedSegments);
  const watchDurationSec = state.smartImport.watchStartTime
    ? Math.round((Date.now() - state.smartImport.watchStartTime) / 1000)
    : 0;

  // 使用 sendBeacon 异步发送，不阻塞页面卸载
  const token = localStorage.getItem('linglish_token') || sessionStorage.getItem('linglish_token');
  if (token && watchedSegments.length > 0) {
    try {
      const data = JSON.stringify({
        sessionId,
        watchedSegments,
        watchDurationSec,
        token // 包含 token 用于认证
      });
      navigator.sendBeacon('/vocabulary/v2/smart-import/finish-beacon', data);
      console.log('[SmartImport] Sent finish beacon on unload');
    } catch (e) {
      console.warn('[SmartImport] Failed to send beacon:', e);
    }
  }
}

// 注册 beforeunload 处理器
window.addEventListener('beforeunload', handleSmartImportBeforeUnload);

/**
 * 显示智能导入确认弹窗
 */
function showSmartImportDialog(recommendations, sessionInfo) {
  console.log('[SmartImport] Showing dialog with', recommendations.length, 'recommendations');

  // 分类推荐词汇
  const clickedWords = recommendations.filter(r => r.click_count > 0);
  const recommendedWords = recommendations.filter(r => r.is_recommended && r.click_count === 0);
  const otherWords = recommendations.filter(r => !r.is_recommended && r.click_count === 0);

  // 创建弹窗容器
  let overlay = document.getElementById('smart-import-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'smart-import-overlay';
    overlay.className = 'smart-import-overlay';
    document.body.appendChild(overlay);
  }

  // 构建弹窗内容
  overlay.innerHTML = `
    <div class="smart-import-dialog">
      <div class="smart-import-header">
        <h3>学习新词汇</h3>
        <p class="smart-import-subtitle">
          本次观看发现 <strong>${recommendations.length}</strong> 个生词，
          推荐学习 <strong>${clickedWords.length + recommendedWords.length}</strong> 个
        </p>
        <button class="smart-import-close" onclick="closeSmartImportDialog()">&times;</button>
      </div>

      <div class="smart-import-content">
        ${clickedWords.length > 0 ? `
          <div class="smart-import-section">
            <h4 class="smart-import-section-title">
              <span class="section-icon">👆</span>
              你查过的词 (${clickedWords.length})
            </h4>
            <div class="smart-import-word-list">
              ${clickedWords.map(w => renderSmartImportWord(w, true)).join('')}
            </div>
          </div>
        ` : ''}

        ${recommendedWords.length > 0 ? `
          <div class="smart-import-section">
            <h4 class="smart-import-section-title">
              <span class="section-icon">⭐</span>
              推荐学习 (${recommendedWords.length})
            </h4>
            <div class="smart-import-word-list">
              ${recommendedWords.map(w => renderSmartImportWord(w, true)).join('')}
            </div>
          </div>
        ` : ''}

        ${otherWords.length > 0 ? `
          <div class="smart-import-section collapsed">
            <h4 class="smart-import-section-title" onclick="toggleSmartImportSection(this)">
              <span class="section-icon">📚</span>
              其他生词 (${otherWords.length})
              <span class="toggle-icon">▼</span>
            </h4>
            <div class="smart-import-word-list" style="display: none;">
              ${otherWords.map(w => renderSmartImportWord(w, false)).join('')}
            </div>
          </div>
        ` : ''}
      </div>

      <div class="smart-import-footer">
        <button class="smart-import-btn primary" onclick="confirmSmartImport('recommended')">
          导入推荐词 (${clickedWords.length + recommendedWords.length})
        </button>
        <button class="smart-import-btn secondary" onclick="confirmSmartImport('clicked_only')">
          只导入查过的 (${clickedWords.length})
        </button>
        <button class="smart-import-btn tertiary" onclick="confirmSmartImport('none')">
          暂不导入
        </button>
      </div>
    </div>
  `;

  overlay.style.display = 'flex';
}

/**
 * 渲染单个推荐词汇
 */
function renderSmartImportWord(word, checked) {
  const sentence = word.best_sentence_text || '';
  const lemma = word.lemma;
  const originalForms = word.original_forms ? word.original_forms.join(', ') : lemma;

  // 在句子中高亮词汇
  let highlightedSentence = sentence;
  if (sentence && word.best_word_position_start != null && word.best_word_position_end != null) {
    const start = word.best_word_position_start;
    const end = word.best_word_position_end;
    if (start >= 0 && end > start && end <= sentence.length) {
      highlightedSentence =
        escapeHtml(sentence.slice(0, start)) +
        '<mark>' + escapeHtml(sentence.slice(start, end)) + '</mark>' +
        escapeHtml(sentence.slice(end));
    } else {
      highlightedSentence = escapeHtml(sentence);
    }
  } else {
    highlightedSentence = escapeHtml(sentence);
  }

  const reasonText = getRecommendationReasonText(word.recommendation_reason, word.click_count);

  return `
    <div class="smart-import-word-item" data-lemma="${escapeHtml(lemma)}">
      <label class="smart-import-checkbox">
        <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleWordSelection('${escapeHtml(lemma)}', this.checked)">
        <span class="checkmark"></span>
      </label>
      <div class="smart-import-word-content">
        <div class="smart-import-word-header">
          <span class="word-lemma">${escapeHtml(lemma)}</span>
          ${originalForms !== lemma ? `<span class="word-forms">(${escapeHtml(originalForms)})</span>` : ''}
          <span class="word-reason">${reasonText}</span>
        </div>
        ${highlightedSentence ? `<p class="word-context">${highlightedSentence}</p>` : ''}
      </div>
    </div>
  `;
}

/**
 * 获取推荐原因的显示文本
 */
function getRecommendationReasonText(reason, clickCount) {
  if (clickCount > 0) {
    return `<span class="reason-tag clicked">你查过</span>`;
  }
  switch (reason) {
    case 'high_frequency':
      return `<span class="reason-tag frequency">高频词</span>`;
    case 'level_match':
      return `<span class="reason-tag level">适合你</span>`;
    case 'user_clicked':
      return `<span class="reason-tag clicked">你查过</span>`;
    default:
      return '';
  }
}

/**
 * 切换其他生词区域的展开/收起
 */
function toggleSmartImportSection(titleEl) {
  const section = titleEl.closest('.smart-import-section');
  const wordList = section.querySelector('.smart-import-word-list');
  const toggleIcon = titleEl.querySelector('.toggle-icon');

  if (wordList.style.display === 'none') {
    wordList.style.display = 'block';
    section.classList.remove('collapsed');
    toggleIcon.textContent = '▲';
  } else {
    wordList.style.display = 'none';
    section.classList.add('collapsed');
    toggleIcon.textContent = '▼';
  }
}

/**
 * 切换单词选择状态
 */
function toggleWordSelection(lemma, selected) {
  console.log('[SmartImport] Toggle selection:', lemma, selected);
  // 更新本地状态（可选：同步到服务器）
  if (window.SmartImportAPI && state.smartImport.sessionId) {
    window.SmartImportAPI.updateSelection(state.smartImport.sessionId, lemma, selected)
      .catch(e => console.warn('[SmartImport] Failed to update selection:', e));
  }
}

/**
 * 确认导入
 */
async function confirmSmartImport(mode) {
  console.log('[SmartImport] Confirming import with mode:', mode);

  const sessionId = state.smartImport.sessionId;
  if (!sessionId) {
    console.error('[SmartImport] No session ID');
    closeSmartImportDialog();
    return;
  }

  // 收集选中的词汇
  let selectedLemmas = [];
  if (mode === 'custom' || mode === 'recommended') {
    const checkedItems = document.querySelectorAll('.smart-import-word-item input[type="checkbox"]:checked');
    selectedLemmas = Array.from(checkedItems).map(cb =>
      cb.closest('.smart-import-word-item').dataset.lemma
    );
  }

  try {
    const result = await window.SmartImportAPI.confirmImport(sessionId, mode, selectedLemmas);
    console.log('[SmartImport] Import result:', result);

    // 显示成功提示
    const message = result.imported > 0
      ? `成功导入 ${result.imported} 个词汇！`
      : '没有新词汇需要导入';

    if (result.skipped > 0) {
      console.log('[SmartImport] Skipped (already known):', result.skippedLemmas);
    }

    // 刷新词汇表
    if (result.imported > 0) {
      await refreshVocabularyMap();
      state.segmentHtmlCache.clear();
    }

    // 关闭弹窗
    closeSmartImportDialog();

    // 显示简短提示
    showSmartImportToast(message);

  } catch (e) {
    console.error('[SmartImport] Failed to confirm import:', e);
    showSmartImportToast('导入失败，请重试');
  }
}

/**
 * 关闭导入弹窗
 */
function closeSmartImportDialog() {
  const overlay = document.getElementById('smart-import-overlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

/**
 * 显示简短提示
 */
function showSmartImportToast(message) {
  let toast = document.getElementById('smart-import-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'smart-import-toast';
    toast.className = 'smart-import-toast';
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

/**
 * 刷新词汇映射表
 */
async function refreshVocabularyMap() {
  try {
    const token = localStorage.getItem('linglish_token') || sessionStorage.getItem('linglish_token');
    if (!token) return;

    const response = await fetch('/vocabulary/v2/my?limit=10000', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (response.ok) {
      const data = await response.json();
      state.vocabMap.clear();
      if (data.items && Array.isArray(data.items)) {
        data.items.forEach(item => {
          if (item.word_lowercase) {
            state.vocabMap.set(item.word_lowercase, item.status || 'encountered');
          }
        });
      }
      console.log('[SmartImport] Refreshed vocabMap, size:', state.vocabMap.size);
    }
  } catch (e) {
    console.warn('[SmartImport] Failed to refresh vocabulary map:', e);
  }
}

// 暴露给 onclick 调用
window.closeSmartImportDialog = closeSmartImportDialog;
window.confirmSmartImport = confirmSmartImport;
window.toggleSmartImportSection = toggleSmartImportSection;
window.toggleWordSelection = toggleWordSelection;

// 音频模式管理器
class AudioModeManager {
  constructor() {
    this.mode = 'original'; // original, my-voice, mixed
    this.userRecordings = {}; // {segmentIndex: audioElement}
    this.currentVideoId = null;
    this.overlayAudio = null;
    this.selectedSpeaker = null;
  }

  // 加载用户录音
  loadUserRecordings(videoId) {
    this.currentVideoId = videoId;
    this.userRecordings = {};

    try {
      const storageKey = `user_recordings_${videoId}`;
      const data = localStorage.getItem(storageKey);
      if (!data || data === 'undefined' || data === 'null') {
        console.log('[音频模式] 没有找到用户录音');
        this.updateRecordingIndicator(0);
        return;
      }

      const recordings = JSON.parse(data);
      this.selectedSpeaker = recordings.selectedSpeaker;

      let count = 0;
      for (const [segmentIndex, recording] of Object.entries(recordings.recordings || {})) {
        if (recording.audioData) {
          const audio = new Audio(recording.audioData);
          audio.preload = 'auto';
          this.userRecordings[segmentIndex] = audio;
          count++;
        }
      }

      console.log(`[音频模式] 已加载 ${count} 条用户录音`);
      this.updateRecordingIndicator(count);
    } catch (err) {
      console.error('[音频模式] 加载录音失败:', err);
      this.updateRecordingIndicator(0);
    }
  }

  // 更新录音指示器
  updateRecordingIndicator(count) {
    const indicator = document.getElementById('recording-indicator');
    const countEl = document.getElementById('recorded-count');
    if (indicator && countEl) {
      if (count > 0) {
        countEl.textContent = count;
        indicator.style.display = 'inline';
      } else {
        indicator.style.display = 'none';
      }
    }
  }

  // 设置播放模式
  setMode(newMode) {
    this.mode = newMode;
    console.log(`[音频模式] 切换到: ${newMode}`);
  }

  // 检查当前segment是否应该播放用户录音
  shouldPlayUserRecording(segmentIndex) {
    if (this.mode === 'original') return false;
    if (!this.userRecordings[segmentIndex]) return false;

    if (this.mode === 'my-voice') {
      // 我的配音模式：有录音就播放
      return true;
    }

    if (this.mode === 'mixed') {
      // 混合模式：只播放学生角色的录音
      const segment = state.currentSegments[segmentIndex];
      if (segment && segment.speaker === this.selectedSpeaker) {
        return true;
      }
    }

    return false;
  }

  // 同步播放用户录音（覆盖视频音频）
  syncPlayUserRecording(segmentIndex, videoPlayer) {
    const audio = this.userRecordings[segmentIndex];
    if (!audio) return;

    // 停止之前的录音
    if (this.overlayAudio) {
      this.overlayAudio.pause();
      this.overlayAudio.currentTime = 0;
    }

    this.overlayAudio = audio;

    // 获取segment时间
    const segment = state.currentSegments[segmentIndex];
    if (!segment) return;

    const segmentStart = segment.start;
    const segmentDuration = (segment.end || segment.start + 3) - segment.start;

    // 降低视频音量
    const originalVolume = videoPlayer.volume;
    videoPlayer.volume = 0.1; // 降低原声

    // 播放用户录音
    audio.currentTime = 0;
    audio.play().catch(err => {
      console.error('[音频模式] 播放录音失败:', err);
      videoPlayer.volume = originalVolume;
    });

    // 录音结束后恢复音量
    audio.onended = () => {
      videoPlayer.volume = originalVolume;
    };

    console.log(`[音频模式] 播放segment ${segmentIndex}的用户录音`);
  }

  // 清理
  cleanup() {
    if (this.overlayAudio) {
      this.overlayAudio.pause();
      this.overlayAudio = null;
    }
  }
}

// 创建音频模式管理器实例
const audioModeManager = new AudioModeManager();

const uploadForm = document.getElementById('upload-form');
const uploadStatus = document.getElementById('upload-status');
const videoListEl = document.getElementById('video-list');
const videoPlayer = document.getElementById('video-player');

// 添加视频错误处理
if (videoPlayer) {
  videoPlayer.addEventListener('error', function (e) {
    console.error('Video error:', e);
    const error = videoPlayer.error;
    if (error) {
      let errorMsg = 'Video playback error. ';
      switch (error.code) {
        case error.MEDIA_ERR_ABORTED:
          errorMsg += 'Playback aborted.';
          break;
        case error.MEDIA_ERR_NETWORK:
          errorMsg += 'Network error.';
          break;
        case error.MEDIA_ERR_DECODE:
          errorMsg += 'Decoding error.';
          break;
        case error.MEDIA_ERR_SRC_NOT_SUPPORTED:
          errorMsg += 'Video format not supported.';
          break;
        default:
          errorMsg += 'Unknown error.';
      }
      console.error(errorMsg, error);
    }
  });

  // 视频加载成功时的处理
  videoPlayer.addEventListener('loadedmetadata', function () {
    console.log('Video loaded successfully');
  });

  // 移动端播放优化
  videoPlayer.addEventListener('canplay', function () {
    console.log('Video can play');
  });

  // 监听播放状态
  videoPlayer.addEventListener('play', function () {
    const playOverlay = document.getElementById('play-overlay');
    if (playOverlay) {
      playOverlay.style.display = 'none';
    }
    startWatchTimer();
    firstLessonLifecycle.playback({ video_resource_id: state.selectedVideoId });
  });

  videoPlayer.addEventListener('pause', function () {
    // 不自动显示overlay，只在视频加载时显示
    stopWatchTimer(true);
  });

  videoPlayer.addEventListener('ended', function () {
    stopWatchTimer(true);
    try { todayPlan.showCompletionPrompt(state.selectedVideoId); } catch (_) { }
    nextVideoSheet.showAfter(state.selectedVideoId);

    // 智能导入：视频结束时触发会话完成
    if (state.smartImport.isActive && state.smartImport.sessionId) {
      finishSmartImportSession();
    }
  });

  videoPlayer.addEventListener('loadedmetadata', function () {
    if (mobileDuration) {
      mobileDuration.textContent = formatTime(videoPlayer.duration || 0);
    }
    if (mobileProgress) {
      mobileProgress.value = 0;
    }
    updateMobileNavButtons(mobileSegmentPosition);
  });
}

// 播放overlay点击事件
const playOverlay = document.getElementById('play-overlay');
if (playOverlay) {
  playOverlay.addEventListener('click', async function () {
    playOverlay.style.display = 'none';
    await safePlayVideo();
  });
}

const transcriptContent = document.getElementById('transcript-content');
const transcriptLanguage = document.getElementById('transcript-language');
const videoMeta = document.getElementById('video-meta');

// 使用事件委托处理转录文本中的按钮点击（性能优化）
if (transcriptContent) {
  transcriptContent.addEventListener('click', function (e) {
    // 处理编辑按钮点击
    if (e.target.classList.contains('transcript-edit-btn')) {
      e.stopPropagation();
      const index = Number(e.target.getAttribute('data-index'));
      enterEditMode(index);
      return;
    }

    // 处理说话人标签点击
    if (e.target.classList.contains('speaker-label')) {
      e.stopPropagation();
      const index = Number(e.target.getAttribute('data-index'));
      handleSpeakerLabelClick(e.target, index);
      return;
    }
  });
}
const rightSidebar = document.getElementById('right-sidebar');
const dictionarySectionRight = document.getElementById('dictionary-section-right');
const practiceSectionRight = document.getElementById('practice-section-right');
const practiceToggleBtnRight = document.getElementById('practice-toggle-btn-right');
const practiceSidebarPanelRight = document.getElementById('practice-sidebar-panel-right');
const dictionaryToggleBtnRight = document.getElementById('dictionary-toggle-btn-right');
const backToVideoFromDict = document.getElementById('back-to-video-from-dict');
const dictionarySidebarPanelRight = document.getElementById('dictionary-sidebar-panel-right');
const dictionaryContent = document.getElementById('dictionary-content');

// Mobile “查看” style vocab detail overlay (used for transcript lookup on small screens)
const vocabDetailOverlay = document.getElementById('vocab-detail-overlay');
const vocabDetailBackdrop = vocabDetailOverlay ? vocabDetailOverlay.querySelector('.vocab-detail-backdrop') : null;
const vocabDetailCloseBtn = document.getElementById('vocab-detail-close');
const vocabDetailWordEl = document.getElementById('detail-word');
const vocabDetailIpaEl = document.getElementById('detail-ipa');
const vocabDetailTranslationEl = document.getElementById('detail-translation');
const vocabDetailStatusEl = document.getElementById('detail-status');
const vocabDetailDictCard = document.getElementById('detail-dict-card');
const vocabDetailLangToggle = document.getElementById('vr-dict-lang-toggle');
const vocabDetailLangEn = document.getElementById('vr-dict-lang-en');
const vocabDetailLangZh = document.getElementById('vr-dict-lang-zh');
let vrTabDeep = document.getElementById('vr-tab-deep');
let vocabDetailDeepCard = document.getElementById('detail-deep-card');

// If HTML is old/cached (no #vr-tab-deep), inject the controls row dynamically
(function injectDeepAnalysisTabs() {
  if (vrTabDeep) return; // already in DOM
  const card = vocabDetailOverlay && vocabDetailOverlay.querySelector('.vocab-detail-card');
  if (!card) return;

  // Build controls row with lang-toggle on left and deep button on right
  const ctrlBar = document.createElement('div');
  ctrlBar.id = 'vr-ctrl-bar';
  ctrlBar.style.cssText = 'display:flex;align-items:center;padding:.4rem 0;border-bottom:1px solid #e2e8f0;';

  // Move lang toggle into ctrl bar (left side)
  const langToggle = document.getElementById('vr-dict-lang-toggle');
  if (langToggle) ctrlBar.appendChild(langToggle);

  // Deep analysis toggle button (right side, all inline styles – immune to CSS overrides)
  const deepBtn = document.createElement('button');
  deepBtn.id = 'vr-tab-deep';
  deepBtn.type = 'button';
  deepBtn.textContent = '✦ 深度解析';
  deepBtn.style.cssText = 'margin-left:auto;flex-shrink:0;display:inline-flex;align-items:center;font-size:.8rem;font-weight:700;color:#4f46e5;background:rgba(99,102,241,.12);border:1.5px solid rgba(99,102,241,.3);border-radius:999px;padding:.32rem .9rem;cursor:pointer;white-space:nowrap;touch-action:manipulation;-webkit-tap-highlight-color:transparent;line-height:1.4;';
  ctrlBar.appendChild(deepBtn);

  // Insert ctrl bar before detail-dict-card
  const dictCard = document.getElementById('detail-dict-card');
  if (dictCard) card.insertBefore(ctrlBar, dictCard);
  else card.appendChild(ctrlBar);

  // Add deep panel after dict card if missing
  if (dictCard && !document.getElementById('detail-deep-card')) {
    const deepPanel = document.createElement('div');
    deepPanel.id = 'detail-deep-card';
    deepPanel.hidden = true;
    dictCard.after(deepPanel);
  }

  vrTabDeep = document.getElementById('vr-tab-deep');
  vocabDetailDeepCard = document.getElementById('detail-deep-card');
})();

let activeDictionaryContainer = dictionaryContent;
let dictLangMode = 'en';
try { dictLangMode = localStorage.getItem('dict_lang_mode') || 'en'; } catch (_) { }
let lastRenderedDictPayload = null; // { word, entry, zh, audioUrl }

function delegateDictionarySpeak(container) {
  if (!container || container.__speakDelegated) return;
  container.addEventListener('click', function (ev) {
    const speakBtn = ev.target && ev.target.closest ? ev.target.closest('.dict-speak-btn') : null;
    if (speakBtn) {
      ev.preventDefault(); ev.stopPropagation(); if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      const w = (speakBtn.getAttribute('data-word') || '').trim();
      const au = (speakBtn.getAttribute('data-audio') || '').trim();
      if (w) playWordAudioSmart(w, au);
      return;
    }
    const defBtn = ev.target && ev.target.closest ? ev.target.closest('.dict-def-speak') : null;
    if (defBtn) {
      ev.preventDefault(); ev.stopPropagation(); if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      const t = (defBtn.getAttribute('data-text') || '').trim();
      if (t) playWordAudioSmart(t, '');
    }
  }, { passive: false });
  Object.defineProperty(container, '__speakDelegated', { value: true, writable: false });
}

delegateDictionarySpeak(dictionaryContent);
delegateDictionarySpeak(vocabDetailDictCard);

function resumePlaybackIfNeeded() {
  stopDictSpeech();
  if (!wasPlayingBeforeLookupMobile) return;
  try {
    const youtubePlayerWrapper = document.getElementById('youtube-player-wrapper');
    const isUsingYouTube = youtubePlayerWrapper && youtubePlayerWrapper.style.display !== 'none';
    if (isUsingYouTube) {
      try {
        if (youtubePlayer && youtubePlayer.getPlayerState && youtubePlayer.getPlayerState() === 2) {
          youtubePlayer.play();
        }
      } catch (_) { }
    } else {
      try {
        if (videoPlayer && videoPlayer.paused) {
          videoPlayer.play().catch(() => { });
        }
      } catch (_) { }
    }
  } finally {
    wasPlayingBeforeLookupMobile = false;
  }
}

function openVocabDetailOverlay(word) {
  if (!vocabDetailOverlay || !vocabDetailDictCard) return false;
  try {
    if (vocabDetailWordEl) vocabDetailWordEl.textContent = word || '';
    if (vocabDetailIpaEl) vocabDetailIpaEl.textContent = '';
    if (vocabDetailTranslationEl) vocabDetailTranslationEl.textContent = '';
    if (vocabDetailStatusEl) vocabDetailStatusEl.textContent = '';
    if (vocabDetailLangToggle) {
      vocabDetailLangToggle.style.display = (window.DictionaryRender ? '' : 'none');
    }
    if (vocabDetailLangEn) vocabDetailLangEn.classList.toggle('active', dictLangMode === 'en');
    if (vocabDetailLangZh) vocabDetailLangZh.classList.toggle('active', dictLangMode !== 'en');
    // Reset to dict tab on each new word open
    switchMobileDictTab('dict');
    if (vocabDetailDeepCard) vocabDetailDeepCard.innerHTML = '';
    vocabDetailOverlay.hidden = false;
    document.body.style.overflow = 'hidden';
    return true;
  } catch (_) { return false; }
}

function closeVocabDetailOverlay({ resumePlayback = true } = {}) {
  if (!vocabDetailOverlay) return;
  vocabDetailOverlay.hidden = true;
  try { document.body.style.overflow = ''; } catch (_) { }
  state.lookupUiOpen = false;
  state.lookupUiMode = null;
  if (resumePlayback) resumePlaybackIfNeeded();
}

if (vocabDetailOverlay) {
  if (vocabDetailBackdrop) {
    vocabDetailBackdrop.addEventListener('click', function () { closeVocabDetailOverlay({ resumePlayback: true }); });
  }
  if (vocabDetailCloseBtn) {
    vocabDetailCloseBtn.addEventListener('click', function () { closeVocabDetailOverlay({ resumePlayback: true }); });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !vocabDetailOverlay.hidden) closeVocabDetailOverlay({ resumePlayback: true });
  });
}

function renderDictionaryInto(container, payload, stopPolling) {
  if (!container || !payload) return;
  const { word, entry, zh, audioUrl } = payload;
  if (window.DictionaryRender) {
    container.innerHTML = DictionaryRender.build(word, entry, zh || '', { audioUrl: audioUrl || '', langMode: dictLangMode });
    if (window.DictionaryLookup) {
      try { window.DictionaryLookup.attachTranslateButtonHandlers(container, word, stopPolling); } catch (_) { }
    }
    delegateDictionarySpeak(container);
  } else {
    container.innerHTML = `<div style="padding: 1rem; color: #64748b;">Dictionary renderer unavailable</div>`;
  }
}

function setDictLangMode(nextMode) {
  const mode = nextMode === 'en' ? 'en' : 'zh';
  if (mode === dictLangMode) return;
  dictLangMode = mode;
  try { localStorage.setItem('dict_lang_mode', dictLangMode); } catch (_) { }
  if (vocabDetailLangEn) vocabDetailLangEn.classList.toggle('active', dictLangMode === 'en');
  if (vocabDetailLangZh) vocabDetailLangZh.classList.toggle('active', dictLangMode !== 'en');
  if (activeDictionaryContainer && lastRenderedDictPayload) {
    renderDictionaryInto(activeDictionaryContainer, lastRenderedDictPayload);
    // Keep vocab meta/action states in sync with the re-rendered container
    try { renderWordMeta(state.currentVocabItem, []); } catch (_) { }
    try { setWordActionState(state.currentVocabItem); } catch (_) { }
  }
}

if (vocabDetailLangToggle) {
  vocabDetailLangToggle.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', function () {
      const mode = btn.getAttribute('data-lang');
      setDictLangMode(mode);
    });
  });
}

// ── Mobile deep analysis toggle ──
function switchMobileDictTab(tab) {
  const isDeep = tab === 'deep';
  if (vocabDetailDictCard) vocabDetailDictCard.hidden = isDeep;
  if (vocabDetailDeepCard) vocabDetailDeepCard.hidden = !isDeep;
  if (vocabDetailLangToggle) vocabDetailLangToggle.style.display = isDeep ? 'none' : '';
  if (vrTabDeep) {
    if (isDeep) {
      vrTabDeep.textContent = '← 词典';
      vrTabDeep.style.color = '#64748b';
      vrTabDeep.style.background = '#f1f5f9';
      vrTabDeep.style.borderColor = '#e2e8f0';
    } else {
      vrTabDeep.textContent = '✦ 深度解析';
      vrTabDeep.style.color = '#4f46e5';
      vrTabDeep.style.background = 'rgba(99,102,241,.12)';
      vrTabDeep.style.borderColor = 'rgba(99,102,241,.3)';
    }
  }
  if (isDeep) {
    const word = (vocabDetailWordEl && vocabDetailWordEl.textContent) || '';
    if (word) loadMobileDeepAnalysis(word);
  }
}

// Inject vocab-status + refresh button at bottom of deep analysis card
function _deepActionStrip(container, word) {
  const daCard = container && container.querySelector('.da-card');
  if (!daCard) return;
  const item = state && state.currentVocabItem;
  const stateLabels = { learning: '学习中 📚', reviewing: '复习中 🔄', mastered: '已掌握 ⭐' };
  const statusHtml = (item && item.state && stateLabels[item.state])
    ? `<span style="font-size:.76rem;color:#64748b;">词汇状态：<strong style="color:#0f172a;">${stateLabels[item.state]}</strong></span>`
    : `<button id="da-add-btn" style="font-size:.76rem;font-weight:700;color:#059669;background:rgba(5,150,105,.1);border:1px solid rgba(5,150,105,.3);border-radius:999px;padding:.2rem .65rem;cursor:pointer;">+ 加入词汇表</button>`;
  const strip = document.createElement('div');
  strip.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:.5rem 1.1rem .75rem;border-top:1px solid #f1f5f9;';
  strip.innerHTML = statusHtml +
    '<button id="da-refresh-btn" title="重新生成" style="font-size:.76rem;color:#94a3b8;background:transparent;border:none;cursor:pointer;padding:.15rem .4rem;border-radius:6px;">↺ 刷新</button>';
  daCard.appendChild(strip);
  const addBtn = daCard.querySelector('#da-add-btn');
  if (addBtn) addBtn.addEventListener('click', async function () {
    try {
      addBtn.disabled = true; addBtn.textContent = '已加入 ✓';
      await markWord(word, 'learning');
    } catch (_) { addBtn.disabled = false; addBtn.textContent = '+ 加入词汇表'; }
  });
  const refBtn = daCard.querySelector('#da-refresh-btn');
  if (refBtn) refBtn.addEventListener('click', function () { loadMobileDeepAnalysis(word, true); });
}

function loadMobileDeepAnalysis(word, forceRefresh) {
  if (!vocabDetailDeepCard || !window.DeepAnalysis) return;
  vocabDetailDeepCard.innerHTML = window.DeepAnalysis.renderLoading();
  const apiBase = window.API_BASE || '';
  const getHdrs = function () {
    const tok = localStorage.getItem('linglish_token');
    return tok ? { 'Authorization': 'Bearer ' + tok } : {};
  };
  const opts = forceRefresh ? { refresh: true } : undefined;
  window.DeepAnalysis.load(word, apiBase, getHdrs, opts).then(function (data) {
    vocabDetailDeepCard.innerHTML = window.DeepAnalysis.render(word, data);
    window.DeepAnalysis.tryRenderMermaid(vocabDetailDeepCard);
    try { _deepActionStrip(vocabDetailDeepCard, word); } catch (e) { console.warn('[DeepAnalysis] strip err', e); }
  }).catch(function (err) {
    if (err && err.paywall && window.DeepAnalysis && typeof window.DeepAnalysis.renderPaywall === 'function') {
      vocabDetailDeepCard.innerHTML = window.DeepAnalysis.renderPaywall(err.paywall);
      return;
    }
    const message = err && err.message ? err.message : '加载失败，请稍后重试';
    vocabDetailDeepCard.innerHTML =
      '<div style="padding:1.5rem;text-align:center;">' +
        `<p style="color:#ef4444;font-size:.86rem;margin:0 0 .9rem;">${escapeHtml(message)}</p>` +
        '<button id="da-retry-btn" style="padding:.38rem 1.2rem;background:#4f46e5;color:#fff;border:none;border-radius:999px;cursor:pointer;font-size:.82rem;font-weight:700;">🔄 重试</button>' +
      '</div>';
    const retryBtn = document.getElementById('da-retry-btn');
    if (retryBtn) retryBtn.addEventListener('click', function () { loadMobileDeepAnalysis(word); });
    console.error('[DeepAnalysis] mobile load error:', err);
  });
}

if (vrTabDeep) vrTabDeep.addEventListener('click', function () {
  const isCurrentlyDeep = vocabDetailDeepCard && !vocabDetailDeepCard.hidden;
  switchMobileDictTab(isCurrentlyDeep ? 'dict' : 'deep');
});

const reviewQueueEl = document.getElementById('review-queue');
const reviewDrill = document.getElementById('review-drill');
const reviewDrillWord = document.getElementById('review-drill-word');
const reviewDrillContext = document.getElementById('review-drill-context');
const reviewPassBtn = document.getElementById('review-pass');
const reviewFailBtn = document.getElementById('review-fail');
const reviewSkipBtn = document.getElementById('review-skip');
const desktopHardFirstToggle = document.getElementById('desktop-hard-first-toggle');
let desktopHardFirst = false;
try { desktopHardFirst = localStorage.getItem('desktop_hard_first') === '1'; } catch (_) { }
function syncDesktopHardBtn() {
  if (desktopHardFirstToggle) {
    desktopHardFirstToggle.textContent = desktopHardFirst ? 'Hard: ON' : 'Hard: OFF';
  }
}
syncDesktopHardBtn();
if (desktopHardFirstToggle) {
  desktopHardFirstToggle.addEventListener('click', function () {
    desktopHardFirst = !desktopHardFirst;
    try { localStorage.setItem('desktop_hard_first', desktopHardFirst ? '1' : '0'); } catch (_) { }
    syncDesktopHardBtn();
    refreshReviewQueue();
  });
}
const speedToggleButton = document.getElementById('speed-toggle-button');
const speedFloatingMenu = document.getElementById('speed-floating-menu');
const practicePanel = document.getElementById('practice-panel');
const practiceSpeakerSelect = document.getElementById('practice-speaker');
const practiceLineList = document.getElementById('practice-line-list');
const practiceCurrentLine = document.getElementById('practice-current-line');
const practiceControls = document.getElementById('practice-controls');
const practicePlayOriginalBtn = document.getElementById('practice-play-original');
const practiceStartBtn = document.getElementById('practice-start');
const practiceCompareBtn = document.getElementById('practice-compare');
const practiceFeedback = document.getElementById('practice-feedback');
const practiceArmBtn = document.getElementById('practice-arm-btn');

if (dictionarySectionRight) {
  dictionarySectionRight.setAttribute('aria-hidden', 'true');
}

// 右侧边栏练习面板元素
const practiceSpeakerSelectRight = document.getElementById('practice-speaker-right');
const practiceLineListRight = document.getElementById('practice-line-list-right');
const practiceCurrentLineRight = document.getElementById('practice-current-line-right');
const practiceControlsRight = document.getElementById('practice-controls-right');
const practicePlayOriginalBtnRight = document.getElementById('practice-play-original-right');
const practiceStartBtnRight = document.getElementById('practice-start-right');
const practiceCompareBtnRight = document.getElementById('practice-compare-right');
const practiceFeedbackRight = document.getElementById('practice-feedback-right');
const practiceArmBtnRight = document.getElementById('practice-arm-btn-right');

const mobileTranscript = document.getElementById('mobile-transcript');
const mobileTranscriptList = document.getElementById('mobile-transcript-list');
const mobilePrevSegmentBtn = document.getElementById('mobile-prev-segment');
const mobileNextSegmentBtn = document.getElementById('mobile-next-segment');
const mobileProgress = document.getElementById('mobile-progress');
const mobileCurrentTime = document.getElementById('mobile-current-time');
const mobileDuration = document.getElementById('mobile-duration');
const mobileSpeedBtns = document.querySelectorAll('.mobile-speed-btn');
const mobileReplayBtn = document.getElementById('mobile-replay');
const mobileBackBtn = document.getElementById('mobile-back-btn');
const mobileViewBtns = document.querySelectorAll('.mobile-view-btn');
const mobilePlayerControls = document.getElementById('mobile-player-controls');
let mobileSegmentPosition = null;
let isMobileProgressDragging = false;

// 左侧边栏练习面板元素

if (reviewPassBtn) {
  reviewPassBtn.addEventListener('click', function () { submitReview('pass'); });
}
if (reviewFailBtn) {
  reviewFailBtn.addEventListener('click', function () { submitReview('fail'); });
}
if (reviewSkipBtn) {
  reviewSkipBtn.addEventListener('click', function () {
    if (state.activeReview) {
      const skipped = state.activeReview;
      closeReviewDrill();
      state.reviewQueue = state.reviewQueue
        .filter(function (item) { return item.lemma !== skipped.lemma; })
        .concat([skipped]);
      renderReviewQueue();
    } else {
      closeReviewDrill();
    }
  });
}

if (practiceSpeakerSelect) {
  practiceSpeakerSelect.addEventListener('change', function (event) {
    setPracticeSpeaker(event.target.value);
  });
}
if (practicePlayOriginalBtn) {
  practicePlayOriginalBtn.addEventListener('click', playOriginalLine);
}
if (practiceStartBtn) {
  practiceStartBtn.addEventListener('click', function () {
    if (!state.practiceArmed) {
      togglePracticeMode(true);
    }
    startPracticeRecording();
  });
}
if (practiceCompareBtn) {
  practiceCompareBtn.addEventListener('click', compareRecordings);
}
if (practiceArmBtn) {
  practiceArmBtn.addEventListener('click', function () { togglePracticeMode(!state.practiceArmed); });
}

// 右侧边栏练习面板事件监听
if (practiceSpeakerSelectRight) {
  practiceSpeakerSelectRight.addEventListener('change', function (event) {
    setPracticeSpeaker(event.target.value);
    // 同步更新主面板的选择
    if (practiceSpeakerSelect) practiceSpeakerSelect.value = event.target.value;
  });
}
if (practicePlayOriginalBtnRight) {
  practicePlayOriginalBtnRight.addEventListener('click', playOriginalLine);
}
if (practiceStartBtnRight) {
  practiceStartBtnRight.addEventListener('click', function () {
    if (!state.practiceArmed) {
      togglePracticeMode(true);
    }
    startPracticeRecording();
  });
}
if (practiceCompareBtnRight) {
  practiceCompareBtnRight.addEventListener('click', compareRecordings);
}
if (practiceArmBtnRight) {
  practiceArmBtnRight.addEventListener('click', function () { togglePracticeMode(!state.practiceArmed); });
}

// 右侧边栏练习面板折叠/展开功能
if (practiceToggleBtnRight && practiceSidebarPanelRight) {
  practiceToggleBtnRight.addEventListener('click', function () {
    const isCollapsed = practiceSidebarPanelRight.classList.contains('collapsed');
    if (isCollapsed) {
      // 展开所有练习相关元素
      practiceSidebarPanelRight.classList.remove('collapsed');
      practiceToggleBtnRight.classList.add('expanded');

      // 显示其他练习元素（如果它们之前被隐藏了）
      if (practiceCurrentLineRight && !practiceCurrentLineRight.hidden) {
        practiceCurrentLineRight.style.display = '';
      }
      if (practiceLineListRight) {
        practiceLineListRight.style.display = '';
      }
      if (practiceControlsRight && !practiceControlsRight.hidden) {
        practiceControlsRight.style.display = '';
      }
      if (practiceFeedbackRight) {
        practiceFeedbackRight.style.display = '';
      }
    } else {
      // 折叠所有练习相关元素
      practiceSidebarPanelRight.classList.add('collapsed');
      practiceToggleBtnRight.classList.remove('expanded');

      // 隐藏其他练习元素
      if (practiceCurrentLineRight) {
        practiceCurrentLineRight.style.display = 'none';
      }
      if (practiceLineListRight) {
        practiceLineListRight.style.display = 'none';
      }
      if (practiceControlsRight) {
        practiceControlsRight.style.display = 'none';
      }
      if (practiceFeedbackRight) {
        practiceFeedbackRight.style.display = 'none';
      }
    }
  });
}

// 右侧边栏区域切换函数
function showPracticeSectionRight() {
  if (practiceSectionRight) {
    practiceSectionRight.style.display = '';
  }
  if (dictionarySectionRight) {
    dictionarySectionRight.style.display = 'none';
  }
  if (rightSidebar) {
    rightSidebar.classList.remove('dict-open');
  }
}

function showDictionarySectionRight() {
  if (practiceSectionRight) {
    practiceSectionRight.style.display = 'none';
  }
  if (dictionarySectionRight) {
    dictionarySectionRight.style.display = 'flex';
    dictionarySectionRight.setAttribute('aria-hidden', 'false');
  }
  // 显示词典浮层
  if (rightSidebar) {
    rightSidebar.classList.add('visible');
    rightSidebar.classList.add('dict-open');
  }
  // X号关闭按钮已经在sticky顶部栏中，不需要额外显示
  vocabStudyStart();
}

// 缓存移动端布局检测结果，避免频繁调用 getComputedStyle
let _mobileLayoutCache = null;
let _mobileLayoutCacheTime = 0;
const MOBILE_LAYOUT_CACHE_TTL = 500; // 缓存500ms

function isMobileLayout() {
  const now = Date.now();
  if (_mobileLayoutCache !== null && (now - _mobileLayoutCacheTime) < MOBILE_LAYOUT_CACHE_TTL) {
    return _mobileLayoutCache;
  }
  let result = false;
  try {
    const el = document.getElementById('mobile-transcript');
    if (el) {
      const style = window.getComputedStyle(el);
      if (style && style.display !== 'none' && style.visibility !== 'hidden') {
        result = true;
      }
    }
  } catch (_) { }
  if (!result) {
    result = typeof window !== 'undefined' && window.innerWidth <= 1024;
  }
  _mobileLayoutCache = result;
  _mobileLayoutCacheTime = now;
  return result;
}

// 窗口大小变化时清除缓存
window.addEventListener('resize', () => { _mobileLayoutCache = null; }, { passive: true });

function updateMobileNavButtons(position = mobileSegmentPosition) {
  if (!isMobileLayout()) return;
  const total = Array.isArray(state.currentSegments) ? state.currentSegments.length : 0;
  const valid = Number.isFinite(position) && position >= 0 && position < total;
  if (mobilePrevSegmentBtn) {
    mobilePrevSegmentBtn.disabled = !valid || position <= 0;
  }
  if (mobileNextSegmentBtn) {
    mobileNextSegmentBtn.disabled = !valid || position >= total - 1;
  }
}

// Ensure an element is visible inside a scrollable container without re-centering.
function ensureVisibleIn(container, el, { marginTop = 40, marginBottom = 60 } = {}) {
  if (!container || !el) return;
  try {
    const cRect = container.getBoundingClientRect();
    const eRect = el.getBoundingClientRect();
    const viewTop = container.scrollTop;
    const elTop = eRect.top - cRect.top + viewTop;
    const elBottom = eRect.bottom - cRect.top + viewTop;
    const viewBottom = viewTop + container.clientHeight;
    let target = null;
    if (elTop < viewTop + marginTop) {
      target = elTop - marginTop;
    } else if (elBottom > viewBottom - marginBottom) {
      target = elBottom - container.clientHeight + marginBottom;
    }
    if (target != null) {
      const clamped = Math.max(0, Math.round(target));
      if (Math.abs(clamped - container.scrollTop) > 2) {
        container.scrollTo({ top: clamped, behavior: 'auto' });
      }
    }
  } catch (_) {
    try { el.scrollIntoView({ block: 'nearest', behavior: 'auto' }); } catch (_) { }
  }
}

// 性能优化：缓存上一次的渲染位置，避免重复渲染
let lastMobileRenderPosition = -1;
// 标记样式是否已初始化，避免重复设置
let _mobileStylesInitialized = false;

function renderMobileTranscriptWindow(position) {
  if (!mobileTranscriptList) return;

  // 首先确保移动端视图容器可见（必须在任何提前返回之前执行）
  if (!_mobileStylesInitialized) {
    const wrapper = mobileTranscriptList.parentElement;
    if (wrapper) {
      const transcriptView = wrapper.parentElement;
      if (transcriptView && transcriptView.classList.contains('mobile-transcript-view')) {
        const focusedSizing =
          window.MobileReaderLayout &&
          window.MobileReaderLayout.usesFocusedTranscriptSizing(document.body.className);
        transcriptView.style.setProperty('display', 'flex', 'important');
        transcriptView.style.setProperty('flex-direction', 'column', 'important');
        if (!focusedSizing) {
          transcriptView.style.setProperty('height', 'calc((100vh - 70px) * 0.55)', 'important');
        }
        transcriptView.style.setProperty('overflow', 'hidden', 'important');
      }
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'row';
      wrapper.style.flex = '1 1 0px';
      wrapper.style.minHeight = '0';
      wrapper.style.overflow = 'hidden';
    }
    mobileTranscriptList.style.flex = '1 1 0px';
    mobileTranscriptList.style.minHeight = '0';
    mobileTranscriptList.style.overflowY = 'auto';
    _mobileStylesInitialized = true;
  }

  const segments = Array.isArray(state.currentSegments) ? state.currentSegments : [];
  if (!segments.length) {
    // 检查是否正在加载字幕
    const loadingText = state.isLoadingTranscript ? '字幕加载中...' : '暂无字幕';
    mobileTranscriptList.innerHTML = `<li class="mobile-transcript-item empty">${loadingText}</li>`;
    updateMobileNavButtons(null);
    lastMobileRenderPosition = -1;
    return;
  }

  let activeIndex = Number.isFinite(position) ? position : 0;
  activeIndex = Math.max(0, Math.min(segments.length - 1, activeIndex));

  // 位置没变，只需滚动
  if (activeIndex === lastMobileRenderPosition) {
    const activeItem = mobileTranscriptList.querySelector('.mobile-transcript-item.active');
    if (activeItem) {
      requestAnimationFrame(() => ensureVisibleIn(mobileTranscriptList, activeItem));
    }
    return;
  }
  lastMobileRenderPosition = activeIndex;

  // 窗口大小7，减少频繁重新渲染
  const windowSize = 7;
  let start = Math.max(0, activeIndex - Math.floor(windowSize / 2));
  let end = Math.min(segments.length, start + windowSize);
  if (end - start < windowSize) {
    start = Math.max(0, end - windowSize);
  }

  const items = [];
  for (let i = start; i < end; i += 1) {
    const seg = segments[i];
    const timeLabel = formatTime(Number((seg && seg.start)) || 0);

    // 性能优化：只为当前激活的字幕分割单词，其他字幕保持纯文本
    let content;
    if (i === activeIndex) {
      let cached = state.segmentHtmlCache.get(i);
      if (!cached) {
        cached = wordHtml((seg && seg.text) || '');
        state.segmentHtmlCache.set(i, cached);
      }
      content = cached;
    } else {
      content = escapeHtml((seg && seg.text) || '');
    }

    // 获取中文翻译
    const translation = (seg && (seg.translation || seg.cn || seg.zh || seg.text_cn || '')).trim();
    const translationHtml = state.showBilingual && translation
      ? `<span class="mobile-segment-translation">${escapeHtml(translation)}</span>`
      : '';

    items.push(`<li class="mobile-transcript-item${i === activeIndex ? ' active' : ''}" data-index="${i}" ${i !== activeIndex ? `data-text="${escapeHtml((seg && seg.text) || '')}"` : ''}>
              <span class="mobile-segment-time">${timeLabel}</span>
              <span class="mobile-segment-text">${content}</span>
              ${translationHtml}
            </li>`);
  }

  mobileTranscriptList.innerHTML = items.join('');
  updateMobileNavButtons(activeIndex);

  // 滚动到激活项，使用单次 rAF 即可
  const activeItem = mobileTranscriptList.querySelector('.mobile-transcript-item.active');
  if (activeItem) {
    requestAnimationFrame(() => ensureVisibleIn(mobileTranscriptList, activeItem));
  }
}

function navigateMobileSegment(direction) {
  if (!isMobileLayout()) return;
  const segments = state.currentSegments || [];
  if (!Array.isArray(segments) || !segments.length) return;
  let targetPos;
  if (Number.isFinite(mobileSegmentPosition)) {
    targetPos = mobileSegmentPosition + direction;
  } else {
    targetPos = direction > 0 ? 0 : segments.length - 1;
  }
  targetPos = Math.max(0, Math.min(segments.length - 1, targetPos));
  const segment = segments[targetPos];
  if (!segment) return;
  const startTime = Number(segment.start);
  if (Number.isFinite(startTime)) {
    // 支持YouTube播放器和HTML5播放器
    if (youtubePlayer && youtubePlayer.player) {
      youtubePlayer.seekTo(Math.max(0, startTime));
      youtubePlayer.play();
    } else if (videoPlayer) {
      videoPlayer.currentTime = Math.max(0, startTime);
      safePlayVideo();
    }
  }
  mobileSegmentPosition = targetPos;
  updateMobileNavButtons(mobileSegmentPosition);
  // 更新字幕显示
  renderMobileTranscriptWindow(mobileSegmentPosition);
}

// 返回视频按钮 - 隐藏右侧边栏
if (backToVideoFromDict) {
  backToVideoFromDict.addEventListener('click', function () {
    if (dictionarySectionRight) {
      dictionarySectionRight.style.display = 'none';
      dictionarySectionRight.setAttribute('aria-hidden', 'true');
    }
    if (rightSidebar) {
      rightSidebar.classList.remove('visible');
      rightSidebar.classList.remove('dict-open');
    }
    state.lookupUiOpen = false;
    state.lookupUiMode = null;
    vocabStudyStop();
  });
}

// X号关闭按钮 - 与返回视频按钮功能相同
const dictionaryCloseBtn = document.getElementById('dictionary-close-btn-right');
if (dictionaryCloseBtn) {
  dictionaryCloseBtn.addEventListener('click', function () {
    if (dictionarySectionRight) {
      dictionarySectionRight.style.display = 'none';
      dictionarySectionRight.setAttribute('aria-hidden', 'true');
    }
    if (rightSidebar) {
      rightSidebar.classList.remove('visible');
      rightSidebar.classList.remove('dict-open');
    }
    state.lookupUiOpen = false;
    state.lookupUiMode = null;
    vocabStudyStop();
  });

  // 添加悬停效果
  dictionaryCloseBtn.addEventListener('mouseenter', function () {
    this.style.background = 'rgba(239, 68, 68, 1)';
    this.style.transform = 'scale(1.15)';
  });
  dictionaryCloseBtn.addEventListener('mouseleave', function () {
    this.style.background = 'rgba(239, 68, 68, 0.9)';
    this.style.transform = 'scale(1)';
  });
}

// 角色扮演按钮的折叠/展开仍然保留原有功能
// （已在前面的代码中实现）

updatePracticeArmUI();

// Observe dictionary/sidebar visibility to stop vocab timer when hidden
try {
  if (rightSidebar) {
    const observer = new MutationObserver(() => {
      const visible = rightSidebar.classList.contains('visible');
      const dictShown = dictionarySectionRight && dictionarySectionRight.style.display !== 'none';
      if (!visible || !dictShown) {
        vocabStudyStop();
      }
    });
    observer.observe(rightSidebar, { attributes: true, attributeFilter: ['class'] });
    if (dictionarySectionRight) {
      const dictObserver = new MutationObserver(() => {
        const dictShown = dictionarySectionRight.style.display !== 'none';
        if (!dictShown) vocabStudyStop();
      });
      dictObserver.observe(dictionarySectionRight, { attributes: true, attributeFilter: ['style'] });
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopWatchTimer(true);
      vocabStudyStop();
    } else if (!document.hidden && !videoPlayer.paused) {
      startWatchTimer();
    }
  });
} catch (_) { }

async function fetchJSON(url, options) {
  if (options === undefined) options = {};
  var headers = Object.assign({}, options.headers || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  var fetchOptions = Object.assign({}, options, { headers: headers });
  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    // In guest mode, just surface errors; if token exists and 401, warn but don't redirect
    if (response.status === 401 && token) {
      console.warn('[Auth] Unauthorized (token invalid or expired)');
    }
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function decodeHtml(text) {
  const div = document.createElement('div');
  div.innerHTML = text;
  return div.textContent || div.innerText || '';
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return 'Not scheduled';
  const target = new Date(timestamp);
  const diffMs = target.getTime() - Date.now();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Due today';
  if (diffDays === 1) return 'Due tomorrow';
  if (diffDays < 0) return `Overdue ${Math.abs(diffDays)}d`;
  return `Due in ${diffDays}d`;
}

async function fetchVocabDetails(word) {
  try {
    const response = await fetch(`${API_BASE}/vocab/item?lemma=${encodeURIComponent(word)}`, {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    });
    if (!response.ok) {
      return { item: null, contexts: [] };
    }
    return await response.json();
  } catch (err) {
    console.warn('Failed to fetch vocab item:', err);
    return { item: null, contexts: [] };
  }
}

function setWordActionState(item) {
  const root = activeDictionaryContainer || dictionaryContent;
  if (!root) return;
  const buttons = root.querySelectorAll('.word-action-btn');
  buttons.forEach(btn => btn.classList.remove('active'));
  if (!item) return;
  let targetStatus = 'new';
  if (item.state === 'learning') targetStatus = 'learning';
  if (item.state === 'reviewing' || item.state === 'mastered') targetStatus = 'known';
  const button = root.querySelector(`.word-action-btn.btn-${targetStatus === 'known' ? 'known' : targetStatus === 'learning' ? 'learning' : 'new'}`);
  if (button) button.classList.add('active');
}

function renderWordMeta(item, contexts) {
  const meta = (activeDictionaryContainer && activeDictionaryContainer.querySelector)
    ? activeDictionaryContainer.querySelector('#word-study-meta')
    : document.getElementById('word-study-meta');
  if (!meta) return;
  if (!item) {
    meta.innerHTML = '<small style="color:#666;">Word not yet tracked. Add it to your list to begin.</small>';
    return;
  }

  const nextReviewText = formatRelativeTime(item.next_review_at);
  const exposures = item.exposures || 0;
  const reviewCount = item.review_count || 0;
  const stateLabel = item.state.replace(/_/g, ' ');
  const contextsHtml = (contexts || [])
    .slice(0, 5)
    .map((ctx) => `<li>${escapeHtml(ctx.sentence || '')}${ctx.start_sec != null ? ` <span style="color:#888;">(${ctx.start_sec.toFixed(1)}s)</span>` : ''}</li>`)
    .join('');

  meta.innerHTML = `
          <h4>Progress</h4>
          <div class="word-meta-grid">
            <div class="word-meta-card"><strong>Stage</strong><br>${escapeHtml(stateLabel)}</div>
            <div class="word-meta-card"><strong>Exposures</strong><br>${exposures}</div>
            <div class="word-meta-card"><strong>Reviews</strong><br>${reviewCount}</div>
            <div class="word-meta-card"><strong>Next review</strong><br>${escapeHtml(nextReviewText)}</div>
          </div>
          ${contextsHtml
      ? `<div><strong>Contexts</strong><ul class="word-context-list">${contextsHtml}</ul></div>`
      : '<div style="color:#666;">No contexts logged yet.</div>'}
        `;
}

async function loadWordMeta(word) {
  state.currentLemma = word;
  const { item, contexts } = await fetchVocabDetails(word);
  if (state.currentLemma !== word) return;
  state.currentVocabItem = item;
  renderWordMeta(item, contexts);
  setWordActionState(item);
}

async function refreshReviewQueue() {
  try {
    const url = `${API_BASE}/vocab/review-queue?limit=10${desktopHardFirst ? '&hard=1' : ''}`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    state.reviewQueue = data.items || [];
    renderReviewQueue();
  } catch (err) {
    console.error('Failed to refresh review queue:', err);
  }
}

function renderReviewQueue() {
  if (!reviewQueueEl) return;
  reviewQueueEl.innerHTML = '';
  if (!state.reviewQueue.length) {
    reviewQueueEl.innerHTML = '<li style="color:#666;">No reviews due right now.</li>';
    reviewDrill.hidden = true;
    state.activeReview = null;
    return;
  }

  state.reviewQueue.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'review-item';
    li.innerHTML = `
            <span>${escapeHtml(item.lemma)}</span>
            <span style="font-size:0.8rem; color:#666;">${formatRelativeTime(item.next_review_at)}</span>
          `;
    li.addEventListener('click', function () { openReviewDrill(item); });
    reviewQueueEl.appendChild(li);
  });
}

async function openReviewDrill(item) {
  state.activeReview = item;
  reviewDrill.hidden = false;
  reviewDrillWord.textContent = item.lemma;

  const details = await fetchVocabDetails(item.lemma);
  const contexts = details.contexts || [];
  if (contexts.length) {
    reviewDrillContext.textContent = contexts[0].sentence || '';
    state.lastLookupContext = {
      segmentIndex: contexts[0].segment_index,
      startSec: contexts[0].start_sec,
      endSec: contexts[0].end_sec,
      sentence: contexts[0].sentence,
    };
  } else {
    reviewDrillContext.textContent = 'No context saved yet. Recall the definition from memory.';
  }
}

function closeReviewDrill() {
  state.activeReview = null;
  if (reviewDrill) {
    reviewDrill.hidden = true;
    reviewDrillWord.textContent = '';
    reviewDrillContext.textContent = '';
  }
}

async function submitReview(outcome) {
  if (!state.activeReview) {
    closeReviewDrill();
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/vocab/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ lemma: state.activeReview.lemma, outcome })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || 'Failed to record review');
    }
  } catch (err) {
    console.error('Review submission failed:', err);
  } finally {
    closeReviewDrill();
    refreshReviewQueue();
  }
}

function formatTime(sec) {
  if (!Number.isFinite(sec)) return '0:00';
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function wordHtml(text) {
  let coloredWords = 0;
  const result = text
    .split(/(\s+)/)
    .map(function (part) {
      if (part.match(/\s+/)) return part;

      // 清理单词：移除所有非字母、非连字符、非撇号的字符
      const clean = part
        .replace(/['']/g, "'")  // 统一引号
        .replace(/[^a-z'-]/gi, '') // 移除非字母字符（保留连字符和撇号）
        .replace(/^['\-]+|['\-]+$/g, ''); // 移除首尾的连字符和撇号

      // 如果清理后为空或太短，直接返回原文本（不包装）
      if (!clean || clean.length < 2 || !/[a-z]/i.test(clean)) {
        return escapeHtml(part);
      }

      // 检查单词的学习状态并添加相应的CSS类
      const wordLower = clean.toLowerCase();
      const vocabState = state.vocabMap.get(wordLower);
      let stateClass = '';

      if (vocabState) {
        // 已学习的单词
        if (vocabState === 'mastered') {
          stateClass = ' word-mastered';
        } else if (vocabState === 'learning' || vocabState === 'reviewing') {
          stateClass = ' word-learning';
        } else {
          stateClass = ' word-encountered';
        }
        coloredWords++;
      } else if (state.smartImport.isActive) {
        // 智能导入模式：未学习的单词标记为候选词
        // 使用客户端 lemma 检查是否已点击
        const lemma = window.SmartImportAPI ? window.SmartImportAPI.simpleLemma(wordLower) : wordLower;
        if (state.smartImport.clickedLemmas.has(lemma)) {
          // 用户已点击查询过的词 - 更强调色
          stateClass = ' word-clicked-lookup';
          coloredWords++;
        } else {
          // 未知候选词 - 淡黄色虚线
          stateClass = ' word-candidate';
        }
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

function renderVideoList() {
  if (!state.videos.length) {
    videoListEl.innerHTML = '<li class="empty-state">Upload a video to get started.</li>';
    return;
  }

  const filteredVideos = state.videos.filter(video => {
    if (!state.selectedTag) return true;
    const videoTags = state.videoTags[video.id] || [];
    return videoTags.includes(state.selectedTag);
  });

  if (filteredVideos.length === 0) {
    videoListEl.innerHTML = '<li class="empty-state">该标签下没有视频</li>';
    return;
  }

  videoListEl.innerHTML = filteredVideos
    .map(video => {
      const isActive = video.id === state.selectedVideoId;
      const statusValue = video.status || 'processing';
      const statusAttr = video.failure_reason
        ? ` title="${escapeHtml(video.failure_reason)}"`
        : '';
      const videoTags = state.videoTags[video.id] || [];
      const tagsHtml = videoTags.length > 0
        ? `<div class="video-tags">${videoTags.map(tag =>
          `<span class="video-tag">${escapeHtml(tag)}</span>`
        ).join('')}</div>`
        : '';

      // 获取视频元数据。公开分享/精选需要后台审核流，不能只改本地状态。
      const videoMeta = videoManagementSystem.getVideo(video.id);
      let expiryBadge = '';
      let videoActionsHtml = '';

      if (videoMeta) {
        const daysLeft = videoManagementSystem.getDaysLeft(video.id);

        // 根据状态显示不同的徽章
        if (videoMeta.isFeatured) {
          expiryBadge = `<span class="video-expiry-badge featured" title="精选视频，永久保存">⭐ 精选</span>`;
        } else if (videoMeta.isShared) {
          expiryBadge = `<span class="video-expiry-badge shared" title="已分享">🌟 已分享</span>`;
        } else if (daysLeft === 0) {
          expiryBadge = `<span class="video-expiry-badge expired" title="已过期">⏰ 已过期</span>`;
        } else if (daysLeft <= 3 && daysLeft !== Infinity) {
          expiryBadge = `<span class="video-expiry-badge expiring-soon" title="即将过期">⚠️ 剩${daysLeft}天</span>`;
        } else if (daysLeft !== Infinity) {
          expiryBadge = `<span class="video-expiry-badge" title="剩余${daysLeft}天" style="background:#e3f2fd;color:#1565c0;">📅 ${daysLeft}天</span>`;
        }

        videoActionsHtml = '';
      }
      const visibilityBadge = video.is_featured
        ? `<span class="video-expiry-badge featured" title="精选公开视频">精选</span>`
        : video.is_public === false
          ? `<span class="video-expiry-badge" title="仅自己可见" style="background:#f8fafc;color:#475569;border:1px solid #e2e8f0;">私有</span>`
          : `<span class="video-expiry-badge shared" title="已公开">公开</span>`;
      expiryBadge = `${visibilityBadge}${expiryBadge}`;

      // Check ownership - only show edit/delete buttons for video owner
      const currentUserId = state.user && state.user.id;
      // Use loose equality to handle number/string type differences
      const isOwner = currentUserId && video.uploader_id && String(video.uploader_id) === String(currentUserId);
      const isAdmin = state.user && state.user.is_admin;
      const shareButtonHtml = isOwner && video.is_public === false
        ? `<button class="video-action-btn share-video-btn" data-id="${video.id}" title="申请公开">↗</button>`
        : '';
      const featureButtonHtml = (isOwner || isAdmin) && !video.is_featured
        ? `<button class="video-action-btn feature-video-btn" data-id="${video.id}" title="${isAdmin ? '设为精选' : '申请精选'}">★</button>`
        : '';

      // Only render edit/delete buttons if user is the owner
      const ownerButtonsHtml = (isOwner || isAdmin) ? `
              <div class="video-item-actions">
                ${shareButtonHtml}
                ${featureButtonHtml}
                <button class="video-action-btn edit-video-btn" data-id="${video.id}" title="编辑标题">✏️</button>
                <button class="video-action-btn tag-video-btn" data-id="${video.id}" title="管理标签">🏷️</button>
                ${isOwner || isAdmin ? `<button class="video-action-btn delete-video-btn" data-id="${video.id}" title="删除视频">🗑️</button>` : ''}
              </div>
            ` : '';

      return `
              <li class="video-item ${isActive ? 'active' : ''}" data-id="${video.id}">
                <div class="video-item-header">
                  <h3 class="video-item-title" data-id="${video.id}">${escapeHtml(video.title)}</h3>
                  ${ownerButtonsHtml}
                </div>
                <div style="font-size: 0.8rem; color: #666; margin-top: 0.25rem;">
                  ${video.duration_sec ? formatTime(video.duration_sec) : '—'} ·
                  ${video.language || 'en'}
                  ${expiryBadge}
                </div>
                ${tagsHtml}
                <div class="video-status ${escapeHtml(statusValue)}"${statusAttr}>
                  ${escapeHtml(statusValue)}
                </div>
                ${videoActionsHtml}
              </li>
            `;
    })
    .join('');

  // Add event listeners for edit, tag, and delete buttons
  document.querySelectorAll('.edit-video-btn').forEach(btn => {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const videoId = Number(btn.getAttribute('data-id'));
      editVideoTitle(videoId);
    });
  });

  document.querySelectorAll('.tag-video-btn').forEach(btn => {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const videoId = Number(btn.getAttribute('data-id'));
      showTagDialog(videoId);
    });
  });

  document.querySelectorAll('.delete-video-btn').forEach(btn => {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const videoId = Number(btn.getAttribute('data-id'));
      deleteVideo(videoId);
    });
  });

  // 分享视频按钮
  document.querySelectorAll('.share-video-btn').forEach(btn => {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const videoId = Number(btn.getAttribute('data-id'));
      shareVideo(videoId);
    });
  });

  // 加精视频按钮（仅管理员）
  document.querySelectorAll('.feature-video-btn').forEach(btn => {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const videoId = Number(btn.getAttribute('data-id'));
      featureVideo(videoId);
    });
  });
}

function renderTranscript(video) {
  // 清除字幕HTML缓存，准备渲染新视频或重新渲染
  state.segmentHtmlCache.clear();

  if (!video) {
    transcriptContent.innerHTML = '<div class="empty-state">Select a video to view its transcript.</div>';
    transcriptLanguage.textContent = '';
    state.currentSegments = [];
    return;
  }

  if (video.status === 'processing') {
    transcriptContent.innerHTML = '<div class="empty-state">Transcription in progress. Please refresh in a moment.</div>';
    transcriptLanguage.textContent = '';
    state.currentSegments = [];
    return;
  }

  if (video.status === 'failed') {
    transcriptContent.innerHTML = `<div class="empty-state" style="color:#d32f2f;">${escapeHtml(video.failure_reason || 'Transcription failed. Please re-upload the video later.')}</div>`;
    transcriptLanguage.textContent = '';
    state.currentSegments = [];
    return;
  }

  if (video.status === 'skipped') {
    transcriptContent.innerHTML = `<div class="empty-state">${escapeHtml(video.failure_reason || 'Transcription skipped.')}</div>`;
    transcriptLanguage.textContent = '';
    state.currentSegments = [];
    return;
  }

  if (!firstLessonSession.isActive() &&
    waveformSegmentationConfig.enabled &&
    video &&
    Array.isArray(video.transcript_segments) &&
    video.transcript_segments.length &&
    !video._waveformSegmentationPromise &&
    !video._waveformSegmentationApplied) {
    const refinementPromise = ensureWaveformSegmentation(video);
    video._waveformSegmentationPromise = refinementPromise;
    refinementPromise.then(
      () => {
        if (video._waveformSegmentationPromise !== refinementPromise) return;
        delete video._waveformSegmentationPromise;
        if (state.selectedVideoId === video.id) renderTranscript(video);
      },
      (error) => {
        if (video._waveformSegmentationPromise !== refinementPromise) return;
        delete video._waveformSegmentationPromise;
        console.warn('Unable to refine transcript segments:', error);
        if (state.selectedVideoId === video.id) renderTranscript(video);
      },
    );
  }
  const transcriptRefinementPending = Boolean(video._waveformSegmentationPromise);

  const rawSegments = Array.isArray(video.transcript_segments) ? video.transcript_segments : [];
  const segments = firstLessonSession.isActive() && window.LinglishSentenceSegments?.toDisplayedSentences
    ? window.LinglishSentenceSegments.toDisplayedSentences(rawSegments)
    : rawSegments;
  state.currentSegments = segments;
  if (window && window.LinglishCoachingDock && typeof window.LinglishCoachingDock.sync === 'function') {
    window.LinglishCoachingDock.sync({
      segments: state.currentSegments,
      index: -1,
      videoId: state.selectedVideoId,
      user: state.user,
    });
  }

  if (segments.length === 0) {
    // 如果正在加载，显示加载状态
    const loadingMsg = state.isLoadingTranscript ? 'Loading transcript...' : 'Transcript unavailable.';
    transcriptContent.innerHTML = `<div class="empty-state">${loadingMsg}</div>`;
    if (video.id && video.status === 'ready' && !state.transcriptFetchRequested.has(video.id)) {
      state.transcriptFetchRequested.add(video.id);
      state.isLoadingTranscript = true;
      fetch(`${API_BASE}/video-resources/${video.id}/transcript`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          state.isLoadingTranscript = false;
          const fetched = data && Array.isArray(data.segments) ? data.segments : [];
          if (fetched.length) {
            video.transcript_segments = fetched;
            renderTranscript(video);
          }
        })
        .catch(() => {
          state.isLoadingTranscript = false;
        });
    }
  } else if (isMobileLayout()) {
    transcriptContent.innerHTML = '<div class="empty-state">Transcript ready.</div>';
  } else {
    // 性能优化：初始渲染不分割单词，按需延迟分割
    // 这样可以减少90%的DOM节点数量，避免浏览器卡死
    console.log(`[Performance] Rendering ${segments.length} segments WITHOUT word splitting (lazy loading)`);

    // 使用 requestAnimationFrame 来避免阻塞 UI
    requestAnimationFrame(() => {
      transcriptContent.innerHTML = segments
        .map(function (segment, index) {
          const start = Number(segment.start) || 0;
          const end = Number(segment.end != null ? segment.end : start);
          const encodedSentence = encodeURIComponent(segment.text || '');
          const speakerKey = segment.index !== undefined ? segment.index : index;
          const speakerNameRaw = (segment.speaker || state.segmentSpeakerMap[speakerKey] || '').trim();
          const hasSpeaker = Boolean(speakerNameRaw);
          const safeSpeakerName = hasSpeaker ? escapeHtml(speakerNameRaw) : '';
          const speaker = `
                  <button
                    type="button"
                    class="speaker-label${hasSpeaker ? '' : ' is-empty'}"
                    data-index="${index}"
                    data-speaker="${safeSpeakerName}"
                    title="${hasSpeaker ? '点击更换角色' : '点击设置角色'}"
                  >
                    ${hasSpeaker ? safeSpeakerName : '设置角色'}
                  </button>
                `;
          // 性能优化：初始只渲染纯文本，不分割单词
          // data-text属性保存原始文本，用于后续按需分割（带颜色）
          return `
                  <div class="transcript-segment" data-index="${index}" data-start="${start}" data-end="${end}" data-sentence="${encodedSentence}">
                    <button class="transcript-edit-btn" data-index="${index}">✏️</button>
                    <span class="transcript-time" data-start="${start}">${formatTime(start)}</span>
                    ${speaker}
                    <span class="transcript-text" data-index="${index}" data-text="${escapeHtml(segment.text || '')}">${escapeHtml(segment.text || '')}</span>
                  </div>
                `;
        })
        .join('');

      console.log(`[Performance] Initial render complete. Words will be split on-demand when segment is activated.`);
    });
  }

  transcriptLanguage.textContent = video.language ? `Language: ${video.language}` : '';
  if (isMobileLayout()) {
    renderMobileTranscriptWindow(segments.length ? (Number.isFinite(mobileSegmentPosition) ? mobileSegmentPosition : 0) : null);
  }
  if (!transcriptRefinementPending) {
    startMobileFirstLessonProgress(video, segments);
    markFirstLessonReadyForCommittedTranscript(video, segments);
  }
}

// 安全播放视频的辅助函数（处理移动端播放限制）
async function safePlayVideo() {
  try {
    await videoPlayer.play();
    return true;
  } catch (err) {
    console.warn('Video play failed:', err);
    // 如果是因为用户交互限制，不显示错误
    if (err.name !== 'NotAllowedError') {
      console.error('Video playback error:', err);
    }
    return false;
  }
}

// 从视频中提取并保存词汇
async function extractAndSaveVocabulary(video) {
  console.log('[Vocab Extract] Starting extraction for video:', video.id);
  console.log('[Vocab Extract] Token exists:', !!token);
  console.log('[Vocab Extract] Video exists:', !!video);
  console.log('[Vocab Extract] Transcript segments:', video && video.transcript_segments);

  if (!token || !video || !video.transcript_segments) {
    console.log('[Vocab Extract] Missing required data, aborting');
    return;
  }

  // 检查是否已经处理过这个视频（从localStorage读取持久化记录）
  const processedVideosKey = 'linglish_processed_videos';
  let processedVideos = new Set();
  try {
    const stored = localStorage.getItem(processedVideosKey);
    if (stored && stored !== 'undefined' && stored !== 'null') {
      processedVideos = new Set(JSON.parse(stored));
    }
  } catch (e) {
    console.warn('[Vocab Extract] Failed to load processed videos from localStorage:', e);
  }

  if (processedVideos.has(video.id)) {
    console.log(`[Vocab Extract] Video ${video.id} already processed for vocabulary extraction (from localStorage)`);
    return;
  }

  try {
    const segments = Array.isArray(video.transcript_segments) ? video.transcript_segments : [];
    console.log('[Vocab Extract] Number of segments:', segments.length);
    const allWords = new Set();

    // 从所有字幕段落中提取单词
    segments.forEach((segment, segmentIndex) => {
      if (!segment.text) return;

      const words = segment.text
        .toLowerCase()
        .replace(/['']/g, "'")
        .split(/[\s\-—–]+/) // 先按空格和连字符分割
        .filter(word => {
          // 移除所有非字母、非连字符、非撇号的字符
          const cleaned = word.replace(/[^a-z'-]/gi, '');
          // 再移除首尾的连字符和撇号
          const trimmed = cleaned.replace(/^['\-]+|['\-]+$/g, '');

          // 过滤条件：
          // 1. 长度至少2个字符
          // 2. 包含至少一个字母
          // 3. 不是纯数字
          // 4. 不包含连续的特殊字符
          return trimmed.length >= 2 &&
            /[a-z]/i.test(trimmed) &&
            !/^\d+$/.test(trimmed) &&
            !/[']{2,}/.test(trimmed); // 不包含连续的撇号
        })
        .map(word => {
          // 最终清理：移除所有非字母、非连字符、非撇号的字符，再移除首尾的标点
          const cleaned = word.replace(/[^a-z'-]/gi, '');
          return cleaned.replace(/^['\-]+|['\-]+$/g, '');
        });

      words.forEach(word => allWords.add(word));
    });

    console.log(`Found ${allWords.size} unique words in video ${video.id}`);

    // 调用后端批量导入API（异步处理，不阻塞视频播放）
    try {
      const response = await fetch(`${API_BASE}/video-resources/${video.id}/import-words`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const result = await response.json();
        console.log(`[Vocab Extract] Word import started:`, result);

        // 检查是后台处理还是立即完成
        if (result.status === 'processing') {
          console.log(`[Vocab Extract] Processing ${result.total} words in background`);
        } else {
          // 兼容旧的同步响应格式
          console.log(`[Vocab Extract] Imported: ${result.imported || 0}, Skipped: ${result.skipped || 0}, Total: ${result.total || 0}`);
        }

        // 标记为已处理（同时保存到localStorage）
        processedVideos.add(video.id);
        state.processedVideos.add(video.id);
        try {
          localStorage.setItem(processedVideosKey, JSON.stringify(Array.from(processedVideos)));
          console.log(`[Vocab Extract] Marked video ${video.id} as processed (saved to localStorage)`);
        } catch (e) {
          console.warn('[Vocab Extract] Failed to save processed videos to localStorage:', e);
        }
      } else {
        const errorText = await response.text();
        console.error(`[Vocab Extract] Failed to import words: ${response.status} ${errorText}`);
      }
    } catch (error) {
      console.error('[Vocab Extract] Error importing words:', error);
    }

  } catch (error) {
    console.error('Failed to extract vocabulary:', error);
  }
}

// 在后台批量保存单词（分批处理避免服务器过载）
async function saveWordsInBackground(words, videoId, segments) {
  console.log(`[Vocab Save] Starting to save ${words.length} words from video ${videoId}`);
  const batchSize = 10;
  const batches = [];

  for (let i = 0; i < words.length; i += batchSize) {
    batches.push(words.slice(i, i + batchSize));
  }

  console.log(`[Vocab Save] Split into ${batches.length} batches`);

  let successCount = 0;
  let failCount = 0;

  // 逐批处理，避免同时发送太多请求
  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    console.log(`[Vocab Save] Processing batch ${batchIdx + 1}/${batches.length}`);

    await Promise.all(batch.map(async (word) => {
      try {
        // 查找包含该单词的第一个句子（使用单词边界匹配，避免子串匹配）
        const wordRegex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        const segmentWithWord = segments.find(s =>
          s.text && wordRegex.test(s.text)
        );

        const segmentIndex = segmentWithWord ? segments.indexOf(segmentWithWord) : null;

        const payload = {
          lemma: word,
          state: 'new',
          videoResourceId: videoId,
          segmentIndex: segmentIndex,
          startSec: (segmentWithWord && segmentWithWord.start !== null && segmentWithWord.start !== undefined) ? segmentWithWord.start : null,
          endSec: (segmentWithWord && segmentWithWord.end !== null && segmentWithWord.end !== undefined) ? segmentWithWord.end : null,
          sentence: (segmentWithWord && segmentWithWord.text !== null && segmentWithWord.text !== undefined) ? segmentWithWord.text : null,
        };

        const response = await fetch(`${API_BASE}/vocab/mark`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          successCount++;
        } else {
          failCount++;
          const errorText = await response.text();
          console.warn(`[Vocab Save] Failed to save word "${word}": ${response.status} ${errorText}`);
        }
      } catch (error) {
        failCount++;
        console.warn(`[Vocab Save] Error saving word "${word}":`, error);
      }
    }));

    // 短暂延迟避免服务器过载
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`[Vocab Save] Completed: ${successCount} successful, ${failCount} failed out of ${words.length} words`);
}

let videoSelectionGeneration = 0;

async function selectVideo(id) {
  teardownMobileFirstLessonRecording('video-selection');
  firstLessonGoal = null;
  firstLessonGoalCard.hide();
  const video = state.videos.find(v => v.id === id);
  const selectionGeneration = ++videoSelectionGeneration;
  const isCurrentSelection = () => (
    selectionGeneration === videoSelectionGeneration && state.selectedVideoId === id
  );
  closeMobileVideoLibrary();
  nextVideoSheet.hide();

  // 防止重复选择同一视频导致字幕重置
  const isNewVideo = state.selectedVideoId !== id;

  state.selectedVideoId = id;
  state.segmentSpeakerMap = {};
  state.waitingForPractice = false;
  state.practicePlaybackLock = false;
  state.practiceArmed = false;
  state.practiceAssessmentContext = null;
  state.isLoadingTranscript = false; // 重置加载状态
  updatePracticeArmUI();
  renderVideoList();

  // 增加视频浏览量（仅在选择新视频时）
  if (isNewVideo && id) {
    fetch(`${API_BASE}/video-resources/${id}/increment-view`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }).catch(err => {
      console.log('[Video] Failed to increment view count:', err);
      // 静默失败，不影响用户体验
    });
  }

  // 性能优化：清理旧视频数据，释放内存
  lastSegmentIndex = -1;
  lastProgressPercent = -1;
  lastProgressSaveTime = 0;
  // 只在切换到新视频时重置移动端字幕位置
  if (isNewVideo) {
    lastMobileRenderPosition = -1;
  }
  state._lastActivePracticeLine = null;
  state._lastActivePracticeLineRight = null;
  console.log('[Performance] Cleaned up old video data, isNewVideo:', isNewVideo);

  // 智能导入：在切换视频时初始化新会话
  if (isNewVideo && id && video && video.status === 'ready') {
    // 重置智能导入状态
    state.smartImport.sessionId = null;
    state.smartImport.isActive = false;
    state.smartImport.videoId = id;
    state.smartImport.clickedLemmas = new Set();
    state.smartImport.watchedSegments = new Set();
    state.smartImport.watchStartTime = Date.now();
    state.smartImport.pendingOccurrences = [];
    state.smartImport.lastOccurrenceReport = 0;
    state.smartImport.pendingRecommendations = null;

    // 异步启动智能导入会话
    if (window.SmartImportAPI) {
      window.SmartImportAPI.startSession(id)
        .then(result => {
          if (result && result.sessionId) {
            state.smartImport.sessionId = result.sessionId;
            state.smartImport.isActive = true;
            state.smartImport.userLevel = result.userLevel || 'intermediate';
            state.smartImport.importBudget = result.importBudget || 12;
            console.log('[SmartImport] Session started:', result.sessionId, 'level:', result.userLevel, 'budget:', result.importBudget);
            // 清除缓存以应用新的候选词高亮
            state.segmentHtmlCache.clear();
          }
        })
        .catch(e => {
          console.warn('[SmartImport] Failed to start session:', e);
          state.smartImport.isActive = false;
        });
    }
  }

  // If transcript data is missing from lite list, fetch full details.
  if (video && (!video.transcript_segments || video.transcript_segments.length === 0)) {
    state.isLoadingTranscript = true;
    fetch(`${API_BASE}/video-resources/${id}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        state.isLoadingTranscript = false;
        const full = data && data.video ? data.video : null;
        if (!full) return;
        const idx = state.videos.findIndex(v => v.id === id);
        if (idx >= 0) state.videos[idx] = full;
        if (state.selectedVideoId === id) {
          renderTranscript(full);
          setTimeout(() => {
            extractAndSaveVocabulary(full);
          }, 1000);
        }
      })
      .catch(() => {
        state.isLoadingTranscript = false;
      });
  }

  // 先显示加载状态，稍后在loadSpeakersForVideo完成后再完整渲染
  // 这样避免了双重渲染的性能问题
  if (video && video.status === 'ready' && video.transcript_segments && video.transcript_segments.length > 0) {
    transcriptContent.innerHTML = '<div class="empty-state">Loading transcript...</div>';
    transcriptLanguage.textContent = video.language ? `Language: ${video.language}` : '';
  } else {
    // 对于空视频或错误状态，立即渲染
    renderTranscript(video);
  }

  // 只在切换到新视频时重置移动端字幕窗口
  if (isNewVideo) {
    mobileSegmentPosition = null;
    renderMobileTranscriptWindow(null);
  }
  if (mobileProgress) {
    mobileProgress.value = 0;
  }
  if (mobileCurrentTime) {
    mobileCurrentTime.textContent = '00:00';
  }

  // 加载用户录音
  audioModeManager.loadUserRecordings(id);

  // 延迟提取词汇，避免阻塞视频加载
  if (video) {
    // 等待3秒后再提取词汇，让视频先流畅加载
    setTimeout(() => {
      extractAndSaveVocabulary(video);
    }, 3000);
  }

  // 在移动端，点击视频后隐藏左侧边栏，显示视频内容
  if (window.innerWidth <= 768 && videoSidebar) {
    videoSidebar.classList.add('hidden');
    if (toggleSidebarBtn) {
      toggleSidebarBtn.textContent = '☰';
    }
  }

  if (video) {
    const youtubePlayerWrapper = document.getElementById('youtube-player-wrapper');
    const youtubePlayerIframe = document.getElementById('youtube-player');

    // 辅助函数：从YouTube URL中提取视频ID
    function extractYouTubeVideoId(url) {
      if (!url || typeof url !== 'string') {
        console.log('[YouTube] extractYouTubeVideoId: invalid input', typeof url);
        return null;
      }

      console.log('[YouTube] Extracting video ID');

      // 匹配各种YouTube URL格式（包括移动版 m.youtube.com）
      const patterns = [
        // Standard and mobile YouTube watch URLs
        /(?:(?:www\.|m\.)?youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
        // Short URLs
        /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
        // Embed URLs
        /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
        // Just the video ID
        /^([a-zA-Z0-9_-]{11})$/
      ];

      for (let i = 0; i < patterns.length; i++) {
        const pattern = patterns[i];
        const match = url.match(pattern);
        if (match && match[1]) {
          console.log('[YouTube] ✓ Extracted video ID with pattern:', i);
          return match[1];
        }
      }

      console.log('[YouTube] ✗ No video ID found in URL');
      return null;
    }

    // 检测是否为YouTube视频（优先使用youtube_video_id字段，否则从video_path提取）
    console.log('[YouTube] Source availability:', {
      hasYouTubeId: Boolean(video.youtube_video_id),
      hasVideoPath: Boolean(video.video_path),
      hasLocalVideoPath: Boolean(video.local_video_path),
      localVideoStatus: video.local_video_status || 'unknown',
    });

    let youtubeVideoId = video.youtube_video_id;
    if (!youtubeVideoId && video.video_path) {
      console.log('[YouTube] Attempting to extract from video_path...');
      youtubeVideoId = extractYouTubeVideoId(video.video_path);
    }

    // Check if this YouTube video has a local copy downloaded (for mainland China users)
    const hasLocalCopy = !!video.local_video_path && video.local_video_status === 'completed';

    // Regional playback logic:
    // - Non-mainland users: Always use YouTube (saves server bandwidth)
    // - Mainland users: Use local copy if available (may not have YouTube access)
    const isYouTube = !!youtubeVideoId && (!state.isMainlandUser || !hasLocalCopy);

    console.log('[YouTube] ========================================');
    console.log('[YouTube] Final Detection Results:');
    console.log('[YouTube]   - Has YouTube ID:', !!youtubeVideoId);
    console.log('[YouTube]   - Has local copy:', hasLocalCopy);
    console.log('[YouTube]   - User is from mainland:', state.isMainlandUser);
    console.log('[YouTube]   - Will use YouTube player:', isYouTube);
    console.log('[YouTube] ========================================');

    if (isYouTube) {
      // YouTube视频 - 使用YouTube IFrame API
      console.log('[YouTube] Loading YouTube video with API:', Boolean(youtubeVideoId));

      // 清理旧的 YouTube 播放器实例
      if (youtubePlayer) {
        console.log('[YouTube] Cleaning up old player');
        try {
          youtubePlayer.destroy();
        } catch (e) {
          console.warn('[YouTube] Error destroying old player:', e);
        }
        youtubePlayer = null;
      }

      // 隐藏HTML5播放器，显示YouTube播放器
      videoPlayer.style.display = 'none';
      videoPlayer.removeAttribute('src');
      if (youtubePlayerWrapper) {
        youtubePlayerWrapper.style.display = 'block';
      }

      videoMeta.textContent = `${video.title || video.original_filename || 'YouTube Video'}`;
      loadSpeakersForVideo(video.id);

      // 隐藏play overlay（YouTube已有自己的播放控件）
      const playOverlay = document.getElementById('play-overlay');
      if (playOverlay) {
        playOverlay.style.display = 'none';
      }

      // 初始化 YouTube 播放器 (异步)
      (async function () {
        try {
          console.log('[YouTube] Initializing YouTubePlayer API');
          youtubePlayer = new YouTubePlayer('youtube-player');
          await youtubePlayer.init(youtubeVideoId);
          console.log('[YouTube] Player initialized successfully');

          // 监听播放状态变化以记录观看时长
          youtubePlayer.on('statechange', function (event) {
            if (event.data === YT.PlayerState.PLAYING) {
              if (firstLessonSession.isActive() && firstLessonGoalBusy) { youtubePlayer.pause(); return; }
              noteLearningVideoStarted();
              startWatchTimer();
              firstLessonLifecycle.playback({ video_resource_id: state.selectedVideoId });
            } else if (event.data === YT.PlayerState.ENDED) {
              stopWatchTimer(true);
              try { todayPlan.showCompletionPrompt(state.selectedVideoId); } catch (_) { }
              nextVideoSheet.showAfter(state.selectedVideoId);
            } else if (event.data === YT.PlayerState.PAUSED) {
              stopWatchTimer(true);
            }
          });

          // 设置时间更新回调来触发字幕滚动
          // 复用与 HTML5 videoPlayer 相同的字幕高亮逻辑
          youtubePlayer.on('timeupdate', function (currentTime) {
            if (firstLessonSession.isActive() && state.segmentPlaybackEnd != null && currentTime >= state.segmentPlaybackEnd) {
              youtubePlayer.pause();
              state.segmentPlaybackEnd = null;
              const callback = state.segmentPlaybackCallback;
              state.segmentPlaybackCallback = null;
              if (callback) callback();
            }
            if (!state.currentSegments.length) {
              console.log('[YouTube] No segments available, skipping');
              return;
            }

            // 查找当前segment索引（使用与 HTML5 player 相同的高级匹配逻辑）
            // 应用字幕偏移：正值=字幕提前，负值=字幕延迟
            const adjustedTime = currentTime + state.subtitleOffset;

            // Strategy: Find the BEST matching segment, not just the first one
            // This prevents subtitle delay when segments overlap or have timing tolerances
            let index = -1;

            // Step 1: Find all segments that contain the current time (with small tolerance)
            // Important: do NOT allow matching segments that start in the future; that makes subtitles run ahead.
            const tolerance = 0.1; // Reduced tolerance for more accurate matching (was 0.3)
            const startTolerance = 0.0;
            const endTolerance = tolerance;
            const matchingSegments = [];

            for (let i = 0; i < state.currentSegments.length; i++) {
              const segment = state.currentSegments[i];
              const start = Number(segment.start) || 0;
              const end = Number(segment.end);
              const effectiveEnd = Number.isFinite(end) ? end : start + 5;

              // Check if current time is within segment bounds
              if (adjustedTime >= (start - startTolerance) && adjustedTime < (effectiveEnd + endTolerance)) {
                matchingSegments.push({
                  index: i,
                  start: start,
                  end: effectiveEnd,
                  distanceFromStart: Math.abs(adjustedTime - start),
                  distanceFromMid: Math.abs(adjustedTime - (start + effectiveEnd) / 2)
                });
              }
            }

            // Step 2: If we have matches, choose the best one
            if (matchingSegments.length > 0) {
              // If multiple segments match, choose the one with:
              // 1. Smallest distance from start time (prefer segments that just started)
              // 2. If distances are similar, prefer the one closest to midpoint
              matchingSegments.sort((a, b) => {
                // Prioritize segments where current time is closest to start
                const startDiff = a.distanceFromStart - b.distanceFromStart;
                if (Math.abs(startDiff) > 0.5) {
                  return startDiff;
                }
                // If start distances are similar, prefer segment closest to midpoint
                return a.distanceFromMid - b.distanceFromMid;
              });

              index = matchingSegments[0].index;
            }

            // Step 3: If no exact match found, find closest *started* segment by start time
            // (Never jump to a FUTURE segment; that makes subtitles "run ahead".)
            if (index === -1 && state.currentSegments.length > 0) {
              let minDiff = Infinity;
              for (let i = 0; i < state.currentSegments.length; i++) {
                const segment = state.currentSegments[i];
                const start = Number(segment.start) || 0;
                const diff = adjustedTime - start;
                if (diff >= -tolerance && diff < minDiff && diff < 3.0) { // Within last ~3 seconds
                  minDiff = diff;
                  index = i;
                }
              }
            }

            observeMobileFirstLessonPlayback(currentTime, index, eventPlayerIsPlaying());
            // 只在segment改变时才更新DOM（性能优化）
            if (index === lastSegmentIndex) {
              return;
            }
            lastSegmentIndex = index;
            publishCoaching(index);

            // 移除上一个字幕的 playing 高亮
            if (state._lastActiveSegmentIndex >= 0) {
              const prevActive = document.querySelector(`.transcript-segment[data-index="${state._lastActiveSegmentIndex}"]`);
              if (prevActive) prevActive.classList.remove('playing');
            }

            // 高亮当前播放的字幕
            if (index >= 0) {
              const isMobile = isMobileLayout();

              // 移动端：更新移动字幕窗口（独立于桌面端元素，必须在 active 检查之外）
              if (isMobile) {
                mobileSegmentPosition = index;
                renderMobileTranscriptWindow(index);
              }

              // 桌面端：高亮和滚动
              const active = document.querySelector(`.transcript-segment[data-index="${index}"]`);
              if (active) {
                active.classList.add('playing');

                // 按需分割单词（懒加载）+ 应用颜色标记
                const textEl = active.querySelector('.transcript-text');
                if (textEl && textEl.hasAttribute('data-text')) {
                  const originalText = textEl.getAttribute('data-text');
                  let html = state.segmentHtmlCache.get(index);
                  if (!html) {
                    html = wordHtml(originalText);
                    state.segmentHtmlCache.set(index, html);
                  }
                  textEl.innerHTML = html;
                  textEl.removeAttribute('data-text');
                }

                // PC端滚动transcript-content
                if (!isMobile) {
                  let tContainer = transcriptContent;
                  try {
                    if (tContainer && (tContainer.scrollHeight <= (tContainer.clientHeight + 2))) {
                      const parent = tContainer.parentElement;
                      if (parent && (parent.scrollHeight > (parent.clientHeight + 2))) {
                        tContainer = parent;
                      }
                    }
                  } catch (_) { }
                  if (tContainer) {
                    ensureVisibleIn(tContainer, active);
                  }
                }

                // Metrics: on segment enter
                if (state._lastActiveSegmentIndex !== index && !state._exposedSegments.has(index)) {
                  try {
                    const words = Array.from((active && active.querySelectorAll('.transcript-word')) || [])
                      .map(el => el.getAttribute('data-word'))
                      .filter(Boolean);
                    const uniq = Array.from(new Set(words));
                    uniq.forEach(w => metrics.logExposure(w, {
                      segmentIndex: index,
                      startSec: Number((active && active.dataset && active.dataset.start)) || null,
                      endSec: Number((active && active.dataset && active.dataset.end)) || null,
                    }));
                    state._exposedSegments.add(index);
                  } catch (_) { }
                }

                // Metrics: when leaving previous segment
                if (state._lastActiveSegmentIndex != null && state._lastActiveSegmentIndex !== index && !state._readSegments.has(state._lastActiveSegmentIndex)) {
                  try {
                    const prev = document.querySelector(`.transcript-segment[data-index="${state._lastActiveSegmentIndex}"]`);
                    const wordsPrev = Array.from((prev && prev.querySelectorAll('.transcript-word')) || [])
                      .map(el => el.getAttribute('data-word'))
                      .filter(Boolean);
                    const uniqPrev = Array.from(new Set(wordsPrev));
                    uniqPrev.forEach(w => metrics.logRead(w, {
                      segmentIndex: state._lastActiveSegmentIndex,
                      startSec: Number((prev && prev.dataset && prev.dataset.start)) || null,
                      endSec: Number((prev && prev.dataset && prev.dataset.end)) || null,
                    }));
                    state._readSegments.add(state._lastActiveSegmentIndex);
                  } catch (_) { }
                }

                state._lastActiveSegmentIndex = index;
              }
            }
          });

          console.log('[YouTube] Time update callback registered');

          // 修复：YouTube播放器初始化完成后，如果是移动端，强制初始化字幕容器布局
          // 这解决了YouTube视频字幕无法滚动的问题（容器clientHeight为0）
          if (isMobileLayout()) {
            console.log('[YouTube] Mobile layout detected, forcing transcript container initialization');

            // 使用requestAnimationFrame确保DOM已经完全渲染
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                // 强制初始化移动端字幕视图的布局
                if (mobileTranscriptList) {
                  const transcriptView = document.getElementById('mobile-transcript');
                  if (transcriptView) {
                    console.log('[YouTube] Forcing .mobile-transcript-view layout');
                    const focusedSizing =
                      window.MobileReaderLayout &&
                      window.MobileReaderLayout.usesFocusedTranscriptSizing(document.body.className);
                    // 使用 !important 强制覆盖所有可能的CSS规则
                    transcriptView.style.setProperty('display', 'flex', 'important');
                    transcriptView.style.setProperty('flex-direction', 'column', 'important');
                    if (!focusedSizing) {
                      transcriptView.style.setProperty('height', 'calc((100vh - 70px) * 0.55)', 'important');
                    }
                    transcriptView.style.setProperty('min-height', '0', 'important');
                    transcriptView.style.setProperty('overflow', 'hidden', 'important');

                    // 强制浏览器重新计算布局
                    void transcriptView.offsetHeight;

                    console.log('[YouTube] After force, transcriptView.clientHeight:', transcriptView.clientHeight);
                  }

                  // 如果有字幕数据，渲染第一个字幕以初始化容器
                  if (state.currentSegments && state.currentSegments.length > 0) {
                    console.log('[YouTube] Initializing mobile transcript window with first segment');
                    mobileSegmentPosition = 0;
                    renderMobileTranscriptWindow(0);

                    // 再次检查容器高度
                    setTimeout(() => {
                      const finalHeight = mobileTranscriptList ? mobileTranscriptList.clientHeight : 0;
                      console.log('[YouTube] Final mobileTranscriptList.clientHeight:', finalHeight);
                      if (finalHeight === 0) {
                        console.warn('[YouTube] ⚠️ WARNING: Mobile transcript container still has 0 height after initialization!');
                      } else {
                        console.log('[YouTube] ✓ Mobile transcript container initialized successfully with height:', finalHeight);
                      }
                    }, 500);
                  }
                }
              });
            });
          }

        } catch (error) {
          console.error('[YouTube] Failed to initialize player:', error);
          alert('YouTube 播放器初始化失败: ' + error.message);
        }
      })();

    } else {
      // 本地视频 - 使用HTML5播放器
      console.log('[LocalVideo] Loading local video');

      // For YouTube videos with local copy, use local_video_path
      let videoPath = video.video_path || '';
      if (hasLocalCopy && video.local_video_path) {
        console.log('[LocalVideo] Using downloaded local copy for YouTube video');
        videoPath = video.local_video_path;
      }

      // 安全检查：确保这不是一个YouTube URL（防御性编程）
      if (videoPath.includes('youtube.com') || videoPath.includes('youtu.be')) {
        console.error('[LocalVideo] ⚠️ WARNING: Detected YouTube URL in local video path!');
        console.error('[LocalVideo] This should not happen. Invalid local source type.');
        console.error('[LocalVideo] Skipping video load to prevent CSP violation.');

        // 清理播放器
        videoPlayer.removeAttribute('src');
        videoPlayer.style.display = 'none';
        if (youtubePlayerWrapper) {
          youtubePlayerWrapper.style.display = 'none';
        }

        // 显示错误信息
        if (videoMeta) {
          videoMeta.textContent = '⚠️ 视频加载错误：YouTube视频配置异常';
          videoMeta.style.color = 'red';
        }
        return;
      }

      // 隐藏YouTube播放器，显示HTML5播放器
      if (youtubePlayerWrapper) {
        youtubePlayerWrapper.style.display = 'none';
      }
      if (youtubePlayerIframe) {
        youtubePlayerIframe.removeAttribute('src');
      }
      videoPlayer.style.display = 'block';

      const baseUrl = `${API_BASE}${videoPath}`;
      console.log('[LocalVideo] Protected source selected');

      // 清除旧的视频源
      videoPlayer.removeAttribute('src');
      videoPlayer.load();

      // 设置新的视频源
      try {
        const playable = await setProtectedMediaSource(videoPlayer, baseUrl, isCurrentSelection);
        if (!playable || !isCurrentSelection()) return;
      } catch (_) {
        if (!isCurrentSelection()) return;
        videoMeta.textContent = '视频授权失败，请重试';
        videoMeta.style.color = 'red';
        return;
      }

      // 强制加载视频
      videoPlayer.load();

      videoMeta.textContent = `${video.title || video.original_filename || ''}`;
      loadSpeakersForVideo(video.id);

      // 添加一次性事件监听，视频可以播放时尝试播放
      const handleCanPlay = () => {
        console.log('Video ready to play');
        // 在移动端显示播放overlay
        if (window.innerWidth <= 768) {
          const playOverlay = document.getElementById('play-overlay');
          if (playOverlay) {
            playOverlay.style.display = 'flex';
          }
        }
        videoPlayer.removeEventListener('canplay', handleCanPlay);
      };
      videoPlayer.addEventListener('canplay', handleCanPlay);
    }
  } else {
    // 清理所有播放器
    const youtubePlayerWrapper = document.getElementById('youtube-player-wrapper');
    const youtubePlayerIframe = document.getElementById('youtube-player');

    // 清理 YouTube 播放器实例
    if (youtubePlayer) {
      console.log('[YouTube] Cleaning up player on video clear');
      try {
        youtubePlayer.destroy();
      } catch (e) {
        console.warn('[YouTube] Error destroying player:', e);
      }
      youtubePlayer = null;
    }

    videoPlayer.removeAttribute('src');
    videoPlayer.style.display = 'block';
    if (youtubePlayerWrapper) {
      youtubePlayerWrapper.style.display = 'none';
    }
    if (youtubePlayerIframe) {
      youtubePlayerIframe.removeAttribute('src');
    }

    videoMeta.textContent = '';
    if (practicePanel) practicePanel.hidden = true;
  }
  // reset metrics trackers for new video
  state._lastActiveSegmentIndex = null;
  state._exposedSegments = new Set();
  state._readSegments = new Set();
}

async function loadUser() {
  try {
    const data = await fetchJSON(`${API_BASE}/users/me`);
    state.user = data;
    console.log('Loaded user:', state.user);
  } catch (err) {
    console.warn('Failed to load user info:', err);
  }
}

async function loadVideos() {
  try {
    const data = await fetchJSON(`${API_BASE}/video-resources?lite=1`);
    state.videos = (data && data.items) || [];
    state.isMainlandUser = data && data.isMainlandUser ? true : false; // Save user's region
    console.log('[Region] User is from mainland China:', state.isMainlandUser);
    renderVideoList();
    // 如果 URL 指定了 videoId，并且在列表中存在，则优先选中它
    // Do not auto-select a video; only select if URL explicitly provided and exists
    if (state.videos.length && !state.selectedVideoId && initialVideoIdFromURL) {
      const exists = state.videos.some(v => v.id === initialVideoIdFromURL);
      if (exists) selectVideo(initialVideoIdFromURL);
    }
  } catch (err) {
    console.error('Failed to load videos:', err);
    videoListEl.innerHTML = '<li class="empty-state" style="color:#d32f2f;">Failed to load videos.</li>';
  }
}

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(uploadForm);
  const file = formData.get('video');
  if (!file || file.size === 0) {
    alert('Please select a video');
    return;
  }

  uploadStatus.textContent = 'Uploading...';
  uploadForm.querySelector('button').disabled = true;

  try {
    const response = await fetch(`${API_BASE}/video-resources/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      },
      body: formData,
    });

    if (response.status === 401) {
      throw new Error('Unauthorized');
    }

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || 'Upload failed');
    }

    if (result.error) {
      uploadStatus.textContent = result.error;
    } else if (response.status === 202) {
      uploadStatus.textContent = 'Upload complete. Transcription is processing...';
    } else {
      uploadStatus.textContent = 'Upload & transcription complete!';
    }

    // Update VIP badge
    const vipBadge = document.getElementById('vip-badge');
    if (vipBadge) {
      if (state.user && state.user.membership_type && state.user.membership_type !== 'free') {
        vipBadge.hidden = false;
        const tier = (state.user.membership_type || '').trim().toLowerCase();
        const isFamily = tier === 'family';
        const isSvip = tier === 'svip';
        vipBadge.classList.remove('vip', 'family', 'svip');
        vipBadge.classList.add(isFamily ? 'family' : (isSvip ? 'svip' : 'vip'));
        const vipText = vipBadge.querySelector('.vip-text');
        if (vipText) vipText.textContent = isFamily ? 'Family' : (isSvip ? 'SVIP' : 'VIP');
        const vipIcon = vipBadge.querySelector('.vip-icon');
        if (vipIcon) vipIcon.textContent = isSvip ? '🚀' : (isFamily ? '👑' : '🔥');
      } else {
        vipBadge.hidden = true;
      }
    }

    // Load user's videos
    await loadVideos();
    if (result.video) {
      selectVideo(result.video.id);
    }
  } catch (err) {
    console.error('Upload failed:', err);
    uploadStatus.textContent = 'Upload failed. Please try again.';
  } finally {
    uploadForm.querySelector('button').disabled = false;
    setTimeout(() => {
      uploadStatus.textContent = '';
    }, 4000);
  }
});

videoListEl.addEventListener('click', function (event) {
  const item = event.target.closest('.video-item');
  if (!item) return;
  const id = Number(item.getAttribute('data-id'));
  selectVideo(id);
});

// 提取单词和字幕点击处理逻辑，支持触摸和点击事件
const handleTranscriptInteraction = (event) => {
  // 优先处理编辑按钮（避免触发跳转）
  if (event.target.closest('.transcript-edit-btn')) {
    return;
  }

  // 处理单词点击（查词功能）
  const wordEl = event.target.closest('.transcript-word');
  if (wordEl) {
    // 阻止默认行为和事件冒泡，避免重复触发
    event.preventDefault();
    event.stopPropagation();

    // 添加点击动画效果
    wordEl.classList.add('clicked');
    setTimeout(() => wordEl.classList.remove('clicked'), 300);

    const word = wordEl.getAttribute('data-word');
    if (word) {
      const segmentEl = event.target.closest('.transcript-segment');
      if (segmentEl) {
        const sentenceData = segmentEl.dataset.sentence || '';
        state.lastLookupContext = {
          segmentIndex: Number(segmentEl.dataset.index),
          startSec: Number(segmentEl.dataset.start),
          endSec: Number(segmentEl.dataset.end),
          sentence: decodeURIComponent(sentenceData) || segmentEl.innerText.trim(),
        };
        // metrics: lookup interaction
        metrics.logInteraction('lookup', word, {
          segmentIndex: state.lastLookupContext.segmentIndex,
          startSec: state.lastLookupContext.startSec,
          endSec: state.lastLookupContext.endSec,
        });
      } else {
        state.lastLookupContext = null;
      }
      lookupWord(word);
      // 更新查词统计
      updateStats('words');

      // 智能导入：记录点击事件（如果会话活跃且单词不在词库中）
      if (state.smartImport.isActive && state.smartImport.sessionId) {
        const wordLower = word.toLowerCase();
        const vocabState = state.vocabMap.get(wordLower);
        // 只记录未知词的点击
        if (!vocabState || (vocabState !== 'mastered' && vocabState !== 'known')) {
          const lemma = window.SmartImportAPI ? window.SmartImportAPI.simpleLemma(wordLower) : wordLower;
          // 添加到本地点击集合
          state.smartImport.clickedLemmas.add(lemma);

          // 计算词在句中的位置
          let wordStart = 0;
          let wordEnd = 0;
          if (state.lastLookupContext && state.lastLookupContext.sentence) {
            const sentence = state.lastLookupContext.sentence;
            const sentenceLower = sentence.toLowerCase();
            wordStart = sentenceLower.indexOf(wordLower);
            if (wordStart >= 0) {
              wordEnd = wordStart + wordLower.length;
            }
          }

          // 获取上下文句子
          const segmentIndex = state.lastLookupContext ? state.lastLookupContext.segmentIndex : null;
          let prevSentence = null;
          let nextSentence = null;
          if (segmentIndex !== null && state.currentSegments) {
            if (segmentIndex > 0 && state.currentSegments[segmentIndex - 1]) {
              prevSentence = state.currentSegments[segmentIndex - 1].text;
            }
            if (segmentIndex < state.currentSegments.length - 1 && state.currentSegments[segmentIndex + 1]) {
              nextSentence = state.currentSegments[segmentIndex + 1].text;
            }
          }

          // 异步上报点击事件
          if (window.SmartImportAPI) {
            window.SmartImportAPI.recordClick(state.smartImport.sessionId, {
              originalForm: word,
              clientLemma: lemma,
              segmentIndex: segmentIndex,
              sentenceText: state.lastLookupContext ? state.lastLookupContext.sentence : null,
              wordPositionStart: wordStart,
              wordPositionEnd: wordEnd,
              prevSentence: prevSentence,
              nextSentence: nextSentence,
            }).catch(e => console.warn('[SmartImport] Failed to record click:', e));
          }

          // 清除缓存，强制重新渲染以更新高亮
          state.segmentHtmlCache.clear();
        }
      }
    }
    return; // 处理完单词点击后返回，不执行跳转
  }

  // 处理整个字幕段点击（跳转视频）
  const segmentEl = event.target.closest('.transcript-segment');
  if (segmentEl) {
    const time = Number(segmentEl.getAttribute('data-start'));
    if (Number.isFinite(time)) {
      videoPlayer.currentTime = time;
      safePlayVideo();
    }
    return;
  }
};

// 同时监听触摸和点击事件，确保移动端单次触摸即可查词
transcriptContent.addEventListener('touchstart', handleTranscriptInteraction, { passive: false });
transcriptContent.addEventListener('click', handleTranscriptInteraction);

// 性能优化：缓存上一次的值，避免重复DOM操作
let lastSegmentIndex = -1;
let lastProgressPercent = -1;
let lastProgressSaveTime = 0;
const PROGRESS_SAVE_INTERVAL = 3000; // 每3秒保存一次进度
let firstLessonLastPlaybackTime = null;
let firstLessonLastResumeAt = 0;

function eventPlayerIsPlaying() {
  try {
    return youtubePlayer && typeof youtubePlayer.getPlayerState === 'function'
      ? youtubePlayer.getPlayerState() === YT.PlayerState.PLAYING
      : false;
  } catch (_) {
    return false;
  }
}

function observeMobileFirstLessonPlayback(currentTime, index, playing) {
  if (!firstLessonSession.isActive() || !firstLessonProgressSubject || index < 0 || !playing) {
    firstLessonLastPlaybackTime = Number(currentTime);
    return;
  }
  const segment = state.currentSegments[index];
  if (!segment) return;
  const start = Number(segment.start ?? segment.start_sec ?? 0);
  const end = Number(segment.end ?? segment.end_sec ?? (start + 0.001));
  const span = Math.max(0.001, end - start);
  const fraction = Math.max(0, Math.min(1, (Number(currentTime) - start) / span));
  const previous = firstLessonLastPlaybackTime;
  const forward = Number.isFinite(previous) && currentTime > previous && (currentTime - previous) < 1.25;
  firstLessonLastPlaybackTime = Number(currentTime);
  const segmentId = window.LinglishFirstLessonProgress.stableSegmentId(state.selectedVideoId, segment, index);
  firstLessonProgressStore.markHeard(firstLessonProgressSubject, state.selectedVideoId, segmentId, {
    source: 'playback',
    forward,
    fraction,
  });
  if (Date.now() - firstLessonLastResumeAt > PROGRESS_SAVE_INTERVAL) {
    firstLessonProgressStore.markResume(firstLessonProgressSubject, state.selectedVideoId, currentTime);
    firstLessonLastResumeAt = Date.now();
  }
}

function coachingTransport() {
  const wrapper = document.getElementById('youtube-player-wrapper');
  const useYouTube = wrapper && wrapper.style.display !== 'none' && youtubePlayer && typeof youtubePlayer.getCurrentTime === 'function';
  if (useYouTube) {
    return {
      getCurrentTime() { try { return Number(youtubePlayer.getCurrentTime()) || 0; } catch (_) { return 0; } },
      seek(seconds) { try { youtubePlayer.seekTo(seconds, true); } catch (_) {} },
      play() { try { if (typeof youtubePlayer.play === 'function') youtubePlayer.play(); else youtubePlayer.playVideo(); } catch (_) {} },
      pause() { try { if (typeof youtubePlayer.pause === 'function') youtubePlayer.pause(); else youtubePlayer.pauseVideo(); } catch (_) {} },
      isPlaying() {
        try {
          if (typeof youtubePlayer.isPlaying === 'function') return youtubePlayer.isPlaying() === true;
          if (typeof youtubePlayer.getPlayerState === 'function') {
            const code = youtubePlayer.getPlayerState();
            return code === 1 || code === 3;
          }
        } catch (_) {}
        return false;
      },
    };
  }
  return {
    getCurrentTime() { return videoPlayer ? Number(videoPlayer.currentTime) || 0 : 0; },
    seek(seconds) { if (videoPlayer) { try { videoPlayer.currentTime = seconds; } catch (_) {} } },
    play() {
      if (!videoPlayer) return;
      const pending = videoPlayer.play();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    },
    pause() { if (videoPlayer) { try { videoPlayer.pause(); } catch (_) {} } },
    isPlaying() { return Boolean(videoPlayer && !videoPlayer.paused && !videoPlayer.ended); },
  };
}

function publishCoaching(index) {
  const dock = window.LinglishCoachingDock;
  if (!dock || typeof dock.sync !== 'function') return;
  dock.sync({
    segments: state.currentSegments,
    index: Number.isInteger(index) ? index : -1,
    videoId: state.selectedVideoId,
    user: state.user,
    transport: coachingTransport(),
  });
}

// 性能优化：节流timeupdate处理，减少iPhone卡顿
let timeupdateThrottleTimer = null;
const TIMEUPDATE_THROTTLE = 200; // 限制处理频率到200ms一次

videoPlayer.addEventListener('timeupdate', function () {
  if (!state.currentSegments.length) return;
  const current = videoPlayer.currentTime;

  // 即时更新时间显示（轻量级操作）
  if (mobileCurrentTime) {
    mobileCurrentTime.textContent = formatTime(current);
  }
  if (mobileProgress && videoPlayer.duration && !Number.isNaN(videoPlayer.duration) && !isMobileProgressDragging) {
    mobileProgress.value = (current / videoPlayer.duration) * 100;
  }

  // 节流localStorage写入：只在进度变化且超过间隔时才写入
  const now = Date.now();
  if (state.selectedVideoId && Number.isFinite(videoPlayer.duration) && videoPlayer.duration > 0) {
    const percent = Math.min(100, Math.max(0, Math.round((current / videoPlayer.duration) * 100)));
    if (percent !== lastProgressPercent && (now - lastProgressSaveTime) > PROGRESS_SAVE_INTERVAL) {
      try {
        localStorage.setItem(`video_progress_${state.selectedVideoId}`, String(percent));
        lastProgressPercent = percent;
        lastProgressSaveTime = now;
      } catch (_) { }
    }
  }

  // 查找当前segment索引
  // 应用字幕偏移：正值=字幕提前，负值=字幕延迟
  const adjustedTime = current + state.subtitleOffset;

  // Strategy: Find the BEST matching segment, not just the first one
  // This prevents subtitle delay when segments overlap or have timing tolerances
  let index = -1;

  // Step 1: Find all segments that contain the current time (with small tolerance)
  // Important: do NOT allow matching segments that start in the future; that makes subtitles run ahead.
  const tolerance = 0.1; // Reduced tolerance for more accurate matching (was 0.3)
  const startTolerance = 0.0;
  const endTolerance = tolerance;
  const matchingSegments = [];

  for (let i = 0; i < state.currentSegments.length; i++) {
    const segment = state.currentSegments[i];
    const start = Number(segment.start) || 0;
    const end = Number(segment.end);
    const effectiveEnd = Number.isFinite(end) ? end : start + 5;

    // Check if current time is within segment bounds
    if (adjustedTime >= (start - startTolerance) && adjustedTime < (effectiveEnd + endTolerance)) {
      matchingSegments.push({
        index: i,
        start: start,
        end: effectiveEnd,
        distanceFromStart: Math.abs(adjustedTime - start),
        distanceFromMid: Math.abs(adjustedTime - (start + effectiveEnd) / 2)
      });
    }
  }

  // Step 2: If we have matches, choose the best one
  if (matchingSegments.length > 0) {
    // If multiple segments match, choose the one with:
    // 1. Smallest distance from start time (prefer segments that just started)
    // 2. If distances are similar, prefer the one closest to midpoint
    matchingSegments.sort((a, b) => {
      // Prioritize segments where current time is closest to start
      const startDiff = a.distanceFromStart - b.distanceFromStart;
      if (Math.abs(startDiff) > 0.5) {
        return startDiff;
      }
      // If start distances are similar, prefer segment closest to midpoint
      return a.distanceFromMid - b.distanceFromMid;
    });

    index = matchingSegments[0].index;
  }

  // Step 3: If no exact match found, find closest *started* segment by start time
  // (Never jump to a FUTURE segment; that makes subtitles "run ahead".)
  if (index === -1 && state.currentSegments.length > 0) {
    let minDiff = Infinity;
    for (let i = 0; i < state.currentSegments.length; i++) {
      const segment = state.currentSegments[i];
      const start = Number(segment.start) || 0;
      const diff = adjustedTime - start;
      if (diff >= -tolerance && diff < minDiff && diff < 3.0) { // Within last ~3 seconds
        minDiff = diff;
        index = i;
      }
    }
  }

  observeMobileFirstLessonPlayback(current, index, !videoPlayer.paused && !videoPlayer.seeking);
  // 性能优化：只在segment改变时才更新DOM
  if (index === lastSegmentIndex) {
    // segment未改变，跳过所有DOM操作
    return;
  }

  // Segment changed - update immediately without throttling
  // 字幕切换时立即更新，不使用节流，确保字幕与音频同步
  // (Segment changes are already naturally rate-limited, no need for additional throttling)
  lastSegmentIndex = index;
  publishCoaching(index);

  // 智能导入：记录观看的片段
  if (index >= 0 && state.smartImport.isActive && state.smartImport.sessionId) {
    if (!state.smartImport.watchedSegments.has(index)) {
      state.smartImport.watchedSegments.add(index);
      console.log('[SmartImport] Watched segment:', index, 'total:', state.smartImport.watchedSegments.size);
    }
  }

  // 移除上一个字幕的 playing 高亮（只移除一个，而不是遍历所有）
  if (state._lastActiveSegmentIndex >= 0) {
    const prevActive = document.querySelector(`.transcript-segment[data-index="${state._lastActiveSegmentIndex}"]`);
    if (prevActive) prevActive.classList.remove('playing');
  }

  // 高亮当前播放的字幕
  if (index >= 0) {
    const isMobile = isMobileLayout();

    // 移动端：更新移动字幕窗口（独立于桌面端元素）
    if (isMobile) {
      mobileSegmentPosition = index;
      renderMobileTranscriptWindow(index);
    }

    // 桌面端：高亮和滚动
    const active = document.querySelector(`.transcript-segment[data-index="${index}"]`);
    if (active) {
      active.classList.add('playing');

      // 性能优化：按需分割单词（懒加载）+ 应用颜色标记
      const textEl = active.querySelector('.transcript-text');
      if (textEl && textEl.hasAttribute('data-text')) {
        const originalText = textEl.getAttribute('data-text');
        let html = state.segmentHtmlCache.get(index);
        if (!html) {
          html = wordHtml(originalText);
          state.segmentHtmlCache.set(index, html);
        }
        textEl.innerHTML = html;
        textEl.removeAttribute('data-text');
      }

      // PC端：滚动transcript-content中的字幕
      if (!isMobile) {
        let tContainer = transcriptContent;
        try {
          if (tContainer && (tContainer.scrollHeight <= (tContainer.clientHeight + 2))) {
            const parent = tContainer.parentElement;
            if (parent && (parent.scrollHeight > (parent.clientHeight + 2))) {
              tContainer = parent;
            }
          }
        } catch (_) { }
        if (tContainer) {
          ensureVisibleIn(tContainer, active);
        }
      }
    }

    // Metrics: on segment enter (once) expose all words
    if (state._lastActiveSegmentIndex !== index && !state._exposedSegments.has(index)) {
      try {
        const words = Array.from((active && active.querySelectorAll('.transcript-word')) || [])
          .map(el => el.getAttribute('data-word'))
          .filter(Boolean);
        const uniq = Array.from(new Set(words));
        uniq.forEach(w => metrics.logExposure(w, {
          segmentIndex: index,
          startSec: Number((active && active.dataset && active.dataset.start)) || null,
          endSec: Number((active && active.dataset && active.dataset.end)) || null,
        }));
        state._exposedSegments.add(index);
      } catch (_) { }
    }

    // Metrics: when leaving previous segment, mark read
    if (state._lastActiveSegmentIndex != null && state._lastActiveSegmentIndex !== index && !state._readSegments.has(state._lastActiveSegmentIndex)) {
      try {
        const prev = document.querySelector(`.transcript-segment[data-index="${state._lastActiveSegmentIndex}"]`);
        const wordsPrev = Array.from((prev && prev.querySelectorAll('.transcript-word')) || [])
          .map(el => el.getAttribute('data-word'))
          .filter(Boolean);
        const uniqPrev = Array.from(new Set(wordsPrev));
        uniqPrev.forEach(w => metrics.logRead(w, {
          segmentIndex: state._lastActiveSegmentIndex,
          startSec: Number((prev && prev.dataset && prev.dataset.start)) || null,
          endSec: Number((prev && prev.dataset && prev.dataset.end)) || null,
        }));
        state._readSegments.add(state._lastActiveSegmentIndex);
      } catch (_) { }
    }

    state._lastActiveSegmentIndex = index;

    // 检查是否应该播放用户录音
    const segmentIndex = (state.currentSegments[index] && state.currentSegments[index].index != null) ? state.currentSegments[index].index : index;
    const segment = state.currentSegments[index];

    // 使用segment开始时间作为触发点，避免重复播放
    if (segment && audioModeManager.shouldPlayUserRecording(segmentIndex)) {
      const timeIntoSegment = current - segment.start;
      // 只在segment刚开始时触发（0.1秒内）
      if (timeIntoSegment < 0.1) {
        audioModeManager.syncPlayUserRecording(segmentIndex, videoPlayer);
      }
    }
  } else {
    // 当没有匹配的segment时（比如segment间隙），保持当前窗口状态
    // 不要重置 mobileSegmentPosition 和窗口，避免不必要的滚动
    // mobileSegmentPosition = null;
    // renderMobileTranscriptWindow(null);
  }

  // 如果在角色扮演模式，也高亮和滚动练习列表中的当前句子
  if (state.selectedSpeaker && practiceLineList && index >= 0) {
    const segmentIndex = (state.currentSegments[index] && state.currentSegments[index].index != null) ? state.currentSegments[index].index : index;

    // 性能优化：缓存上一个激活的练习行，只移除那一个
    if (!state._lastActivePracticeLine) state._lastActivePracticeLine = null;
    if (!state._lastActivePracticeLineRight) state._lastActivePracticeLineRight = null;

    if (state._lastActivePracticeLine) {
      state._lastActivePracticeLine.classList.remove('playing-now');
    }
    if (state._lastActivePracticeLineRight) {
      state._lastActivePracticeLineRight.classList.remove('playing-now');
    }

    // 主面板
    const activePracticeLine = practiceLineList.querySelector(`li[data-segment-index="${segmentIndex}"]`);
    if (activePracticeLine) {
      activePracticeLine.classList.add('playing-now');
      // 只在PC端滚动，移动端不需要（避免上下抖动）
      if (!isMobileLayout()) {
        activePracticeLine.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      state._lastActivePracticeLine = activePracticeLine;
    }

    // 右侧边栏
    if (practiceLineListRight) {
      const activePracticeLineRight = practiceLineListRight.querySelector(`li[data-segment-index="${segmentIndex}"]`);
      if (activePracticeLineRight) {
        activePracticeLineRight.classList.add('playing-now');
        // 只在PC端滚动，移动端不需要（避免上下抖动）
        if (!isMobileLayout()) {
          activePracticeLineRight.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        state._lastActivePracticeLineRight = activePracticeLineRight;
      }
    }
  }

  if (state.segmentPlaybackEnd != null && current >= state.segmentPlaybackEnd) {
    videoPlayer.pause();
    state.segmentPlaybackEnd = null;
    const callback = state.segmentPlaybackCallback;
    state.segmentPlaybackCallback = null;
    if (typeof callback === 'function') {
      callback();
    }
  }
});

videoPlayer.addEventListener('play', function () {
  if (state.practiceArmed && state.practicePlaybackLock) {
    videoPlayer.pause();
    return;
  }
  noteLearningVideoStarted();
});

// Resume video when dictionary is closed (via back button or close button)
(function bindDictResume() {
  try {
    // 定义恢复播放的共用函数
    const resumeVideoPlayback = function () {
      stopDictSpeech();
      console.log('[移动端关闭查词] wasPlayingBeforeLookupMobile =', wasPlayingBeforeLookupMobile);
      // Only resume if video was playing before lookup
      if (wasPlayingBeforeLookupMobile) {
        console.log('[移动端关闭查词] 尝试恢复播放');
        // Check which player is in use
        const youtubePlayerWrapper = document.getElementById('youtube-player-wrapper');
        const isUsingYouTube = youtubePlayerWrapper && youtubePlayerWrapper.style.display !== 'none';

        if (isUsingYouTube) {
          // Resume YouTube player
          try {
            if (youtubePlayer) {
              console.log('[移动端关闭查词] 检测到YouTube播放器，调用 play()');
              youtubePlayer.play();
              console.log('[移动端关闭查词] ✓ YouTube播放器恢复成功');
            }
          } catch (err) {
            console.warn('[移动端关闭查词] ✗ YouTube播放器恢复失败:', err);
          }
        } else {
          // Resume HTML5 player
          try {
            if (videoPlayer && videoPlayer.paused) {
              videoPlayer.play().catch(() => { });
              console.log('[移动端关闭查词] ✓ HTML5播放器恢复成功');
            }
          } catch (_) { }
        }
        wasPlayingBeforeLookupMobile = false;
      } else {
        console.log('[移动端关闭查词] 视频原本就是暂停的，不恢复播放');
      }
    };

    // 绑定到"返回视频"按钮
    const backBtn = document.getElementById('back-to-video-from-dict');
    if (backBtn) {
      backBtn.addEventListener('click', resumeVideoPlayback);
    }

    // 绑定到X号关闭按钮
    const closeBtn = document.getElementById('dictionary-close-btn-right');
    if (closeBtn) {
      closeBtn.addEventListener('click', resumeVideoPlayback);
    }
    const dictSection = document.getElementById('dictionary-section-right');
    if (dictSection) {
      let prevHidden = null;
      const obs = new MutationObserver(() => {
        const hidden = dictSection.style.display === 'none' || dictSection.getAttribute('aria-hidden') === 'true';
        console.log('[移动端查词区域变化] hidden =', hidden, 'wasPlayingBeforeLookupMobile =', wasPlayingBeforeLookupMobile);
        // Avoid resuming immediately when we hide the sidebar while opening the mobile overlay.
        // Only resume on a visible -> hidden transition and when lookup UI is in sidebar mode.
        const shouldResume = (prevHidden === false || prevHidden === null) && hidden && wasPlayingBeforeLookupMobile && state.lookupUiMode === 'sidebar';
        prevHidden = hidden;
        if (shouldResume) {
          stopDictSpeech();
          // Only resume if video was playing before lookup
          console.log('[移动端关闭查词] 尝试恢复播放 (MutationObserver)');
          try {
            if (videoPlayer && videoPlayer.paused) {
              videoPlayer.play().catch(() => { });
              console.log('[移动端关闭查词] ✓ HTML5播放器恢复成功');
            }
          } catch (_) { }
          // Also resume YouTube player if it exists and is paused
          try {
            if (youtubePlayer && youtubePlayer.getPlayerState() === 2) { // 2 is paused
              youtubePlayer.play();
              console.log('[移动端关闭查词] ✓ YouTube播放器恢复成功');
            }
          } catch (_) { }
          wasPlayingBeforeLookupMobile = false;
        } else if (hidden) {
          console.log('[移动端关闭查词] 视频原本就是暂停的，不恢复播放');
        }
      });
      obs.observe(dictSection, { attributes: true, attributeFilter: ['style', 'aria-hidden'] });
    }
  } catch (_) { }
})();

// Client-side audio cache for instant playback
const audioCache = new Map();

// One audible source for the word, a definition, a sentence, or the learning video.
let currentAudioPlayer = null;
let dictSpeakFallbackTimer = null;
const dictVoiceSlot = (window.LinglishVoiceSlot
  ? window.LinglishVoiceSlot.createVoiceSlot()
  : { claim() { return 1; }, release() {}, isCurrent() { return true; } });

function haltDictSpeechOutput() {
  if (dictSpeakFallbackTimer) {
    clearTimeout(dictSpeakFallbackTimer);
    dictSpeakFallbackTimer = null;
  }
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
function stopDictSpeech() {
  learningVideoYieldUntil = 0;
  dictVoiceSlot.release();
  haltDictSpeechOutput();
}

function pauseLearningVideoNow() {
  try {
    const youtubePlayerWrapper = document.getElementById('youtube-player-wrapper');
    const isUsingYouTube = youtubePlayerWrapper && youtubePlayerWrapper.style.display !== 'none';
    if (isUsingYouTube && youtubePlayer) {
      const playing = youtubePlayer.getPlayerState && youtubePlayer.getPlayerState() === 1;
      if (playing) {
        if (typeof youtubePlayer.pause === 'function') youtubePlayer.pause();
        if (youtubePlayer.player && typeof youtubePlayer.player.pauseVideo === 'function') youtubePlayer.player.pauseVideo();
      }
    } else if (videoPlayer && !videoPlayer.paused) {
      videoPlayer.pause();
    }
  } catch (_) { }
}

function pauseLearningVideoForWord() {
  learningVideoYieldUntil = Date.now() + 250;
  pauseLearningVideoNow();
}

function noteLearningVideoStarted() {
  if (Date.now() < learningVideoYieldUntil) {
    pauseLearningVideoNow();
    return;
  }
  stopDictSpeech();
}

// Track if video was playing before lookup (mobile)
let wasPlayingBeforeLookupMobile = false;

// Track current dictionary polling to stop it when looking up a new word
let currentDictPollingStop = null;

async function showSentenceAssist(word) {
  const card = document.getElementById('sentence-assist');
  const assist = window.LinglishSentenceAssist;
  if (!card || !assist) return false;
  const sentence = (state.lastLookupContext && state.lastLookupContext.sentence) || '';
  const paint = (gloss, phonetic) => {
    card.hidden = false;
    card.innerHTML = assist.cardHTML({ word, phonetic, gloss, sentence });
    const closeBtn = card.querySelector('[data-assist="close"]');
    const sayBtn = card.querySelector('[data-assist="say"]');
    if (closeBtn) closeBtn.addEventListener('click', () => { card.hidden = true; });
    if (sayBtn) sayBtn.addEventListener('click', () => {
      card.hidden = true;
      const record = document.getElementById('practice-start');
      if (record) record.click();
    });
  };
  paint('正在查这个词…', '');
  let entry = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const token = localStorage.getItem('linglish_token') || localStorage.getItem('authToken');
    const res = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(word)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    if (res.ok) entry = (await res.json()).entry || null;
  } catch (_) { }
  finally { clearTimeout(timer); }
  if (card.hidden) return true;
  paint(assist.shortGloss(entry), assist.phoneticOf(entry));
  return true;
}

async function lookupWord(rawWord) {
  // Stop any previous polling to prevent old word's data from overwriting new word's display
  if (typeof currentDictPollingStop === 'function') {
    console.log('[Lookup] Stopping previous dictionary polling');
    currentDictPollingStop();
    currentDictPollingStop = null;
  }
  let word = rawWord
    .replace(/[']/g, "'")
    .replace(/[^a-zA-Z']/g, '')
    .replace(/^'+|'+$/g, '')
    .toLowerCase();

  if (!word || word.replace(/'/g, '').length < 2) return;

  // Auto-switch to dictionary section when looking up a word
  // Pause video on mobile while user is in dictionary

  // 检查当前使用的是YouTube播放器还是HTML5播放器
  const youtubePlayerWrapper = document.getElementById('youtube-player-wrapper');
  const isUsingYouTube = youtubePlayerWrapper && youtubePlayerWrapper.style.display !== 'none';

  // Track playing state before pausing
  wasPlayingBeforeLookupMobile = false;

  if (isUsingYouTube) {
    // 使用YouTube播放器 - 只暂停YouTube播放器
    try {
      console.log('[Lookup] Attempting to pause YouTube player (force)');
      if (youtubePlayer) {
        // Check if playing before pausing
        wasPlayingBeforeLookupMobile = (youtubePlayer.getPlayerState && youtubePlayer.getPlayerState() === 1); // 1 = playing

        // Method 1: Use wrapper method
        youtubePlayer.pause();

        // Method 2: Direct access fallback (for Chrome specifically)
        if (youtubePlayer.player && typeof youtubePlayer.player.pauseVideo === 'function') {
          youtubePlayer.player.pauseVideo();
        }

        console.log('[Lookup] YouTube pause command sent, was playing:', wasPlayingBeforeLookupMobile);

        // Method 3: Retry after small delay (fix for some Chrome race conditions)
        setTimeout(() => {
          if (youtubePlayer && youtubePlayer.isPlaying && youtubePlayer.isPlaying()) {
            console.log('[Lookup] Retry pausing YouTube player...');
            youtubePlayer.pause();
          }
        }, 100);
      } else {
        console.warn('[Lookup] youtubePlayer object is null/undefined');
      }
    } catch (e) {
      console.warn('[Lookup] Failed to pause YouTube player:', e);
      wasPlayingBeforeLookupMobile = false;
    }
  } else {
    // 使用HTML5播放器 - 只暂停HTML5播放器
    try {
      if (videoPlayer) {
        wasPlayingBeforeLookupMobile = !videoPlayer.paused;
        if (wasPlayingBeforeLookupMobile) {
          console.log('[Lookup] Pausing HTML5 video player');
          videoPlayer.pause();
        }
      }
    } catch (e) {
      console.warn('[Lookup] Failed to pause HTML5 player:', e);
      wasPlayingBeforeLookupMobile = false;
    }
  }
  if (new URLSearchParams(window.location.search).get('focus') === 'first_lesson') {
    const stayed = await showSentenceAssist(word);
    if (stayed) return;
  }
  const useOverlay = window.innerWidth <= 768 && vocabDetailOverlay && vocabDetailDictCard;
  if (useOverlay) {
    state.lookupUiMode = 'overlay';
    state.lookupUiOpen = true;
    activeDictionaryContainer = vocabDetailDictCard;
    openVocabDetailOverlay(word);
    // Silently prefetch deep analysis in background so it's instant when user switches tab
    if (window.DeepAnalysis) {
      const _tok = localStorage.getItem('linglish_token');
      window.DeepAnalysis.load(word, window.API_BASE || '', function () {
        return _tok ? { 'Authorization': 'Bearer ' + _tok } : {};
      }).catch(function () {});
    }
    if (rightSidebar) {
      rightSidebar.classList.remove('visible');
      rightSidebar.classList.remove('dict-open');
    }
    if (dictionarySectionRight) {
      dictionarySectionRight.style.display = 'none';
      dictionarySectionRight.setAttribute('aria-hidden', 'true');
    }
  } else {
    state.lookupUiMode = 'sidebar';
    state.lookupUiOpen = true;
    activeDictionaryContainer = dictionaryContent;
    showDictionarySectionRight();
  }

  if (!activeDictionaryContainer) return;
  activeDictionaryContainer.innerHTML = `
    <div style="padding: 2rem; text-align: center; color: #666;">
      Loading definition for "${word}"...
    </div>
  `;

  try {
    // Use unified dictionary lookup module (parallel requests, immediate render)
    const { entry, wordTranslation } = await window.DictionaryLookup.lookupWord(word, {
      onLoading: (w) => {
        console.log('[Lookup] Loading dictionary for:', w);
      },
      onError: (err) => {
        console.error('[Lookup] Error:', err);
      }
    });

    // Extract phonetic text
    let phoneticText = '';
    if (entry.phonetic) {
      phoneticText = entry.phonetic;
    } else if (entry.phonetics && entry.phonetics.length > 0) {
      const phoneticEntry = entry.phonetics.find(p => p.text);
      phoneticText = (phoneticEntry && phoneticEntry.text) || '';
    }

    // Extract audio URL for pronunciation (validate to avoid 404s)
    let audioUrl = '';
    if (entry.phonetics && entry.phonetics.length > 0) {
      // Find first phonetic entry with a valid audio URL
      const phoneticWithAudio = entry.phonetics.find(p => p.audio && p.audio.trim() !== '');
      if (phoneticWithAudio && phoneticWithAudio.audio) {
        const rawUrl = phoneticWithAudio.audio;
        // Only use audio URL if it's a valid HTTP(S) URL or same-origin path
        if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://') || rawUrl.startsWith('/')) {
          audioUrl = rawUrl;
        }
      }
    }

    // Proactively prefetch TTS so fallback is instant on click (covers invalid dict audio cases)
    prefetchTTSAudio(word);
    console.log('Audio available:', Boolean(audioUrl));

    // Unified dictionary rendering with word translation
    if (window.DictionaryRender) {
      lastRenderedDictPayload = { word, entry, zh: (wordTranslation || ''), audioUrl };

      // Attach translate button handlers for definitions/examples
      if (window.DictionaryLookup) {
        // Variable to hold the stop polling function
        let stopPolling = null;

        const isRealChineseTranslation = (zhText, enText) => {
          if (!zhText || zhText === '[待翻译]') return false;
          const zh = String(zhText || '').trim();
          if (!zh) return false;
          if (/翻译中/.test(zh)) return false;
          if (!/[\u4e00-\u9fa5]/.test(zh)) return false;
          if (enText && zh.toLowerCase() === String(enText).trim().toLowerCase()) return false;
          return true;
        };

        // Check if there are untranslated definitions/examples
        let hasUntranslated = false;
        if (entry && entry.meanings) {
          for (const meaning of entry.meanings) {
            if (!meaning.definitions) continue;
            for (const def of meaning.definitions) {
              if (!isRealChineseTranslation(def.zh, def.definition)) {
                hasUntranslated = true;
                break;
              }
              if (def.example && !isRealChineseTranslation(def.exampleZh, def.example)) {
                hasUntranslated = true;
                break;
              }
            }
            if (hasUntranslated) break;
          }
        }

        // If there are untranslated items, poll for updates
        if (hasUntranslated) {
          console.log(`[Lookup] Starting polling for translations: ${word}`);
          stopPolling = window.DictionaryLookup.pollForTranslations(word, (updatedEntry, updatedZh) => {
            console.log(`[Lookup] Received translation update for: ${word}`);
            const prevScrollTop = activeDictionaryContainer ? activeDictionaryContainer.scrollTop : 0;
            // Re-render the dictionary card with updated translations
            lastRenderedDictPayload = { word, entry: updatedEntry, zh: (updatedZh || wordTranslation || ''), audioUrl };
            renderDictionaryInto(activeDictionaryContainer, lastRenderedDictPayload, stopPolling);
            if (activeDictionaryContainer) {
              requestAnimationFrame(() => { try { activeDictionaryContainer.scrollTop = prevScrollTop; } catch (_) { } });
            }
            // Speak handlers are already set up via delegateDictionarySpeak in renderDictionaryInto
            // No need to re-attach here to avoid duplicate playback
          }, { maxAttempts: 10, interval: 2000, initialEntry: entry, initialZh: (wordTranslation || '') });
          // Save to global so we can stop it when looking up a new word
          currentDictPollingStop = stopPolling;
        }

        // Initial render with stopPolling (may be null if no polling needed)
        renderDictionaryInto(activeDictionaryContainer, lastRenderedDictPayload, stopPolling);
      } else {
        // Fallback render without DictionaryLookup
        renderDictionaryInto(activeDictionaryContainer, lastRenderedDictPayload);
      }
    } else {
      activeDictionaryContainer.innerHTML = `
              <div class="word-header">
                <div class="word-title">${word}</div>
                <button class="word-audio-btn" onclick="playWordAudioSmart('${word}', '${audioUrl}')" title="发音">🔊</button>
              </div>
              ${phoneticText ? `<div class="word-phonetic">${phoneticText}</div>` : ''}
              ${wordTranslation ? `<div class="word-chinese">${wordTranslation}</div>` : '<div id="word-chinese-container" style="color:#999;font-size:0.9rem;font-style:italic;margin-bottom:0.5rem;">翻译暂不可用</div>'}
            `;
    }
    // Attach speak handler only if delegation not installed
    (() => {
      if (activeDictionaryContainer && activeDictionaryContainer.__speakDelegated) return;
      const btn = activeDictionaryContainer.querySelector('.dict-speak-btn');
      if (btn) btn.addEventListener('click', function () { playWordAudioSmart(word, audioUrl); });
      const defBtns = activeDictionaryContainer.querySelectorAll('.dict-def-speak');
      defBtns.forEach(b => b.addEventListener('click', function () {
        const txt = b.getAttribute('data-text') || word;
        playWordAudioSmart(txt, '');
      }));
      const addBtn = activeDictionaryContainer.querySelector('.dict-add-btn');
      if (addBtn) addBtn.addEventListener('click', async () => {
        const addedLabel = (typeof i18n !== 'undefined' && i18n && i18n.t) ? (i18n.t('dict.added') || '已加入学习中') : '已加入学习中';
        const addLabel = (typeof i18n !== 'undefined' && i18n && i18n.t) ? (i18n.t('dict.add') || '加入学习') : '加入学习';
        try {
          addBtn.disabled = true; addBtn.classList.add('added'); addBtn.textContent = addedLabel;
          await markWord(word, 'learning');
        } catch (_) { addBtn.disabled = false; addBtn.classList.remove('added'); addBtn.textContent = addLabel; }
      });
    })();
    // CN translation: only show "fetching" when we truly don't have it.
    // If DictionaryRender already rendered the card, it already places IPA+ZH in the header line,
    // so we don't add an extra bottom "word-chinese" row (avoids duplicates like "房子" shown twice).
    if (activeDictionaryContainer) {
      const renderedByDictionaryRender = !!activeDictionaryContainer.querySelector('.dict-card');
      const hasWordChinese = !!activeDictionaryContainer.querySelector('.word-chinese');
      const placeholder = activeDictionaryContainer.querySelector('#word-chinese-container');
      const safeZh = (s) => escapeHtml(String(s || ''));

      if (renderedByDictionaryRender) {
        if (placeholder) placeholder.remove();
        // Keep DictionaryRender's own header translation; don't add another one.
        return;
      }

      if (wordTranslation) {
        if (placeholder) {
          placeholder.outerHTML = `<div class="word-chinese">${safeZh(wordTranslation)}</div>`;
        } else if (!hasWordChinese) {
          const anchor =
            activeDictionaryContainer.querySelector('.word-phonetic') ||
            activeDictionaryContainer.querySelector('.word-header') ||
            null;
          const zhEl = document.createElement('div');
          zhEl.className = 'word-chinese';
          zhEl.textContent = wordTranslation;
          if (anchor && anchor.parentNode) {
            anchor.insertAdjacentElement('afterend', zhEl);
          } else {
            activeDictionaryContainer.appendChild(zhEl);
          }
        }
      } else if (!placeholder && !hasWordChinese) {
        const p = document.createElement('div');
        p.id = 'word-chinese-container';
        p.style.cssText = 'color:#999;font-size:0.9rem;font-style:italic;margin-bottom:0.5rem;';
        p.textContent = '正在获取中文翻译...';
        activeDictionaryContainer.appendChild(p);
      }
    }
    // Auto-add to user's vocabulary as 'learning' once looked up
    (async () => {
      try {
        await markWord(word, 'learning');
      } catch (_) { }
    })();

    loadWordMeta(word);
  } catch (error) {
    console.error('Dictionary lookup error:', error);
    // Prefetch TTS audio for words without dictionary entry
    prefetchTTSAudio(word);
    // Keep UI minimal when dictionary entry missing: no red warning
    if (window.DictionaryRender) {
      activeDictionaryContainer.innerHTML = DictionaryRender.build(word, null, '', { audioUrl: '' });
      // Attach speak handler only if delegation not installed
      if (!(activeDictionaryContainer && activeDictionaryContainer.__speakDelegated)) {
        const btn = activeDictionaryContainer.querySelector('.dict-speak-btn');
        if (btn) btn.addEventListener('click', function () { playWordAudioSmart(word, ''); });
        const defBtns = activeDictionaryContainer.querySelectorAll('.dict-def-speak');
        defBtns.forEach(b => b.addEventListener('click', function () {
          const txt = b.getAttribute('data-text') || word;
          playWordAudioSmart(txt, '');
        }));
      }
      const addBtn = activeDictionaryContainer.querySelector('.dict-add-btn');
      if (addBtn) addBtn.addEventListener('click', async () => {
        const addedLabel = (typeof i18n !== 'undefined' && i18n && i18n.t) ? (i18n.t('dict.added') || '已加入学习中') : '已加入学习中';
        const addLabel = (typeof i18n !== 'undefined' && i18n && i18n.t) ? (i18n.t('dict.add') || '加入学习') : '加入学习';
        try {
          addBtn.disabled = true; addBtn.classList.add('added'); addBtn.textContent = addedLabel;
          await markWord(word, 'learning');
        } catch (_) { addBtn.disabled = false; addBtn.classList.remove('added'); addBtn.textContent = addLabel; }
      });
    } else {
      activeDictionaryContainer.innerHTML = `
              <div class="word-header">
                <div class="word-title">${word}</div>
                <button class="word-audio-btn" onclick="playWordAudioSmart('${word}', '')" title="发音">🔊</button>
              </div>
              <div style="color:#ef4444;padding:1rem;">查词失败: ${error.message || '未找到单词'}</div>
              <div class="word-study-meta" id="word-study-meta">
                <small style="color:#666;">Vocabulary tracking available once the word is saved.</small>
              </div>
            `;
    }
    state.currentLemma = word;
    state.currentVocabItem = null;
    renderWordMeta(null, []);
    setWordActionState(null);

    // Fetch Chinese translation even when definition is not found
    (async () => {
      try {
        console.log('[Frontend] Fetching translation for error case, word:', word);
        const encodedWord = encodeURIComponent(word);
        console.log('[Frontend] Encoded word for error case:', encodedWord);
        const dictRes = await fetch(`${API_BASE}/dictionary/${encodedWord}`, {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {}
        });
        console.log('[Frontend] Error case dictionary response:', dictRes.status);

        const container = activeDictionaryContainer ? activeDictionaryContainer.querySelector('#word-chinese-container') : null;
        if (!container) return;

        if (dictRes.ok) {
          const dictData = await dictRes.json();
          console.log('[Frontend] Error case dictionary data:', dictData);
          if (dictData.zh) {
            container.outerHTML = `<div class="word-chinese">${dictData.zh}</div>`;
          } else {
            container.outerHTML = '';
          }
        } else {
          console.error('[Frontend] Error case dictionary lookup failed:', dictRes.status);
          container.outerHTML = '';
        }
      } catch (err) {
        console.error('[Frontend] Error case translation exception:', err);
        const container = activeDictionaryContainer ? activeDictionaryContainer.querySelector('#word-chinese-container') : null;
        if (container) container.outerHTML = '';
      }
    })();
  }
}

function playWordAudio(audioUrl) {
  if (!audioUrl) {
    console.warn('No audio URL provided');
    return;
  }
  console.log('Playing audio:', Boolean(audioUrl));
  const audio = new Audio(audioUrl);
  audio.play()
    .then(() => console.log('Audio playing successfully'))
    .catch(err => {
      console.error('Failed to play audio:', err);
      alert('音频播放失败：' + err.message);
    });
}

// Prefetch TTS audio in background for faster playback
async function prefetchTTSAudio(word) {
  const selectedVoice = window.LinglishTtsVoice ? LinglishTtsVoice.current() : 'en-US-AvaMultilingualNeural';
  if (!word || audioCache.has(`tts_${selectedVoice}_${word}`)) return;
  try {
    const voiceLang = selectedVoice.startsWith('en-') ? 'en' : (selectedVoice.startsWith('zh-') ? 'zh-CN' : 'en');

    const _headers1 = { 'Content-Type': 'application/json' };
    if (token) _headers1['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/tts/generate`, {
      method: 'POST',
      headers: _headers1,
      body: JSON.stringify({ text: word, lang: voiceLang, provider: 'edge', voice: selectedVoice })
    });

    if (res.ok) {
      const data = await res.json();
      if (data.audioUrl) {
        audioCache.set(`tts_${selectedVoice}_${word}`, data.audioUrl);
        console.log('TTS audio prefetched and cached for:', word);
      }
    }
  } catch (err) {
    console.warn('Failed to prefetch TTS audio:', err);
  }
}

// Smart audio playback with cache and robust TTS fallback
async function playWordAudioSmart(word, dictAudioUrl) {
  const lemma = String(word || '').trim();
  const normKey = lemma.toLowerCase();
  if (!lemma) return;
  const speakToken = dictVoiceSlot.claim(lemma);
  if (!speakToken) return;
  const alive = () => dictVoiceSlot.isCurrent(speakToken);
  haltDictSpeechOutput();
  pauseLearningVideoForWord();

  const ua = navigator.userAgent || '';
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) || (window.innerWidth && window.innerWidth <= 768);
  let fallbackTimer = null;
  let played = false; // ensure we only play once
  function armGestureFallback() {
    // On mobile, use longer timeout to allow TTS audio to play first
    // Edge TTS takes longer than Google TTS, so increase timeout
    const timeoutMs = isMobile ? 2000 : 1500;
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) { }
    fallbackTimer = setTimeout(() => {
      try {
        if (played || !alive()) return;
        const u = new SpeechSynthesisUtterance(lemma);
        let v = 'en-US';
        try {
          const pref = localStorage.getItem('linglish_tts_voice') || '';
          v = pref.startsWith('zh-')
            ? 'zh-CN'
            : (window.LinglishTtsVoice && LinglishTtsVoice.synthesisLang ? LinglishTtsVoice.synthesisLang() : 'en-US');
        } catch (_) { }
        u.lang = v;
        if (!alive()) return;
        window.speechSynthesis.speak(u);
        played = true;
      } catch (_) { }
    }, timeoutMs);
    dictSpeakFallbackTimer = fallbackTimer;
  }
  function clearGestureFallback() {
    if (dictSpeakFallbackTimer) {
      clearTimeout(dictSpeakFallbackTimer);
      dictSpeakFallbackTimer = null;
    }
    fallbackTimer = null;
  }
  async function tryPlay(url) {
    if (!alive()) return false;
    if (!url) return false;
    if (played) return false;
    try {
      const a = new Audio();
      try { a.crossOrigin = 'anonymous'; } catch (_) { }
      a.src = url;
      // Cancel any ongoing speech fallback before starting audio
      try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) { }

      // Set as current player
      currentAudioPlayer = a;

      await a.play();
      if (!alive()) {
        try { a.pause(); } catch (_) { }
        if (currentAudioPlayer === a) currentAudioPlayer = null;
        return false;
      }
      clearGestureFallback();
      played = true;

      // Clear reference when audio ends
      a.addEventListener('ended', () => {
        if (currentAudioPlayer === a) {
          currentAudioPlayer = null;
        }
      });

      // Clear reference on error
      a.addEventListener('error', () => {
        if (currentAudioPlayer === a) {
          currentAudioPlayer = null;
        }
      });

      return true;
    } catch (e) {
      console.warn('[Audio] play failed:', e?.name || 'PLAYBACK_ERROR');
      if (currentAudioPlayer && currentAudioPlayer.src === url) {
        currentAudioPlayer = null;
      }
      return false;
    }
  }

  try {
    armGestureFallback();
    // 1) Cached dict/tts first
    if (dictAudioUrl) {
      // Skip cross-origin dict audio when CSP blocks external media
      try {
        const u = new URL(dictAudioUrl, location.href);
        if (u.origin !== location.origin) {
          throw new Error('cross-origin-audio');
        }
      } catch (_) {
        // Force TTS path
      }
      const cached = audioCache.get(`dict_${normKey}`);
      if (cached && await tryPlay(cached)) return;
      if (!alive()) return;
    } else {
      const cachedTts = audioCache.get(`tts_${normKey}`);
      if (cachedTts && await tryPlay(cachedTts)) return;
      if (!alive()) return;
    }

    // 2) Dictionary audio if provided; if it fails, continue to TTS
    if (dictAudioUrl) {
      let canUseDict = true;
      try { const u = new URL(dictAudioUrl, location.href); if (u.origin !== location.origin) canUseDict = false; } catch (_) { canUseDict = false; }
      if (canUseDict && await tryPlay(dictAudioUrl)) {
        audioCache.set(`dict_${normKey}`, dictAudioUrl);
        return;
      }
      if (!alive()) return;
      console.log('[Audio] Falling back to TTS for', word);
    }

    // 3) Prefetched TTS
    const selectedVoice = window.LinglishTtsVoice ? LinglishTtsVoice.current() : 'en-US-AvaMultilingualNeural';
    const pref = audioCache.get(`tts_${selectedVoice}_${normKey}`);
    if (pref && await tryPlay(pref)) return;
    if (!alive()) return;

    // 4) Generate TTS on demand
    const voiceLang = selectedVoice.startsWith('en-') ? 'en' : (selectedVoice.startsWith('zh-') ? 'zh-CN' : 'en');

    const _headers2 = { 'Content-Type': 'application/json' };
    if (token) _headers2['Authorization'] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/tts/generate`, {
      method: 'POST',
      headers: _headers2,
      body: JSON.stringify({ text: lemma, lang: voiceLang, provider: 'edge', voice: selectedVoice })
    });
    if (!alive()) return;

    if (res.ok) {
      const data = await res.json();
      if (data.audioUrl) {
        audioCache.set(`tts_${selectedVoice}_${normKey}`, data.audioUrl);
        if (await tryPlay(data.audioUrl)) return;
        if (!alive()) return;
      }
    }

    // 5) Last resort: Web Speech API
    try {
      if (!alive()) return;
      clearGestureFallback();
      const utterance = new SpeechSynthesisUtterance(lemma);
      utterance.lang = voiceLang.startsWith('zh')
        ? 'zh-CN'
        : (window.LinglishTtsVoice && LinglishTtsVoice.synthesisLang ? LinglishTtsVoice.synthesisLang() : 'en-US');
      speechSynthesis.cancel();
      if (!alive()) return;
      speechSynthesis.speak(utterance);
      played = true;
    } catch (_) { }
  } catch (err) {
    console.error('Failed to play audio:', err);
  }
}

async function markWord(word, status) {
  if (!token) return;
  try {
    const payload = {
      lemma: word,
      state: status,
      videoResourceId: state.selectedVideoId,
      segmentIndex: (state.lastLookupContext && state.lastLookupContext.segmentIndex !== null && state.lastLookupContext.segmentIndex !== undefined) ? state.lastLookupContext.segmentIndex : null,
      startSec: (state.lastLookupContext && state.lastLookupContext.startSec !== null && state.lastLookupContext.startSec !== undefined) ? state.lastLookupContext.startSec : null,
      endSec: (state.lastLookupContext && state.lastLookupContext.endSec !== null && state.lastLookupContext.endSec !== undefined) ? state.lastLookupContext.endSec : null,
      sentence: (state.lastLookupContext && state.lastLookupContext.sentence !== null && state.lastLookupContext.sentence !== undefined) ? state.lastLookupContext.sentence : null,
    };

    const response = await fetch(`${API_BASE}/vocab/mark`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || 'Failed to save vocabulary item');
    }

    const data = await response.json();
    state.currentVocabItem = data.item;
    renderWordMeta(data.item, data.contexts || []);
    setWordActionState(data.item);
    refreshReviewQueue();
    // 更新词汇Map以反映新的学习状态
    if (data.item && data.item.lemma) {
      state.vocabMap.set(data.item.lemma.toLowerCase(), data.item.state || 'encountered');
      console.log('[VocabMap] Updated word:', data.item.lemma, 'to state:', data.item.state);

      // 清除缓存以便重新渲染带有新颜色的字幕
      state.segmentHtmlCache.clear();

      // 重新渲染当前视频的字幕以应用新的颜色
      if (state.selectedVideoId) {
        const currentVideo = state.videos.find(function (v) { return v.id === state.selectedVideoId; });
        if (currentVideo) {
          renderTranscript(currentVideo);
          // 同时更新移动端字幕（如果处于移动端）
          if (typeof renderMobileTranscriptWindow === 'function' && mobileSegmentPosition !== null) {
            renderMobileTranscriptWindow(mobileSegmentPosition);
          }
        }
      }
    }
    // highlight all occurrences in transcript
    try {
      const norm = String(((data.item && data.item.lemma) || word) || '').toLowerCase();
      document.querySelectorAll(`.word[data-lemma="${CSS.escape(norm)}"]`).forEach(function (el) { el.classList.add('owned'); });
      try { localStorage.setItem('vocab_update', JSON.stringify({ ts: Date.now(), lemma: norm, state: status })); } catch (_) { }
    } catch (_) { }
  } catch (err) {
    console.error('Failed to update vocabulary item:', err);
    alert(err.message || 'Failed to update vocabulary item.');
  }
}

// ---- Pronunciation assessment (membership gated at server) ----
async function assessPronunciation(text) {
  async function ensureAuthToken() {
    const isValid = (t) => {
      if (!t || typeof t !== 'string') return false;
      if (t === 'guest-token') return false;
      const parts = t.split('.');
      return parts.length === 3 && parts[0] && parts[1];
    };

    try {
      if (window.AuthManager && typeof window.AuthManager.getToken === 'function') {
        const t = window.AuthManager.getToken();
        if (isValid(t)) {
          token = t;
          return t;
        }
      }
    } catch (_) { }

    const t = resolveAuthToken();
    if (isValid(t) && !isTokenExpired(t)) {
      token = t;
      return t;
    }

    if (isValid(t) && isTokenExpired(t)) {
      if (window.AuthManager && typeof window.AuthManager.ensureSession === 'function') {
        try {
          const renewed = await window.AuthManager.ensureSession({ force: true });
          if (renewed) {
            token = renewed;
            return renewed;
          }
        } catch (_) { }
      }
    }

    // Registered token exists but is expired -> force re-login instead of silently switching.
    if (isValid(t) && isTokenExpired(t)) {
      try {
        if (window.AuthManager && typeof window.AuthManager.clearToken === 'function') {
          await window.AuthManager.clearToken();
        }
      } catch (_) { }
      try { localStorage.removeItem('authToken'); } catch (_) { }
      try { localStorage.removeItem('linglish_token'); } catch (_) { }
      try { sessionStorage.removeItem('authToken'); } catch (_) { }
      try { sessionStorage.removeItem('linglish_token'); } catch (_) { }
      token = null;
      return null;
    }

    return null;
  }

    const freshToken = await ensureAuthToken();
    if (!freshToken) {
      alert('登录已过期，请重新登录后再试');
      try {
        const next = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = `./mobile-auth.html?next=${next}`;
      } catch (_) { }
      return;
    }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const recordingStartTime = Date.now();

    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        console.log('[Recording] Chunk received:', e.data.size, 'bytes', 'type:', e.data.type);
        chunks.push(e.data);
      } else {
        console.warn('[Recording] Empty chunk received!');
      }
    };

    // 使用 timeslice 确保数据不丢失
    rec.start(100);

    // 等待录音器真正开始
    await new Promise(r => setTimeout(r, 100));

    alert('准备录音！\n\n请先朗读完整句子，\n朗读完毕后点击【确定】结束录音。');

    rec.stop();
    await new Promise(r => rec.onstop = r);

    const recordingDuration = (Date.now() - recordingStartTime) / 1000;
    console.log('[Recording] Duration:', recordingDuration.toFixed(2), 'seconds');
    console.log('[Recording] Chunks collected:', chunks.length);

    stream.getTracks().forEach(t => t.stop());

    // 检查是否有音频数据
    if (chunks.length === 0) {
      throw new Error('录音失败：未捕获到音频数据。请检查麦克风权限。');
    }

    const blob = new Blob(chunks, { type: 'audio/webm' });
    console.log('[Recording] Blob size:', (blob.size / 1024).toFixed(2), 'KB');
    console.log('[Recording] Blob type:', blob.type);

    // 尝试读取 blob 的一部分来验证数据
    const sample = await blob.slice(0, Math.min(100, blob.size)).arrayBuffer();
    const sampleBytes = new Uint8Array(sample);
    console.log('[Recording] First 10 bytes:', Array.from(sampleBytes.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join(' '));

    const b64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });

    const res = await fetch(`${API_BASE}/pronunciation/assess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${freshToken}` },
      body: JSON.stringify({ text, lemma: text.toLowerCase(), audio_data: b64 }),
    });

    const data = await res.json();
    if (!res.ok) {
      if (res.status === 402 && data.code === 'PRONUNCIATION_DAILY_LIMIT_REACHED') {
        const quota = data.quota || {};
        const tier = String(quota.tier || 'free').toLowerCase();
        const message = tier === 'free'
          ? `今日免费发音评测 ${quota.limit || 0} 次已用完，升级会员可继续练习。`
          : '今日发音评测额度已用完，明天会自动恢复。';
        alert(message);
        return;
      }
      if (res.status === 403 && data.message === 'MEMBERSHIP_REQUIRED') {
        alert('该功能仅对高级会员开放。请升级会员以使用发音校正。');
        return;
      }
      throw new Error(data.message || '评测失败');
    }

    const a = data.assessment || {};
    renderPronunciationCard({
      text,
      hypothesis: data.hypothesis || '',
      overall: Math.round(a.overall || 0),
      accuracy: Math.round(a.accuracy || 0),
      fluency: Math.round(a.fluency || 0),
      completeness: Math.round(a.completeness || 0),
      words: Array.isArray(a.words) ? a.words : [],
    });
  } catch (err) {
    console.error('[Pronunciation] Error:', err);
    alert(`评测失败: ${err.message}`);
  }
}

function renderPronunciationCard(result) {
  try { showDictionarySectionRight(); } catch (_) { }
  const container = document.getElementById('dictionary-content');
  if (!container) return;
  const wordsHtml = (() => {
    const ops = result.words || [];
    if (!ops.length) return `<span style="color:#666;">无词级对齐信息</span>`;
    return ops.map(op => {
      if (op.type === 'correct') return `<span style="background:#e6ffed;color:#036703;padding:2px 4px;border-radius:4px;margin:2px;display:inline-block;">${op.word}</span>`;
      if (op.type === 'missing') return `<span style="background:#fff4e5;color:#8a4b00;padding:2px 4px;border-radius:4px;margin:2px;display:inline-block;text-decoration:line-through;">${op.word}</span>`;
      if (op.type === 'extra') return `<span style="background:#fde2e1;color:#b91c1c;padding:2px 4px;border-radius:4px;margin:2px;display:inline-block;">+${op.word}</span>`;
      return `<span style="padding:2px 4px;margin:2px;">${op.word || ''}</span>`;
    }).join(' ');
  })();
  const card = document.createElement('div');
  card.className = 'pron-card';
  card.style.cssText = 'margin-top:12px;padding:12px;border:1px solid #eee;border-radius:8px;background:#fafafa;';
  card.innerHTML = `
          <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
            <div><strong>发音评测</strong></div>
            <div style="font-size:12px;color:#555;">总体 ${result.overall}/100 · 准确 ${result.accuracy} · 流利 ${result.fluency} · 完整 ${result.completeness}</div>
          </div>
          <div style="margin-top:8px;">
            <div style="font-size:12px;color:#666;">参考</div>
            <div>${escapeHtmlInline(result.text)}</div>
          </div>
          <div style="margin-top:6px;">
            <div style="font-size:12px;color:#666;">识别</div>
            <div>${escapeHtmlInline(result.hypothesis)}</div>
          </div>
          <div style="margin-top:6px;">
            <div style="font-size:12px;color:#666;">词级对齐</div>
            <div>${wordsHtml}</div>
          </div>
          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
            <button id="pron-slow-tts" style="padding:6px 10px;border:0;background:#2b6cb0;color:#fff;border-radius:6px;cursor:pointer;">慢速示范</button>
            <button id="pron-minimal-pairs" style="padding:6px 10px;border:1px solid #ccc;background:#fff;border-radius:6px;cursor:pointer;">最小对立体</button>
          </div>
        `;
  container.prepend(card);

  const pronSlowTtsBtn = document.getElementById('pron-slow-tts');
  if (pronSlowTtsBtn) pronSlowTtsBtn.addEventListener('click', async () => {
    try {
      const selectedVoice = window.LinglishTtsVoice ? LinglishTtsVoice.current() : 'en-US-AvaMultilingualNeural';
      const voiceLang = selectedVoice.startsWith('en-') ? 'en' : (selectedVoice.startsWith('zh-') ? 'zh-CN' : 'en');
      const resp = await fetch(`${API_BASE}/tts/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ text: result.text, slow: true, lang: voiceLang, provider: 'edge', voice: selectedVoice })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || 'TTS 失败');
      const audio = new Audio(data.audioUrl);
      audio.play();
    } catch (e) { alert('TTS 播放失败: ' + e.message); }
  });

  const pronMinimalPairsBtn = document.getElementById('pron-minimal-pairs');
  if (pronMinimalPairsBtn) pronMinimalPairsBtn.addEventListener('click', function () {
    const list = suggestMinimalPairs(result.text);
    alert(list.length ? ('最小对立体\n' + list.join('\n')) : '暂无对立体建议');
  });
}

function escapeHtmlInline(s) {
  const div = document.createElement('div');
  div.textContent = String(s || '');
  return div.innerHTML;
}

function suggestMinimalPairs(word) {
  const pairs = {
    'th': ['think/sink', 'thin/sin', 'bath/bass', 'three/free'],
    'r': ['rock/lock', 'correct/collect', 'rake/lake'],
    'l': ['light/right', 'long/wrong', 'glass/grass'],
    'v': ['vine/fine', 'save/safe'],
    'w': ['west/vest'],
    'i': ['ship/sheep', 'live/leave'],
    'e': ['pen/pan'],
  };
  const lower = String(word || '').toLowerCase();
  const hit = Object.keys(pairs).find(k => lower.includes(k));
  return hit ? pairs[hit] : [];
}

async function loadSpeakersForVideo(videoId) {
  if (!practicePanel) return;
  try {
    const response = await fetch(`${API_BASE}/practice/speakers?videoId=${videoId}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    if (!response.ok) {
      throw new Error('Failed to load speakers');
    }
    const data = await response.json();
    state.speakers = data.speakers || [];
    state.segmentSpeakerMap = {};
    state.speakers.forEach((speakerGroup) => {
      (speakerGroup.lines || []).forEach((line) => {
        if (line && line.index !== undefined) {
          state.segmentSpeakerMap[line.index] = speakerGroup.speaker;
        }
      });
    });

    const currentVideo = state.videos.find((v) => v.id === videoId);
    if (currentVideo) {
      renderTranscript(currentVideo);
    }

    state.practiceArmed = false;
    updatePracticeArmUI();
    if (!state.speakers.length) {
      practicePanel.hidden = true;
      return;
    }

    practicePanel.hidden = false;

    // 生成说话者选项HTML
    const speakerOptionsHTML = state.speakers
      .map((speaker, idx) => `<option value="${escapeHtml(speaker.speaker)}" ${idx === 0 ? 'selected' : ''}>${escapeHtml(speaker.speaker)}</option>`)
      .join('');

    // 填充主面板和右侧边栏的说话者下拉框
    if (practiceSpeakerSelect) {
      practiceSpeakerSelect.innerHTML = speakerOptionsHTML;
    }
    if (practiceSpeakerSelectRight) {
      practiceSpeakerSelectRight.innerHTML = speakerOptionsHTML;
    }

    setPracticeSpeaker(state.speakers[0].speaker);
  } catch (err) {
    console.warn('Unable to load practice speakers:', err);
    practicePanel.hidden = true;

    // 即使加载speakers失败，也要渲染转录（避免停留在loading状态）
    const currentVideo = state.videos.find((v) => v.id === videoId);
    if (currentVideo) {
      renderTranscript(currentVideo);
    }
  }
}

function setPracticeSpeaker(speakerName) {
  if (state.recorder && state.recorder.state !== 'inactive') {
    state.recorder.stop();
  }
  state.selectedSpeaker = speakerName;
  const speakerData = state.speakers.find((s) => s.speaker === speakerName);
  state.practiceLines = firstLessonSession.isActive()
    ? state.currentSegments.map((segment, index) => ({ ...segment, index }))
    : (speakerData ? speakerData.lines : []);
  state.practiceLineResults = {};
  state.practiceLineWordResults = {};
  state.practiceLines.forEach((line) => {
    if (line && line.index !== undefined) {
      state.segmentSpeakerMap[line.index] = speakerName;
    }
  });
  state.practiceIndex = 0;
  state.practiceAttempts = 0;
  renderPracticeLines();
  renderPracticeCurrentLine();
  updatePracticeArmUI();
  const currentVideo = state.videos.find((v) => v.id === state.selectedVideoId);
  if (currentVideo) {
    renderTranscript(currentVideo);
  }
}

function togglePracticeMode(forceState) {
  const nextState = typeof forceState === 'boolean' ? forceState : !state.practiceArmed;
  state.practiceArmed = nextState;
  updatePracticeArmUI();
  if (state.practiceArmed) {
    state.practicePlaybackLock = true;
    state.waitingForPractice = true;
    renderPracticeCurrentLine();
  } else {
    state.practicePlaybackLock = false;
    state.waitingForPractice = false;
    state.segmentPlaybackEnd = null;
    state.segmentPlaybackCallback = null;
    const disabledText = 'Practice mode disabled. Use play controls freely.';
    if (practiceFeedback) practiceFeedback.textContent = disabledText;
    if (practiceFeedbackRight) practiceFeedbackRight.textContent = disabledText;
  }
}

function updatePracticeArmUI() {
  const activeText = 'Disable Practice Mode';
  const inactiveText = 'Enable Practice Mode';

  // 更新主面板按钮
  if (practiceArmBtn) {
    if (state.practiceArmed) {
      practiceArmBtn.classList.add('active');
      practiceArmBtn.textContent = activeText;
    } else {
      practiceArmBtn.classList.remove('active');
      practiceArmBtn.textContent = inactiveText;
    }
  }

  // 更新右侧边栏按钮
  if (practiceArmBtnRight) {
    if (state.practiceArmed) {
      practiceArmBtnRight.classList.add('active');
      practiceArmBtnRight.textContent = activeText;
    } else {
      practiceArmBtnRight.classList.remove('active');
      practiceArmBtnRight.textContent = inactiveText;
    }
  }
}

// 辅助函数：同时更新主面板和右侧边栏的反馈消息
function updatePracticeFeedback(text, color = '#333') {
  if (firstLessonSession.isActive()) firstLessonGoalCard.feedback(text);
  if (practiceFeedback) {
    practiceFeedback.textContent = text;
    practiceFeedback.style.color = color;
  }
  if (practiceFeedbackRight) {
    practiceFeedbackRight.textContent = text;
    practiceFeedbackRight.style.color = color;
  }
}

// 辅助函数：同时更新主面板和右侧边栏的按钮状态
function updatePracticeButtons(playOriginalDisabled, recordDisabled, compareDisabled) {
  if (practicePlayOriginalBtn) practicePlayOriginalBtn.disabled = playOriginalDisabled;
  if (practiceStartBtn) practiceStartBtn.disabled = recordDisabled;
  if (practiceCompareBtn) practiceCompareBtn.disabled = compareDisabled;
  if (practicePlayOriginalBtnRight) practicePlayOriginalBtnRight.disabled = playOriginalDisabled;
  if (practiceStartBtnRight) practiceStartBtnRight.disabled = recordDisabled;
  if (practiceCompareBtnRight) practiceCompareBtnRight.disabled = compareDisabled;
}

function renderPracticeLines() {
  if (!practicePanel) return;

  // 清空主面板和右侧边栏的列表
  if (practiceLineList) {
    practiceLineList.innerHTML = '';
  }
  if (practiceLineListRight) {
    practiceLineListRight.innerHTML = '';
  }

  if (!state.practiceLines.length) {
    if (practiceCurrentLine) practiceCurrentLine.hidden = true;
    if (practiceCurrentLineRight) practiceCurrentLineRight.hidden = true;
    practiceControlsHidden(true);
    updatePracticeFeedback('No lines available for this speaker.');
    return;
  }

  // 创建学生台词的索引映射（用于快速查找）
  const studentLineIndexMap = new Map();
  state.practiceLines.forEach((line, idx) => {
    if (line && line.index != null) {
      studentLineIndexMap.set(line.index, idx);
    }
  });

  // 遍历所有字幕句子，显示完整对话
  state.currentSegments.forEach((segment, segmentIdx) => {
    const segmentIndex = segment.index != null ? segment.index : segmentIdx;
    const isStudentLine = studentLineIndexMap.has(segmentIndex);
    const studentIdx = studentLineIndexMap.get(segmentIndex);

    // 如果是学生的台词，检查状态
    const lineStatus = isStudentLine ? (state.practiceLineResults[segmentIndex] || null) : null;
    const isActive = isStudentLine && studentIdx === state.practiceIndex;

    const classNames = [];
    if (!isStudentLine) {
      classNames.push('other-speaker'); // 其他角色的台词
    } else {
      if (lineStatus === 'success') {
        classNames.push('practice-success');
      }
      if (isActive) {
        classNames.push('active');
      }
    }
    const className = classNames.join(' ');

    // 获取角色名称
    const speakerName = state.segmentSpeakerMap[segmentIndex] || '';
    const speakerLabel = speakerName ? `[${speakerName}] ` : '';

    // 主面板
    if (practiceLineList) {
      const li = document.createElement('li');
      if (className) {
        li.className = className;
      }
      // 添加 data-index 属性，用于视频播放时的高亮和滚动
      li.setAttribute('data-segment-index', segmentIndex);
      li.innerHTML = `<span>${speakerLabel}${escapeHtml(segment.text || '')}</span><span style="font-size:0.75rem; color:#666;">${formatTime(segment.start)}</span>`;

      // 只有学生的台词可以点击
      if (isStudentLine) {
        li.style.cursor = 'pointer';
        li.addEventListener('click', function () {
          state.practiceIndex = studentIdx;
          state.practiceAttempts = 0;
          renderPracticeLines();
          renderPracticeCurrentLine();
        });
      } else {
        li.style.cursor = 'default';
      }

      practiceLineList.appendChild(li);
    }

    // 右侧边栏
    if (practiceLineListRight) {
      const liRight = document.createElement('li');
      if (className) {
        liRight.className = className;
      }
      // 添加 data-index 属性，用于视频播放时的高亮和滚动
      liRight.setAttribute('data-segment-index', segmentIndex);
      liRight.innerHTML = `<span>${speakerLabel}${escapeHtml(segment.text || '')}</span><span style="font-size:0.75rem; color:#666;">${formatTime(segment.start)}</span>`;

      // 只有学生的台词可以点击
      if (isStudentLine) {
        liRight.style.cursor = 'pointer';
        liRight.addEventListener('click', function () {
          state.practiceIndex = studentIdx;
          state.practiceAttempts = 0;
          renderPracticeLines();
          renderPracticeCurrentLine();
        });
      } else {
        liRight.style.cursor = 'default';
      }

      practiceLineListRight.appendChild(liRight);
    }
  });

  practiceControlsHidden(false);
}

function practiceControlsHidden(hidden) {
  if (practiceControls) {
    practiceControls.hidden = hidden;
  }
  if (practiceControlsRight) {
    practiceControlsRight.hidden = hidden;
  }
}

function tokenizeForPracticeComparison(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function computePracticeWordMatches(referenceText, recognizedText) {
  const correctIndexes = [];
  const missingIndexes = [];
  const refTokens = tokenizeForPracticeComparison(referenceText);
  const hypTokens = tokenizeForPracticeComparison(recognizedText);
  if (!refTokens.length) {
    return { correctIndexes, missingIndexes };
  }
  const hypCounts = new Map();
  hypTokens.forEach((token) => {
    hypCounts.set(token, (hypCounts.get(token) || 0) + 1);
  });

  for (let i = 0; i < refTokens.length; i += 1) {
    const token = refTokens[i];
    const remaining = hypCounts.get(token) || 0;
    if (remaining > 0) {
      correctIndexes.push(i);
      hypCounts.set(token, remaining - 1);
    } else {
      missingIndexes.push(i);
    }
  }
  return { correctIndexes, missingIndexes };
}

function buildHighlightedPracticeHTML(originalText, correctIndexes, missingIndexes) {
  if (!originalText) return '';
  const correctSet = new Set(correctIndexes || []);
  const missingSet = new Set(missingIndexes || []);
  const segments = [];
  const wordRegex = /[A-Za-z0-9']+/g;
  let lastIndex = 0;
  let match = null;
  let wordIndex = 0;

  while ((match = wordRegex.exec(originalText)) !== null) {
    if (match.index > lastIndex) {
      segments.push(escapeHtml(originalText.slice(lastIndex, match.index)));
    }
    const wordText = match[0];
    const escapedWord = escapeHtml(wordText);
    if (correctSet.has(wordIndex)) {
      segments.push(`<span class="practice-word-correct">${escapedWord}</span>`);
    } else if (missingSet.has(wordIndex)) {
      segments.push(`<span class="practice-word-missing">${escapedWord}</span>`);
    } else {
      segments.push(escapedWord);
    }
    lastIndex = match.index + wordText.length;
    wordIndex += 1;
  }

  if (lastIndex < originalText.length) {
    segments.push(escapeHtml(originalText.slice(lastIndex)));
  }

  return segments.join('');
}

function renderPracticeCurrentLine() {
  const line = state.practiceLines[state.practiceIndex];
  if (!line) {
    if (practiceCurrentLine) {
      practiceCurrentLine.hidden = true;
      practiceCurrentLine.classList.remove('practice-successful');
    }
    if (practiceCurrentLineRight) {
      practiceCurrentLineRight.hidden = true;
      practiceCurrentLineRight.classList.remove('practice-successful');
    }
    updatePracticeFeedback('');
    return;
  }

  const key = line && line.index != null ? line.index : state.practiceIndex;
  const lineStatus = state.practiceLineResults[key] || null;
  const isSuccessful = lineStatus === 'success';
  const storedMatches = state.practiceLineWordResults[key] || {};
  let missingIndexes = storedMatches.missingIndexes;
  if (!Array.isArray(missingIndexes) && window.LinglishMissedWords && line.text) {
    const saved = new Set(window.LinglishMissedWords.wordsFor(localStorage, state.selectedVideoId, key));
    missingIndexes = [];
    const tokens = String(line.text).match(/[A-Za-z0-9']+/g) || [];
    tokens.forEach((token, index) => {
      if (saved.has(token.toLowerCase())) missingIndexes.push(index);
    });
  }
  const highlightedLineHtml = line.text
    ? buildHighlightedPracticeHTML(line.text, storedMatches.correctIndexes, missingIndexes)
    : '';
  const currentLineHTML = `
          <div style="font-weight:600; margin-bottom:0.4rem;">Line ${state.practiceIndex + 1} of ${state.practiceLines.length}</div>
          <div>${highlightedLineHtml}</div>
          <div style="font-size:0.8rem; color:#666; margin-top:0.3rem;">${formatTime(line.start)} – ${formatTime(line.end)}</div>
        `;

  const feedbackText = firstLessonSession.isActive() ? '先听原句，再点击「跟读这句」。录完点击「完成录音」获取反馈。' : state.practiceArmed
    ? 'Press "🎙 Record" to practice this line.'
    : 'Enable practice mode to auto-pause before each line.';

  // 更新主面板和右侧边栏
  if (practiceCurrentLine) {
    practiceCurrentLine.hidden = false;
    practiceCurrentLine.innerHTML = currentLineHTML;
    practiceCurrentLine.classList.toggle('practice-successful', isSuccessful);
  }
  if (practiceCurrentLineRight) {
    practiceCurrentLineRight.hidden = false;
    practiceCurrentLineRight.innerHTML = currentLineHTML;
    practiceCurrentLineRight.classList.toggle('practice-successful', isSuccessful);
  }

  updatePracticeFeedback(feedbackText, '#333');
  updatePracticeButtons(false, false, false);

  const start = Number(line.start) || 0;
  if (state.practiceArmed) {
    state.segmentPlaybackEnd = null;
    state.segmentPlaybackCallback = null;
    if (Number.isFinite(start)) {
      try {
        videoPlayer.currentTime = start;
      } catch (err) {
        console.warn('Unable to seek video to practice start:', err);
      }
    }
    videoPlayer.pause();
    state.waitingForPractice = true;
    state.practicePlaybackLock = true;
  } else {
    state.waitingForPractice = false;
    state.practicePlaybackLock = false;
  }

  // 滚动字幕列表到当前练习的句子（参考视频播放时的滚动方式）
  if (line.index != null) {
    const active = document.querySelector(`.transcript-segment[data-index="${line.index}"]`);
    if (active) {
      active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}

function cleanupRecordingMonitor() {
  const monitor = state.recordingMonitor;
  if (!monitor) return;
  state.recordingMonitor = null;

  if (monitor.checkIntervalId) {
    clearInterval(monitor.checkIntervalId);
  }
  if (monitor.source) {
    try {
      monitor.source.disconnect();
    } catch (err) {
      console.warn('Unable to disconnect audio source:', err);
    }
  }
  if (monitor.analyser) {
    try {
      monitor.analyser.disconnect();
    } catch (err) {
      console.warn('Unable to disconnect audio analyser:', err);
    }
  }
  if (monitor.context) {
    monitor.context.close().catch(() => { });
  }
}

function teardownMobileFirstLessonRecording() {
  firstLessonGoalBusy = false;
  firstLessonGoalCard.setState('idle');
  state.practiceAssessmentContext = null;
  cleanupRecordingMonitor();
  state.recordingChunks.length = 0;
  if (state.recorder && state.recorder.state !== 'inactive') {
    try { state.recorder.stop(); } catch (_) { }
  }
  state.recorder = null;
  if (state.mediaStream) {
    try { state.mediaStream.getTracks().forEach((track) => track.stop()); } catch (_) { }
  }
  state.mediaStream = null;
  state.waitingForPractice = false;
  state.practicePlaybackLock = false;
  updatePracticeButtons(false, false, false);
}

function beginRecordingMonitor() {
  if (!state.mediaStream) return;

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (typeof AudioCtx !== 'function') {
    console.warn('AudioContext not available; auto-stop disabled.');
    return;
  }

  cleanupRecordingMonitor();

  let context;
  try {
    context = new AudioCtx();
  } catch (err) {
    console.warn('Failed to initialize AudioContext:', err);
    return;
  }

  const source = context.createMediaStreamSource(state.mediaStream);
  const analyser = context.createAnalyser();
  analyser.smoothingTimeConstant = 0.8;
  analyser.fftSize = 2048;
  source.connect(analyser);

  const dataArray = new Uint8Array(analyser.fftSize);
  const now = Date.now();
  const monitor = {
    context,
    source,
    analyser,
    dataArray,
    checkIntervalId: null,
    startedAt: now,
    lastVoiceAt: now,
    silenceThreshold: 0.02,
    minRecordingMs: 1400,
    silenceDurationMs: 1800,
    maxRecordingMs: 20000,
    pendingStop: false,
  };

  monitor.checkIntervalId = window.setInterval(() => {
    analyser.getByteTimeDomainData(dataArray);
    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i += 1) {
      const value = (dataArray[i] - 128) / 128;
      sumSquares += value * value;
    }

    const rms = Math.sqrt(sumSquares / dataArray.length);
    const currentTime = Date.now();
    if (rms > monitor.silenceThreshold) {
      monitor.lastVoiceAt = currentTime;
    }

    const elapsed = currentTime - monitor.startedAt;
    const silentFor = currentTime - monitor.lastVoiceAt;

    if (!monitor.pendingStop) {
      if (elapsed >= monitor.maxRecordingMs) {
        monitor.pendingStop = true;
        updatePracticeFeedback('Time limit reached, evaluating...');
        stopPracticeRecording('auto');
        return;
      }

      if (elapsed >= monitor.minRecordingMs && silentFor >= monitor.silenceDurationMs) {
        monitor.pendingStop = true;
        updatePracticeFeedback('Detected silence, evaluating...');
        stopPracticeRecording('auto');
      }
    }
  }, 150);

  state.recordingMonitor = monitor;
}

async function startPracticeRecording() {
  if (firstLessonSession.isActive() && firstLessonGoalBusy) return;
  const line = state.practiceLines[state.practiceIndex];
  if (!line) return;
  if (!state.practiceArmed) {
    togglePracticeMode(true);
  }
  const key = line && line.index != null ? line.index : state.practiceIndex;
  if (key !== undefined && key !== null) {
    delete state.practiceLineWordResults[key];
    renderPracticeCurrentLine();
  }
  const assessmentContext = firstLessonSession.isActive() ? createMobileAssessmentContext(line) : null;
  if (firstLessonSession.isActive() && !assessmentContext) return;
  state.practiceAssessmentContext = assessmentContext;
  if (assessmentContext) {
    firstLessonGoalBusy = true;
    firstLessonGoalCard.setState('requesting');
  }
  videoPlayer.pause();
  if (assessmentContext && youtubePlayer?.player) youtubePlayer.pause();
  state.practicePlaybackLock = true;
  try {
    if (!state.mediaStream) {
      state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (assessmentContext && !isMobileAssessmentContextCurrent(assessmentContext)) {
      teardownMobileFirstLessonRecording('stale-before-recording');
      return;
    }
    state.recordingChunks = [];
    state.recorder = new MediaRecorder(state.mediaStream, { mimeType: 'audio/webm' });
    const recording = state.recorder;
    state.recorder.addEventListener('dataavailable', function (event) {
      if (assessmentContext && state.recorder !== recording) return;
      if (event.data.size > 0) {
        state.recordingChunks.push(event.data);
      }
    });
    state.recorder.addEventListener('stop', async () => {
      if (assessmentContext && state.recorder !== recording) return;
      cleanupRecordingMonitor();
      updatePracticeButtons(false, false, false);
      const chunks = state.recordingChunks.splice(0);
      state.recorder = null;
      if (!chunks.length) {
        firstLessonGoalBusy = false;
        firstLessonGoalCard.setState('idle');
        return;
      }
      const blob = new Blob(chunks, { type: 'audio/webm' });
      if (assessmentContext) firstLessonGoalCard.setState('evaluating');
      updatePracticeFeedback('Evaluating...');
      await submitPracticeRecording(blob, line, assessmentContext);
      if (!assessmentContext || state.practiceAssessmentContext === assessmentContext) {
        firstLessonGoalBusy = false;
        firstLessonGoalCard.setState('idle');
      }
    });
    state.recorder.start();
    if (assessmentContext) firstLessonGoalCard.setState('recording');
    beginRecordingMonitor();
    updatePracticeButtons(true, true, false);
    updatePracticeFeedback('Recording...');
  } catch (err) {
    firstLessonGoalBusy = false;
    firstLessonGoalCard.setState('idle');
    console.error('Unable to record audio:', err);

    // 提供详细的错误提示和解决方案
    let errorMessage = '无法访问麦克风，请检查权限设置：\n\n';

    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      errorMessage += '1. 点击地址栏的 🔒 或 ⓘ 图标\n';
      errorMessage += '2. 找到"麦克风"或"录音"权限\n';
      errorMessage += '3. 将权限设置为"允许"\n';
      errorMessage += '4. 刷新页面后重试';
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      errorMessage += '未检测到麦克风设备\n';
      errorMessage += '请确保设备有可用的麦克风';
    } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      errorMessage += '麦克风被其他应用占用\n';
      errorMessage += '请关闭其他使用麦克风的应用后重试';
    } else {
      errorMessage += '错误类型: ' + (err.name || 'Unknown') + '\n';
      errorMessage += '\n请尝试：\n';
      errorMessage += '1. 检查浏览器麦克风权限\n';
      errorMessage += '2. 关闭其他使用麦克风的应用\n';
      errorMessage += '3. 重启浏览器后重试';
    }

    alert(errorMessage);
    updatePracticeButtons(false, false, false);
    teardownMobileFirstLessonRecording('recording-error');
  }
}

function stopPracticeRecording(reason) {
  if (reason && typeof reason === 'object' && typeof reason.type === 'string') {
    reason.preventDefault && reason.preventDefault();
    reason = 'manual';
  }
  if (state.recordingMonitor) {
    state.recordingMonitor.pendingStop = true;
  }
  cleanupRecordingMonitor();
  if (state.recorder && state.recorder.state !== 'inactive') {
    state.recorder.stop();
  }
}

async function submitPracticeRecording(blob, line, assessmentContext = null) {
  if (!token || !state.selectedVideoId) return;
  // Save the recording blob for comparison
  state.lastRecordingBlob = blob;
  try {
    let result = null;
    if (assessmentContext) {
      result = await window.LinglishFirstLessonPractice.submitAssessment({
        fetch,
        url: `${API_BASE}/practice/evaluate`,
        token,
        blob,
        context: assessmentContext,
        isContextCurrent: isMobileAssessmentContextCurrent,
      });
      if (!result) return;
    } else {
      const formData = new FormData();
      formData.append('audio', blob, 'practice.webm');
      formData.append('videoId', String(state.selectedVideoId));
      formData.append('segmentIndex', String(line.index));
      const response = await fetch(`${API_BASE}/practice/evaluate`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || 'Evaluation failed');
      }
      result = await response.json();
      result.__assessmentId = result.assessment_id || result.assessmentId ||
        response.headers?.get?.('x-request-id') || `assessment-${Date.now()}`;
    }
    handlePracticeResult(result, line, assessmentContext);
  } catch (err) {
    console.error('Practice evaluation failed:', err);
    updatePracticeFeedback(err.message || 'Evaluation failed. Please try again.');
  }
}

function handlePracticeResult(result, line, assessmentContext = null) {
  if (assessmentContext && !isMobileAssessmentContextCurrent(assessmentContext)) return false;
  const { success, similarity, recognizedText, targetText } = result;
  const percent = Math.round(similarity * 100);
  const key = line && line.index != null ? line.index : state.practiceIndex;
  const wordMatches = computePracticeWordMatches(targetText || (line ? line.text : ''), recognizedText || '');
  if (window.LinglishMissedWords && line) {
    const persisted = window.LinglishMissedWords.remember(
      localStorage,
      state.selectedVideoId,
      key,
      targetText || line.text || '',
      recognizedText || ''
    );
    wordMatches.missingWords = persisted;
  }
  state.practiceLineWordResults[key] = wordMatches;
  renderPracticeCurrentLine();

  if (firstLessonSession.isActive()) {
    if (success) {
      markPracticedMobileFirstLesson(assessmentContext, result, result.__assessmentId, 'recording_assessment');
      state.practiceLineResults[key] = 'success';
      state.practiceAttempts = 0;
      state.waitingForPractice = false;
      state.practicePlaybackLock = false;
      videoPlayer.pause();
      state.segmentPlaybackEnd = null;
      state.segmentPlaybackCallback = null;
    }
    firstLessonGoalCard.settle(window.LinglishFirstLessonGoal.sentenceResult(success === true, wordMatches.missingWords));
    updatePracticeButtons(false, false, false);
    return true;
  }
  if (success) {
    markPracticedMobileFirstLesson(assessmentContext, result, result.__assessmentId, 'recording_assessment');
    updatePracticeFeedback(`Great! (${percent}% match) — "${recognizedText}"`, '#155724');
    state.practiceLineResults[key] = 'success';
    renderPracticeLines();
    state.practiceAttempts = 0;
    state.waitingForPractice = false;
    state.practicePlaybackLock = false;
    scheduleNextLine(line, 'Continuing video...');
  } else {
    state.practiceAttempts += 1;
    let feedbackMsg = `Not quite (${percent}% match). Recognized: "${recognizedText}". Try again! (${state.practiceAttempts}/3)`;
    const missedList = (wordMatches.missingWords || []).slice(0, 4);
    if (missedList.length) {
      feedbackMsg = `这句漏了 ${missedList.join('、')}（${percent}%）。漏掉的词留在这一句里。 (${state.practiceAttempts}/3)`;
    }
    if (state.practiceAttempts >= 3) {
      feedbackMsg += ' Playing original line.';
      updatePracticeFeedback(feedbackMsg, '#b71c1c');
      state.practiceAttempts = 0;
      state.practicePlaybackLock = false;
      playSegmentSnippet(line, () => scheduleNextLine(line, 'Original line played. Continuing...'));
    } else {
      updatePracticeFeedback(feedbackMsg, '#b71c1c');
    }
  }
  return true;
}

function skipPracticeLine() {
  const line = state.practiceLines[state.practiceIndex];
  if (!line) return;
  updatePracticeFeedback('Line skipped.', '#666');
  state.practiceAttempts = 0;
  state.waitingForPractice = false;
  state.practicePlaybackLock = false;
  scheduleNextLine(line, 'Continuing to next line...');
}

function playOriginalLine() {
  const line = state.practiceLines[state.practiceIndex];
  if (!line) return;
  updatePracticeFeedback('Playing original line...', '#4a5ff7');

  // Temporarily unlock playback to allow playing the original
  const wasLocked = state.practicePlaybackLock;
  state.practicePlaybackLock = false;

  // Reset practice attempts for this line
  state.practiceAttempts = 0;
  state.waitingForPractice = false;

  // Find the next student line to determine where to stop
  const nextLine = state.practiceLines[state.practiceIndex + 1];
  // 如果有下一句学生台词，提前0.2秒停止，避免播放到下一句
  const endTime = nextLine ? (nextLine.start - 0.2) : (line.end && line.end > line.start ? line.end : (line.start || 0) + 4);

  // Set video to start at current line
  videoPlayer.currentTime = line.start || 0;

  // Set playback to continue until next student line
  state.segmentPlaybackEnd = endTime;
  state.segmentPlaybackCallback = () => {
    videoPlayer.pause();
    // Restore the lock state
    state.practicePlaybackLock = wasLocked;
    // Advance to next line
    scheduleNextLine(line, 'Original line played. Continuing to next line...');
  };

  safePlayVideo();
}

function compareRecordings() {
  const line = state.practiceLines[state.practiceIndex];
  if (!line) return;

  updatePracticeFeedback('Playing original dialogue...', '#f59e0b');

  // Temporarily unlock playback to allow playing the original
  const wasLocked = state.practicePlaybackLock;
  state.practicePlaybackLock = false;

  // Find the next student line to determine where to stop
  const nextLine = state.practiceLines[state.practiceIndex + 1];
  // 如果有下一句学生台词，提前0.2秒停止，避免播放到下一句
  const endTime = nextLine ? (nextLine.start - 0.2) : (line.end && line.end > line.start ? line.end : (line.start || 0) + 4);

  // Set video to start at current line
  videoPlayer.currentTime = line.start || 0;

  // Set playback to continue until next student line
  state.segmentPlaybackEnd = endTime;
  state.segmentPlaybackCallback = () => {
    videoPlayer.pause();
    // Restore the lock state
    state.practicePlaybackLock = wasLocked;

    // After playing original, automatically start recording
    updatePracticeFeedback('Original played. Starting recording in 1 second...', '#f59e0b');
    setTimeout(() => {
      startPracticeRecording();
    }, 1000);
  };

  safePlayVideo();
}

function playSegmentSnippet(line, callback) {
  if (!line) return;
  videoPlayer.currentTime = line.start || 0;
  const end = line.end && line.end > line.start ? line.end : (line.start || 0) + 4;

  // Always set the playback end and callback for segment playback
  state.segmentPlaybackEnd = end;
  state.segmentPlaybackCallback = () => {
    videoPlayer.pause();
    if (callback) callback();
  };

  safePlayVideo();
}

function scheduleNextLine(line, message) {
  if (!line) return;
  const nextLine = state.practiceLines[state.practiceIndex + 1] || null;
  const resumeFrom = line && line.end && line.end > line.start ? line.end : (line.start || 0) + 0.1;
  updatePracticeButtons(true, true, true);
  state.waitingForPractice = false;
  state.practicePlaybackLock = false;

  if (!state.practiceArmed) {
    if (nextLine) {
      state.practiceIndex += 1;
      state.practiceAttempts = 0;
      renderPracticeLines();
      renderPracticeCurrentLine();
    } else {
      updatePracticeFeedback(message || 'All lines completed for this speaker!', '#155724');
    }
    if (message) {
      updatePracticeFeedback(message, '#155724');
    }
    updatePracticeButtons(false, false, false);
    return;
  }

  state.segmentPlaybackCallback = null;
  state.segmentPlaybackEnd = null;

  if (nextLine) {
    const nextStart = Number(nextLine.start);
    // 提前0.2秒停止，确保学生的台词不会被播放出来
    const stopBeforeStart = Number.isFinite(nextStart) && nextStart > resumeFrom ? nextStart - 0.2 : resumeFrom + 0.5;
    state.segmentPlaybackEnd = stopBeforeStart;
    state.segmentPlaybackCallback = () => {
      videoPlayer.pause();
      state.practiceIndex += 1;
      state.practiceAttempts = 0;
      renderPracticeLines();
      renderPracticeCurrentLine();
    };
    if (message) {
      updatePracticeFeedback(message, '#155724');
    }
    videoPlayer.currentTime = resumeFrom;
    safePlayVideo();
  } else {
    state.segmentPlaybackCallback = null;
    state.segmentPlaybackEnd = null;
    const completionMsg = message
      ? message + ' All lines completed for this speaker!'
      : 'All lines completed for this speaker!';
    updatePracticeFeedback(completionMsg, '#155724');
    videoPlayer.currentTime = resumeFrom;
    safePlayVideo();
    updatePracticeButtons(true, true, false);
  }
}

// Tag Management Functions
function loadTagsFromLocalStorage() {
  try {
    const savedTags = localStorage.getItem('linglish_tags');
    if (savedTags && savedTags !== 'undefined' && savedTags !== 'null') {
      state.tags = JSON.parse(savedTags);
    }
  } catch (e) {
    console.warn('[Tags] Failed to parse tags from localStorage:', e);
    state.tags = [];
  }

  try {
    const savedVideoTags = localStorage.getItem('linglish_video_tags');
    if (savedVideoTags && savedVideoTags !== 'undefined' && savedVideoTags !== 'null') {
      state.videoTags = JSON.parse(savedVideoTags);
    }
  } catch (e) {
    console.warn('[Tags] Failed to parse video tags from localStorage:', e);
    state.videoTags = {};
  }

  renderTagList();
}

function saveTagsToLocalStorage() {
  localStorage.setItem('linglish_tags', JSON.stringify(state.tags));
  localStorage.setItem('linglish_video_tags', JSON.stringify(state.videoTags));
}

function renderTagList() {
  const tagListEl = document.getElementById('tag-list');
  if (!tagListEl) return;

  const allTagHtml = `<span class="tag-item ${state.selectedTag === '' ? 'active' : ''}" data-tag="">全部</span>`;
  const tagsHtml = state.tags.map(tag => {
    const count = Object.values(state.videoTags).filter(tags => tags.includes(tag)).length;
    return `<span class="tag-item ${state.selectedTag === tag ? 'active' : ''}" data-tag="${escapeHtml(tag)}">
            ${escapeHtml(tag)} (${count})
            <span class="tag-delete" data-tag="${escapeHtml(tag)}">×</span>
          </span>`;
  }).join('');

  tagListEl.innerHTML = allTagHtml + tagsHtml;

  // Add click event listeners
  tagListEl.querySelectorAll('.tag-item').forEach(el => {
    el.addEventListener('click', function (e) {
      if (!e.target.classList.contains('tag-delete')) {
        selectTag(el.getAttribute('data-tag'));
      }
    });
  });

  tagListEl.querySelectorAll('.tag-delete').forEach(el => {
    el.addEventListener('click', function (e) {
      e.stopPropagation();
      deleteTag(el.getAttribute('data-tag'));
    });
  });
}

function selectTag(tag) {
  state.selectedTag = tag;
  renderTagList();
  renderVideoList();
}

function addTag() {
  const input = document.getElementById('new-tag-input');
  const tagName = input.value.trim();
  if (!tagName) return;

  if (state.tags.includes(tagName)) {
    alert('标签已存在');
    return;
  }

  state.tags.push(tagName);
  saveTagsToLocalStorage();
  renderTagList();
  input.value = '';
}

function deleteTag(tag) {
  if (!confirm(`确定要删除标签"${tag}"吗？`)) return;

  state.tags = state.tags.filter(t => t !== tag);
  // Remove tag from all videos
  Object.keys(state.videoTags).forEach(videoId => {
    state.videoTags[videoId] = state.videoTags[videoId].filter(t => t !== tag);
  });

  if (state.selectedTag === tag) {
    state.selectedTag = '';
  }

  saveTagsToLocalStorage();
  renderTagList();
  renderVideoList();
}

function editVideoTitle(videoId) {
  const video = state.videos.find(v => v.id === videoId);
  if (!video) return;

  const newTitle = prompt('修改视频名称：', video.title);
  if (!newTitle || newTitle === video.title) return;

  video.title = newTitle;
  // TODO: Call API to update video title on server
  // For now, just update locally
  renderVideoList();
}

function showTagDialog(videoId) {
  const video = state.videos.find(v => v.id === videoId);
  if (!video) return;

  const currentTags = state.videoTags[videoId] || [];
  const availableTags = state.tags.filter(tag => !currentTags.includes(tag));

  let message = `为"${video.title}"添加/移除标签：\n\n当前标签：\n`;
  if (currentTags.length > 0) {
    currentTags.forEach((tag, i) => {
      message += `${i + 1}. ${tag}\n`;
    });
  } else {
    message += '(无)\n';
  }

  message += '\n可用标签：\n';
  if (availableTags.length > 0) {
    availableTags.forEach((tag, i) => {
      message += `${currentTags.length + i + 1}. ${tag}\n`;
    });
  } else {
    message += '(无可用标签，请先创建标签)\n';
  }

  message += '\n输入标签名称来添加/移除标签（取消则关闭）：';
  const tagName = prompt(message);
  if (!tagName) return;

  const trimmedTag = tagName.trim();
  if (!state.tags.includes(trimmedTag)) {
    alert('标签不存在');
    return;
  }

  if (!state.videoTags[videoId]) {
    state.videoTags[videoId] = [];
  }

  if (state.videoTags[videoId].includes(trimmedTag)) {
    // Remove tag
    state.videoTags[videoId] = state.videoTags[videoId].filter(t => t !== trimmedTag);
  } else {
    // Add tag
    state.videoTags[videoId].push(trimmedTag);
  }

  saveTagsToLocalStorage();
  renderTagList();
  renderVideoList();
}

async function deleteVideo(videoId) {
  const video = state.videos.find(v => v.id === videoId);
  if (!video) return;

  // 确认删除
  const confirmMsg = `确定要删除视频"${video.title}"吗？\n\n此操作无法撤销，将会删除：\n- 视频文件\n- 字幕数据\n- 相关的学习记录`;
  if (!confirm(confirmMsg)) {
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/video-resources/${videoId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || 'Failed to delete video');
    }

    const result = await response.json();
    console.log('[DELETE] Video deleted successfully:', result);

    // 从本地状态中移除视频
    state.videos = state.videos.filter(v => v.id !== videoId);

    // 清理该视频的标签
    if (state.videoTags[videoId]) {
      delete state.videoTags[videoId];
      saveTagsToLocalStorage();
      renderTagList();
    }

    // 如果删除的是当前选中的视频，选择另一个视频
    if (state.selectedVideoId === videoId) {
      if (state.videos.length > 0) {
        selectVideo(state.videos[0].id);
      } else {
        state.selectedVideoId = null;
        videoPlayer.removeAttribute('src');
        videoMeta.textContent = '';
        transcriptContent.innerHTML = '<div class="empty-state">No videos available.</div>';
      }
    }

    // 重新渲染视频列表
    renderVideoList();

    alert('视频已成功删除');
  } catch (err) {
    console.error('[DELETE] Failed to delete video:', err);
    alert(`删除失败：${err.message}`);
  }
}

function showVideoActionNotice(message, type) {
  if (window.membershipSystem && typeof window.membershipSystem.showNotification === 'function') {
    window.membershipSystem.showNotification(message, type || 'info');
    return;
  }
  alert(message);
}

function getJsonAuthHeaders() {
  token = resolveAuthToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function submitVideoReviewRequest(videoId, requestType) {
  const video = state.videos.find(v => v.id === videoId);
  if (!video) return;
  if (!resolveAuthToken()) {
    showVideoActionNotice('请先登录后再提交审核。', 'warning');
    return;
  }

  const response = await fetch(`${API_BASE}/api/video-share-requests`, {
    method: 'POST',
    headers: getJsonAuthHeaders(),
    body: JSON.stringify({
      video_id: videoId,
      request_type: requestType,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || '审核请求提交失败');
  }
  if (data.already_public) {
    video.is_public = true;
    renderVideoList();
    showVideoActionNotice('这个视频已经公开。', 'success');
    return;
  }
  if (data.already_featured) {
    video.is_featured = true;
    video.is_public = true;
    renderVideoList();
    showVideoActionNotice('这个视频已经是精选。', 'success');
    return;
  }
  const pending = data?.request?.already_pending;
  const label = requestType === 'featured' ? '精选' : '公开';
  showVideoActionNotice(pending ? `${label}申请已在审核中。` : `${label}申请已提交，审核通过后会自动生效。`, 'success');
}

// 申请分享视频
async function shareVideo(videoId) {
  const video = state.videos.find(v => v.id === videoId);
  if (!video) return;
  try {
    if (state.user && state.user.is_admin) {
      const response = await fetch(`${API_BASE}/video-resources/${videoId}`, {
        method: 'PATCH',
        headers: getJsonAuthHeaders(),
        body: JSON.stringify({ is_public: true }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.message || '公开失败');
      }
      if (data.video) {
        Object.assign(video, data.video);
        renderVideoList();
      }
      showVideoActionNotice('已设为公开视频。', 'success');
      return;
    }
    await submitVideoReviewRequest(videoId, 'public');
  } catch (err) {
    console.error('[VideoShare] Failed:', err);
    showVideoActionNotice(err.message || '公开申请提交失败', 'error');
  }
}

// 加精视频（仅管理员）
async function featureVideo(videoId) {
  const video = state.videos.find(v => v.id === videoId);
  if (!video) return;
  try {
    if (state.user && state.user.is_admin) {
      const response = await fetch(`${API_BASE}/video-resources/${videoId}`, {
        method: 'PATCH',
        headers: getJsonAuthHeaders(),
        body: JSON.stringify({ is_featured: true }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.message || '设为精选失败');
      }
      if (data.video) {
        Object.assign(video, data.video);
        renderVideoList();
      }
      showVideoActionNotice('已设为精选公开视频。', 'success');
      return;
    }
    await submitVideoReviewRequest(videoId, 'featured');
  } catch (err) {
    console.error('[VideoFeature] Failed:', err);
    showVideoActionNotice(err.message || '精选申请提交失败', 'error');
  }
}

// Transcript editing functions
function enterEditMode(index) {
  const textEl = transcriptContent.querySelector(`.transcript-text[data-index="${index}"]`);
  if (!textEl) return;

  const currentText = state.currentSegments[index].text || '';

  // Replace word spans with plain text and make it editable
  textEl.innerHTML = escapeHtml(currentText);
  textEl.contentEditable = 'true';
  textEl.classList.add('editing');

  // Focus and select all
  textEl.focus();
  const range = document.createRange();
  range.selectNodeContents(textEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  // Handle blur (exit edit mode)
  const handleBlur = () => {
    exitEditMode(index);
    textEl.removeEventListener('blur', handleBlur);
    textEl.removeEventListener('keydown', handleKeydown);
  };

  // Handle Enter key
  const handleKeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      textEl.blur();
    } else if (e.key === 'Escape') {
      // Cancel editing
      textEl.innerHTML = wordHtml(currentText);
      textEl.contentEditable = 'false';
      textEl.classList.remove('editing');
      textEl.removeEventListener('blur', handleBlur);
      textEl.removeEventListener('keydown', handleKeydown);
    }
  };

  textEl.addEventListener('blur', handleBlur);
  textEl.addEventListener('keydown', handleKeydown);
}

function exitEditMode(index) {
  const textEl = transcriptContent.querySelector(`.transcript-text[data-index="${index}"]`);
  if (!textEl) return;

  const newText = textEl.textContent.trim();
  const oldText = state.currentSegments[index].text || '';

  textEl.contentEditable = 'false';
  textEl.classList.remove('editing');

  if (newText && newText !== oldText) {
    // Save the edit
    saveTranscriptEdit(index, newText);
    // Update display with word spans
    textEl.innerHTML = wordHtml(newText);
  } else {
    // Restore original text with word spans
    textEl.innerHTML = wordHtml(oldText);
  }
}

async function saveTranscriptEdit(segmentIndex, newText) {
  if (!state.selectedVideoId) return;

  const video = state.videos.find(v => v.id === state.selectedVideoId);
  if (!video) return;

  // Update local state immediately
  if (state.currentSegments[segmentIndex]) {
    state.currentSegments[segmentIndex].text = newText;
  }
  if (video.transcript_segments && video.transcript_segments[segmentIndex]) {
    video.transcript_segments[segmentIndex].text = newText;
  }

  try {
    // Save to backend
    const response = await fetch(`${API_BASE}/video-resources/${state.selectedVideoId}/transcript/${segmentIndex}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ text: newText })
    });

    if (!response.ok) {
      throw new Error('Failed to save transcript edit');
    }

    console.log('Transcript segment updated successfully');
  } catch (err) {
    console.error('Failed to save transcript edit:', err);
    alert('保存失败，请重试');
  }
}

function getSpeakerNameForSegment(segmentIndex) {
  const segment = state.currentSegments[segmentIndex];
  if (!segment) return '';
  if (segment.speaker && segment.speaker.trim()) {
    return segment.speaker.trim();
  }
  const key = segment.index != null ? segment.index : segmentIndex;
  const mapped = state.segmentSpeakerMap[key];
  return typeof mapped === 'string' ? mapped.trim() : '';
}

function getAllSpeakerNames() {
  const names = new Set();
  state.speakers.forEach((group) => {
    if (group && typeof group.speaker === 'string' && group.speaker.trim()) {
      names.add(group.speaker.trim());
    }
  });
  state.currentSegments.forEach((segment) => {
    if (segment && typeof segment.speaker === 'string' && segment.speaker.trim()) {
      names.add(segment.speaker.trim());
    }
  });
  Object.values(state.segmentSpeakerMap).forEach((value) => {
    if (typeof value === 'string' && value.trim()) {
      names.add(value.trim());
    }
  });
  return Array.from(names).filter(Boolean).sort((a, b) => a.localeCompare(b, 'en'));
}

function closeSpeakerPicker() {
  if (!state.activeSpeakerEditor) return;
  const { wrapper, anchor, outsideHandler } = state.activeSpeakerEditor;
  if (outsideHandler) {
    document.removeEventListener('click', outsideHandler, true);
  }
  if (wrapper && wrapper.parentNode) {
    wrapper.parentNode.removeChild(wrapper);
  }
  if (anchor) {
    anchor.style.display = '';
  }
  state.activeSpeakerEditor = null;
}

function handleSpeakerLabelClick(buttonEl, segmentIndex) {
  if (state.activeSpeakerEditor && state.activeSpeakerEditor.anchor === buttonEl) {
    closeSpeakerPicker();
    return;
  }
  showSpeakerPicker(buttonEl, segmentIndex);
}

function showSpeakerPicker(anchorEl, segmentIndex) {
  closeSpeakerPicker();

  const currentName = getSpeakerNameForSegment(segmentIndex);
  const wrapper = document.createElement('div');
  wrapper.className = 'speaker-picker-popover';

  const select = document.createElement('select');
  select.className = 'speaker-picker-select';

  const noneOption = document.createElement('option');
  noneOption.value = '__none__';
  noneOption.textContent = '(无角色)';
  select.appendChild(noneOption);

  const speakerNames = getAllSpeakerNames();
  if (!speakerNames.includes(currentName) && currentName) {
    speakerNames.push(currentName);
  }
  speakerNames
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    });

  const newOption = document.createElement('option');
  newOption.value = '__new__';
  newOption.textContent = '+ 新角色...';
  select.appendChild(newOption);

  if (currentName) {
    select.value = currentName;
  } else {
    select.value = '__none__';
  }

  wrapper.appendChild(select);

  if (currentName) {
    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'speaker-picker-action';
    renameBtn.textContent = '重命名';
    renameBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const nameInput = prompt(`将「${currentName}」重命名为：`, currentName);
      if (!nameInput || !nameInput.trim() || nameInput.trim() === currentName) {
        return;
      }
      const success = await renameSpeakerForVideo(currentName, nameInput.trim());
      if (success) {
        closeSpeakerPicker();
      }
    });
    wrapper.appendChild(renameBtn);
  }

  const outsideHandler = (event) => {
    if (!wrapper.contains(event.target) && event.target !== anchorEl) {
      closeSpeakerPicker();
    }
  };

  setTimeout(() => document.addEventListener('click', outsideHandler, true), 0);

  state.activeSpeakerEditor = {
    wrapper,
    anchor: anchorEl,
    segmentIndex,
    outsideHandler,
  };

  anchorEl.style.display = 'none';
  anchorEl.parentNode.insertBefore(wrapper, anchorEl.nextSibling);

  select.focus();

  select.addEventListener('change', async (event) => {
    const value = event.target.value;
    if (value === '__new__') {
      const nameInput = prompt('输入新的角色名称，例如 “老师” 或 “学生”', currentName || '');
      if (nameInput && nameInput.trim()) {
        const success = await updateSegmentSpeaker(segmentIndex, nameInput.trim());
        if (success) {
          closeSpeakerPicker();
        } else {
          event.target.value = currentName ? currentName : '__none__';
        }
      } else {
        event.target.value = currentName ? currentName : '__none__';
      }
      return;
    }

    const normalized = value === '__none__' ? null : value;
    const success = await updateSegmentSpeaker(segmentIndex, normalized);
    if (success) {
      closeSpeakerPicker();
    } else {
      event.target.value = currentName ? currentName : '__none__';
    }
  });

  select.addEventListener('blur', function () {
    setTimeout(() => {
      if (state.activeSpeakerEditor && state.activeSpeakerEditor.wrapper === wrapper) {
        closeSpeakerPicker();
      }
    }, 120);
  });
}

async function updateSegmentSpeaker(segmentIndex, speakerName) {
  if (!state.selectedVideoId) return false;
  const videoId = state.selectedVideoId;
  const payload = { speaker: speakerName == null ? null : speakerName };
  try {
    const response = await fetch(`${API_BASE}/video-resources/${videoId}/transcript/${segmentIndex}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.message || 'Failed to update speaker');
    }

    await response.json().catch(() => null);
    await loadSpeakersForVideo(videoId);
    return true;
  } catch (err) {
    console.error('Failed to update segment speaker:', err);
    alert(err.message || '更新角色失败，请稍后重试');
    return false;
  }
}

function collectSegmentIndicesForSpeaker(targetName) {
  const indices = [];
  if (!targetName) return indices;
  state.currentSegments.forEach((segment, idx) => {
    const effective = getSpeakerNameForSegment(idx);
    if (effective === targetName) {
      indices.push(idx);
    }
  });
  return indices;
}

async function renameSpeakerForVideo(oldName, newName) {
  if (!state.selectedVideoId) return false;
  const videoId = state.selectedVideoId;
  const indices = collectSegmentIndicesForSpeaker(oldName);
  if (!indices.length) {
    alert('未找到使用该角色的台词');
    return false;
  }

  try {
    const response = await fetch(`${API_BASE}/video-resources/${videoId}/speakers`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        from: oldName,
        to: newName,
        segment_indices: indices,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.message || 'Failed to rename speaker');
    }

    await response.json().catch(() => null);
    await loadSpeakersForVideo(videoId);
    return true;
  } catch (err) {
    console.error('Failed to rename speaker:', err);
    alert(err.message || '重命名角色失败，请稍后重试');
    return false;
  }
}

// Event listeners for tag management
const addTagBtn = document.getElementById('add-tag-btn');
const newTagInput = document.getElementById('new-tag-input');

if (addTagBtn) {
  addTagBtn.addEventListener('click', addTag);
}

if (newTagInput) {
  newTagInput.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
      addTag();
    }
  });
}

// Toggle sidebar, toolbar, and dictionary
const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
const dictCloseBtn = document.getElementById('dict-close-btn');
const videoSidebar = document.getElementById('video-sidebar');
const mobileLibraryBackdrop = document.getElementById('mobile-library-backdrop');
const mobileSidebarLayout = window.MobileReaderLayout;

function applyMobileVideoLibraryState(nextState) {
  if (!nextState || !toggleSidebarBtn || !videoSidebar) return;
  videoSidebar.classList.toggle('hidden', nextState.hidden);
  toggleSidebarBtn.setAttribute('aria-expanded', String(nextState.expanded));
  toggleSidebarBtn.setAttribute('aria-label', nextState.label);
  toggleSidebarBtn.textContent = nextState.text;
  document.body.classList.toggle('mobile-library-open', nextState.expanded);
  if (mobileLibraryBackdrop) {
    mobileLibraryBackdrop.tabIndex = nextState.expanded ? 0 : -1;
  }
}

function closeMobileVideoLibrary() {
  if (
    !document.body.classList.contains('video-reader-mobile-focus') ||
    !mobileSidebarLayout ||
    !toggleSidebarBtn ||
    !videoSidebar
  ) {
    return;
  }
  applyMobileVideoLibraryState(mobileSidebarLayout.closedSidebarState());
}

if (toggleSidebarBtn && videoSidebar) {
  if (
    document.body.classList.contains('video-reader-mobile-focus') &&
    mobileSidebarLayout &&
    mobileSidebarLayout.shouldStartSidebarHidden(window.innerWidth)
  ) {
    closeMobileVideoLibrary();
  }

  toggleSidebarBtn.addEventListener('click', function () {
    if (document.body.classList.contains('video-reader-mobile-focus') && mobileSidebarLayout) {
      if (firstLessonSession.isActive() && videoSidebar.classList.contains('hidden')) {
        firstLessonSession.deactivate('library-open');
      }
      applyMobileVideoLibraryState(
        mobileSidebarLayout.nextSidebarState(videoSidebar.classList.contains('hidden'))
      );
      return;
    }
    videoSidebar.classList.toggle('hidden');
    toggleSidebarBtn.textContent = videoSidebar.classList.contains('hidden') ? '☰' : '✕';
  });
}

if (mobileLibraryBackdrop) {
  mobileLibraryBackdrop.addEventListener('click', closeMobileVideoLibrary);
}

document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape' && document.body.classList.contains('mobile-library-open')) {
    closeMobileVideoLibrary();
    if (toggleSidebarBtn) toggleSidebarBtn.focus();
  }
});

const videoToolbar = document.getElementById('video-toolbar');

// View mode toggle functionality
const videoWrapper = document.querySelector('.video-wrapper');
const transcriptPanel = document.querySelector('.transcript-panel');
const viewModeBtns = document.querySelectorAll('.view-mode-btn');
let currentViewMode = 'both';

function setActiveViewButtons(mode) {
  viewModeBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
  });
  mobileViewBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
  });
}

function applyViewMode(mode) {
  currentViewMode = mode;
  setActiveViewButtons(mode);

  if (videoWrapper) {
    if (mode === 'text-only') {
      videoWrapper.classList.add('hidden');
    } else {
      videoWrapper.classList.remove('hidden');
    }
  }

  if (transcriptPanel) {
    transcriptPanel.classList.remove('fullscreen');
    if (mode === 'video-only') {
      transcriptPanel.style.display = 'none';
    } else if (mode === 'text-only') {
      transcriptPanel.style.display = 'block';
      transcriptPanel.classList.add('fullscreen');
    } else {
      transcriptPanel.style.display = 'block';
    }
  }

  if (mobileTranscript) {
    if (mode === 'video-only') {
      mobileTranscript.style.display = 'none';
    } else {
      mobileTranscript.style.display = '';
    }
  }

  if (mobilePlayerControls) {
    mobilePlayerControls.style.display = '';
  }

  if (mode === 'video-only') {
    updateMobileNavButtons(null);
  } else {
    renderMobileTranscriptWindow(mobileSegmentPosition);
  }
}

viewModeBtns.forEach(btn => {
  btn.addEventListener('click', function () {
    const mode = btn.getAttribute('data-mode') || 'both';
    applyViewMode(mode);
  });
});

mobileViewBtns.forEach(btn => {
  btn.addEventListener('click', function () {
    const mode = btn.getAttribute('data-mode');

    // 处理字幕语言切换按钮
    if (mode === 'english' || mode === 'bilingual') {
      // 更新状态
      state.showBilingual = (mode === 'bilingual');
      // 保存到 localStorage
      try {
        localStorage.setItem('transcript_mode', mode === 'bilingual' ? 'bi' : 'en');
      } catch (e) {
        console.warn('Failed to save transcript mode:', e);
      }
      // 更新按钮激活状态
      mobileViewBtns.forEach(b => {
        const bMode = b.getAttribute('data-mode');
        if (bMode === 'english' || bMode === 'bilingual') {
          b.classList.toggle('active', bMode === mode);
        }
      });
      // 重新渲染字幕以显示/隐藏翻译
      renderMobileTranscriptWindow(mobileSegmentPosition);
    }
    // 处理导航按钮
    else if (mode === 'prev') {
      navigateMobileSegment(-1);
    }
    else if (mode === 'next') {
      navigateMobileSegment(1);
    }
    // 处理原有的视图模式切换（如果还有的话）
    else {
      applyViewMode(mode || 'both');
    }
  });
});

applyViewMode(currentViewMode);

// 初始化移动端字幕语言按钮状态
mobileViewBtns.forEach(btn => {
  const mode = btn.getAttribute('data-mode');
  if (mode === 'english' || mode === 'bilingual') {
    const shouldBeActive = (mode === 'bilingual' && state.showBilingual) ||
      (mode === 'english' && !state.showBilingual);
    btn.classList.toggle('active', shouldBeActive);
  }
});

// Playback speed control functionality
const speedBtns = document.querySelectorAll('.speed-btn');

const formatSpeedLabel = (value) => {
  if (!Number.isFinite(value)) return '1';
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};

const updateSpeedDisplay = (value) => {
  if (!speedToggleButton) return;
  speedToggleButton.textContent = `${formatSpeedLabel(value)}x`;
};

const syncSpeedButtons = (rate) => {
  if (!Number.isFinite(rate)) return;
  speedBtns.forEach((desktopBtn) => {
    const desktopSpeed = parseFloat(desktopBtn.getAttribute('data-speed'));
    if (Number.isFinite(desktopSpeed) && Math.abs(desktopSpeed - rate) < 0.001) {
      desktopBtn.classList.add('active');
    } else {
      desktopBtn.classList.remove('active');
    }
  });
  mobileSpeedBtns.forEach((mobileBtn) => {
    const mobileSpeed = parseFloat(mobileBtn.dataset.speed);
    if (Number.isFinite(mobileSpeed) && Math.abs(mobileSpeed - rate) < 0.001) {
      mobileBtn.classList.add('active');
    } else {
      mobileBtn.classList.remove('active');
    }
  });
};

if (speedToggleButton) {
  speedToggleButton.setAttribute('aria-expanded', 'false');
}

if (speedToggleButton && speedFloatingMenu) {
  speedToggleButton.addEventListener('click', function (event) {
    event.stopPropagation();
    const isOpen = speedFloatingMenu.classList.toggle('open');
    speedToggleButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  });

  document.addEventListener('click', function (event) {
    if (!speedFloatingMenu.classList.contains('open')) return;
    if (event.target === speedToggleButton || speedFloatingMenu.contains(event.target)) return;
    speedFloatingMenu.classList.remove('open');
    speedToggleButton.setAttribute('aria-expanded', 'false');
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && speedFloatingMenu.classList.contains('open')) {
      speedFloatingMenu.classList.remove('open');
      speedToggleButton.setAttribute('aria-expanded', 'false');
    }
  });
}

speedBtns.forEach((btn) => {
  btn.addEventListener('click', function () {
    const speed = parseFloat(btn.getAttribute('data-speed'));
    if (!Number.isFinite(speed)) return;
    if (videoPlayer) {
      videoPlayer.playbackRate = speed;
    }
    syncSpeedButtons(speed);
    updateSpeedDisplay(speed);
    if (speedFloatingMenu && speedFloatingMenu.classList.contains('open')) {
      speedFloatingMenu.classList.remove('open');
      if (speedToggleButton) {
        speedToggleButton.setAttribute('aria-expanded', 'false');
      }
    }
  });
});

mobileSpeedBtns.forEach((btn) => {
  btn.addEventListener('click', function () {
    const speed = parseFloat(btn.dataset.speed);
    if (!Number.isFinite(speed)) return;
    if (videoPlayer) {
      videoPlayer.playbackRate = speed;
    }
    syncSpeedButtons(speed);
    updateSpeedDisplay(speed);
    if (speedFloatingMenu && speedFloatingMenu.classList.contains('open')) {
      speedFloatingMenu.classList.remove('open');
      if (speedToggleButton) {
        speedToggleButton.setAttribute('aria-expanded', 'false');
      }
    }
  });
});

const initialSpeedBtn = Array.from(speedBtns).find((btn) => btn.classList.contains('active'));
const initialSpeed = initialSpeedBtn
  ? parseFloat(initialSpeedBtn.getAttribute('data-speed'))
  : (videoPlayer ? Number(videoPlayer.playbackRate) : 1);

if (Number.isFinite(initialSpeed)) {
  syncSpeedButtons(initialSpeed);
  updateSpeedDisplay(initialSpeed);
}

// Subtitle offset control functionality
const offsetBtns = document.querySelectorAll('.offset-btn');

// Load saved subtitle offset from localStorage
try {
  const savedOffset = localStorage.getItem('subtitle_offset');
  if (savedOffset !== null && savedOffset !== 'null' && savedOffset !== 'undefined') {
    const offset = parseFloat(savedOffset);
    if (Number.isFinite(offset)) {
      state.subtitleOffset = offset;
    }
  }
} catch (_) {
  // ignore localStorage errors
}

const syncOffsetButtons = (offset) => {
  if (!Number.isFinite(offset)) return;
  offsetBtns.forEach((btn) => {
    const btnOffset = parseFloat(btn.getAttribute('data-offset'));
    if (Number.isFinite(btnOffset) && Math.abs(btnOffset - offset) < 0.001) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
};

offsetBtns.forEach((btn) => {
  btn.addEventListener('click', function () {
    const offset = parseFloat(btn.getAttribute('data-offset'));
    if (!Number.isFinite(offset)) return;

    // Update state
    state.subtitleOffset = offset;

    // Save to localStorage
    try {
      localStorage.setItem('subtitle_offset', String(offset));
    } catch (_) {
      // ignore localStorage errors
    }

    // Update button states
    syncOffsetButtons(offset);

    // Log for debugging
    console.log('[Subtitle Offset] Set to:', offset, 'seconds');
  });
});

// Initialize offset buttons with saved value
syncOffsetButtons(state.subtitleOffset);

if (videoPlayer) {
  videoPlayer.addEventListener('ratechange', function () {
    const currentRate = Number(videoPlayer.playbackRate);
    if (Number.isFinite(currentRate)) {
      syncSpeedButtons(currentRate);
      updateSpeedDisplay(currentRate);
    }
  });
}

if (mobileReplayBtn) {
  mobileReplayBtn.addEventListener('click', function () {
    if (!videoPlayer) return;
    videoPlayer.currentTime = 0;
    safePlayVideo();
  });
}

if (mobileProgress && videoPlayer) {
  const commitMobileSeek = () => {
    if (!videoPlayer.duration || Number.isNaN(videoPlayer.duration)) {
      isMobileProgressDragging = false;
      return;
    }
    const fraction = Number(mobileProgress.value) / 100;
    videoPlayer.currentTime = Math.max(0, Math.min(videoPlayer.duration * fraction, videoPlayer.duration));
    isMobileProgressDragging = false;
  };

  mobileProgress.addEventListener('input', function () {
    if (!videoPlayer.duration || Number.isNaN(videoPlayer.duration)) return;
    isMobileProgressDragging = true;
    const fraction = Number(mobileProgress.value) / 100;
    const previewTime = videoPlayer.duration * fraction;
    if (mobileCurrentTime) {
      mobileCurrentTime.textContent = formatTime(previewTime);
    }
  });

  mobileProgress.addEventListener('change', commitMobileSeek);
  mobileProgress.addEventListener('mouseup', commitMobileSeek);
  mobileProgress.addEventListener('touchend', commitMobileSeek, { passive: true });
  mobileProgress.addEventListener('pointerup', commitMobileSeek);
  mobileProgress.addEventListener('mousedown', function () { isMobileProgressDragging = true; });
  mobileProgress.addEventListener('touchstart', function () { isMobileProgressDragging = true; }, { passive: true });
  mobileProgress.addEventListener('pointerdown', function () { isMobileProgressDragging = true; });
}

if (mobilePrevSegmentBtn) {
  mobilePrevSegmentBtn.addEventListener('click', function () { navigateMobileSegment(-1); });
}
if (mobileNextSegmentBtn) {
  mobileNextSegmentBtn.addEventListener('click', function () { navigateMobileSegment(1); });
}
if (mobileBackBtn) {
  mobileBackBtn.addEventListener('click', function () {
    // 检测来源页面
    const referrer = document.referrer || '';
    const params = (function () {
      try { return new URLSearchParams(window.location.search || ''); } catch (_) { return null; }
    })();
    const from = params ? params.get('from') : null;

    // 如果有历史记录且来自本站，使用 history.back()
    if (referrer && referrer.startsWith(window.location.origin)) {
      window.history.back();
    } else {
      // 否则根据视口宽度或referrer智能跳转
      const isDesktopReferrer = referrer.includes('index-desktop.html') || referrer.includes('video-reader-desktop.html');
      const isMobileReferrer = referrer.includes('mobile-') || (referrer.includes('index.html') && !isDesktopReferrer);

      if (isDesktopReferrer) {
        window.location.href = './index-desktop.html';
      } else if (from === 'today' || referrer.includes('mobile-today.html')) {
        window.location.href = './mobile-today.html';
      } else if (isMobileReferrer) {
        window.location.href = './mobile-explore.html';
      } else {
        // 默认根据视口宽度判断
        const isMobileViewport = window.innerWidth <= 768;
        window.location.href = isMobileViewport ? './mobile-explore.html' : './index-desktop.html';
      }
    }
  });
}
if (mobileTranscriptList) {
  mobileTranscriptList.addEventListener('click', function (event) {
    // 优先处理单词点击（查词功能）
    const wordEl = event.target.closest('.transcript-word');
    if (wordEl) {
      event.preventDefault();
      event.stopPropagation();

      // 添加点击动画效果
      wordEl.classList.add('clicked');
      setTimeout(function () { wordEl.classList.remove('clicked'); }, 300);

      const word = wordEl.getAttribute('data-word');
      if (word) {
        const item = event.target.closest('.mobile-transcript-item');
        if (item) {
          const index = Number(item.dataset.index);
          const segments = state.currentSegments || [];
          const segment = segments[index];
          if (segment) {
            state.lastLookupContext = {
              segmentIndex: index,
              startSec: Number(segment.start),
              endSec: Number(segment.end),
              sentence: segment.text || '',
            };
            // metrics: lookup interaction
            metrics.logInteraction('lookup', word, {
              segmentIndex: state.lastLookupContext.segmentIndex,
              startSec: state.lastLookupContext.startSec,
              endSec: state.lastLookupContext.endSec,
            });
          } else {
            state.lastLookupContext = null;
          }
        }
        lookupWord(word);
        updateStats('words');
      }
      return;
    }

    // 处理整个字幕项点击（跳转视频）
    const item = event.target.closest('.mobile-transcript-item');
    if (!item || item.classList.contains('empty')) return;
    if (!isMobileLayout()) return;
    const index = Number(item.dataset.index);
    if (!Number.isFinite(index)) return;
    const segments = state.currentSegments || [];
    const segment = segments[index];
    if (!segment || !videoPlayer) return;
    const startTime = Number(segment.start);
    if (Number.isFinite(startTime)) {
      videoPlayer.currentTime = Math.max(0, startTime);
      safePlayVideo();
    }
    mobileSegmentPosition = index;
    renderMobileTranscriptWindow(mobileSegmentPosition);
  });
}

// Audio mode toggle functionality
// 学习统计功能
const stats = {
  words: parseInt(localStorage.getItem('linglish_words_learned') || '0'),
  videos: parseInt(localStorage.getItem('linglish_videos_completed') || '0'),
  streak: parseInt(localStorage.getItem('linglish_streak_days') || '0'),
};

function updateStats(type) {
  if (type === 'words') {
    stats.words++;
    localStorage.setItem('linglish_words_learned', stats.words.toString());
    const el = document.getElementById('stat-words');
    if (el) {
      el.textContent = stats.words;
      el.classList.add('updated');
      setTimeout(() => el.classList.remove('updated'), 300);
    }
  } else if (type === 'videos') {
    stats.videos++;
    localStorage.setItem('linglish_videos_completed', stats.videos.toString());
    const el = document.getElementById('stat-videos');
    if (el) {
      el.textContent = stats.videos;
      el.classList.add('updated');
      setTimeout(() => el.classList.remove('updated'), 300);
    }
  }
}

function updateStreak() {
  const today = new Date().toDateString();
  const lastVisit = localStorage.getItem('linglish_last_visit');

  if (lastVisit !== today) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    if (lastVisit === yesterday.toDateString()) {
      stats.streak++;
    } else if (!lastVisit) {
      stats.streak = 1;
    } else {
      stats.streak = 1; // 断签，重新开始
    }

    localStorage.setItem('linglish_streak_days', stats.streak.toString());
    localStorage.setItem('linglish_last_visit', today);
  }

  const el = document.getElementById('stat-streak');
  if (el) el.textContent = stats.streak;
}

function initializeStats() {
  document.getElementById('stat-words').textContent = stats.words;
  document.getElementById('stat-videos').textContent = stats.videos;
  document.getElementById('stat-streak').textContent = stats.streak;
  updateStreak();
}

// 词汇管理功能
let currentVocabFilter = 'all';
let vocabularyCache = [];
let allVocabularyCache = []; // 保存所有词汇用于统计

// 加载词汇状态Map用于字幕颜色标记
async function loadVocabMap() {
  try {
    const vocabToken = localStorage.getItem('linglish_token');
    if (!vocabToken) {
      console.log('[VocabMap] No auth token, skipping vocab map load');
      return;
    }

    console.log('[VocabMap] Starting to load vocabulary...');
    const response = await fetch(`${API_BASE}/vocab?limit=10000`, {
      headers: { Authorization: `Bearer ${vocabToken}` }
    });

    if (response.ok) {
      const data = await response.json();
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
      console.warn('[VocabMap] Failed to load, status:', response.status);
    }
  } catch (err) {
    console.warn('[VocabMap] Failed to load:', err);
  }
}

async function loadVocabulary(filter = null) {
  console.log('[Vocab Load] ========== START ==========');
  console.log('[Vocab Load] Filter parameter:', filter);
  console.log('[Vocab Load] Current filter before:', currentVocabFilter);

  try {
    if (filter) {
      currentVocabFilter = filter;
      console.log('[Vocab Load] Updated filter to:', currentVocabFilter);
    }

    const vocabToken = localStorage.getItem('linglish_token');
    console.log('[Vocab Load] Token exists:', !!vocabToken);
    if (!vocabToken) {
      console.log('[Vocab Load] No auth token, skipping vocabulary load');
      return;
    }

    // 如果是首次加载或者切换到'all'，加载所有词汇用于统计
    if (allVocabularyCache.length === 0 || currentVocabFilter === 'all') {
      console.log('[Vocab Load] Loading ALL vocabulary for stats...');
      const allParams = new URLSearchParams();
      allParams.append('limit', '10000');
      const allUrl = `${API_BASE}/vocab?${allParams}`;
      console.log('[Vocab Load] Request path:', '/vocab');

      const allResponse = await fetch(allUrl, {
        headers: { Authorization: `Bearer ${vocabToken}` }
      });

      if (allResponse.ok) {
        const allData = await allResponse.json();
        allVocabularyCache = allData.items || [];
        console.log('[Vocab Load] ✓ Loaded ALL vocabulary for stats:', allVocabularyCache.length, 'items');
      }
    }

    // 加载筛选后的词汇
    const queryParams = new URLSearchParams();
    if (currentVocabFilter !== 'all') {
      queryParams.append('state', currentVocabFilter);
      console.log('[Vocab Load] Adding state filter:', currentVocabFilter);
    }
    queryParams.append('limit', '10000');

    const url = `${API_BASE}/vocab?${queryParams}`;
    console.log('[Vocab Load] Request path:', '/vocab');

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${vocabToken}` }
    });

    console.log('[Vocab Load] Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Vocab Load] ✗ Error response:', errorText);
      throw new Error('Failed to load vocabulary');
    }

    const data = await response.json();
    console.log('[Vocab Load] ✓ Received filtered data:', (data.items && data.items.length), 'items');

    // 显示前3个词的状态用于验证
    if (data.items && data.items.length > 0) {
      console.log('[Vocab Load] Sample items:');
      data.items.slice(0, 3).forEach(item => {
        console.log(`  - ${item.lemma}: state="${item.state}"`);
      });
    }

    vocabularyCache = data.items || [];

    console.log('[Vocab Load] Calling renderVocabulary with', vocabularyCache.length, 'items');
    renderVocabulary(vocabularyCache);

    console.log('[Vocab Load] Calling updateVocabularyStats');
    updateVocabularyStats();

    console.log('[Vocab Load] ========== END ==========');
  } catch (error) {
    console.error('[Vocab Load] ✗ Failed to load vocabulary:', error);
    const msgL = (typeof i18n !== 'undefined' && i18n && i18n.t) ? (i18n.t('vocab.load_error') || 'Load failed') : 'Load failed';
    showToast(msgL, 'warn');
  }
}

function renderVocabulary(items) {
  const vocabularyList = document.getElementById('vocabulary-list');
  const vocabularyEmpty = document.getElementById('vocabulary-empty');

  console.log('[Vocab Render] Rendering', (items && items.length), 'items');
  console.log('[Vocab Render] vocabularyList:', vocabularyList);
  console.log('[Vocab Render] vocabularyEmpty:', vocabularyEmpty);

  if (!vocabularyList) {
    console.error('[Vocab Render] vocabulary-list element not found!');
    return;
  }

  if (!items || items.length === 0) {
    console.log('[Vocab Render] No items, showing empty message');

    if (vocabularyEmpty) {
      vocabularyEmpty.style.display = 'block';
    }

    // 清空列表，只显示空提示
    vocabularyList.innerHTML = `
            <div class="vocabulary-empty" style="display: block;">
              <p>当前筛选条件下没有词汇</p>
              <p style="font-size: 0.9rem; color: #666;">尝试切换其他筛选条件</p>
            </div>
          `;
    return;
  }

  console.log('[Vocab Render] Has items, hiding empty message');
  if (vocabularyEmpty) {
    vocabularyEmpty.style.display = 'none';
  }

  vocabularyList.innerHTML = items.map(item => {
    const stateClass = `vocab-state-${item.state || 'encountered'}`;
    const stateName = item.state || 'encountered';

    // 直接使用数据库中的翻译，不再重新获取
    // 如果翻译是占位符（[待翻译]），也显示刷新按钮
    const needsRefresh = !item.translation ||
      item.translation.startsWith('[待翻译]') ||
      item.translation.startsWith('[译]');

    // 翻译文本（不包含按钮）
    const displayText = needsRefresh
      ? (item.translation || '暂无翻译')
      : item.translation;

    const translationStyle = needsRefresh
      ? 'color: #999; font-style: italic;'
      : '';

    // 操作按钮（放在右侧）
    const actionButtons = needsRefresh
      ? `
              <button class="vocab-pronunciation-btn" onclick="playPronunciation('${item.lemma}')" title="播放发音">
                🔊
              </button>
              <button class="vocab-refresh-btn" onclick="refreshTranslation('${item.lemma}')" title="点击获取翻译">
                🔄
              </button>
              <button class="vocab-delete-btn" onclick="deleteVocab('${item.lemma}')" title="删除此词">
                🗑️
              </button>`
      : `
              <button class="vocab-pronunciation-btn" onclick="playPronunciation('${item.lemma}')" title="播放发音">
                🔊
              </button>
              <button class="vocab-edit-btn" onclick="editTranslation('${item.lemma}')" title="编辑翻译">
                ✏️
              </button>
              <button class="vocab-delete-btn" onclick="deleteVocab('${item.lemma}')" title="删除此词">
                🗑️
              </button>`;

    return `
            <div class="vocab-item" data-lemma="${item.lemma}">
              <div class="vocab-word-section">
                <div class="vocab-word">${item.lemma}</div>
                <div class="vocab-translation" id="translation-${item.lemma}" style="${translationStyle}">
                  ${displayText}
                </div>
              </div>
              <div class="vocab-actions">
                ${actionButtons}
              </div>
            </div>
          `;
  }).join('');
}

// 手动刷新单个词汇的翻译
async function refreshTranslation(lemma) {
  const vocabToken = localStorage.getItem('linglish_token');
  if (!vocabToken) return;

  const translationEl = document.getElementById(`translation-${lemma}`);
  const vocabItem = translationEl && translationEl.closest('.vocab-item');
  const actionsEl = vocabItem && vocabItem.querySelector('.vocab-actions');

  if (!translationEl || !actionsEl) return;

  try {
    // 显示加载状态
    translationEl.textContent = '刷新中...';
    translationEl.style.color = '#999';
    translationEl.style.fontStyle = 'italic';

    // 获取新翻译（从统一的 dictionary API）
    const response = await fetch(`${API_BASE}/dictionary/${encodeURIComponent(lemma)}`, {
      headers: { Authorization: `Bearer ${vocabToken}` }
    });

    if (!response.ok) {
      throw new Error('翻译获取失败');
    }

    const data = await response.json();
    const newTranslation = data.zh;

    // 保存到数据库
    const updateResponse = await fetch(`${API_BASE}/vocab/translation`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${vocabToken}`
      },
      body: JSON.stringify({
        lemma: lemma,
        translation: newTranslation
      })
    });

    if (!updateResponse.ok) {
      throw new Error('保存翻译失败');
    }

    // 更新显示
    const needsRefresh = newTranslation.startsWith('[待翻译]') || newTranslation.startsWith('[译]');

    translationEl.textContent = newTranslation;
    if (needsRefresh) {
      translationEl.style.color = '#999';
      translationEl.style.fontStyle = 'italic';
      actionsEl.innerHTML = `
              <button class="vocab-pronunciation-btn" onclick="playPronunciation('${lemma}')" title="播放发音">
                🔊
              </button>
              <button class="vocab-refresh-btn" onclick="refreshTranslation('${lemma}')" title="点击获取翻译">
                🔄
              </button>
              <button class="vocab-delete-btn" onclick="deleteVocab('${lemma}')" title="删除此词">
                🗑️
              </button>`;
    } else {
      translationEl.style.color = '';
      translationEl.style.fontStyle = '';
      actionsEl.innerHTML = `
              <button class="vocab-pronunciation-btn" onclick="playPronunciation('${lemma}')" title="播放发音">
                🔊
              </button>
              <button class="vocab-edit-btn" onclick="editTranslation('${lemma}')" title="编辑翻译">
                ✏️
              </button>
              <button class="vocab-delete-btn" onclick="deleteVocab('${lemma}')" title="删除此词">
                🗑️
              </button>`;
    }

    const msgU = (typeof i18n !== 'undefined' && i18n && i18n.t) ? (i18n.t('feedback.updated') || '已更新') : '已更新';
    showToast(msgU, 'success');
    try { if (window.Feedback) Feedback.playSfx('success'); } catch (_) { }

    // 更新缓存
    const itemInCache = vocabularyCache.find(item => item.lemma === lemma);
    if (itemInCache) {
      itemInCache.translation = newTranslation;
    }
  } catch (error) {
    console.error(`Failed to refresh translation for ${lemma}:`, error);
    translationEl.textContent = '刷新失败';
    translationEl.style.color = '#f44336';
    translationEl.style.fontStyle = 'italic';
    const msgRU = (typeof i18n !== 'undefined' && i18n && i18n.t) ? (i18n.t('vocab.load_error') || '加载失败') : '加载失败';
    showToast(msgRU, 'warn');
  }
}

// 手动编辑翻译
async function editTranslation(lemma, currentTranslation) {
  const translationEl = document.getElementById(`translation-${lemma}`);

  // 如果没有传递 currentTranslation，从 DOM 中读取
  if (!currentTranslation) {
    currentTranslation = (translationEl && translationEl.textContent && translationEl.textContent.trim()) || '';
  }

  const newTranslation = prompt(`编辑"${lemma}"的翻译：`, currentTranslation);
  if (!newTranslation || newTranslation === currentTranslation) {
    return; // 用户取消或未修改
  }

  const vocabToken = localStorage.getItem('linglish_token');
  if (!vocabToken) return;

  const vocabItem = translationEl && translationEl.closest('.vocab-item');
  const actionsEl = vocabItem && vocabItem.querySelector('.vocab-actions');

  if (!translationEl || !actionsEl) return;

  try {
    // 显示保存状态
    translationEl.textContent = '保存中...';
    translationEl.style.color = '#999';
    translationEl.style.fontStyle = 'italic';

    // 保存到数据库
    const updateResponse = await fetch(`${API_BASE}/vocab/translation`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${vocabToken}`
      },
      body: JSON.stringify({
        lemma: lemma,
        translation: newTranslation.trim()
      })
    });

    console.log('[Save Translation] Response status:', updateResponse.status);

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      console.error('[Save Translation] Error response:', errorText);
      throw new Error('保存翻译失败');
    }

    // 解析响应
    let responseData;
    try {
      responseData = await updateResponse.json();
      console.log('[Save Translation] Response received:', Boolean(responseData));
    } catch (jsonError) {
      console.error('[Save Translation] JSON parse error:', jsonError);
      // JSON 解析失败，但请求成功了，继续更新界面
    }

    // 更新显示
    console.log('[Save Translation] Updating UI...');

    // 重新获取元素，确保它们仍然存在
    const freshTranslationEl = document.getElementById(`translation-${lemma}`);
    const freshVocabItem = freshTranslationEl && freshTranslationEl.closest('.vocab-item');
    const freshActionsEl = freshVocabItem && freshVocabItem.querySelector('.vocab-actions');

    console.log('[Save Translation] Elements check:', {
      freshTranslationEl: !!freshTranslationEl,
      freshVocabItem: !!freshVocabItem,
      freshActionsEl: !!freshActionsEl
    });

    if (!freshTranslationEl || !freshActionsEl) {
      console.warn('[Save Translation] Elements not found after save, but data was saved successfully');
      showToast('翻译已保存');
      return;
    }

    freshTranslationEl.textContent = newTranslation.trim();
    freshTranslationEl.style.color = '';
    freshTranslationEl.style.fontStyle = '';

    // 不要在 onclick 中传递 translation，避免特殊字符问题
    console.log('[Save Translation] Setting innerHTML for lemma:', lemma);
    try {
      freshActionsEl.innerHTML = `
              <button class="vocab-pronunciation-btn" onclick="playPronunciation('${lemma}')" title="播放发音">
                🔊
              </button>
              <button class="vocab-edit-btn" onclick="editTranslation('${lemma}')" title="编辑翻译">
                ✏️
              </button>
              <button class="vocab-delete-btn" onclick="deleteVocab('${lemma}')" title="删除此词">
                🗑️
              </button>`;
      console.log('[Save Translation] innerHTML set successfully');
    } catch (htmlError) {
      console.error('[Save Translation] innerHTML error:', htmlError);
      throw htmlError;
    }

    const msgS = (typeof i18n !== 'undefined' && i18n && i18n.t) ? (i18n.t('feedback.saved') || '已保存') : '已保存';
    showToast(msgS, 'success');
    try { if (window.Feedback) Feedback.playSfx('success'); } catch (_) { }

    // 更新缓存
    try {
      const itemInCache = vocabularyCache.find(item => item.lemma === lemma);
      if (itemInCache) {
        itemInCache.translation = newTranslation.trim();
      }
      console.log('[Save Translation] Cache updated');
    } catch (cacheError) {
      console.error('[Save Translation] Cache update error:', cacheError);
      // 缓存更新失败不影响主流程
    }

    console.log('[Save Translation] All done successfully');
  } catch (error) {
    console.error(`[Save Translation] Failed for ${lemma}:`, error);
    translationEl.textContent = '保存失败';
    translationEl.style.color = '#f44336';
    translationEl.style.fontStyle = 'italic';
    const msgRS = (typeof i18n !== 'undefined' && i18n && i18n.t) ? (i18n.t('vocab.save_error') || '保存失败') : '保存失败';
    showToast(msgRS, 'warn');
  }
}

// 显示提示消息（优先使用 feedback.js）
function showToast(message, type = 'info') {
  if (window.Feedback) { Feedback.showToast(type, message); return; }
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => { toast.classList.remove('show'); }, 3000);
}

// 删除词汇项
async function deleteVocab(lemma) {
  if (!confirm(`确定要删除"${lemma}"吗？\n\n此操作不可恢复。`)) {
    return;
  }

  const vocabToken = localStorage.getItem('linglish_token');
  if (!vocabToken) return;

  try {
    const response = await fetch(`${API_BASE}/vocab/${encodeURIComponent(lemma)}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${vocabToken}`
      }
    });

    if (!response.ok) {
      throw new Error('删除失败');
    }

    // 从缓存中移除
    const index = vocabularyCache.findIndex(item => item.lemma === lemma);
    if (index > -1) {
      vocabularyCache.splice(index, 1);
    }

    // 重新渲染列表
    renderVocabulary(vocabularyCache);
    updateVocabularyStats();
    const msgD = (typeof i18n !== 'undefined' && i18n && i18n.t) ? (i18n.t('vocab.delete_word_success') || 'Deleted') : 'Deleted';
    showToast(msgD, 'success');
    try { if (window.Feedback) Feedback.playSfx('success'); } catch (_) { }

    console.log(`[Vocab] Deleted: ${lemma}`);
  } catch (error) {
    console.error(`Failed to delete vocab ${lemma}:`, error);
    showToast('删除失败');
  }
}

async function playPronunciation(word) {
  try {
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = (window.LinglishTtsVoice && LinglishTtsVoice.synthesisLang) ? LinglishTtsVoice.synthesisLang() : 'en-US';
    const systemVoice = (window.LinglishTtsVoice && LinglishTtsVoice.findSystemVoice)
      ? LinglishTtsVoice.findSystemVoice(window.speechSynthesis.getVoices())
      : null;
    if (systemVoice) utterance.voice = systemVoice;
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
    // metrics: pronounce interaction
    metrics.logInteraction('pronounce', word, {});
  } catch (error) {
    console.error('Failed to play pronunciation:', error);
  }
}

function updateVocabularyStats() {
  // 使用所有词汇来计算统计数据，而不是筛选后的
  const statsData = allVocabularyCache.length > 0 ? allVocabularyCache : vocabularyCache;

  const total = statsData.length;
  const newCount = statsData.filter(i => i.state === 'encountered').length;
  const learningCount = statsData.filter(i => i.state === 'learning').length;
  const reviewingCount = statsData.filter(i => i.state === 'reviewing').length;
  const masteredCount = statsData.filter(i => i.state === 'mastered').length;

  console.log('[Vocab Stats] Total:', total, 'New:', newCount, 'Learning:', learningCount, 'Reviewing:', reviewingCount, 'Mastered:', masteredCount);

  document.getElementById('vocab-total-count').textContent = total;
  document.getElementById('vocab-new-count').textContent = newCount;
  document.getElementById('vocab-learning-count').textContent = learningCount;
  // Mastered显示reviewing + mastered的总和
  document.getElementById('vocab-mastered-count').textContent = reviewingCount + masteredCount;
}

// 词汇过滤器事件监听 - 使用事件委托确保能正确捕获点击
let vocabFiltersInitialized = false;

function initVocabFilters() {
  // 防止重复初始化
  if (vocabFiltersInitialized) {
    console.log('[Vocab Filters] Already initialized, skipping');
    return;
  }

  const statItems = document.querySelectorAll('.vocab-stat-item');
  console.log('[Vocab Filters] Found', statItems.length, 'stat items');

  if (statItems.length === 0) {
    console.warn('[Vocab Filters] No stat items found!');
    return;
  }

  statItems.forEach(item => {
    item.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      const filter = item.dataset.filter;
      console.log('[Vocab Filters] Stat item clicked:', filter);

      // 移除所有active类
      statItems.forEach(i => i.classList.remove('active'));
      // 添加active类到当前卡片
      item.classList.add('active');

      loadVocabulary(filter);
    });
  });

  vocabFiltersInitialized = true;
  console.log('[Vocab Filters] Initialization complete');
}

// 初始化筛选器（在DOM加载后）
setTimeout(() => {
  initVocabFilters();
  console.log('[Vocab Filters] Initialized');
}, 100);

// 上传表单折叠/展开功能
const uploadToggleBtn = document.getElementById('upload-toggle-btn');
const videoUpload = document.getElementById('video-upload');

if (uploadToggleBtn && videoUpload) {
  uploadToggleBtn.addEventListener('click', function () {
    const isCollapsed = videoUpload.classList.contains('collapsed');

    if (isCollapsed) {
      videoUpload.classList.remove('collapsed');
      uploadToggleBtn.classList.add('expanded');
    } else {
      videoUpload.classList.add('collapsed');
      uploadToggleBtn.classList.remove('expanded');
    }
  });
}

// 底部导航栏功能
const navItems = document.querySelectorAll('.nav-item');

navItems.forEach(item => {
  item.addEventListener('click', function (e) {
    e.preventDefault();
    const tab = item.dataset.tab;

    if (tab === 'practice') {
      const videoId = state.selectedVideoId || audioModeManager.currentVideoId;
      if (videoId) {
        const targetUrl = `/practice-session.html?videoId=${encodeURIComponent(videoId)}`;
        window.location.href = targetUrl;
        return;
      }
    }

    // 更新激活状态
    navItems.forEach(nav => nav.classList.remove('active'));
    item.classList.add('active');

    // 根据选择的标签切换视图
    switch (tab) {
      case 'library':
        // 显示视频库（左侧边栏）
        if (videoSidebar) {
          videoSidebar.classList.remove('hidden');
          if (toggleSidebarBtn) {
            toggleSidebarBtn.textContent = '✕';
          }
        }
        // 隐藏右侧边栏
        if (rightSidebar && window.innerWidth <= 768) {
          rightSidebar.classList.remove('visible');
          rightSidebar.classList.remove('dict-open');
        }
        // 隐藏词汇视图
        const vocabView = document.getElementById('vocabulary-view');
        if (vocabView) {
          vocabView.style.display = 'none';
        }
        break;

      case 'vocabulary':
        // 显示词汇视图
        const vocabularyView = document.getElementById('vocabulary-view');
        if (vocabularyView) {
          vocabularyView.style.display = 'block';
          // 重新初始化筛选器按钮事件
          initVocabFilters();
          loadVocabulary();
        }
        // 隐藏右侧边栏和视频库
        if (rightSidebar && window.innerWidth <= 768) {
          rightSidebar.classList.remove('visible');
          rightSidebar.classList.remove('dict-open');
        }
        if (videoSidebar && window.innerWidth <= 768) {
          videoSidebar.classList.add('hidden');
        }
        break;

      case 'practice':
        // 没有 videoId 时仍 fallback 为原逻辑
        showPracticeSectionRight();
        if (rightSidebar) {
          if (window.innerWidth <= 768) {
            rightSidebar.classList.add('visible');
          } else {
            rightSidebar.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
        if (videoSidebar && window.innerWidth <= 768) {
          videoSidebar.classList.add('hidden');
        }
        break;

      case 'more':
        alert('更多功能开发中...');
        if (rightSidebar && window.innerWidth <= 768) {
          rightSidebar.classList.remove('visible');
          rightSidebar.classList.remove('dict-open');
        }
        break;
    }
  });
});

// 返回视频按钮功能
const backToVideoBtn = document.getElementById('back-to-video-btn');
if (backToVideoBtn) {
  backToVideoBtn.addEventListener('click', function () {
    // 隐藏词汇视图
    const vocabularyView = document.getElementById('vocabulary-view');
    if (vocabularyView) {
      vocabularyView.style.display = 'none';
    }

    // 显示视频库
    if (videoSidebar) {
      videoSidebar.classList.remove('hidden');
      if (toggleSidebarBtn) {
        toggleSidebarBtn.textContent = '✕';
      }
    }

    // 隐藏右侧边栏（移动端）
    if (rightSidebar && window.innerWidth <= 768) {
      rightSidebar.classList.remove('visible');
      rightSidebar.classList.remove('dict-open');
    }
  });
}

// 词汇表按钮功能（桌面端）
const showVocabularyBtn = document.getElementById('show-vocabulary-btn');
if (showVocabularyBtn) {
  showVocabularyBtn.addEventListener('click', function () {
    // 显示词汇视图
    const vocabularyView = document.getElementById('vocabulary-view');
    if (vocabularyView) {
      vocabularyView.style.display = 'block';
      // 重新初始化筛选器按钮事件
      initVocabFilters();
      loadVocabulary();
    }

    // 隐藏视频库（移动端）
    if (videoSidebar && window.innerWidth <= 768) {
      videoSidebar.classList.add('hidden');
    }

    // 隐藏右侧边栏（移动端）
    if (rightSidebar && window.innerWidth <= 768) {
      rightSidebar.classList.remove('visible');
      rightSidebar.classList.remove('dict-open');
    }
  });
}

// 会员面板折叠/展开功能
const membershipExpandBtn = document.getElementById('membership-expand-btn');
const membershipPanel = document.getElementById('membership-panel');

if (membershipExpandBtn && membershipPanel) {
  membershipExpandBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    membershipPanel.classList.toggle('collapsed');
  });
}

window.addEventListener('resize', function () {
  updateMobileNavButtons(mobileSegmentPosition);
  renderMobileTranscriptWindow(mobileSegmentPosition);
});

// Initialize
initializeStats();
loadTagsFromLocalStorage();
loadUser(); // Load user info for ownership checks

// 先加载词汇Map，然后再加载视频，确保字幕渲染时可以应用颜色
(async function () {
  await loadVocabMap(); // 加载词汇状态用于字幕颜色标记
  loadVideos(); // 加载视频列表
})();

refreshReviewQueue();
