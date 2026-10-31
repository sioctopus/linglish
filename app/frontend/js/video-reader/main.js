const API_BASE = (() => {
  try {
    if (typeof window !== 'undefined' && typeof window.LINGLISH_API_BASE === 'string' && window.LINGLISH_API_BASE) {
      return window.LINGLISH_API_BASE;
    }
    const { protocol, hostname, port } = window.location;
    if (protocol === 'file:') return 'http://localhost:4000';
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      if (port === '4000' || port === '8000' || !port) return '';
      return `${protocol}//${hostname}:4000`;
    }
  } catch (_) {}
  return '';
})();
try { if (typeof window !== 'undefined') window.API_BASE = API_BASE; } catch (_) {}
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

const LAST_STUDY_MEDIA_KEY = 'linglish.last_study_media.v1';
let pendingResumeSeek = null; // { videoId, startSec }

// 解析 URL 参数中的 videoId（数字库内视频 / yt:… / yt=…）
const initialVideoIdFromURL = (function () {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const raw = String(params.get('videoId') || '').trim();
    if (raw) return raw;
    const yt = String(params.get('yt') || '').trim();
    if (/^[\w-]{6,}$/.test(yt)) return `yt:${yt}`;
    return null;
  } catch (_) {
    return null;
  }
})();

function readLastStudyMedia() {
  try {
    const raw = localStorage.getItem(LAST_STUDY_MEDIA_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return data && data.id != null ? data : null;
  } catch (_) {
    return null;
  }
}

function writeLastStudyMedia(snapshot) {
  if (!snapshot || snapshot.id == null || snapshot.id === '') return;
  try {
    localStorage.setItem(LAST_STUDY_MEDIA_KEY, JSON.stringify(snapshot));
  } catch (_) {}
  if (/^\d+$/.test(String(snapshot.id))) {
    try { localStorage.setItem('last_video_id', String(snapshot.id)); } catch (_) {}
  }
}

function mediaSnapshotFromVideo(video, extras) {
  if (!video || video.id == null) return null;
  const extra = extras && typeof extras === 'object' ? extras : {};
  return {
    id: String(video.id),
    title: video.title || video.original_filename || '',
    youtube_video_id: video.youtube_video_id || '',
    audioUrl: video.audioUrl || '',
    transcriptUrl: video.transcriptUrl || '',
    external_podcast: Boolean(video.external_podcast),
    external_youtube: Boolean(video.external_youtube || video.youtube_video_id),
    thumbnail_path: video.thumbnail_path || '',
    collection_name: video.collection_name || '',
    seconds: Number.isFinite(Number(extra.seconds)) ? Math.max(0, Math.round(Number(extra.seconds))) : 0,
    percent: Number.isFinite(Number(extra.percent)) ? Math.max(0, Math.min(100, Math.round(Number(extra.percent)))) : 0,
    updatedAt: Date.now(),
  };
}

function videoFromMediaSnapshot(snap) {
  if (!snap || snap.id == null) return null;
  const id = String(snap.id);
  const ytFromId = (id.match(/^yt:([\w-]{6,})$/) || [])[1] || '';
  const youtubeId = snap.youtube_video_id || ytFromId;
  if (snap.external_podcast || snap.audioUrl) {
    return {
      id,
      title: snap.title || '播客',
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
      id: id.startsWith('yt:') ? id : `yt:${youtubeId}`,
      title: snap.title || `YouTube ${youtubeId}`,
      youtube_video_id: youtubeId,
      external_youtube: true,
      thumbnail_path: snap.thumbnail_path || `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
      collection_name: snap.collection_name || '',
      status: 'ready',
      duration_sec: 0,
    };
  }
  if (/^\d+$/.test(id)) {
    return {
      id: Number(id) || id,
      title: snap.title || '',
      thumbnail_path: snap.thumbnail_path || '',
      status: 'ready',
    };
  }
  return null;
}

function syncStudyVideoUrl(video) {
  if (!video || video.id == null) return;
  try {
    const url = new URL(window.location.href);
    const id = String(video.id);
    url.searchParams.set('videoId', id);
    if (video.youtube_video_id) url.searchParams.set('yt', String(video.youtube_video_id));
    else url.searchParams.delete('yt');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  } catch (_) {}
}

function rememberStudySelection(video) {
  const snap = mediaSnapshotFromVideo(video);
  if (!snap) return;
  const prev = readLastStudyMedia();
  if (prev && String(prev.id) === String(snap.id)) {
    snap.seconds = Number(prev.seconds) || 0;
    snap.percent = Number(prev.percent) || 0;
  }
  writeLastStudyMedia(snap);
  if (window.LinglishStudyRecent) {
    window.LinglishStudyRecent.record({
      id: snap.id,
      title: snap.title,
      thumb: snap.thumbnail_path,
      seconds: snap.seconds,
      percent: snap.percent,
    });
  }
  syncStudyVideoUrl(video);
}

function rememberPlaybackProgress(seconds, duration) {
  if (!state.selectedVideoId) return;
  const sec = Math.max(0, Math.round(Number(seconds) || 0));
  if (sec < 1) return;
  const dur = Number(duration) || 0;
  const percent = dur > 0 ? Math.min(100, Math.max(0, Math.round((sec / dur) * 100))) : 0;
  try {
    const snap = readLastStudyMedia() || { id: String(state.selectedVideoId) };
    if (String(snap.id) !== String(state.selectedVideoId)) return;
    snap.seconds = sec;
    if (percent) snap.percent = percent;
    snap.updatedAt = Date.now();
    writeLastStudyMedia(snap);
  } catch (_) {}
  if (window.LinglishStudyRecent) {
    window.LinglishStudyRecent.touch(state.selectedVideoId, { seconds: sec, percent: percent || undefined });
  }
}

function applyPendingResumeSeek() {
  if (!pendingResumeSeek) return false;
  if (String(pendingResumeSeek.videoId) !== String(state.selectedVideoId)) return false;
  const startSec = Number(pendingResumeSeek.startSec);
  if (!Number.isFinite(startSec) || startSec < 1) {
    pendingResumeSeek = null;
    return false;
  }
  pendingResumeSeek = null;
  try {
    if (youtubePlayer && typeof youtubePlayer.seekTo === 'function') {
      youtubePlayer.seekTo(startSec, true);
      return true;
    }
  } catch (_) {}
  try {
    if (videoPlayer) {
      videoPlayer.currentTime = startSec;
      return true;
    }
  } catch (_) {}
  return false;
}

async function fetchLibraryVideoById(id) {
  if (!/^\d+$/.test(String(id))) return null;
  try {
    const res = await fetch(`${API_BASE}/video-resources/${id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return (data && data.video) || data || null;
  } catch (_) {
    return null;
  }
}

async function resolveResumeTarget() {
  const candidates = [];
  if (initialVideoIdFromURL) candidates.push({ id: initialVideoIdFromURL, seconds: 0, source: 'url' });
  const lastMedia = readLastStudyMedia();
  if (lastMedia) candidates.push({ ...lastMedia, source: 'media' });
  try {
    const recent = window.LinglishStudyRecent && window.LinglishStudyRecent.latest();
    if (recent) candidates.push({ ...recent, source: 'recent' });
  } catch (_) {}
  try {
    const lastId = localStorage.getItem('last_video_id');
    if (lastId) candidates.push({ id: lastId, seconds: 0, source: 'legacy' });
  } catch (_) {}

  for (const entry of candidates) {
    if (!entry || entry.id == null || entry.id === '') continue;
    const id = String(entry.id);
    let video = state.videos.find((item) => String(item.id) === id);
    if (!video && /^\d+$/.test(id)) {
      const full = await fetchLibraryVideoById(id);
      if (full && full.id != null) {
        if (!state.videos.some((item) => String(item.id) === String(full.id))) {
          state.videos = [full, ...state.videos];
        }
        video = full;
      }
    }
    if (!video) {
      video = videoFromMediaSnapshot(entry);
      if (video && !state.videos.some((item) => String(item.id) === String(video.id))) {
        state.videos = [video, ...state.videos];
      }
    }
    if (!video) continue;
    const seconds = Number(entry.seconds) > 1 ? Number(entry.seconds) : 0;
    return { video, seconds, source: entry.source || 'unknown' };
  }
  return null;
}

async function restoreStudyVideoOnBoot() {
  if (state.selectedVideoId) return false;
  const target = await resolveResumeTarget();
  if (!target || !target.video) return false;
  if (target.seconds > 1) {
    pendingResumeSeek = { videoId: target.video.id, startSec: target.seconds };
  }
  await selectVideo(target.video);
  return true;
}

window.resumeLastStudyVideo = function resumeLastStudyVideo() {
  return restoreStudyVideoOnBoot();
};

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
  rawSegments: [],
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
  lastRecordingUrl: null,
  lastRecordingSegmentIndex: null,
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

function isMobileReaderFocus() {
  return document.body.classList.contains('video-reader-mobile-focus');
}

function hidePlayOverlay() {
  const overlay = document.getElementById('play-overlay');
  if (!overlay) return;
  overlay.hidden = true;
  overlay.style.display = 'none';
}

function hideYtEmbedFallback() {
  const box = document.getElementById('yt-embed-fallback');
  if (box) box.hidden = true;
}

function showYtEmbedFallback(youtubeVideoId) {
  const box = document.getElementById('yt-embed-fallback');
  if (!box) return;
  const id = String(youtubeVideoId || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    hideYtEmbedFallback();
    return;
  }
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  const appUrl = `vnd.youtube://${id}`;
  box.innerHTML = [
    '<p class="yt-embed-fallback__text">当前环境播不了 YouTube 内嵌。<strong>可改用 App 打开</strong>，字幕仍可在本页看。</p>',
    '<div class="yt-embed-fallback__actions">',
    `<a class="yt-embed-fallback__btn" href="${appUrl}" rel="noopener">打开 YouTube</a>`,
    `<a class="yt-embed-fallback__btn yt-embed-fallback__btn--ghost" href="${watchUrl}" target="_blank" rel="noopener">网页打开</a>`,
    '<button type="button" class="yt-embed-fallback__btn yt-embed-fallback__btn--ghost" id="yt-fallback-dismiss">关闭</button>',
    '</div>',
  ].join('');
  box.hidden = false;
  const dismiss = box.querySelector('#yt-fallback-dismiss');
  if (dismiss) dismiss.addEventListener('click', hideYtEmbedFallback, { once: true });
}

(function wireYtEmbedFallback() {
  hideYtEmbedFallback();
})();

function configureMobileFocusVideoChrome() {
  if (!isMobileReaderFocus()) return;
  hidePlayOverlay();
  if (videoPlayer) {
    // Timeline stays on the video; bottom dock keeps play / pause / next.
    videoPlayer.setAttribute('controls', '');
    videoPlayer.setAttribute('controlslist', 'nodownload noremoteplayback noplaybackrate');
    videoPlayer.setAttribute('playsinline', '');
    videoPlayer.setAttribute('webkit-playsinline', '');
  }
}

function playMicReadyCue() {
  try {
    if (window.LinglishAudioCues && typeof window.LinglishAudioCues.playMicReadyCue === 'function') {
      window.LinglishAudioCues.playMicReadyCue();
    }
  } catch (_) {}
}

configureMobileFocusVideoChrome();

// 添加视频错误处理
if (videoPlayer) {
  videoPlayer.addEventListener('error', function (e) {
    console.error('Video error:', e);
    const error = videoPlayer.error;
    const isPod = document.getElementById('video-wrapper')
      && document.getElementById('video-wrapper').classList.contains('is-podcast');
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
      if (isPod) {
        showPodcastPlaybackError(
          error.code === error.MEDIA_ERR_NETWORK
            ? '网络读不到这集音频，换一集或稍后再试'
            : '这集音频格式暂时不支持，换一集试试'
        );
      }
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
    hidePlayOverlay();
    startWatchTimer();
    firstLessonLifecycle.playback({ video_resource_id: state.selectedVideoId });
  });

  videoPlayer.addEventListener('pause', function () {
    // Never flash a play/pause icon over the video surface.
    hidePlayOverlay();
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

// 播放overlay点击事件（桌面/旧版移动端；聚焦阅读模式不使用该层）
const playOverlay = document.getElementById('play-overlay');
if (playOverlay) {
  playOverlay.addEventListener('click', async function () {
    hidePlayOverlay();
    await safePlayVideo();
  });
}

// Tap the video surface to toggle play/pause without any overlay icon.
const videoSurface = document.getElementById('video-wrapper');
if (videoSurface && videoPlayer) {
  videoSurface.addEventListener('click', function (event) {
    if (!isMobileReaderFocus()) return;
    if (event.target.closest('#podcast-faceplate')) {
      event.preventDefault();
      togglePodcastPlaybackFromFaceplate();
      return;
    }
    if (event.target.closest('button, a, input, select, textarea, .speed-control-overlay')) return;
    if (videoPlayer.style.display === 'none') return;
    event.preventDefault();
    if (videoPlayer.paused || videoPlayer.ended) {
      safePlayVideo().finally(() => {
        syncMobilePlayButton();
        syncPodcastFaceplatePlayState();
      });
    } else {
      try { videoPlayer.pause(); } catch (_) {}
      syncMobilePlayButton();
      syncPodcastFaceplatePlayState();
    }
  });
}

const podcastFaceplateEl = document.getElementById('podcast-faceplate');
if (podcastFaceplateEl) {
  podcastFaceplateEl.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    togglePodcastPlaybackFromFaceplate();
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
const mobilePlayBtn = document.getElementById('mobile-play');
const mobileHoldBtn = document.getElementById('mobile-hold');
const mobileContinueBtn = document.getElementById('mobile-continue');
const mobileSpeakHint = document.getElementById('mobile-speak-hint');
const mobileShadowBtn = document.getElementById('mobile-shadow-btn');
const mobileHearMeBtn = document.getElementById('mobile-hear-me-btn');
const mobileBackBtn = document.getElementById('mobile-back-btn');
const mobileViewBtns = document.querySelectorAll('.mobile-view-btn, .mobile-sentence-btn');
const mobilePlayerControls = document.getElementById('mobile-player-controls');
let mobileSegmentPosition = null;
let isMobileProgressDragging = false;
let mobileShadowBusy = false;
let mobilePreviewAudio = null;

function setMobileSpeakHint(text, options) {
  // X-DM voice UX: no coaching toasts / captions under the play dock.
  try {
    if (typeof canUseMobileVoiceChatHold === 'function' && canUseMobileVoiceChatHold()) {
      if (mobileSpeakHint) {
        mobileSpeakHint.textContent = '';
        mobileSpeakHint.hidden = true;
      }
      return;
    }
  } catch (_) {}
  const msg = String(text || '').trim();
  if (mobileSpeakHint) mobileSpeakHint.textContent = msg;
  const forceToast = options && options.toast === true;
  const hidden = Boolean(
    mobileSpeakHint
    && typeof window.getComputedStyle === 'function'
    && window.getComputedStyle(mobileSpeakHint).display === 'none'
  );
  if (msg && (forceToast || hidden) && typeof showToast === 'function') {
    try { showToast(msg, (options && options.kind) || 'info'); } catch (_) {}
  }
}

function rememberLastRecording(blob, segmentIndex) {
  if (!blob) return;
  if (state.lastRecordingUrl) {
    try { URL.revokeObjectURL(state.lastRecordingUrl); } catch (_) {}
  }
  state.lastRecordingBlob = blob;
  state.lastRecordingUrl = URL.createObjectURL(blob);
  state.lastRecordingSegmentIndex = Number.isFinite(segmentIndex) ? segmentIndex : mobileSegmentPosition;
  if (mobileHearMeBtn) mobileHearMeBtn.disabled = false;
  try { syncMobileReviewSheet(); } catch (_) {}
  try {
    const bridge = window.LinglishVoiceChatBridge;
    if (bridge && typeof bridge.persistShadowRecording === 'function') {
      bridge.persistShadowRecording(blob, state.lastRecordingSegmentIndex);
    } else if (window.LinglishShadowRecordingCache && typeof window.LinglishShadowRecordingCache.save === 'function') {
      const videoId = state.currentVideo?.id || state.selectedVideoId || window.LinglishStudyVideoId;
      if (videoId != null) {
        window.LinglishShadowRecordingCache.save({
          videoId,
          segmentIndex: state.lastRecordingSegmentIndex,
          blob,
          mimeType: blob.type || 'audio/webm',
        });
      }
    }
  } catch (_) {}
}
try { window.rememberLastRecording = rememberLastRecording; } catch (_) {}

async function playLastRecordingPreview() {
  if (!state.lastRecordingUrl && !state.lastRecordingBlob) {
    try {
      if (typeof window.resolvePlayableShadowUrl === 'function') {
        const restored = await window.resolvePlayableShadowUrl(state.lastRecordingSegmentIndex);
        if (restored) state.lastRecordingUrl = restored;
      } else if (typeof window.hydrateShadowRecording === 'function') {
        await window.hydrateShadowRecording(state.currentVideo?.id || state.selectedVideoId);
      }
    } catch (_) {}
  }
  if (!state.lastRecordingUrl && !state.lastRecordingBlob) {
    setMobileSpeakHint('先跟读一句，再听自己的声音');
    return false;
  }
  try {
    if (mobilePreviewAudio) {
      mobilePreviewAudio.pause();
      mobilePreviewAudio = null;
    }
  } catch (_) {}
  const url = state.lastRecordingUrl || URL.createObjectURL(state.lastRecordingBlob);
  if (!state.lastRecordingUrl) state.lastRecordingUrl = url;
  const audio = new Audio(url);
  mobilePreviewAudio = audio;
  setMobileSpeakHint('');
  try {
    await audio.play();
    audio.onended = () => {
      if (mobilePreviewAudio === audio) mobilePreviewAudio = null;
    };
    return true;
  } catch (_) {
    setMobileSpeakHint('预听失败，请再试一次');
    return false;
  }
}

function resolveMobileSegmentIndexAtTime(t) {
  const segments = Array.isArray(state.currentSegments) ? state.currentSegments : [];
  if (!segments.length) return -1;
  const time = Number(t) || 0;
  let containing = -1;
  let containingStart = -Infinity;
  let past = -1;
  let pastStart = -Infinity;
  for (let i = 0; i < segments.length; i++) {
    const start = Number(segments[i].start ?? segments[i].start_sec) || 0;
    const endRaw = Number(segments[i].end ?? segments[i].end_sec);
    const end = Number.isFinite(endRaw) && endRaw > start ? endRaw : start + 3;
    if (time >= start - 0.05 && time < end + 0.15 && start >= containingStart) {
      containing = i;
      containingStart = start;
    }
    if (start <= time + 0.1 && start >= pastStart) {
      past = i;
      pastStart = start;
    }
  }
  return containing >= 0 ? containing : past;
}

function getMobileShadowSegment() {
  const segments = Array.isArray(state.currentSegments) ? state.currentSegments : [];
  if (!segments.length) return null;
  let now = 0;
  try {
    const transport = typeof coachingTransport === 'function' ? coachingTransport() : null;
    now = transport && typeof transport.getCurrentTime === 'function'
      ? Number(transport.getCurrentTime()) || 0
      : (videoPlayer ? Number(videoPlayer.currentTime) || 0 : 0);
  } catch (_) {
    now = videoPlayer ? Number(videoPlayer.currentTime) || 0 : 0;
  }
  // 重放 / 跟读：优先播放头所在句（正在讲的这一句），再回退到字幕窗口位置
  let index = resolveMobileSegmentIndexAtTime(now);
  if (index < 0 && Number.isFinite(mobileSegmentPosition)) index = mobileSegmentPosition;
  if (index < 0 && Number.isFinite(lastSegmentIndex) && lastSegmentIndex >= 0) index = lastSegmentIndex;
  if (index < 0) index = 0;
  index = Math.max(0, Math.min(segments.length - 1, index));
  const segment = segments[index];
  if (!segment) return null;
  const start = Number(segment.start ?? segment.start_sec) || 0;
  const endRaw = Number(segment.end ?? segment.end_sec);
  const end = Number.isFinite(endRaw) && endRaw > start ? endRaw : start + 3;
  return {
    index,
    text: String(segment.text || segment.en || '').trim(),
    start,
    end,
  };
}

async function playSegmentBoundsForShadow(segment) {
  if (!segment) return 'missing';
  const transport = typeof coachingTransport === 'function' ? coachingTransport() : null;
  if (!transport && !videoPlayer) return 'missing';

  // Lock the mobile transcript on THIS sentence for the whole shadow take.
  if (Number.isInteger(segment.index)) {
    mobileSegmentPosition = segment.index;
    try { renderMobileTranscriptWindow(segment.index); } catch (_) {}
  }

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) {
        try { window.clearInterval(pollTimer); } catch (_) {}
        pollTimer = 0;
      }
      state.segmentPlaybackCallback = null;
      state.segmentPlaybackEnd = null;
      try { pauseLearningVideoNow(); } catch (_) {}
      try { syncMobilePlayButton(); } catch (_) {}
      if (Number.isInteger(segment.index)) {
        mobileSegmentPosition = segment.index;
        try { renderMobileTranscriptWindow(segment.index); } catch (_) {}
      }
      resolve(result);
    };

    try { pauseLearningVideoNow(); } catch (_) {}

    state.segmentPlaybackEnd = segment.end;
    state.segmentPlaybackCallback = () => finish('ok');

    try {
      if (transport && typeof transport.seek === 'function') {
        transport.seek(Math.max(0, segment.start + 0.01));
        if (typeof transport.play === 'function') transport.play();
        else safePlayVideo();
      } else if (videoPlayer) {
        videoPlayer.currentTime = Math.max(0, segment.start + 0.01);
        safePlayVideo();
      } else {
        finish('missing');
        return;
      }
    } catch (_) {
      finish('missing');
      return;
    }

    const started = Date.now();
    const limit = Math.min(15000, Math.max(2500, (segment.end - segment.start) * 1000 + 1200));
    pollTimer = window.setInterval(() => {
      let now = 0;
      try {
        now = transport && typeof transport.getCurrentTime === 'function'
          ? Number(transport.getCurrentTime()) || 0
          : (videoPlayer ? Number(videoPlayer.currentTime) || 0 : 0);
      } catch (_) {
        now = videoPlayer ? Number(videoPlayer.currentTime) || 0 : 0;
      }
      if (now >= segment.end - 0.05) {
        finish('ok');
        return;
      }
      if (Date.now() - started > limit) finish('timeout');
    }, 80);
  });
}

let mobileShadowStop = null;
let mobileShadowCancel = null;
let mobileShadowAwaitHold = false;
let mobileShadowHoldSegment = null;
let mobileShadowHolding = false;
let mobileShadowHoldWanted = false;
let mobileShadowMicReady = false;
let mobileShadowPressStartedAt = 0;
let mobileShadowRecordStartedAt = 0;
let mobileShadowIgnoreClickUntil = 0;
let mobileShadowDocListenBound = false;
let mobileShadowEndingHold = false;
const MOBILE_SHADOW_MIN_RECORD_MS = 500;
const MOBILE_PLAY_LONGPRESS_MS = 420;
let mobilePlayLongPressTimer = 0;
let mobilePlayLongPressArmed = false;
let mobilePlaySuppressClick = false;
let mobilePlayPointerDown = false;

function syncMobilePlayHoldLabel(text) {
  const label = document.getElementById('mobile-play-hold-label');
  if (!label) return;
  if (text) {
    label.hidden = false;
    label.setAttribute('aria-hidden', 'false');
    label.textContent = text;
  } else {
    label.hidden = true;
    label.setAttribute('aria-hidden', 'true');
    label.textContent = '';
  }
}

function syncMobileHoldButton(active, warming) {
  if (!mobileHoldBtn) return;
  mobileHoldBtn.classList.toggle('is-holding', !!active && !warming);
  mobileHoldBtn.classList.toggle('is-mic-warming', !!warming);
  let label = mobileHoldBtn.querySelector('[data-hold-label]') || mobileHoldBtn.querySelector('.mobile-hold-main');
  if (!label) {
    mobileHoldBtn.textContent = '';
    label = document.createElement('span');
    label.className = 'mobile-hold-main';
    label.setAttribute('data-hold-label', '');
    mobileHoldBtn.appendChild(label);
  }
  let text = 'Hold to record';
  let aria = '按住跟读';
  if (warming) {
    text = 'Opening mic…';
    aria = '开麦中';
  } else if (active) {
    text = 'Release to send';
    aria = '松开结束跟读';
  }
  label.textContent = text;
  mobileHoldBtn.setAttribute('aria-label', aria);
}

function syncMobileShadowButton() {
  // Mic UI is the X-style Hold pill — keep legacy shadow btn inert.
  if (mobileShadowBtn) {
    mobileShadowBtn.classList.remove('is-holding', 'is-await-hold', 'is-mic-warming', 'is-busy');
    mobileShadowBtn.setAttribute('aria-hidden', 'true');
    mobileShadowBtn.tabIndex = -1;
    mobileShadowBtn.disabled = true;
  }
  const micActive = mobileShadowHolding || mobileShadowAwaitHold || mobilePlayLongPressArmed;
  if (mobileShadowHolding) {
    syncMobileHoldButton(true, !mobileShadowMicReady);
    syncMobilePlayHoldLabel(mobileShadowMicReady ? '松开结束' : '开麦中…');
  } else if (mobileShadowAwaitHold || micActive) {
    syncMobileHoldButton(true, true);
    syncMobilePlayHoldLabel('按住说话');
  } else {
    syncMobileHoldButton(false, false);
    syncMobilePlayHoldLabel('');
  }
  if (mobilePlayBtn) {
    mobilePlayBtn.classList.remove('is-holding', 'is-mic-warming', 'is-await-hold');
    try { syncMobilePlayButton(); } catch (_) {}
  }
}

function unbindMobileShadowDocListen() {
  if (!mobileShadowDocListenBound) return;
  mobileShadowDocListenBound = false;
  try {
    document.removeEventListener('touchend', onMobileShadowDocRelease, true);
    document.removeEventListener('touchcancel', onMobileShadowDocRelease, true);
    document.removeEventListener('mouseup', onMobileShadowDocRelease, true);
  } catch (_) {}
}

function bindMobileShadowDocListen() {
  if (mobileShadowDocListenBound) return;
  mobileShadowDocListenBound = true;
  // WeChat-style: release anywhere finishes; don't end just because finger slid off the button.
  document.addEventListener('touchend', onMobileShadowDocRelease, true);
  document.addEventListener('touchcancel', onMobileShadowDocRelease, true);
  document.addEventListener('mouseup', onMobileShadowDocRelease, true);
}

function onMobileShadowDocRelease(event) {
  if (!mobileShadowHolding && !mobileShadowHoldWanted) return;
  if (event && event.type === 'mouseup' && event.button != null && event.button !== 0) return;
  endMobileShadowHoldRecord();
}

function resetMobileShadowUi() {
  unbindMobileShadowDocListen();
  mobileShadowBusy = false;
  mobileShadowStop = null;
  mobileShadowCancel = null;
  mobileShadowAwaitHold = false;
  mobileShadowHoldSegment = null;
  mobileShadowHolding = false;
  mobileShadowHoldWanted = false;
  mobileShadowMicReady = false;
  mobileShadowEndingHold = false;
  mobileShadowPressStartedAt = 0;
  mobileShadowRecordStartedAt = 0;
  mobilePlayLongPressArmed = false;
  clearMobilePlayLongPressTimer();
  syncMobileShadowButton();
}

function clearMobilePlayLongPressTimer() {
  if (mobilePlayLongPressTimer) {
    clearTimeout(mobilePlayLongPressTimer);
    mobilePlayLongPressTimer = 0;
  }
}

function keepAwaitingHold(segment, hint) {
  unbindMobileShadowDocListen();
  mobileShadowBusy = true;
  mobileShadowHolding = false;
  mobileShadowHoldWanted = false;
  mobileShadowMicReady = false;
  mobileShadowEndingHold = false;
  mobileShadowStop = null;
  mobileShadowCancel = null;
  mobileShadowRecordStartedAt = 0;
  mobileShadowAwaitHold = true;
  mobileShadowHoldSegment = segment || mobileShadowHoldSegment;
  syncMobileShadowButton();
  if (hint) setMobileSpeakHint(hint, { toast: true, kind: 'warn' });
}

async function finishMobileShadowCapture(captured) {
  unbindMobileShadowDocListen();
  mobileShadowHolding = false;
  mobileShadowHoldWanted = false;
  mobileShadowMicReady = false;
  mobileShadowEndingHold = false;
  mobileShadowStop = null;
  mobileShadowCancel = null;
  mobileShadowAwaitHold = false;
  mobileShadowHoldSegment = null;
  mobileShadowBusy = false;
  mobileShadowRecordStartedAt = 0;
  syncMobileShadowButton();
  if (!captured || !captured.blob) {
    setMobileSpeakHint('没录上，请再按住说一次', { toast: true, kind: 'warn' });
    return;
  }
  const segmentIndex = Number.isFinite(state.lastRecordingSegmentIndex)
    ? state.lastRecordingSegmentIndex
    : mobileSegmentPosition;
  rememberLastRecording(captured.blob, segmentIndex);
  const previewOk = await playLastRecordingPreview();
  const mic = window.LinglishShadowMic;
  const wechat = mic && typeof mic.isWeChatBrowser === 'function' && mic.isWeChatBrowser();
  setMobileSpeakHint(previewOk
    ? '已预听你的跟读，可再点「听自己」'
    : (wechat
      ? '录音已保存。点「听自己」；仍无声就用 Safari 打开。'
      : '录音已保存，点「听自己」听回放'), { toast: true, kind: previewOk ? 'success' : 'info' });
}

async function beginMobileShadowHoldRecord() {
  if (mobileShadowHolding || !mobileShadowAwaitHold || !mobileShadowHoldSegment) return;
  const mic = window.LinglishShadowMic;
  const segment = mobileShadowHoldSegment;
  if (!mic || typeof mic.recordShadow !== 'function' || typeof mic.acquireMic !== 'function') {
    setMobileSpeakHint('跟读录音组件还没加载', { toast: true, kind: 'warn' });
    return;
  }

  mobileShadowHolding = true;
  mobileShadowHoldWanted = true;
  mobileShadowMicReady = false;
  mobileShadowEndingHold = false;
  mobileShadowPressStartedAt = Date.now();
  mobileShadowRecordStartedAt = 0;
  bindMobileShadowDocListen();
  syncMobileShadowButton();
  setMobileSpeakHint('开麦中，请按住别松…', { toast: true });

  try { pauseLearningVideoNow(); } catch (_) {}
  mobileSegmentPosition = segment.index;
  try { renderMobileTranscriptWindow(segment.index); } catch (_) {}

  // High-sensitivity open: no noise gate, AGC on, Web Audio boost for quiet speech.
  const holdConstraints = typeof mic.sensitiveConstraints === 'function'
    ? mic.sensitiveConstraints()
    : { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true }, video: false };
  const holdGain = typeof mic.defaultBoostGain === 'function' ? mic.defaultBoostGain() : 4;

  let stream = null;
  try {
    stream = await mic.acquireMic({ constraints: holdConstraints });
    if (!mobileShadowHoldWanted) {
      try { mic.stopTracks(stream); } catch (_) {}
      keepAwaitingHold(segment, '开麦时松手了，请再按住说完再松');
      return;
    }
    const captured = await mic.recordShadow({
      stream,
      releaseStream: true,
      boost: true,
      gain: holdGain,
      maxGain: 9,
      maxDurationMs: Math.max(8000, mic.recordingDurationMs(segment)),
      minBytes: 8,
      timeslice: 0,
      onReady(handle) {
        mobileShadowStop = handle && handle.stop;
        mobileShadowCancel = handle && handle.cancel;
        mobileShadowMicReady = true;
        mobileShadowRecordStartedAt = Date.now();
        syncMobileShadowButton();
        if (!mobileShadowHoldWanted) {
          // Finger already up — still keep a brief take if they held through warm-up.
          const pressedMs = Date.now() - (mobileShadowPressStartedAt || 0);
          try {
            if (pressedMs >= MOBILE_SHADOW_MIN_RECORD_MS && typeof handle.stop === 'function') {
              handle.stop();
            } else if (typeof handle.cancel === 'function') {
              handle.cancel();
            } else if (typeof handle.stop === 'function') {
              handle.stop();
            }
          } catch (_) {}
          return;
        }
        setMobileSpeakHint('正在录音…说完再松开', { toast: true });
        try {
          if (window.LinglishAudioCues && typeof window.LinglishAudioCues.playMicReadyCue === 'function') {
            window.LinglishAudioCues.playMicReadyCue();
          }
        } catch (_) {}
      },
    });
    if (!captured || !captured.blob) {
      keepAwaitingHold(segment, '没录上，请按住说完再松开');
      return;
    }
    state.lastRecordingSegmentIndex = segment.index;
    await finishMobileShadowCapture(captured);
  } catch (error) {
    try { if (stream) mic.stopTracks(stream); } catch (_) {}
    if (!mobileShadowHoldWanted) {
      keepAwaitingHold(segment, '没录上，请按住说完再松开');
      return;
    }
    if (error && error.code === 'EMPTY_RECORDING') {
      keepAwaitingHold(segment, '没录到声音，请靠近嘴再按住说一次');
      return;
    }
    resetMobileShadowUi();
    setMobileSpeakHint(typeof mic.errorHint === 'function'
      ? mic.errorHint(error)
      : '录音失败，请再按住试一次', { toast: true, kind: 'warn' });
  }
}

function endMobileShadowHoldRecord() {
  if (mobileShadowEndingHold) return;
  if (!mobileShadowHolding && !mobileShadowHoldWanted) return;
  mobileShadowEndingHold = true;
  mobileShadowIgnoreClickUntil = Date.now() + 450;
  const pressMs = Date.now() - (mobileShadowPressStartedAt || 0);
  const recordMs = mobileShadowMicReady && mobileShadowRecordStartedAt
    ? (Date.now() - mobileShadowRecordStartedAt)
    : 0;

  // Accidental flick before mic is ready.
  if (!mobileShadowMicReady) {
    mobileShadowHoldWanted = false;
    if (typeof mobileShadowCancel === 'function') {
      try { mobileShadowCancel(); } catch (_) {}
    } else if (typeof mobileShadowStop === 'function') {
      try { mobileShadowStop(); } catch (_) {}
    }
    keepAwaitingHold(
      mobileShadowHoldSegment,
      pressMs < 280 ? '请按住不放，说完再松手' : '开麦中请别松手，再按住试一次',
    );
    return;
  }

  // Mic is live — only reject very short actual recordings.
  if (recordMs < MOBILE_SHADOW_MIN_RECORD_MS) {
    mobileShadowHoldWanted = false;
    if (typeof mobileShadowCancel === 'function') {
      try { mobileShadowCancel(); } catch (_) {}
    } else if (typeof mobileShadowStop === 'function') {
      try { mobileShadowStop(); } catch (_) {}
    }
    keepAwaitingHold(mobileShadowHoldSegment, '说太短了，请按住把整句说完再松');
    return;
  }

  mobileShadowHoldWanted = false;
  setMobileSpeakHint('正在结束录音…', { toast: true });
  if (typeof mobileShadowStop === 'function') {
    try { mobileShadowStop(); } catch (_) {}
  }
}

async function startMobileSentenceShadow() {
  if (Date.now() < mobileShadowIgnoreClickUntil) return;
  // Already waiting for WeChat-style hold — don't restart the whole flow.
  if (mobileShadowAwaitHold || mobileShadowHolding) {
    setMobileSpeakHint('请长按中间播放键说话，说完再松手', { toast: true });
    return;
  }
  if (typeof mobileShadowStop === 'function') {
    setMobileSpeakHint('正在结束录音…', { toast: true });
    try { mobileShadowStop(); } catch (_) {}
    return;
  }
  if (mobileShadowBusy) return;
  const segment = getMobileShadowSegment();
  if (!segment) {
    setMobileSpeakHint(state.isLoadingTranscript ? '字幕加载中…' : '暂无字幕，无法跟读', { toast: true, kind: 'warn' });
    return;
  }
  const mic = window.LinglishShadowMic;
  if (!mic || typeof mic.recordShadow !== 'function' || typeof mic.acquireMic !== 'function') {
    setMobileSpeakHint('跟读录音组件还没加载，请强制刷新后再试', { toast: true, kind: 'warn' });
    return;
  }

  const support = typeof mic.recordingSupport === 'function' ? mic.recordingSupport() : { ok: true };
  if (support && support.ok === false) {
    setMobileSpeakHint(support.hint || '当前浏览器不能录音', { toast: true, kind: 'warn' });
    return;
  }

  mobileShadowBusy = true;
  mobileShadowAwaitHold = false;
  mobileShadowHoldSegment = null;
  syncMobilePlayHoldLabel('开麦中…');
  if (mobilePlayBtn) {
    mobilePlayBtn.classList.add('is-mic-warming');
    mobilePlayBtn.textContent = '…';
  }

  // Warm mic permission on the first tap, then release before model audio.
  try {
    setMobileSpeakHint('请允许麦克风', { toast: true });
    const warm = await mic.acquireMic();
    try { mic.stopTracks(warm); } catch (_) {}
  } catch (error) {
    resetMobileShadowUi();
    setMobileSpeakHint(typeof mic.errorHint === 'function'
      ? mic.errorHint(error)
      : '打不开麦克风，请换 Safari / Chrome 再试', { toast: true, kind: 'warn' });
    return;
  }

  syncMobilePlayHoldLabel('听原句…');
  setMobileSpeakHint('先听这一句…', { toast: true });
  try {
    await playSegmentBoundsForShadow(segment);
  } catch (_) { /* still offer hold-to-talk */ }

  try { pauseLearningVideoNow(); } catch (_) {}
  mobileSegmentPosition = segment.index;
  try { renderMobileTranscriptWindow(segment.index); } catch (_) {}

  // WeChat voice-note style: long-press the play button to speak this sentence.
  mobileShadowAwaitHold = true;
  mobileShadowHoldSegment = segment;
  syncMobileShadowButton();
  setMobileSpeakHint('长按中间播放键说话，松手完成', { toast: true });
}

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

  const focusedSizing = Boolean(
    window.MobileReaderLayout &&
    window.MobileReaderLayout.usesFocusedTranscriptSizing(document.body.className)
  );

  // 首先确保移动端视图容器可见（必须在任何提前返回之前执行）
  if (!_mobileStylesInitialized) {
    const wrapper = mobileTranscriptList.parentElement;
    if (wrapper) {
      const transcriptView = wrapper.parentElement;
      if (transcriptView && transcriptView.classList.contains('mobile-transcript-view')) {
        transcriptView.style.setProperty('display', 'flex', 'important');
        transcriptView.style.setProperty('flex-direction', 'column', 'important');
        if (focusedSizing) {
          // Let CSS size the cue box from sentence count; clear legacy forced heights.
          transcriptView.style.removeProperty('min-height');
          transcriptView.style.removeProperty('height');
        } else {
          transcriptView.style.setProperty('height', 'calc((100vh - 70px) * 0.55)', 'important');
        }
        transcriptView.style.setProperty('overflow', 'hidden', 'important');
      }
      wrapper.style.display = 'flex';
      wrapper.style.flexDirection = 'row';
      wrapper.style.flex = focusedSizing ? '0 1 auto' : '1 1 0px';
      wrapper.style.minHeight = '0';
      wrapper.style.height = focusedSizing ? 'auto' : '';
      wrapper.style.overflow = 'hidden';
    }
    mobileTranscriptList.style.flex = focusedSizing ? '0 1 auto' : '1 1 0px';
    mobileTranscriptList.style.minHeight = '0';
    mobileTranscriptList.style.height = focusedSizing ? 'auto' : '';
    mobileTranscriptList.style.overflowY = 'auto';
    _mobileStylesInitialized = true;
  }

  const segments = Array.isArray(state.currentSegments) ? state.currentSegments : [];
  if (!segments.length) {
    // 检查是否正在加载字幕
    let loadingText = '暂无字幕';
    let showRetry = false;
    let showGenerate = false;
    let showUpgrade = false;
    const current = state.videos.find((item) => String(item.id) === String(state.selectedVideoId))
      || (window.LinglishStudyMedia && String(window.LinglishStudyMedia.id) === String(state.selectedVideoId)
        ? videoFromMediaSnapshot(window.LinglishStudyMedia)
        : null);
    if (state._podcastGenerating) {
      loadingText = '正在生成字幕…通常需要几十秒';
    } else if (state.isLoadingTranscript) {
      loadingText = '字幕加载中…';
    } else if (current && current.external_podcast) {
      if (current._podcastSubtitleError) {
        loadingText = String(current._podcastSubtitleError);
        showGenerate = isPremiumMember();
      } else if (isPremiumMember()) {
        showGenerate = true;
        loadingText = current.transcriptUrl
          ? '这一集文稿还没拉下来，可重试或生成字幕'
          : '这一集没有自带文稿。可生成字幕，或先听 Spotlight English（自带文稿）';
      } else {
        showUpgrade = true;
        loadingText = current.transcriptUrl
          ? '这一集有文稿但没拉下来，可重试'
          : '这一集没有自带文稿；会员可生成字幕，也可先听 Spotlight English'
        ;
        if (current.transcriptUrl) showRetry = true;
      }
    } else if (current && current.external_youtube) {
      showRetry = true;
      loadingText = current._captionFetchFailed
        ? '点读字幕拉取失败（视频里可能已开内置字幕）。网络需能访问 YouTube，或点下方重试。'
        : '还没有点读字幕，可点重试拉取';
    } else if (current && (current.status === 'processing')) {
      loadingText = '字幕生成中，请稍后再打开';
    }
    const actions = [];
    if (showGenerate) {
      actions.push('<button type="button" class="mobile-caption-generate" style="font:inherit;padding:0.35rem 0.8rem;border-radius:999px;border:0;background:#0f766e;color:#fff;cursor:pointer;font-weight:700;">生成字幕</button>');
      if (current && current.transcriptUrl) {
        actions.push('<button type="button" class="mobile-caption-retry" style="font:inherit;padding:0.35rem 0.8rem;border-radius:999px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;margin-left:0.4rem;">重试拉取</button>');
      }
      if (current && !current.transcriptUrl) {
        actions.push('<button type="button" class="mobile-caption-spotlight" style="font:inherit;padding:0.35rem 0.8rem;border-radius:999px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;margin-left:0.4rem;">去听有字幕播客</button>');
      }
    } else if (showUpgrade) {
      actions.push('<button type="button" class="mobile-caption-upgrade" style="font:inherit;padding:0.35rem 0.8rem;border-radius:999px;border:0;background:#0f766e;color:#fff;cursor:pointer;font-weight:700;">了解会员字幕</button>');
      if (showRetry) {
        actions.push('<button type="button" class="mobile-caption-retry" style="font:inherit;padding:0.35rem 0.8rem;border-radius:999px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;margin-left:0.4rem;">重试拉取字幕</button>');
      }
    } else if (showRetry) {
      actions.push('<button type="button" class="mobile-caption-retry" style="font:inherit;padding:0.35rem 0.8rem;border-radius:999px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;">重试拉取字幕</button>');
    }
    mobileTranscriptList.innerHTML = `<li class="mobile-transcript-item empty">${loadingText}${
      actions.length ? `<div style="margin-top:0.6rem;">${actions.join('')}</div>` : ''
    }</li>`;
    const retryBtn = mobileTranscriptList.querySelector('.mobile-caption-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const target = state.videos.find((item) => String(item.id) === String(state.selectedVideoId));
        if (target && target.external_podcast) {
          ensurePodcastSubtitles(target, { auto: true, force: true });
        } else if (target) {
          selectVideo(target);
        }
      });
    }
    const generateBtn = mobileTranscriptList.querySelector('.mobile-caption-generate');
    if (generateBtn) {
      generateBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const target = state.videos.find((item) => String(item.id) === String(state.selectedVideoId));
        if (!target) return;
        const ok = await ensurePodcastSubtitles(target, { auto: true, force: true });
        if (ok) showToast('字幕已就绪，可以跟读了', 'info');
      });
    }
    const spotlightBtn = mobileTranscriptList.querySelector('.mobile-caption-spotlight');
    if (spotlightBtn) {
      spotlightBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          if (window.LinglishMobileMediaLibrary && typeof window.LinglishMobileMediaLibrary.setView === 'function') {
            window.LinglishMobileMediaLibrary.setView('podcasts');
          }
          const openBtn = document.getElementById('open-video-library')
            || document.querySelector('[data-action="open-library"]')
            || Array.from(document.querySelectorAll('button')).find((b) => /视频库/.test(b.textContent || ''));
          if (openBtn) openBtn.click();
          setTimeout(() => {
            const card = Array.from(document.querySelectorAll('button, .vb-card, [role="button"]'))
              .find((el) => /Spotlight English/i.test(el.getAttribute('aria-label') || el.textContent || ''));
            if (card) card.click();
            else showToast('请打开视频库 → 播客 → Spotlight English', 'info');
          }, 400);
        } catch (_) {
          showToast('请打开视频库 → 播客 → Spotlight English（有文稿字幕）', 'info');
        }
      });
    }
    const upgradeBtn = mobileTranscriptList.querySelector('.mobile-caption-upgrade');
    if (upgradeBtn) {
      upgradeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.location.href = './pricing.html';
      });
    }
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

  // Focused mobile: keep exactly two cue rows (current + next).
  // Legacy mobile keeps a wider window for list browsing.
  const windowSize = focusedSizing ? 2 : 7;
  let start;
  let end;
  if (focusedSizing) {
    start = activeIndex;
    end = Math.min(segments.length, start + windowSize);
    if (end - start < windowSize) {
      start = Math.max(0, end - windowSize);
    }
  } else {
    start = Math.max(0, activeIndex - Math.floor(windowSize / 2));
    end = Math.min(segments.length, start + windowSize);
    if (end - start < windowSize) {
      start = Math.max(0, end - windowSize);
    }
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

    // 双语 = 英文字幕 + 中文翻译（同屏中英）
    const translation = mobileCueTranslationOf(seg);
    let translationHtml = '';
    if (state.showBilingual) {
      const enKey = bilingualCacheKey((seg && seg.text) || '');
      const failed = bilingualLoginBlocked || bilingualTranslateFailed.has(enKey);
      const waiting = !translation && !failed && (i === activeIndex || i === activeIndex + 1);
      const label = translation
        || (waiting ? '翻译中…' : '')
        || (failed && (i === activeIndex || i === activeIndex + 1)
          ? (bilingualLoginBlocked ? '登录后可看中文翻译' : '暂无翻译')
          : '');
      if (label) {
        translationHtml = `<span class="mobile-segment-translation${waiting && !translation ? ' is-pending' : ''}${failed && !translation ? ' is-failed' : ''}">${escapeHtml(label)}</span>`;
      }
    }

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

  if (state.showBilingual) {
    ensureMobileBilingualTranslations([activeIndex, activeIndex + 1]);
  }
}

const bilingualTranslateCache = new Map(); // key -> zh
const bilingualTranslateInflight = new Map();
const bilingualTranslateFailed = new Set();
let bilingualLoginBlocked = false;

function syncMobileBilingualClass() {
  try {
    document.body.classList.toggle('vrf-bilingual', Boolean(state.showBilingual));
  } catch (_) { }
}

function translationLooksStaleForEnglish(english, chinese) {
  const en = String(english || '').trim();
  const zh = String(chinese || '').trim();
  if (!zh) return true;
  const enWords = (en.match(/\b[\w’'-]+\b/g) || []).length;
  const zhChars = (zh.match(/[\u4e00-\u9fa5]/g) || []).join('').length;
  if (enWords >= 5 && zhChars <= 4) return true;
  if (enWords >= 8 && zhChars <= 6) return true;
  return false;
}

function mobileCueTranslationOf(seg) {
  const zh = String(seg && (seg.translation || seg.cn || seg.zh || seg.text_cn) || '').trim();
  if (!zh) return '';
  if (translationLooksStaleForEnglish(seg && seg.text, zh)) return '';
  return zh;
}

function bilingualCacheKey(text) {
  return String(state.selectedVideoId || '') + '::' + String(text || '').trim().toLowerCase();
}

function applyCueTranslation(index, zh) {
  const text = String(zh || '').trim();
  if (!text || !Array.isArray(state.currentSegments) || !state.currentSegments[index]) return;
  state.currentSegments[index].translation = text;
  state.currentSegments[index].cn = text;
  // Do not write display-index translations back into raw transcript_segments —
  // those indices diverge after sentence split/merge and poison later renders.
}

async function fetchSentenceChinese(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  const key = bilingualCacheKey(source);
  if (bilingualTranslateCache.has(key)) return bilingualTranslateCache.get(key) || '';
  if (bilingualTranslateInflight.has(key)) return bilingualTranslateInflight.get(key);

  const job = (async () => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}/dictionary/translate-text`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: source }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      throw new Error('login-required');
    }
    const zh = data && data.success && data.translation ? String(data.translation).trim() : '';
    if (zh && /[\u4e00-\u9fa5]/.test(zh)) {
      bilingualTranslateCache.set(key, zh);
      bilingualTranslateFailed.delete(key);
      return zh;
    }
    bilingualTranslateFailed.add(key);
    return '';
  })();

  bilingualTranslateInflight.set(key, job);
  try {
    return await job;
  } finally {
    bilingualTranslateInflight.delete(key);
  }
}

let bilingualEnsureToken = 0;
async function ensureMobileBilingualTranslations(indices) {
  if (!state.showBilingual || !isMobileLayout()) return;
  const segments = Array.isArray(state.currentSegments) ? state.currentSegments : [];
  if (!segments.length) return;
  const tokenAtStart = ++bilingualEnsureToken;
  const targets = (Array.isArray(indices) ? indices : [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0 && n < segments.length);

  let updated = false;
  let loginRequired = false;
  await Promise.all(targets.map(async (index) => {
    const seg = segments[index];
    if (!seg || mobileCueTranslationOf(seg)) return;
    const en = String(seg.text || '').trim();
    if (!en) return;
    const key = bilingualCacheKey(en);
    if (bilingualTranslateFailed.has(key) && !bilingualTranslateCache.has(key)) return;
    try {
      const zh = await fetchSentenceChinese(en);
      if (tokenAtStart !== bilingualEnsureToken) return;
      if (!zh) {
        updated = true; // clear 翻译中…
        return;
      }
      applyCueTranslation(index, zh);
      updated = true;
    } catch (err) {
      if (err && err.message === 'login-required') loginRequired = true;
      else bilingualTranslateFailed.add(key);
      updated = true;
    }
  }));

  if (tokenAtStart !== bilingualEnsureToken) return;
  if (loginRequired) {
    bilingualLoginBlocked = true;
    if (typeof setMobileSpeakHint === 'function') {
      setMobileSpeakHint('登录后可显示中英双语字幕');
    }
  }
  if (updated) {
    lastMobileRenderPosition = -1; // force redraw with Chinese lines
    renderMobileTranscriptWindow(mobileSegmentPosition);
  }
}

function navigateMobileSegment(direction) {
  if (!isMobileLayout()) return;
  const segments = state.currentSegments || [];
  if (!Array.isArray(segments) || !segments.length) {
    setMobileSpeakHint('暂无字幕，无法切句');
    return;
  }
  let targetPos;
  if (Number.isFinite(mobileSegmentPosition)) {
    targetPos = mobileSegmentPosition + direction;
  } else {
    targetPos = direction > 0 ? 0 : segments.length - 1;
  }
  targetPos = Math.max(0, Math.min(segments.length - 1, targetPos));
  const segment = segments[targetPos];
  if (!segment) return;
  const startTime = Number(segment.start ?? segment.start_sec);
  if (Number.isFinite(startTime)) {
    const transport = typeof coachingTransport === 'function' ? coachingTransport() : null;
    try {
      if (transport && typeof transport.seek === 'function') {
        transport.seek(Math.max(0, startTime + 0.01));
        if (typeof transport.play === 'function') transport.play();
        else safePlayVideo();
      } else if (youtubePlayer && typeof youtubePlayer.seekTo === 'function') {
        youtubePlayer.seekTo(Math.max(0, startTime), true);
        try {
          if (typeof youtubePlayer.playVideo === 'function') youtubePlayer.playVideo();
          else if (typeof youtubePlayer.play === 'function') youtubePlayer.play();
        } catch (_) {}
      } else if (videoPlayer) {
        videoPlayer.currentTime = Math.max(0, startTime);
        safePlayVideo();
      }
    } catch (_) {
      if (videoPlayer) {
        try { videoPlayer.currentTime = Math.max(0, startTime); } catch (__) {}
        safePlayVideo();
      }
    }
  }
  mobileSegmentPosition = targetPos;
  updateMobileNavButtons(mobileSegmentPosition);
  renderMobileTranscriptWindow(mobileSegmentPosition);
  syncMobilePlayButton();
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
      const isActive = String(video.id) === String(state.selectedVideoId);
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

function normalizeCaptionSegments(raw) {
  const list = coerceSegmentList(raw);
  if (!list.length) return [];
  try {
    if (window.LinglishSentenceSegments && typeof window.LinglishSentenceSegments.toDisplayedSentences === 'function') {
      // Always re-run: older cached cues can carry source_indices yet still be
      // paragraph-long under the player. The splitter is idempotent on short lines.
      const next = window.LinglishSentenceSegments.toDisplayedSentences(list);
      if (Array.isArray(next) && next.length) return next;
    }
  } catch (err) {
    console.warn('[Transcript] sentence normalize failed, using raw segments:', err);
  }
  return list.map((seg, index) => ({
    ...(seg || {}),
    index,
    source_indices: Array.isArray(seg && seg.source_indices) ? seg.source_indices : [index],
  }));
}

function clearTranscriptCues() {
  state.rawSegments = [];
  state.currentSegments = [];
}

// Raw timed cues stay immutable for the sync clock; display cards are derived.
function applyTranscriptCues(rawCues, video) {
  const raw = coerceSegmentList(rawCues).map((seg, index) => ({
    ...(seg || {}),
    index,
    source_indices: [index],
  }));
  const display = normalizeCaptionSegments(raw);
  state.rawSegments = raw;
  state.currentSegments = Array.isArray(display) && display.length ? display : raw;
  if (video) {
    // Persist RAW cues only — never overwrite with display rewrite.
    video.transcript_segments = raw;
  }
  try {
    if (window.LinglishArenaDialogue && typeof window.LinglishArenaDialogue.sync === 'function') {
      window.LinglishArenaDialogue.sync();
    }
  } catch (_) {}
  try {
    window.dispatchEvent(new CustomEvent('linglish:segments-ready'));
  } catch (_) {}
  return state.currentSegments;
}

function currentSegmentIndexByTime(t) {
  const display = state.currentSegments || [];
  if (!display.length) return -1;
  const raw = state.rawSegments || [];
  const api = window.LinglishSentenceSegments;
  if (api && typeof api.displayIndexForTime === 'function' && raw.length) {
    try { return api.displayIndexForTime(display, raw, t, 0.1); } catch (_) {}
  }
  if (api && typeof api.findIndexByTime === 'function') {
    try { return api.findIndexByTime(display, t, 0.1); } catch (_) {}
  }
  const tolerance = 0.1;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < display.length; i += 1) {
    const start = Number(display[i].start ?? display[i].start_sec ?? 0) || 0;
    const endRaw = Number(display[i].end ?? display[i].end_sec);
    const end = Number.isFinite(endRaw) ? endRaw : start + 5;
    if (t >= start - tolerance && t < end + tolerance) {
      const dist = Math.abs(t - start);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
  }
  if (best >= 0) return best;
  for (let i = 0; i < display.length; i += 1) {
    const start = Number(display[i].start ?? display[i].start_sec ?? 0) || 0;
    const diff = t - start;
    if (diff >= -tolerance && diff < bestDist && diff < 3) {
      bestDist = diff;
      best = i;
    }
  }
  return best;
}

function renderTranscript(video) {
  // 清除字幕HTML缓存，准备渲染新视频或重新渲染
  state.segmentHtmlCache.clear();

  if (!video) {
    transcriptContent.innerHTML = '<div class="empty-state">Select a video to view its transcript.</div>';
    transcriptLanguage.textContent = '';
    clearTranscriptCues();
    return;
  }

  if (video.status === 'processing') {
    transcriptContent.innerHTML = '<div class="empty-state">Transcription in progress. Please refresh in a moment.</div>';
    transcriptLanguage.textContent = '';
    clearTranscriptCues();
    return;
  }

  if (video.status === 'failed') {
    transcriptContent.innerHTML = `<div class="empty-state" style="color:#d32f2f;">${escapeHtml(video.failure_reason || 'Transcription failed. Please re-upload the video later.')}</div>`;
    transcriptLanguage.textContent = '';
    clearTranscriptCues();
    return;
  }

  if (video.status === 'skipped') {
    transcriptContent.innerHTML = `<div class="empty-state">${escapeHtml(video.failure_reason || 'Transcription skipped.')}</div>`;
    transcriptLanguage.textContent = '';
    clearTranscriptCues();
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

  const rawSegments = coerceSegmentList(video.transcript_segments);
  const segments = applyTranscriptCues(rawSegments, video);
  if (window && window.LinglishCoachingDock && typeof window.LinglishCoachingDock.sync === 'function') {
    window.LinglishCoachingDock.sync({
      segments: state.currentSegments,
      index: -1,
      videoId: state.selectedVideoId,
      user: state.user,
    });
  }

  if (!segments.length) {
    // 如果正在加载，显示加载状态
    const loadingMsg = state.isLoadingTranscript ? 'Loading transcript...' : 'Transcript unavailable.';
    transcriptContent.innerHTML = `<div class="empty-state">${loadingMsg}</div>`;
    if (isMobileLayout()) {
      renderMobileTranscriptWindow(null);
    }
    const canFetchTranscript = video.id && /^\d+$/.test(String(video.id))
      && (video.status === 'ready' || video.status === 'processing' || video.status === 'completed' || !video.status);
    if (canFetchTranscript && !state.transcriptFetchRequested.has(video.id)) {
      state.transcriptFetchRequested.add(video.id);
      state.isLoadingTranscript = true;
      if (isMobileLayout()) renderMobileTranscriptWindow(null);
      fetch(`${API_BASE}/video-resources/${video.id}/transcript`)
        .then(res => res.ok ? res.json() : null)
        .then(data => {
          state.isLoadingTranscript = false;
          if (String(state.selectedVideoId) !== String(video.id)) return;
          const fetched = data && Array.isArray(data.segments) ? data.segments : [];
          // Don't wipe a usable in-memory transcript with an empty/failed fetch.
          if (!fetched.length && Array.isArray(video.transcript_segments) && video.transcript_segments.length) {
            renderTranscript(video);
            return;
          }
          video.transcript_segments = fetched;
          const idx = state.videos.findIndex((item) => String(item.id) === String(video.id));
          if (idx >= 0) state.videos[idx] = Object.assign({}, state.videos[idx], { transcript_segments: fetched });
          renderTranscript(video);
        })
        .catch(() => {
          state.isLoadingTranscript = false;
          if (String(state.selectedVideoId) === String(video.id)) {
            renderTranscript(video);
          }
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

// 安全播放视频的辅助函数（处理移动端播放限制；含 YouTube iframe）
async function safePlayVideo() {
  try {
    const transport = typeof coachingTransport === 'function' ? coachingTransport() : null;
    const wrapper = document.getElementById('youtube-player-wrapper');
    const usingYouTube = wrapper && wrapper.style.display !== 'none' && youtubePlayer;
    if (usingYouTube && transport && typeof transport.play === 'function') {
      transport.play();
      syncMobilePlayButton();
      return true;
    }
    if (!videoPlayer) return false;
    await videoPlayer.play();
    syncMobilePlayButton();
    return true;
  } catch (err) {
    console.warn('Video play failed:', err);
    // 如果是因为用户交互限制，不显示错误
    if (err.name !== 'NotAllowedError') {
      console.error('Video playback error:', err);
    }
    syncMobilePlayButton();
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

const POD_CUES_STORE_KEY = 'linglish_pod_cues_v1';

function isPremiumMember() {
  const user = state.user;
  if (!user) {
    try {
      const type = String(localStorage.getItem('membership_type') || 'free').toLowerCase();
      return type === 'vip' || type === 'svip' || type === 'family' || type === 'admin' || type === 'pro' || type === 'premium';
    } catch (_) {
      return false;
    }
  }
  if (user.is_admin || user.role === 'admin') return true;
  const type = String(user.membership_type || 'free').toLowerCase();
  if (type === 'vip' || type === 'svip' || type === 'family' || type === 'admin' || type === 'pro' || type === 'premium') {
    return true;
  }
  try {
    if (window.LinglishEntitlements && typeof window.LinglishEntitlements.hasActivePaidEntitlement === 'function') {
      return window.LinglishEntitlements.hasActivePaidEntitlement(user);
    }
  } catch (_) {}
  return false;
}

function readPodCueCache(id) {
  try {
    const all = JSON.parse(localStorage.getItem(POD_CUES_STORE_KEY) || '{}');
    const row = all && all[String(id || '')];
    return row && Array.isArray(row.cues) ? row.cues : null;
  } catch (_) {
    return null;
  }
}

function writePodCueCache(id, cues) {
  if (!id || !Array.isArray(cues) || !cues.length) return;
  try {
    const all = JSON.parse(localStorage.getItem(POD_CUES_STORE_KEY) || '{}');
    all[String(id)] = { cues, savedAt: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > 40) {
      keys.sort((a, b) => (all[a].savedAt || 0) - (all[b].savedAt || 0))
        .slice(0, keys.length - 40)
        .forEach((key) => { delete all[key]; });
    }
    localStorage.setItem(POD_CUES_STORE_KEY, JSON.stringify(all));
  } catch (_) {}
}

function normalizePodcastCues(raw) {
  let cues = (Array.isArray(raw) ? raw : []).map((cue, index) => ({
    index,
    text: cue.text,
    start: cue.start,
    end: cue.end,
  })).filter((cue) => String(cue.text || '').trim());
  if (window.LinglishSentenceSegments && typeof window.LinglishSentenceSegments.toDisplayedSentences === 'function') {
    cues = window.LinglishSentenceSegments.toDisplayedSentences(cues);
  } else if (window.LinglishSentenceSegments && typeof window.LinglishSentenceSegments.toCompleteSentences === 'function') {
    cues = window.LinglishSentenceSegments.toCompleteSentences(cues);
  }
  return cues;
}

function mediaAuthToken() {
  try {
    if (window.AuthManager && typeof window.AuthManager.getToken === 'function') {
      const t = window.AuthManager.getToken();
      if (t) return t;
    }
  } catch (_) {}
  return token
    || localStorage.getItem('linglish_token')
    || sessionStorage.getItem('linglish_token')
    || localStorage.getItem('authToken')
    || '';
}

async function postMediaJson(path, body) {
  const auth = mediaAuthToken();
  const res = await fetch(`${API_BASE}/media/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || '请求失败');
  return data;
}

function fetchYouTubeCaptionsForVideo(target) {
  if (!target || !target.youtube_video_id) return Promise.resolve([]);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => {
      try { controller.abort(); } catch (_) {}
    }, 35000)
    : null;
  return fetch(`${API_BASE}/youtube/transcript`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(mediaAuthToken() ? { Authorization: 'Bearer ' + mediaAuthToken() } : {}),
    },
    body: JSON.stringify({
      url: `https://www.youtube.com/watch?v=${target.youtube_video_id}`,
      language: 'en',
    }),
    ...(controller ? { signal: controller.signal } : {}),
  })
    .then((res) => res.json().then((data) => ({ ok: res.ok, data })).catch(() => ({ ok: false, data: {} })))
    .then(({ ok, data }) => {
      if (!ok || data.success === false) return [];
      if (Array.isArray(data.segments) && data.segments.length) return data.segments;
      return [];
    })
    .catch((err) => {
      if (err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')))) {
        console.warn('[YouTube] Caption fetch timed out');
      }
      return [];
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

async function uploadPodcastAudioForTranscript(video) {
  const audioUrl = video && video.audioUrl;
  if (!audioUrl) throw new Error('这一集没有可识别的音频');
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) throw new Error('音频下载失败，请稍后重试');
  const buf = await audioRes.arrayBuffer();
  if (!buf || !buf.byteLength) throw new Error('音频文件是空的');
  if (buf.byteLength > 40 * 1024 * 1024) throw new Error('这一集音频太大，暂时无法生成字幕');
  const extMatch = String(audioUrl).match(/\.(mp3|m4a|wav|ogg)(?:$|\?)/i);
  const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : '.mp3';
  const auth = mediaAuthToken();
  const headers = {
    'Content-Type': 'application/octet-stream',
    'X-Audio-Ext': ext,
    'X-Audio-Language': video.language || 'en',
  };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const res = await fetch(`${API_BASE}/media/transcribe`, {
    method: 'POST',
    headers,
    body: buf,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || '生成字幕失败');
  return data;
}

async function generatePodcastSubtitles(video) {
  if (!video || !video.external_podcast) {
    throw new Error('这一集没有可识别的音频');
  }
  const cached = readPodCueCache(video.id);
  if (cached && cached.length) return normalizePodcastCues(cached);
  let data;
  let lastErr;
  try {
    data = await postMediaJson('resolve-cues', {
      transcriptUrl: video.transcriptUrl || '',
      audioUrl: video.audioUrl || '',
      title: video.title || video.original_filename || '',
      youtubeVideoId: video.youtube_video_id || '',
      language: video.language || 'en',
    });
  } catch (resolveErr) {
    lastErr = resolveErr;
    if (video.audioUrl) {
      try {
        data = await postMediaJson('transcribe', {
          audioUrl: video.audioUrl,
          title: video.title || '',
          language: video.language || 'en',
        });
      } catch (urlErr) {
        lastErr = urlErr;
        try {
          data = await uploadPodcastAudioForTranscript(video);
        } catch (uploadErr) {
          throw lastErr || uploadErr;
        }
      }
    } else {
      throw lastErr;
    }
  }
  const cues = normalizePodcastCues(data.cues || []);
  if (!cues.length) throw new Error('生成字幕失败，没有识别到内容');
  writePodCueCache(video.id, cues);
  return cues;
}

async function ensureAnyMediaSubtitles(video, options = {}) {
  if (!video) return false;
  if (Array.isArray(video.transcript_segments) && video.transcript_segments.length) return true;
  if (video.external_podcast) {
    return ensurePodcastSubtitles(video, options);
  }
  if (video.youtube_video_id || video.external_youtube) {
    state.isLoadingTranscript = true;
    state._podcastGenerating = true;
    renderTranscript(video);
    try {
      let segments = [];
      try {
        segments = await fetchYouTubeCaptionsForVideo(video);
      } catch (_) {}
      if (!segments.length) {
        const data = await postMediaJson('resolve-cues', {
          youtubeVideoId: video.youtube_video_id,
          title: video.title || video.original_filename || '',
          language: video.language || 'en',
          allowAudioStt: true,
        });
        segments = normalizePodcastCues(data.cues || []);
      }
      if (String(state.selectedVideoId) !== String(video.id)) return false;
      // Store RAW cues; display cards are derived in renderTranscript/applyTranscriptCues.
      video.transcript_segments = coerceSegmentList(segments);
      video._captionFetchFailed = !video.transcript_segments.length;
      video._podcastSubtitleError = segments.length ? '' : '暂时拿不到字幕';
      const idx = state.videos.findIndex((item) => String(item.id) === String(video.id));
      if (idx >= 0) state.videos[idx] = video;
      return segments.length > 0;
    } catch (err) {
      video._captionFetchFailed = true;
      video._podcastSubtitleError = (err && err.message) || '字幕加载失败';
      return false;
    } finally {
      state.isLoadingTranscript = false;
      state._podcastGenerating = false;
      if (String(state.selectedVideoId) === String(video.id)) {
        renderTranscript(video);
        if (Array.isArray(video.transcript_segments) && video.transcript_segments.length && isMobileLayout()) {
          mobileSegmentPosition = 0;
          renderMobileTranscriptWindow(0);
        }
      }
    }
  }
  return false;
}

function applyPodcastCuesToVideo(video, cues) {
  if (!video) return;
  const next = normalizePodcastCues(cues);
  video.transcript_segments = next;
  if (window.LinglishStudyMedia && String(window.LinglishStudyMedia.id) === String(video.id)) {
    window.LinglishStudyMedia.cues = next;
  }
}

async function ensurePodcastSubtitles(video, options = {}) {
  if (!video || !video.external_podcast) return false;
  if (Array.isArray(video.transcript_segments) && video.transcript_segments.length) {
    applyPodcastCuesToVideo(video, video.transcript_segments);
    return true;
  }
  const cached = readPodCueCache(video.id);
  if (cached && cached.length) {
    applyPodcastCuesToVideo(video, cached);
    return true;
  }

  const auto = options.auto === true;
  const premium = isPremiumMember();

  if (video.transcriptUrl) {
    state.isLoadingTranscript = true;
    state._podcastGenerating = false;
    renderTranscript(video);
    try {
      const data = await postMediaJson('cues', { url: video.transcriptUrl });
      if (String(state.selectedVideoId) !== String(video.id)) return false;
      let cues = normalizePodcastCues(data.cues || []);
      if (!cues.length && premium) {
        state._podcastGenerating = true;
        renderTranscript(video);
        cues = await generatePodcastSubtitles(video);
      } else if (!cues.length) {
        showToast('这一集的文稿是空的', 'warn');
      }
      if (String(state.selectedVideoId) !== String(video.id)) return false;
      applyPodcastCuesToVideo(video, cues);
      return cues.length > 0;
    } catch (err) {
      if (premium) {
        try {
          state._podcastGenerating = true;
          renderTranscript(video);
          const cues = await generatePodcastSubtitles(video);
          if (String(state.selectedVideoId) !== String(video.id)) return false;
          applyPodcastCuesToVideo(video, cues);
          return cues.length > 0;
        } catch (genErr) {
          showToast((genErr && genErr.message) || (err && err.message) || '字幕加载失败', 'warn');
          return false;
        }
      }
      showToast((err && err.message) || '字幕文稿加载失败', 'warn');
      return false;
    } finally {
      state.isLoadingTranscript = false;
      state._podcastGenerating = false;
      if (String(state.selectedVideoId) === String(video.id)) {
        renderTranscript(video);
        if (Array.isArray(video.transcript_segments) && video.transcript_segments.length) {
          mobileSegmentPosition = 0;
          renderMobileTranscriptWindow(0);
        }
      }
    }
  }

  // Local Whisper makes generation free; still try for every playable podcast episode.
  if (!auto && !options.force && !premium) return false;

  state.isLoadingTranscript = true;
  state._podcastGenerating = true;
  renderTranscript(video);
  try {
    const cues = await generatePodcastSubtitles(video);
    if (String(state.selectedVideoId) !== String(video.id)) return false;
    applyPodcastCuesToVideo(video, cues);
    video._podcastSubtitleError = '';
    return cues.length > 0;
  } catch (err) {
    const message = (err && err.message) || '字幕生成失败';
    video._podcastSubtitleError = message;
    if (String(state.selectedVideoId) === String(video.id)) {
      showToast(message, 'warn');
    }
    return false;
  } finally {
    state.isLoadingTranscript = false;
    state._podcastGenerating = false;
    if (String(state.selectedVideoId) === String(video.id)) {
      renderTranscript(video);
      if (Array.isArray(video.transcript_segments) && video.transcript_segments.length) {
        mobileSegmentPosition = 0;
        renderMobileTranscriptWindow(0);
      }
    }
  }
}

async function selectVideo(idOrVideo) {
  teardownMobileFirstLessonRecording('video-selection');
  firstLessonGoal = null;
  firstLessonGoalCard.hide();
  const entry = idOrVideo && typeof idOrVideo === 'object' ? idOrVideo : null;
  const id = entry ? entry.id : idOrVideo;
  let video = state.videos.find((item) => String(item.id) === String(id));
  if (!video && entry) {
    state.videos = [entry, ...state.videos.filter((item) => String(item.id) !== String(id))];
    video = entry;
  }
  const selectionGeneration = ++videoSelectionGeneration;
  const isCurrentSelection = () => (
    selectionGeneration === videoSelectionGeneration && String(state.selectedVideoId) === String(id)
  );

  const playable = Boolean(
    video && (
      video.external_youtube ||
      video.external_podcast ||
      video.status === 'ready' ||
      video.youtube_video_id
    )
  );
  if (playable) {
    closeMobileVideoLibrary();
  } else if (video && (video.status === 'failed' || video.status === 'processing' || video.status === 'skipped')) {
    const tip = video.status === 'processing'
      ? '这支视频还在转录，稍后再点。'
      : (video.failure_reason || '这支视频无法播放。请换一支，或从频道 / 播客选取。');
    try { window.alert(tip); } catch (_) {}
    return;
  } else {
    closeMobileVideoLibrary();
  }
  nextVideoSheet.hide();

  // 防止重复选择同一视频导致字幕重置
  const isNewVideo = String(state.selectedVideoId) !== String(id);

  state.selectedVideoId = id;
  try {
    if (/^\d+$/.test(String(id))) {
      window.LinglishStudyVideoId = String(id);
      window.LinglishStudyMedia = null;
    } else if (video) {
      window.LinglishStudyVideoId = '';
      window.LinglishStudyMedia = mediaSnapshotFromVideo(video);
    }
    if (video) rememberStudySelection(video);
  } catch (_) {}
  try {
    if (isNewVideo) {
      state.lastRecordingBlob = null;
      if (state.lastRecordingUrl) {
        try { URL.revokeObjectURL(state.lastRecordingUrl); } catch (_) {}
      }
      state.lastRecordingUrl = null;
      state.lastRecordingSegmentIndex = null;
      if (typeof window.hydrateShadowRecording === 'function') {
        window.hydrateShadowRecording(id).catch(() => {});
      }
    }
  } catch (_) {}
  state.segmentSpeakerMap = {};
  state.waitingForPractice = false;
  state.practicePlaybackLock = false;
  state.practiceArmed = false;
  state.practiceAssessmentContext = null;
  state.isLoadingTranscript = false; // 重置加载状态
  updatePracticeArmUI();
  renderVideoList();

  // 增加视频浏览量（仅在选择新视频时；外部频道/播客无数字 ID）
  if (isNewVideo && id && /^\d+$/.test(String(id))) {
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

  function enableYouTubeNativeCaptionsFallback() {
    try {
      if (youtubePlayer && typeof youtubePlayer.enableNativeCaptions === 'function') {
        youtubePlayer.enableNativeCaptions('en');
      }
    } catch (_) {}
  }

  // 外部 YouTube / 频道视频：字幕轨道 → 不行再本地/云端识别
  if (video && video.external_youtube && video.youtube_video_id) {
    ensureAnyMediaSubtitles(video, { auto: true }).then((ok) => {
      if (!isCurrentSelection()) return;
      if (!ok) enableYouTubeNativeCaptionsFallback();
      else if (youtubePlayer && typeof youtubePlayer.disableNativeCaptions === 'function') {
        // Our sentence dock owns the text — hide YouTube CC so mid-line wraps
        // like "…here" + next sentence do not fight the on-screen dialogue.
        youtubePlayer.disableNativeCaptions();
      }
      if (ok && isMobileLayout()) {
        mobileSegmentPosition = 0;
        renderMobileTranscriptWindow(0);
      }
    }).catch(() => {
      if (!isCurrentSelection()) return;
      enableYouTubeNativeCaptionsFallback();
      renderTranscript(video);
    });
  } else if (video && video.external_podcast) {
    // 有文稿就拉 VTT/SRT；没有则会员走 Whisper 生成（与桌面播客一致）
    ensurePodcastSubtitles(video, { auto: true }).then((ok) => {
      if (!isCurrentSelection()) return;
      if (ok && Array.isArray(video.transcript_segments) && video.transcript_segments.length) {
        mobileSegmentPosition = 0;
        renderMobileTranscriptWindow(0);
      } else {
        renderTranscript(video);
        renderMobileTranscriptWindow(null);
      }
    }).catch(() => {
      if (isCurrentSelection()) {
        state.isLoadingTranscript = false;
        state._podcastGenerating = false;
        renderTranscript(video);
        renderMobileTranscriptWindow(null);
      }
    });
  } else if (video && /^\d+$/.test(String(id)) && (!video.transcript_segments || video.transcript_segments.length === 0)) {
    state.isLoadingTranscript = true;
    if (isMobileLayout()) renderMobileTranscriptWindow(null);
    fetch(`${API_BASE}/video-resources/${id}`)
      .then(res => res.ok ? res.json() : null)
      .then(async (data) => {
        const full = data && data.video ? data.video : null;
        if (!full) {
          state.isLoadingTranscript = false;
          if (String(state.selectedVideoId) === String(id)) renderTranscript(video);
          return;
        }
        let segments = Array.isArray(full.transcript_segments) ? full.transcript_segments : [];
        // Library YouTube / empty DB captions → captions → local/cloud STT.
        if (!segments.length && full.youtube_video_id) {
          try {
            segments = await fetchYouTubeCaptionsForVideo(full);
          } catch (_) {}
          if (!segments.length) {
            try {
              const data = await postMediaJson('resolve-cues', {
                youtubeVideoId: full.youtube_video_id,
                title: full.title || full.original_filename || '',
                language: full.language || 'en',
                allowAudioStt: true,
              });
              segments = normalizePodcastCues(data.cues || []);
            } catch (_) {}
          }
          if (segments.length) {
            full.transcript_segments = segments;
            full.status = 'ready';
          }
        }
        state.isLoadingTranscript = false;
        const idx = state.videos.findIndex(v => String(v.id) === String(id));
        if (idx >= 0) state.videos[idx] = full;
        if (String(state.selectedVideoId) === String(id)) {
          renderTranscript(full);
          setTimeout(() => {
            extractAndSaveVocabulary(full);
          }, 1000);
        }
      })
      .catch(() => {
        state.isLoadingTranscript = false;
        if (String(state.selectedVideoId) === String(id)) renderTranscript(video);
      });
  }

  // 立刻渲染字幕（含移动端字幕窗）。speakers 加载完成后会再刷一次角色信息。
  // 以前有字幕时先空着等 speakers，speakers 失败/跳过就会一直「暂无字幕」。
  renderTranscript(video);

  // 只在切换到新视频时重置移动端字幕位置；有字幕则落到第 1 句，不要清成空窗
  if (isNewVideo) {
    mobileSegmentPosition = null;
    if (Array.isArray(state.currentSegments) && state.currentSegments.length) {
      renderMobileTranscriptWindow(0);
    } else {
      renderMobileTranscriptWindow(null);
    }
  }
  if (mobileProgress) {
    mobileProgress.value = 0;
  }
  if (mobileCurrentTime) {
    mobileCurrentTime.textContent = '00:00';
  }

  // 加载用户录音（仅站内数字 ID）
  if (/^\d+$/.test(String(id))) {
    audioModeManager.loadUserRecordings(id);
  }

  // 延迟提取词汇，避免阻塞视频加载
  if (video) {
    // 等待3秒后再提取词汇，让视频先流畅加载
    setTimeout(() => {
      extractAndSaveVocabulary(video);
    }, 3000);
  }

  // 在移动端，点选内容后收起视频库，露出播放区
  if (window.innerWidth <= 768) {
    if (typeof closeMobileVideoLibrary === 'function') {
      closeMobileVideoLibrary();
    } else if (videoSidebar) {
      videoSidebar.classList.add('hidden');
      renderToggleSidebarControl(false, '打开视频库');
    }
    if (typeof syncMobileStudyLibraryChrome === 'function') {
      syncMobileStudyLibraryChrome();
    }
  }

  if (video) {
    const youtubePlayerWrapper = document.getElementById('youtube-player-wrapper');
    const youtubePlayerIframe = document.getElementById('youtube-player');

    // 播客音频：直接用 HTML5 播放器（画面用封面板，避免黑屏）
    if (video.external_podcast) {
      hideYtEmbedFallback();
      if (youtubePlayer) {
        try { youtubePlayer.destroy(); } catch (_) {}
        youtubePlayer = null;
      }
      if (youtubePlayerWrapper) youtubePlayerWrapper.style.display = 'none';
      if (youtubePlayerIframe) youtubePlayerIframe.style.display = 'none';
      const startPodcastPlayback = (podVideo) => {
        syncPodcastFaceplate(podVideo);
        if (!videoPlayer) return;
        videoPlayer.style.display = 'block';
        videoPlayer.removeAttribute('poster');
        try { videoPlayer.removeAttribute('crossorigin'); } catch (_) {}
        const audioSrc = String(podVideo && podVideo.audioUrl || '').replace(/^http:\/\//i, 'https://');
        if (!audioSrc) {
          showPodcastPlaybackError('这一集还没有音频链接，请返回播客列表重新打开');
          if (typeof syncMobilePlayButton === 'function') syncMobilePlayButton();
          return;
        }
        if (/sphinx\.acast\.com\/p\/open\//i.test(audioSrc)) {
          showPodcastPlaybackError('这集音频链接失效了，请返回播客列表重新打开这一集');
          if (typeof syncMobilePlayButton === 'function') syncMobilePlayButton();
          return;
        }
        videoPlayer.src = audioSrc;
        videoPlayer.load();
        const resumePodcast = () => {
          applyPendingResumeSeek();
          videoPlayer.removeEventListener('loadedmetadata', resumePodcast);
        };
        videoPlayer.addEventListener('loadedmetadata', resumePodcast);
        videoPlayer.play().then(() => {
          if (typeof syncMobilePlayButton === 'function') syncMobilePlayButton();
          syncPodcastFaceplatePlayState();
        }).catch((err) => {
          if (err && err.name === 'NotAllowedError') {
            // 等用户点封面或底部 Play
            if (typeof syncMobilePlayButton === 'function') syncMobilePlayButton();
            syncPodcastFaceplatePlayState();
            return;
          }
          showPodcastPlaybackError('这集音频暂时播不了，换一集或稍后再试');
          if (typeof syncMobilePlayButton === 'function') syncMobilePlayButton();
          syncPodcastFaceplatePlayState();
        });
      };
      const resolver = window.LinglishMobileMediaLibrary
        && typeof window.LinglishMobileMediaLibrary.resolvePlayablePodcastAudio === 'function'
        ? window.LinglishMobileMediaLibrary.resolvePlayablePodcastAudio(video)
        : Promise.resolve(video);
      Promise.resolve(resolver).then((resolved) => {
        if (resolved && resolved !== video) {
          try { Object.assign(video, resolved); } catch (_) {}
        }
        startPodcastPlayback(resolved || video);
      }).catch(() => startPodcastPlayback(video));
      if (typeof configureMobileFocusVideoChrome === 'function') {
        configureMobileFocusVideoChrome();
      }
    } else {
      syncPodcastFaceplate(null);

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
        // YouTube Shorts
        /(?:(?:www\.|m\.)?youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
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

    let youtubeVideoId = video.external_podcast ? null : video.youtube_video_id;
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

      hidePlayOverlay();
      hideYtEmbedFallback();

      // 初始化 YouTube 播放器 (异步)
      (async function () {
        try {
          console.log('[YouTube] Initializing YouTubePlayer API');
          youtubePlayer = new YouTubePlayer('youtube-player');
          const ytOptions = isMobileReaderFocus()
            ? { playerVars: { controls: 1, fs: 0, disablekb: 1, modestbranding: 1, rel: 0 } }
            : {};
          await youtubePlayer.init(youtubeVideoId, ytOptions);
          console.log('[YouTube] Player initialized successfully');
          applyPendingResumeSeek();
          if (video._captionFetchFailed) {
            enableYouTubeNativeCaptionsFallback();
          }

          let ytEverPlayed = false;
          if (isMobileReaderFocus()) {
            window.setTimeout(() => {
              if (!isCurrentSelection() || ytEverPlayed) return;
              showYtEmbedFallback(youtubeVideoId);
            }, 5000);
          }

          // 监听播放状态变化以记录观看时长
          youtubePlayer.on('statechange', function (event) {
            if (event.data === YT.PlayerState.PLAYING) {
              ytEverPlayed = true;
              hideYtEmbedFallback();
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
            syncMobilePlayButton();
          });

          // 设置时间更新回调来触发字幕滚动
          // 复用与 HTML5 videoPlayer 相同的字幕高亮逻辑
          youtubePlayer.on('timeupdate', function (currentTime) {
            if (mobileCurrentTime) {
              mobileCurrentTime.textContent = formatTime(currentTime || 0);
            }
            let ytDuration = 0;
            try {
              ytDuration = Number(youtubePlayer.getDuration && youtubePlayer.getDuration()) || 0;
              if (mobileDuration && ytDuration > 0) {
                mobileDuration.textContent = formatTime(ytDuration);
              }
              if (mobileProgress && ytDuration > 0 && !isMobileProgressDragging) {
                mobileProgress.value = (currentTime / ytDuration) * 100;
              }
            } catch (_) {}
            const nowTs = Date.now();
            if (state.selectedVideoId && (nowTs - lastProgressSaveTime) > PROGRESS_SAVE_INTERVAL) {
              lastProgressSaveTime = nowTs;
              rememberPlaybackProgress(currentTime, ytDuration);
            }
            // Sentence practice / 跟读: stop at this cue for YouTube too (not only first-lesson).
            if (state.segmentPlaybackEnd != null && currentTime >= state.segmentPlaybackEnd) {
              try { youtubePlayer.pause(); } catch (_) {}
              state.segmentPlaybackEnd = null;
              const callback = state.segmentPlaybackCallback;
              state.segmentPlaybackCallback = null;
              if (callback) callback();
              // Keep mobile window locked on the practiced sentence while shadowing.
              if (mobileShadowBusy && Number.isFinite(mobileSegmentPosition)) {
                try { renderMobileTranscriptWindow(mobileSegmentPosition); } catch (_) {}
              }
            }
            if (!state.currentSegments.length) {
              console.log('[YouTube] No segments available, skipping');
              return;
            }

            // 查找当前segment索引（使用与 HTML5 player 相同的高级匹配逻辑）
            // 应用字幕偏移：正值=字幕提前，负值=字幕延迟
            const adjustedTime = currentTime + state.subtitleOffset;

            // Source-anchored clock: raw cue by time → display card.
            let index = currentSegmentIndexByTime(adjustedTime);

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

              // 移动端：更新移动字幕窗口（跟读进行中锁在当前句，不跟着进度往下跑）
              if (isMobile) {
                if (mobileShadowBusy && Number.isFinite(mobileSegmentPosition)) {
                  renderMobileTranscriptWindow(mobileSegmentPosition);
                } else {
                  mobileSegmentPosition = index;
                  renderMobileTranscriptWindow(index);
                }
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
                    if (focusedSizing) {
                      transcriptView.style.removeProperty('min-height');
                      transcriptView.style.removeProperty('height');
                    } else {
                      transcriptView.style.setProperty('height', 'calc((100vh - 70px) * 0.55)', 'important');
                      transcriptView.style.setProperty('min-height', '0', 'important');
                    }
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
          if (isMobileReaderFocus()) {
            showYtEmbedFallback(youtubeVideoId);
            setMobileSpeakHint('YouTube 内嵌播不了，可点播放器上的打开方式');
          } else {
            alert('YouTube 播放器初始化失败: ' + error.message);
          }
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

      configureMobileFocusVideoChrome();
      // 添加一次性事件监听，视频可以播放时尝试播放
      const handleCanPlay = () => {
        console.log('Video ready to play');
        applyPendingResumeSeek();
        // Focused mobile reader: no center play overlay. Legacy mobile still gets one.
        if (window.innerWidth <= 768 && !isMobileReaderFocus()) {
          const overlay = document.getElementById('play-overlay');
          if (overlay) {
            overlay.hidden = false;
            overlay.style.display = 'flex';
          }
        } else {
          hidePlayOverlay();
        }
        videoPlayer.removeEventListener('canplay', handleCanPlay);
      };
      videoPlayer.addEventListener('canplay', handleCanPlay);
    }
    } // end non-podcast media load
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
    // Refresh keeps the last selected video (URL / localStorage / recent).
    if (!state.selectedVideoId) {
      try {
        const restored = await restoreStudyVideoOnBoot();
        if (restored) console.log('[Resume] Restored last study video');
      } catch (resumeErr) {
        console.warn('[Resume] Failed to restore study video:', resumeErr);
      }
    }
  } catch (err) {
    console.error('Failed to load videos:', err);
    videoListEl.innerHTML = '<li class="empty-state" style="color:#d32f2f;">Failed to load videos.</li>';
  }
}

const videoFileInput = document.getElementById('video-file');
const videoTitleInput = document.getElementById('video-title');
if (videoFileInput && videoTitleInput) {
  videoFileInput.addEventListener('change', () => {
    const file = videoFileInput.files && videoFileInput.files[0];
    if (!file) return;
    const current = String(videoTitleInput.value || '').trim();
    if (current && current !== 'My listening video') return;
    const base = String(file.name || '').replace(/\.[^.]+$/, '').trim();
    if (base) videoTitleInput.value = base.slice(0, 80);
  });
}

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(uploadForm);
  const file = formData.get('video');
  const submitBtn = document.getElementById('upload-submit-btn')
    || uploadForm.querySelector('button[type="submit"]')
    || uploadForm.querySelector('button');
  if (!file || !(file instanceof File) || file.size === 0) {
    if (uploadStatus) uploadStatus.textContent = '请先选择要上传的视频文件。';
    return;
  }

  const authToken = resolveAuthToken() || token;
  if (!authToken) {
    if (uploadStatus) uploadStatus.textContent = '请先登录后再上传视频。';
    return;
  }

  if (uploadStatus) uploadStatus.textContent = '正在上传…请勿离开页面。';
  if (submitBtn) submitBtn.disabled = true;

  try {
    const response = await fetch(`${API_BASE}/video-resources/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      },
      body: formData,
    });

    const result = await response.json().catch(() => ({}));

    if (response.status === 401) {
      throw new Error('登录已过期，请重新登录后再上传。');
    }
    if (response.status === 403) {
      throw new Error(result.message === 'GUEST_UPLOAD_FORBIDDEN' || result.code === 'GUEST_UPLOAD_FORBIDDEN'
        ? '游客不能上传。请先注册或登录。'
        : (result.message || '今日上传次数已用完，或没有上传权限。'));
    }
    if (response.status === 413) {
      throw new Error('文件太大，请压缩后再上传。');
    }
    if (response.status === 409 && result.existing_video_id) {
      if (uploadStatus) {
        uploadStatus.textContent = result.message || '该视频已存在，正在打开…';
      }
      await loadVideos();
      selectVideo(result.existing_video_id);
      return;
    }

    if (!response.ok) {
      throw new Error(result.message || result.code || '上传失败，请稍后重试。');
    }

    if (result.error) {
      uploadStatus.textContent = result.error;
    } else if (response.status === 202) {
      uploadStatus.textContent = '上传成功，正在后台转写字幕…';
    } else {
      uploadStatus.textContent = '上传并转写完成。';
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
    if (uploadStatus) {
      uploadStatus.textContent = (err && err.message) || '上传失败，请稍后重试。';
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    const msg = uploadStatus ? String(uploadStatus.textContent || '') : '';
    const keep = /失败|登录|权限|太大|游客/.test(msg);
    if (!keep) {
      setTimeout(() => {
        if (uploadStatus && !/失败|登录|权限|太大|游客/.test(String(uploadStatus.textContent || ''))) {
          uploadStatus.textContent = '';
        }
      }, 5000);
    }
  }
});

videoListEl.addEventListener('click', function (event) {
  if (event.target.closest('.video-action-btn')) return;
  const item = event.target.closest('.video-item');
  if (!item) return;
  const raw = item.getAttribute('data-id');
  if (raw == null || raw === '') return;
  const id = /^\d+$/.test(String(raw)) ? Number(raw) : raw;
  selectVideo(id);
});

// 供频道 / 播客侧栏选取
window.selectVideo = selectVideo;
window.LinglishVideoReaderState = state;

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

  // 处理整个字幕段点击：只练这一句，播完停下（不连播下一段）
  const segmentEl = event.target.closest('.transcript-segment');
  if (segmentEl) {
    const time = Number(segmentEl.getAttribute('data-start'));
    const end = Number(segmentEl.getAttribute('data-end'));
    if (Number.isFinite(time)) {
      if (Number.isFinite(end) && end > time + 0.2) {
        state.segmentPlaybackEnd = end;
      } else {
        state.segmentPlaybackEnd = time + 4;
      }
      state.segmentPlaybackCallback = null;
      if (youtubePlayer?.player || (youtubePlayer && typeof youtubePlayer.seekTo === 'function')) {
        try {
          youtubePlayer.seekTo(time, true);
          if (typeof youtubePlayer.play === 'function') youtubePlayer.play();
          else if (typeof youtubePlayer.playVideo === 'function') youtubePlayer.playVideo();
        } catch (_) {}
      } else if (videoPlayer) {
        videoPlayer.currentTime = time;
        safePlayVideo();
      }
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
  const current = videoPlayer.currentTime;

  // 即时更新时间显示（轻量级操作）— 播客无字幕时也要走进度条
  if (mobileCurrentTime) {
    mobileCurrentTime.textContent = formatTime(current);
  }
  if (mobileProgress && videoPlayer.duration && !Number.isNaN(videoPlayer.duration) && !isMobileProgressDragging) {
    mobileProgress.value = (current / videoPlayer.duration) * 100;
  }
  if (mobileDuration && videoPlayer.duration && !Number.isNaN(videoPlayer.duration)) {
    mobileDuration.textContent = formatTime(videoPlayer.duration);
  }

  if (!state.currentSegments.length) return;

  // 节流localStorage写入：只在进度变化且超过间隔时才写入
  const now = Date.now();
  if (state.selectedVideoId && Number.isFinite(videoPlayer.duration) && videoPlayer.duration > 0) {
    const percent = Math.min(100, Math.max(0, Math.round((current / videoPlayer.duration) * 100)));
    if (percent !== lastProgressPercent && (now - lastProgressSaveTime) > PROGRESS_SAVE_INTERVAL) {
      try {
        localStorage.setItem(`video_progress_${state.selectedVideoId}`, String(percent));
        lastProgressPercent = percent;
        lastProgressSaveTime = now;
        rememberPlaybackProgress(current, videoPlayer.duration);
      } catch (_) { }
    }
  }

  // Source-anchored clock: raw cue by time → display card.
  // 应用字幕偏移：正值=字幕提前，负值=字幕延迟
  const adjustedTime = current + state.subtitleOffset;
  let index = currentSegmentIndexByTime(adjustedTime);

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

    // 移动端：更新移动字幕窗口（跟读进行中锁在当前句）
    if (isMobile) {
      if (mobileShadowBusy && Number.isFinite(mobileSegmentPosition)) {
        renderMobileTranscriptWindow(mobileSegmentPosition);
      } else {
        mobileSegmentPosition = index;
        renderMobileTranscriptWindow(index);
      }
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
          v = pref && pref.startsWith('zh-') ? 'zh-CN' : 'en-US';
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
      utterance.lang = voiceLang.startsWith('zh') ? 'zh-CN' : 'en-US';
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
  const ensureTranscriptPaint = function () {
    const currentVideo = state.videos.find((v) => String(v.id) === String(videoId));
    if (currentVideo && String(state.selectedVideoId) === String(videoId)) {
      renderTranscript(currentVideo);
    }
  };
  if (!practicePanel) {
    ensureTranscriptPaint();
    return;
  }
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

    ensureTranscriptPaint();

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
    ensureTranscriptPaint();
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
    playMicReadyCue();
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
  // Save the recording blob for comparison / self-preview
  rememberLastRecording(blob, line && Number.isFinite(line.index) ? line.index : mobileSegmentPosition);
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
  if (!input) return;
  const tagName = input.value.trim();
  if (!tagName) {
    showToast('先输入标签名再点 +', 'warn');
    input.focus();
    return;
  }

  if (state.tags.includes(tagName)) {
    showToast('标签已存在', 'warn');
    input.focus();
    input.select();
    return;
  }

  state.tags.push(tagName);
  saveTagsToLocalStorage();
  renderTagList();
  input.value = '';
  showToast(`已添加「${tagName}」`, 'success');
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

function currentMobileStudyMode() {
  const mode = document.body.dataset.studyMode || '';
  if (mode === 'coach' || mode === 'arena' || mode === 'video') return mode;
  if (document.body.classList.contains('study-mode-coach')) return 'coach';
  if (document.body.classList.contains('study-mode-arena')) return 'arena';
  return 'video';
}

function mobileLibraryClosedLabel(mode) {
  return (mode === 'coach' || mode === 'arena') ? '换片' : '视频库';
}

function renderToggleSidebarControl(isExpanded, label) {
  const btn = document.getElementById('toggle-sidebar-btn');
  if (!btn) return;
  const mode = currentMobileStudyMode();
  const closedText = mobileLibraryClosedLabel(mode);
  const accessibleLabel = label
    || (isExpanded ? '关闭视频库' : ((mode === 'coach' || mode === 'arena') ? '回视频学习换内容' : '打开视频库'));
  btn.setAttribute('aria-expanded', String(Boolean(isExpanded)));
  btn.setAttribute('aria-label', accessibleLabel);
  btn.title = isExpanded
    ? accessibleLabel
    : ((mode === 'coach' || mode === 'arena') ? '换内容请到视频学习' : '视频库');
  btn.classList.toggle('is-library-open', Boolean(isExpanded));
  btn.classList.toggle('is-change-media', !isExpanded && (mode === 'coach' || mode === 'arena'));

  if (document.body.classList.contains('video-reader-mobile-focus')) {
    const text = isExpanded ? '关闭' : closedText;
    let labelEl = btn.querySelector('.mobile-reader-lib-label');
    if (!labelEl) {
      btn.innerHTML = '<span class="mobile-reader-lib-label"></span>';
      labelEl = btn.querySelector('.mobile-reader-lib-label');
    }
    if (labelEl) labelEl.textContent = text;
    return;
  }

  btn.textContent = isExpanded ? '✕' : '☰';
}

function syncMobileStudyLibraryChrome() {
  if (!document.body.classList.contains('video-reader-mobile-focus')) return;
  const expanded = document.body.classList.contains('mobile-library-open');
  renderToggleSidebarControl(expanded, expanded ? '关闭视频库' : undefined);
  syncMobileSharedMediaBanner();
}
window.syncMobileStudyLibraryChrome = syncMobileStudyLibraryChrome;

function readMobileSharedMediaTitle() {
  try {
    const sel = window.LinglishStudySelection && typeof window.LinglishStudySelection.read === 'function'
      ? window.LinglishStudySelection.read()
      : null;
    if (sel && (sel.title || sel.original_filename)) return String(sel.title || sel.original_filename);
  } catch (_) {}
  try {
    const current = state.videos && state.videos.find((item) => String(item.id) === String(state.selectedVideoId));
    if (current) return String(current.title || current.original_filename || '').trim();
  } catch (_) {}
  try {
    if (window.LinglishStudyMedia && window.LinglishStudyMedia.title) {
      return String(window.LinglishStudyMedia.title);
    }
  } catch (_) {}
  return '';
}

function syncMobileSharedMediaBanner() {
  if (!document.body.classList.contains('video-reader-mobile-focus')) return;
  const mode = currentMobileStudyMode();
  const header = document.querySelector('.mobile-reader-header');
  if (!header) return;
  let banner = document.getElementById('mobile-shared-media-banner');
  if (mode !== 'coach' && mode !== 'arena') {
    if (banner) banner.hidden = true;
    document.body.classList.remove('has-shared-media-banner');
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'mobile-shared-media-banner';
    banner.className = 'mobile-shared-media-banner';
    banner.setAttribute('role', 'status');
    header.insertAdjacentElement('afterend', banner);
  }
  const title = readMobileSharedMediaTitle();
  const hasContent = Boolean(title)
    || Boolean(state.selectedVideoId)
    || (window.LinglishStudySelection && typeof window.LinglishStudySelection.hasContent === 'function'
      && window.LinglishStudySelection.hasContent());
  banner.hidden = false;
  document.body.classList.add('has-shared-media-banner');
  banner.innerHTML = hasContent
    ? `<span class="mobile-shared-media-lock">跟视频学习同一内容</span><strong class="mobile-shared-media-title">${escapeHtml(title || '已选内容')}</strong>`
    : `<span class="mobile-shared-media-lock">还没选内容</span><button type="button" class="mobile-shared-media-pick" data-shared-pick>去视频学习选</button>`;
  const pick = banner.querySelector('[data-shared-pick]');
  if (pick && !pick.dataset.wired) {
    pick.dataset.wired = '1';
    pick.addEventListener('click', () => {
      if (window.LinglishStudySelection && typeof window.LinglishStudySelection.openPicker === 'function') {
        window.LinglishStudySelection.openPicker('videos');
      } else {
        openMobileVideoLibrary('videos');
      }
    });
  }
}

function openMobileVideoLibrary(libSrc) {
  if (
    !document.body.classList.contains('video-reader-mobile-focus') ||
    !mobileSidebarLayout ||
    !toggleSidebarBtn ||
    !videoSidebar
  ) {
    return;
  }
  // AI陪练 / 实战场不独立换片：先回到视频学习再选
  const studyMode = currentMobileStudyMode();
  if (studyMode === 'coach' || studyMode === 'arena') {
    if (typeof window.switchVideoStudyMode === 'function') {
      window.switchVideoStudyMode('video');
    } else {
      document.body.dataset.studyMode = 'video';
      document.body.classList.remove('study-mode-coach', 'study-mode-arena');
    }
    try {
      setMobileSpeakHint('换内容请在「视频学习」里选；选好后再去 AI陪练 / 实战场', { toast: true });
    } catch (_) {}
  }
  // Voice DM is fullscreen above the library — close it so picks stay tappable.
  try {
    const bridge = window.LinglishVoiceChatBridge;
    if (bridge && typeof bridge.closeSession === 'function') bridge.closeSession();
  } catch (_) {}
  if (firstLessonSession && firstLessonSession.isActive && firstLessonSession.isActive()) {
    firstLessonSession.deactivate('library-open');
  }
  applyMobileVideoLibraryState(mobileSidebarLayout.openSidebarState
    ? mobileSidebarLayout.openSidebarState()
    : mobileSidebarLayout.nextSidebarState(true));
  syncMobileStudyLibraryChrome();
  if (libSrc) {
    const tab = document.querySelector(`[data-lib-src="${libSrc}"]`);
    if (tab) tab.click();
    else if (window.LinglishMobileMediaLibrary && typeof window.LinglishMobileMediaLibrary.setView === 'function') {
      const view = libSrc === 'channels' || libSrc === 'podcasts' ? libSrc : 'videos';
      window.LinglishMobileMediaLibrary.setView(view);
    }
  }
}
window.openMobileVideoLibrary = openMobileVideoLibrary;

function syncPodcastFaceplatePlayState() {
  const wrapper = document.getElementById('video-wrapper');
  const playIcon = document.getElementById('podcast-faceplate-play');
  const plate = document.getElementById('podcast-faceplate');
  let playing = false;
  try {
    playing = Boolean(videoPlayer && !videoPlayer.paused && !videoPlayer.ended);
  } catch (_) {}
  if (wrapper) wrapper.classList.toggle('is-playing', playing);
  if (playIcon) playIcon.textContent = playing ? '❚❚' : '▶';
  if (plate) plate.setAttribute('aria-label', playing ? '暂停播客' : '播放播客');
}

function togglePodcastPlaybackFromFaceplate() {
  if (!videoPlayer) return;
  const current = state.videos.find((item) => String(item.id) === String(state.selectedVideoId));
  if (!(current && current.external_podcast)) return;
  if (!String(videoPlayer.currentSrc || videoPlayer.src || '').trim()) {
    showPodcastPlaybackError('这一集还没有加载音频，请返回列表重新打开');
    return;
  }
  if (videoPlayer.paused || videoPlayer.ended) {
    safePlayVideo().finally(() => {
      syncMobilePlayButton();
      syncPodcastFaceplatePlayState();
    });
    return;
  }
  try { videoPlayer.pause(); } catch (_) {}
  syncMobilePlayButton();
  syncPodcastFaceplatePlayState();
}

function syncPodcastFaceplate(video) {
  const wrapper = document.getElementById('video-wrapper');
  const plate = document.getElementById('podcast-faceplate');
  const art = document.getElementById('podcast-faceplate-art');
  const titleEl = document.getElementById('podcast-faceplate-title');
  const metaEl = document.getElementById('podcast-faceplate-meta');
  const errEl = document.getElementById('podcast-faceplate-error');
  const isPod = Boolean(video && video.external_podcast);
  if (wrapper) wrapper.classList.toggle('is-podcast', isPod);
  if (!plate) return;
  if (!isPod) {
    plate.hidden = true;
    if (wrapper) wrapper.classList.remove('is-playing');
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = '';
    }
    return;
  }
  plate.hidden = false;
  if (titleEl) titleEl.textContent = video.title || video.original_filename || '播客';
  if (metaEl) {
    metaEl.textContent = video.collection_name
      ? `${video.collection_name} · 点封面播放`
      : '点封面播放 / 暂停';
  }
  if (art) {
    const src = video.thumbnail_path || '';
    if (src) {
      art.hidden = false;
      art.src = src;
    } else {
      art.removeAttribute('src');
      art.hidden = true;
    }
  }
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = '';
  }
  syncPodcastFaceplatePlayState();
}

function showPodcastPlaybackError(message) {
  const errEl = document.getElementById('podcast-faceplate-error');
  const text = message || '音频暂时播不了，请换一集或检查网络';
  if (errEl) {
    errEl.hidden = false;
    errEl.textContent = text;
  }
  showSmartImportToast(text);
}

function applyMobileVideoLibraryState(nextState) {
  if (!nextState || !toggleSidebarBtn || !videoSidebar) return;
  videoSidebar.classList.toggle('hidden', nextState.hidden);
  renderToggleSidebarControl(nextState.expanded, nextState.label);
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
  syncMobileStudyLibraryChrome();
}
window.closeMobileVideoLibrary = closeMobileVideoLibrary;

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
      // 打开库必须走 openMobileVideoLibrary，陪练/实战场会先回视频学习
      if (videoSidebar.classList.contains('hidden')) {
        openMobileVideoLibrary();
        return;
      }
      closeMobileVideoLibrary();
      return;
    }
    videoSidebar.classList.toggle('hidden');
    renderToggleSidebarControl(!videoSidebar.classList.contains('hidden'));
  });
}

if (mobileLibraryBackdrop) {
  mobileLibraryBackdrop.addEventListener('click', closeMobileVideoLibrary);
}

const mobileLibraryQuick = document.getElementById('mobile-library-quick');
if (mobileLibraryQuick) {
  mobileLibraryQuick.addEventListener('click', function (event) {
    const btn = event.target && event.target.closest
      ? event.target.closest('[data-open-lib]')
      : null;
    if (!btn) return;
    openMobileVideoLibrary(btn.getAttribute('data-open-lib'));
  });
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
  // mobile-view-btn also covers 英文/双语/上一句/下一句 — only sync layout modes here
  mobileViewBtns.forEach((btn) => {
    const btnMode = btn.getAttribute('data-mode');
    if (btnMode === 'english' || btnMode === 'bilingual' || btnMode === 'prev' || btnMode === 'next') {
      return;
    }
    btn.classList.toggle('active', btnMode === mode);
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

    // 处理字幕语言切换按钮：双语 = 英文 + 中文翻译
    if (mode === 'english' || mode === 'bilingual') {
      state.showBilingual = (mode === 'bilingual');
      if (mode === 'bilingual') bilingualLoginBlocked = false;
      syncMobileBilingualClass();
      try {
        localStorage.setItem('transcript_mode', mode === 'bilingual' ? 'bi' : 'en');
      } catch (e) {
        console.warn('Failed to save transcript mode:', e);
      }
      mobileViewBtns.forEach(b => {
        const bMode = b.getAttribute('data-mode');
        if (bMode === 'english' || bMode === 'bilingual') {
          b.classList.toggle('active', bMode === mode);
        }
      });
      lastMobileRenderPosition = -1;
      renderMobileTranscriptWindow(mobileSegmentPosition);
      if (mode === 'bilingual') {
        setMobileSpeakHint('双语：英文字幕 + 中文翻译');
      } else {
        setMobileSpeakHint('仅显示英文字幕');
      }
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
syncMobileBilingualClass();
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

function applyPlaybackSpeed(speed) {
  if (!Number.isFinite(speed)) return;
  if (videoPlayer) {
    try { videoPlayer.playbackRate = speed; } catch (_) {}
  }
  try {
    if (youtubePlayer && typeof youtubePlayer.setPlaybackRate === 'function') {
      youtubePlayer.setPlaybackRate(speed);
    }
  } catch (_) {}
}

const updateSpeedDisplay = (value) => {
  const label = `${formatSpeedLabel(value)}x`;
  if (speedToggleButton) speedToggleButton.textContent = label;
  const mobileTrigger = document.getElementById('mobile-speed-trigger');
  if (mobileTrigger) mobileTrigger.textContent = label;
};

function setMobileSpeedMenuOpen(open) {
  const trigger = document.getElementById('mobile-speed-trigger');
  const menu = document.getElementById('mobile-speed-menu');
  if (!trigger || !menu) return;
  const next = Boolean(open);
  menu.hidden = !next;
  trigger.setAttribute('aria-expanded', next ? 'true' : 'false');
  document.body.classList.toggle('mobile-speed-menu-open', next);
}

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
    const on = Number.isFinite(mobileSpeed) && Math.abs(mobileSpeed - rate) < 0.001;
    mobileBtn.classList.toggle('active', on);
    mobileBtn.setAttribute('aria-selected', on ? 'true' : 'false');
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
    applyPlaybackSpeed(speed);
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
    applyPlaybackSpeed(speed);
    syncSpeedButtons(speed);
    updateSpeedDisplay(speed);
    setMobileSpeakHint(`速度 ${formatSpeedLabel(speed)}x`);
    setMobileSpeedMenuOpen(false);
    if (speedFloatingMenu && speedFloatingMenu.classList.contains('open')) {
      speedFloatingMenu.classList.remove('open');
      if (speedToggleButton) {
        speedToggleButton.setAttribute('aria-expanded', 'false');
      }
    }
  });
});

(function bindMobileSpeedDropdown() {
  const trigger = document.getElementById('mobile-speed-trigger');
  const menu = document.getElementById('mobile-speed-menu');
  const shell = document.getElementById('mobile-speed-controls');
  if (!trigger || !menu) return;

  trigger.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    setMobileSpeedMenuOpen(menu.hidden);
  });

  document.addEventListener('click', function (event) {
    if (menu.hidden) return;
    if (shell && shell.contains(event.target)) return;
    setMobileSpeedMenuOpen(false);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !menu.hidden) {
      setMobileSpeedMenuOpen(false);
      trigger.focus();
    }
  });
})();

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

function syncMobilePlayButton() {
  if (!mobilePlayBtn) return;
  if (mobileShadowHolding) {
    mobilePlayBtn.classList.add('is-holding');
    mobilePlayBtn.classList.toggle('is-mic-warming', !mobileShadowMicReady);
    mobilePlayBtn.textContent = mobileShadowMicReady ? '●' : '…';
    mobilePlayBtn.setAttribute('aria-label', mobileShadowMicReady ? '松开结束跟读' : '开麦中');
    return;
  }
  let playing = false;
  try {
    const transport = typeof coachingTransport === 'function' ? coachingTransport() : null;
    if (transport && typeof transport.isPlaying === 'function') {
      playing = Boolean(transport.isPlaying());
    } else if (videoPlayer) {
      playing = !videoPlayer.paused && !videoPlayer.ended;
    }
  } catch (_) {}
  mobilePlayBtn.classList.remove('is-holding', 'is-mic-warming', 'is-await-hold');
  syncMobilePlayHoldLabel('');
  mobilePlayBtn.classList.toggle('is-playing', playing);
  mobilePlayBtn.textContent = playing ? '❚❚' : '▶';
  mobilePlayBtn.setAttribute('aria-label', playing ? '暂停（长按说话）' : '播放（长按说话）');
  mobilePlayBtn.setAttribute('title', '点按播放/暂停 · 长按像微信一样说话');
  if (mobileSpeakHint && !mobileShadowBusy) {
    if (playing) {
      setMobileSpeakHint('点按暂停 · 长按说话');
    } else if (state.lastRecordingBlob) {
      setMobileSpeakHint('可在⋯里听自己，或长按播放键再说一次');
    } else {
      setMobileSpeakHint('点按播放/暂停 · 长按中间键说话');
    }
  }
}

function replayMobileCurrentClip() {
  const transport = typeof coachingTransport === 'function' ? coachingTransport() : null;
  const segment = getMobileShadowSegment();
  let seekTo = 0;
  if (segment) {
    seekTo = Math.max(0, segment.start + 0.01);
    mobileSegmentPosition = segment.index;
    setMobileSpeakHint('重新播放本句');
  } else {
    let now = 0;
    try {
      now = transport && typeof transport.getCurrentTime === 'function'
        ? Number(transport.getCurrentTime()) || 0
        : (videoPlayer ? Number(videoPlayer.currentTime) || 0 : 0);
    } catch (_) {}
    // 暂无字幕时：回到开头，或从当前位置回退 5 秒再播
    seekTo = now > 2 ? Math.max(0, now - 5) : 0;
    setMobileSpeakHint(seekTo > 0 ? '从刚才位置重新播放' : '从头重新播放');
  }
  try {
    if (transport && typeof transport.seek === 'function') transport.seek(seekTo);
    else if (videoPlayer) videoPlayer.currentTime = seekTo;
  } catch (_) {
    if (videoPlayer) {
      try { videoPlayer.currentTime = seekTo; } catch (__) {}
    }
  }
  if (segment) {
    state.segmentPlaybackEnd = segment.end;
    state.segmentPlaybackCallback = () => {
      try { pauseLearningVideoNow(); } catch (_) {}
      syncMobilePlayButton();
    };
  }
  return safePlayVideo().finally(syncMobilePlayButton);
}

function syncMobileReviewSheet() {
  const hearBtn = document.getElementById('mobile-review-hear-me');
  const hint = document.getElementById('mobile-review-hint');
  const hasMine = Boolean(state.lastRecordingUrl || state.lastRecordingBlob);
  if (hearBtn) hearBtn.disabled = !hasMine;
  if (hint) {
    hint.textContent = hasMine
      ? '左右对比：先听原句，再听自己的跟读。'
      : '还没有跟读录音。长按中间播放键说完一句，再回来听自己。';
  }
}

function openMobileFeatureSheet() {
  const sheet = document.getElementById('mobile-feature-sheet');
  if (!sheet) return;
  syncMobileReviewSheet();
  sheet.hidden = false;
  document.body.classList.add('mobile-feature-open');
}

function closeMobileFeatureSheet() {
  const sheet = document.getElementById('mobile-feature-sheet');
  if (sheet) sheet.hidden = true;
  document.body.classList.remove('mobile-feature-open');
}

function closeMobileMicSheet() {
  const sheet = document.getElementById('mobile-mic-sheet');
  if (sheet) sheet.hidden = true;
  document.body.classList.remove('mobile-feature-open');
}

function openMobileMicSheet() {
  const sheet = document.getElementById('mobile-mic-sheet');
  if (!sheet) return;
  sheet.hidden = false;
  document.body.classList.add('mobile-feature-open');
  refreshMobileMicList().catch(() => {});
}
try { window.openMobileMicSheet = openMobileMicSheet; } catch (_) {}

async function refreshMobileMicList() {
  const list = document.getElementById('mobile-mic-list');
  const mic = window.LinglishShadowMic;
  if (!list || !mic || typeof mic.listAudioInputs !== 'function') return;
  list.innerHTML = '<p class="mobile-mic-hint">正在读取麦克风…</p>';
  let inputs = [];
  try {
    inputs = await mic.listAudioInputs({ warm: true });
  } catch (_) {
    inputs = [];
  }
  const preferred = typeof mic.getPreferredMicId === 'function' ? mic.getPreferredMicId() : '';
  list.innerHTML = '';
  if (!inputs.length) {
    list.innerHTML = '<p class="mobile-mic-hint">没读到设备。请先允许麦克风，并确认领夹麦 / 耳机已连接。</p>';
    return;
  }
  inputs.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mobile-feature-item';
    btn.setAttribute('data-mic-id', item.deviceId || '');
    btn.textContent = item.label || '麦克风';
    if ((item.deviceId || '') === (preferred || '') || item.preferred) {
      btn.classList.add('is-selected');
    }
    list.appendChild(btn);
  });
}

function chooseMobileMic(deviceId) {
  const mic = window.LinglishShadowMic;
  if (mic && typeof mic.setPreferredMicId === 'function') {
    mic.setPreferredMicId(deviceId || '');
  }
  closeMobileMicSheet();
  setMobileSpeakHint(deviceId
    ? '已切换麦克风，可开始跟读'
    : '已用系统默认麦克风', { toast: true, kind: 'success' });
}

function runMobileFeature(feature) {
  closeMobileFeatureSheet();
  if (feature === 'mic') {
    openMobileMicSheet();
    return;
  }
  if (feature === 'replay-original') {
    replayMobileCurrentClip();
    setMobileSpeakHint('正在听原句', { toast: true });
    return;
  }
  if (feature === 'shadow' || feature === 'shadow-again') {
    setMobileSpeakHint('请长按中间播放键说话，说完再松手', { toast: true });
    syncMobilePlayHoldLabel('长按说话');
    if (mobilePlayBtn) {
      mobilePlayBtn.classList.add('is-await-hold');
      try { mobilePlayBtn.focus({ preventScroll: true }); } catch (_) {}
    }
    // Warm the same hold-ready path used by 跟读, without showing a second button.
    startMobileSentenceShadow().catch(() => setMobileSpeakHint('跟读失败，请再试一次'));
    return;
  }
  if (feature === 'hear-me') {
    if (!state.lastRecordingUrl && !state.lastRecordingBlob) {
      setMobileSpeakHint('还没有跟读录音，先长按中间键说一句', { toast: true, kind: 'warn' });
      return;
    }
    playLastRecordingPreview();
    setMobileSpeakHint('正在听自己的跟读', { toast: true });
    return;
  }
  if (feature === 'prev') {
    navigateMobileSegment(-1);
    setMobileSpeakHint('上一句');
    return;
  }
  if (feature === 'next') {
    navigateMobileSegment(1);
    setMobileSpeakHint('下一句');
    return;
  }
  if (feature === 'english' || feature === 'bilingual') {
    const btn = document.querySelector(`.mobile-view-btn[data-mode="${feature}"]`);
    if (btn) btn.click();
    else {
      state.showBilingual = feature === 'bilingual';
      renderMobileTranscriptWindow(mobileSegmentPosition);
    }
    setMobileSpeakHint(feature === 'bilingual' ? '已切到双语字幕' : '已切到仅英文');
    return;
  }
  if (feature === 'coach') {
    setMobileSpeakHint('带教功能已关闭');
  }
}

if (mobileReplayBtn) {
  mobileReplayBtn.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    replayMobileCurrentClip();
  });
}

function toggleMobilePlayPause() {
  let playing = false;
  try {
    const transport = typeof coachingTransport === 'function' ? coachingTransport() : null;
    if (transport && typeof transport.isPlaying === 'function') {
      playing = Boolean(transport.isPlaying());
    } else if (videoPlayer) {
      playing = !videoPlayer.paused && !videoPlayer.ended;
    }
  } catch (_) {}
  if (playing) {
    pauseLearningVideoNow();
    syncMobilePlayButton();
    return;
  }
  safePlayVideo().finally(syncMobilePlayButton);
}

/** Mobile video-reader always uses X-DM 跟读回听 when the bridge is loaded. */
function canUseMobileVoiceChatHold() {
  const bridge = window.LinglishVoiceChatBridge;
  return !!(bridge && typeof bridge.beginHold === 'function');
}

function isMobileCoachVoiceMode() {
  // Prefer chat hold on all mobile study modes once the session bridge exists.
  if (canUseMobileVoiceChatHold()) return true;
  return document.body.classList.contains('study-mode-coach')
    || document.body.dataset.studyMode === 'coach'
    || document.body.classList.contains('has-voice-chat');
}

function syncMobilePlayButtonVoiceHold(active, warming) {
  syncMobileHoldButton(active, warming);
  if (mobilePlayBtn) {
    mobilePlayBtn.classList.remove('is-holding', 'is-mic-warming', 'is-await-hold');
    if (!active && !warming) {
      try { syncMobilePlayButton(); } catch (_) {}
    }
  }
}
window.syncMobilePlayButtonVoiceHold = syncMobilePlayButtonVoiceHold;

window.LinglishMobilePlayback = {
  playSegmentBounds: (segment) => playSegmentBoundsForShadow(segment),
  pause: () => {
    try { pauseLearningVideoNow(); } catch (_) {}
  },
  setIndex: (index) => {
    const i = Number(index);
    if (!Number.isFinite(i) || i < 0) return;
    mobileSegmentPosition = i;
    try { renderMobileTranscriptWindow(i); } catch (_) {}
  },
  getIndex: () => mobileSegmentPosition,
};

function clearMobileCueKaraoke() {
  if (!mobileTranscriptList) return;
  mobileTranscriptList.querySelectorAll('.mobile-segment-text.is-karaoke').forEach((el) => {
    el.classList.remove('is-karaoke');
    const item = el.closest('.mobile-transcript-item');
    const idx = item ? Number(item.dataset.index) : NaN;
    const seg = Number.isFinite(idx) ? (state.currentSegments || [])[idx] : null;
    if (seg) el.textContent = seg.text || '';
  });
}

function paintMobileCueKaraoke(detail) {
  if (!mobileTranscriptList) return;
  if (!detail || !detail.holding) {
    clearMobileCueKaraoke();
    return;
  }
  const idx = Number(detail.index);
  if (!Number.isFinite(idx)) return;
  const item = mobileTranscriptList.querySelector('.mobile-transcript-item[data-index="' + idx + '"]')
    || mobileTranscriptList.querySelector('.mobile-transcript-item.active');
  if (!item) return;
  const textEl = item.querySelector('.mobile-segment-text');
  if (!textEl) return;
  const html = detail.html
    || (window.LinglishVoiceChatCoach && typeof window.LinglishVoiceChatCoach.karaokeEnHtml === 'function'
      ? window.LinglishVoiceChatCoach.karaokeEnHtml(detail.text || '', detail.hitCount || 0, detail.partial || 0)
      : '');
  if (!html) return;
  textEl.classList.add('is-karaoke');
  textEl.innerHTML = html;
}

window.addEventListener('linglish:voice-live-match', (event) => {
  try { paintMobileCueKaraoke(event && event.detail); } catch (_) {}
});

async function startMobilePlayButtonShadowHold() {
  mobilePlayLongPressArmed = true;
  mobilePlaySuppressClick = true;
  mobileShadowIgnoreClickUntil = Date.now() + 900;
  if (!mobilePlayPointerDown) {
    mobilePlayLongPressArmed = false;
    return;
  }

  // Same Hold pipeline as X DM compose — shared chat + karaoke sync.
  if (canUseMobileVoiceChatHold()) {
    const bridge = window.LinglishVoiceChatBridge;
    const chat = bridge && typeof bridge.getChat === 'function' ? bridge.getChat() : null;
    const segment = getMobileShadowSegment();
    try { pauseLearningVideoNow(); } catch (_) {}
    if (segment) {
      mobileSegmentPosition = segment.index;
      state.activeSegmentIndex = segment.index;
      try { renderMobileTranscriptWindow(segment.index); } catch (_) {}
      if (chat && typeof chat.lockPracticeTarget === 'function') {
        try { chat.lockPracticeTarget(segment.index); } catch (_) {}
      }
    }
    syncMobilePlayButtonVoiceHold(true, true);
    try {
      if (bridge && typeof bridge.beginHold === 'function') {
        await bridge.beginHold();
      }
      syncMobilePlayButtonVoiceHold(true, false);
      if (!mobilePlayPointerDown && bridge && typeof bridge.endHold === 'function') {
        await bridge.endHold();
        syncMobilePlayButtonVoiceHold(false, false);
      }
    } catch (err) {
      console.warn('[Mobile Play] voice chat hold failed', err);
      syncMobilePlayButtonVoiceHold(false, false);
    } finally {
      mobilePlayLongPressArmed = false;
    }
    return;
  }

  const segment = getMobileShadowSegment();
  if (!segment) {
    mobilePlayLongPressArmed = false;
    syncMobilePlayButtonVoiceHold(false, false);
    setMobileSpeakHint(state.isLoadingTranscript ? '字幕加载中…' : '暂无字幕，无法跟读', { toast: true, kind: 'warn' });
    return;
  }
  const mic = window.LinglishShadowMic;
  if (!mic || typeof mic.recordShadow !== 'function' || typeof mic.acquireMic !== 'function') {
    mobilePlayLongPressArmed = false;
    syncMobilePlayButtonVoiceHold(false, false);
    setMobileSpeakHint('跟读录音组件还没加载，请强制刷新后再试', { toast: true, kind: 'warn' });
    return;
  }
  try { pauseLearningVideoNow(); } catch (_) {}
  mobileSegmentPosition = segment.index;
  try { renderMobileTranscriptWindow(segment.index); } catch (_) {}
  mobileShadowBusy = true;
  mobileShadowAwaitHold = true;
  mobileShadowHoldSegment = segment;
  syncMobileShadowButton();
  try {
    await beginMobileShadowHoldRecord();
    if (!mobilePlayPointerDown && (mobileShadowHolding || mobileShadowHoldWanted)) {
      endMobileShadowHoldRecord();
    }
  } catch (err) {
    console.warn('[Mobile Play] hold shadow failed', err);
    resetMobileShadowUi();
    setMobileSpeakHint('跟读失败，请再按住试一次', { toast: true, kind: 'warn' });
  }
}

// Play = tap only. Mic = X-style Hold to record pill.
if (mobilePlayBtn) {
  mobilePlayBtn.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    const bridge = window.LinglishVoiceChatBridge;
    const voiceHolding = bridge && typeof bridge.isHolding === 'function' && bridge.isHolding();
    if (mobileShadowHolding || mobileShadowAwaitHold || voiceHolding || Date.now() < mobileShadowIgnoreClickUntil) {
      return;
    }
    toggleMobilePlayPause();
  });
}

if (mobileHoldBtn) {
  let holdPointerId = null;
  const onHoldStart = function (event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (mobilePlayPointerDown) return;
    event.preventDefault();
    event.stopPropagation();
    mobilePlayPointerDown = true;
    mobilePlaySuppressClick = true;
    holdPointerId = event.pointerId;
    try {
      if (typeof mobileHoldBtn.setPointerCapture === 'function') {
        mobileHoldBtn.setPointerCapture(event.pointerId);
      }
    } catch (_) {}
    clearMobilePlayLongPressTimer();
    startMobilePlayButtonShadowHold();
  };

  const onHoldEnd = function (event) {
    if (event && holdPointerId != null && event.pointerId !== holdPointerId) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
      try {
        if (holdPointerId != null && typeof mobileHoldBtn.releasePointerCapture === 'function') {
          mobileHoldBtn.releasePointerCapture(holdPointerId);
        }
      } catch (_) {}
    }
    holdPointerId = null;
    if (!mobilePlayPointerDown) return;
    mobilePlayPointerDown = false;
    const bridge = window.LinglishVoiceChatBridge;
    if (bridge && typeof bridge.isHolding === 'function' && bridge.isHolding()) {
      Promise.resolve(bridge.endHold()).finally(() => syncMobilePlayButtonVoiceHold(false, false));
      return;
    }
    // beginHold still opening mic — wait briefly then end if it became active
    if (bridge && typeof bridge.endHold === 'function') {
      window.setTimeout(() => {
        if (bridge.isHolding && bridge.isHolding()) {
          Promise.resolve(bridge.endHold()).finally(() => syncMobilePlayButtonVoiceHold(false, false));
        } else {
          syncMobilePlayButtonVoiceHold(false, false);
        }
      }, 80);
    }
    if (mobileShadowHolding || mobileShadowHoldWanted) {
      endMobileShadowHoldRecord();
    } else if (!bridge) {
      syncMobilePlayButtonVoiceHold(false, false);
    }
  };

  mobileHoldBtn.addEventListener('pointerdown', onHoldStart);
  mobileHoldBtn.addEventListener('pointerup', onHoldEnd);
  mobileHoldBtn.addEventListener('pointercancel', onHoldEnd);
  // Do NOT end on pointerleave — finger drift used to cancel hold instantly ("no reaction").
  mobileHoldBtn.addEventListener('lostpointercapture', onHoldEnd);
  mobileHoldBtn.addEventListener('contextmenu', function (event) {
    event.preventDefault();
  });
}

if (mobileContinueBtn) {
  mobileContinueBtn.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    const bridge = window.LinglishVoiceChatBridge;
    // ⋯ = 跟读回听（近十条字幕 + 语音气泡），无提示。
    if (bridge && typeof bridge.toggleSession === 'function') {
      try { closeMobileFeatureSheet(); } catch (_) {}
      bridge.toggleSession();
      return;
    }
    const sheet = document.getElementById('mobile-feature-sheet');
    if (sheet && !sheet.hidden) {
      closeMobileFeatureSheet();
      return;
    }
    openMobileFeatureSheet();
  });
}

(function bindMobileFeatureSheet() {
  const sheet = document.getElementById('mobile-feature-sheet');
  if (!sheet) return;
  const backdrop = document.getElementById('mobile-feature-backdrop');
  const cancel = document.getElementById('mobile-feature-cancel');
  if (backdrop) backdrop.addEventListener('click', closeMobileFeatureSheet);
  if (cancel) cancel.addEventListener('click', closeMobileFeatureSheet);
  sheet.addEventListener('click', function (event) {
    const item = event.target.closest('[data-feature]');
    if (!item) return;
    event.preventDefault();
    runMobileFeature(item.getAttribute('data-feature'));
  });
})();

(function bindMobileMicSheet() {
  const sheet = document.getElementById('mobile-mic-sheet');
  if (!sheet) return;
  const backdrop = document.getElementById('mobile-mic-backdrop');
  const cancel = document.getElementById('mobile-mic-cancel');
  if (backdrop) backdrop.addEventListener('click', closeMobileMicSheet);
  if (cancel) cancel.addEventListener('click', closeMobileMicSheet);
  sheet.addEventListener('click', function (event) {
    const item = event.target.closest('[data-mic-id]');
    if (!item) return;
    event.preventDefault();
    chooseMobileMic(item.getAttribute('data-mic-id') || '');
  });
})();

if (mobileShadowBtn) {
  const onShadowHoldStart = function (event) {
    if (!(mobileShadowAwaitHold || mobileShadowHolding)) return;
    if (mobileShadowHolding) return;
    if (event.type === 'mousedown' && event.button !== 0) return;
    // Prefer touch; ignore synthetic mouse after touch on WeChat/iOS.
    if (event.type === 'mousedown' && event.sourceCapabilities && event.sourceCapabilities.firesTouchEvents) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    beginMobileShadowHoldRecord().catch((err) => {
      console.warn('[Mobile Shadow] hold failed', err);
      resetMobileShadowUi();
      setMobileSpeakHint('录音失败，请再按住试一次', { toast: true, kind: 'warn' });
    });
  };

  mobileShadowBtn.addEventListener('touchstart', onShadowHoldStart, { passive: false });
  mobileShadowBtn.addEventListener('mousedown', onShadowHoldStart);
  // Release is handled on document so sliding off the button still finishes (WeChat-like).
  mobileShadowBtn.addEventListener('click', function (event) {
    if (mobileShadowAwaitHold || mobileShadowHolding || Date.now() < mobileShadowIgnoreClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      if (mobileShadowAwaitHold && !mobileShadowHolding) {
        setMobileSpeakHint('请按住说话，说完再松手', { toast: true });
      }
      return;
    }
    startMobileSentenceShadow().catch((err) => {
      console.warn('[Mobile Shadow] failed', err);
      resetMobileShadowUi();
      setMobileSpeakHint('跟读失败，请再试一次', { toast: true, kind: 'warn' });
    });
  });
}

if (mobileHearMeBtn) {
  mobileHearMeBtn.addEventListener('click', function () {
    playLastRecordingPreview();
  });
}

if (videoPlayer) {
  videoPlayer.addEventListener('play', () => {
    syncMobilePlayButton();
    syncPodcastFaceplatePlayState();
  });
  videoPlayer.addEventListener('pause', () => {
    syncMobilePlayButton();
    syncPodcastFaceplatePlayState();
  });
  videoPlayer.addEventListener('ended', () => {
    syncMobilePlayButton();
    syncPodcastFaceplatePlayState();
  });
}
syncMobilePlayButton();

if (mobileProgress) {
  function mobileSeekDuration() {
    try {
      if (youtubePlayer && typeof youtubePlayer.getDuration === 'function') {
        const ytDuration = Number(youtubePlayer.getDuration());
        if (ytDuration > 0 && !Number.isNaN(ytDuration)) return ytDuration;
      }
    } catch (_) {}
    if (videoPlayer && videoPlayer.duration && !Number.isNaN(videoPlayer.duration)) {
      return videoPlayer.duration;
    }
    return 0;
  }

  const commitMobileSeek = () => {
    const duration = mobileSeekDuration();
    if (!duration) {
      isMobileProgressDragging = false;
      return;
    }
    const fraction = Number(mobileProgress.value) / 100;
    const nextTime = Math.max(0, Math.min(duration * fraction, duration));
    try {
      if (youtubePlayer && typeof youtubePlayer.seekTo === 'function' && videoPlayer && videoPlayer.style.display === 'none') {
        youtubePlayer.seekTo(nextTime, true);
      } else if (videoPlayer) {
        videoPlayer.currentTime = nextTime;
      }
    } catch (_) {
      if (videoPlayer) videoPlayer.currentTime = nextTime;
    }
    isMobileProgressDragging = false;
  };

  mobileProgress.addEventListener('input', function () {
    const duration = mobileSeekDuration();
    if (!duration) return;
    isMobileProgressDragging = true;
    const fraction = Number(mobileProgress.value) / 100;
    const previewTime = duration * fraction;
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
  // Subtitle list: tap only (listen / select). Practice via bottom play long-press
  // or session 「Hold to record」— avoids finger covering the line.
  mobileTranscriptList.addEventListener('click', function (event) {
    // Tap a word → word card. Tap the rest of the cue → replay that line.
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

    // 单击字幕：锁定跟读目标 + 听这句；同一句正在播再点 → 暂停
    const item = event.target.closest('.mobile-transcript-item');
    if (!item || item.classList.contains('empty')) return;
    if (!isMobileLayout()) return;
    const index = Number(item.dataset.index);
    if (!Number.isFinite(index)) return;
    const segments = state.currentSegments || [];
    const segment = segments[index];
    if (!segment || !videoPlayer) return;

    const start = Number(segment.start);
    const end = Number(segment.end != null ? segment.end : start + 8);
    const t = Number(videoPlayer.currentTime);
    const playingThis = !videoPlayer.paused
      && Number.isFinite(start)
      && t >= start - 0.35
      && t <= end + 0.25;

    mobileSegmentPosition = index;
    state.activeSegmentIndex = index;
    try { renderMobileTranscriptWindow(mobileSegmentPosition); } catch (_) {}

    const bridge = window.LinglishVoiceChatBridge;
    const chat = bridge && typeof bridge.getChat === 'function' ? bridge.getChat() : null;
    if (chat && typeof chat.lockPracticeTarget === 'function') {
      try { chat.lockPracticeTarget(index); } catch (_) {}
    }

    if (playingThis) {
      try { pauseLearningVideoNow(); } catch (_) {}
      try { syncMobilePlayButton(); } catch (_) {}
      return;
    }

    if (Number.isFinite(start)) {
      videoPlayer.currentTime = Math.max(0, start);
      safePlayVideo();
    }
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
    utterance.lang = 'en-US';
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
          renderToggleSidebarControl(true, '关闭视频库');
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
      renderToggleSidebarControl(true, '关闭视频库');
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

try {
  if (document.body.classList.contains('video-reader-mobile-focus')) {
    setTimeout(() => {
      if (typeof syncMobileStudyLibraryChrome === 'function') syncMobileStudyLibraryChrome();
    }, 80);
  }
} catch (_) {}
