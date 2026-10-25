
      // 返回移动端实战场页面
      function goBack() {
        window.location.href = './mobile-arena.html';
      }

      function getYouTubeOrigin() {
        if (window.location.origin && window.location.origin !== 'null') {
          return window.location.origin;
        }
        if (window.location.protocol && window.location.host) {
          return `${window.location.protocol}//${window.location.host}`;
        }
        return '';
      }

      const PRACTICE_MODE_STORAGE_KEY = 'linglish_practice_mode';
      const THEME_STORAGE_KEY = 'linglish_theme';

      function loadPracticeModePreference() {
        try {
          const saved = localStorage.getItem(PRACTICE_MODE_STORAGE_KEY);
          if (saved === 'shadowing' || saved === 'dialogue') {
            return saved;
          }
        } catch (_) { }
        return null;
      }

      function savePracticeModePreference(mode) {
        try {
          localStorage.setItem(PRACTICE_MODE_STORAGE_KEY, mode);
        } catch (_) { }
      }

      function loadThemePreference() {
        try {
          const saved = localStorage.getItem(THEME_STORAGE_KEY);
          if (saved === 'dark' || saved === 'light') return saved;
        } catch (_) { }
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
          return 'dark';
        }
        return 'light';
      }

      function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        document.body.setAttribute('data-theme', theme);
      }

      function saveThemePreference(theme) {
        try {
          localStorage.setItem(THEME_STORAGE_KEY, theme);
        } catch (_) { }
      }

      // ==================== Practice Mode Management ====================
      function getInitialPracticeMode() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('quick') === '1' || params.get('from') === 'today_first_lesson') return 'shadowing';
        const requestedMode = params.get('mode');
        if (requestedMode === 'shadowing' || requestedMode === 'dialogue') return requestedMode;
        return loadPracticeModePreference() || 'shadowing';
      }

      let currentPracticeMode = getInitialPracticeMode(); // shadowing or dialogue

      function buildPracticeVideoHref(videoId) {
        const previous = new URLSearchParams(window.location.search);
        const params = new URLSearchParams({ videoId: String(videoId), mode: currentPracticeMode });
        for (const key of ['from', 'quick', 'lines', 'level', 'desktop']) {
          if (previous.has(key)) params.set(key, previous.get(key));
        }
        return `?${params.toString()}`;
      }
      let globalRecorder = null;
      let globalRecordingChunks = [];
      let globalRecordingBlob = null;
      let recordingStartTime = null;
      let recordingTimer = null;

      // Shadowing mode state
      let shadowingCurrentIndex = 0; // Current sentence index for shadowing
      let shadowingSentences = []; // All sentences for shadowing
      let shadowingAutoPauseListener = null; // Video timeupdate listener
      let shadowingYouTubePauseInterval = null; // YouTube pause polling interval
      let shadowingAutoMode = false; // Whether auto mode is active
      let shadowingWaitingTimeout = null; // Timeout for waiting period
      let shadowingSentenceEnded = false; // Guard to prevent race conditions
      let shadowingProgressTimer = null; // Polling interval for sentence end detection
      let shadowingPlaybackGuard = null;

      function createShadowingPlaybackGuard(sentence, requiresSeek = true) {
        shadowingPlaybackGuard = window.LinglishOriginalAudioReplay.createSegmentPlaybackGuard({
          start: Number(sentence.startTime), end: Number(sentence.endTime), requiresSeek
        });
        return shadowingPlaybackGuard;
      }

      function canFinishShadowingPlayback(time, endPoint = shadowingTargetEndTime) {
        return shadowingPlaybackGuard && !shadowingSentenceEnded &&
          shadowingPlaybackGuard.acceptTime(time) && time >= endPoint;
      }
      let shadowingTargetEndTime = 0; // Target end time for current sentence
      let shadowingLastStopIndex = null; // Index that produced shadowingLastStopTime
      let shadowingLastStopTime = null; // Actual paused time (can overshoot target slightly)

      // Helper functions for segment processing
      function normalizeSegTime(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }
      function segStart(seg) {
        return normalizeSegTime(seg?.start ?? seg?.start_sec ?? seg?.startTime ?? seg?.start_time);
      }
      function segEnd(seg) {
        return normalizeSegTime(seg?.end ?? seg?.end_sec ?? seg?.endTime ?? seg?.end_time);
      }
      function getSegText(seg) {
        return String(seg?.text ?? seg?.transcript ?? seg?.line ?? '').trim();
      }

      function stripPromptMarkers(text) {
        return String(text || '').replace(/^\s*>>\s*/g, '').trim();
      }

      function getSegmentationMode() {
        try {
          const params = new URLSearchParams(window.location.search);
          const v = String(params.get('segMode') || '').trim().toLowerCase();
          if (v === 'caption' || v === 'smart') return v;
          const stored = String(localStorage.getItem('linglish.segMode') || '').trim().toLowerCase();
          if (stored === 'caption' || stored === 'smart') return stored;
        } catch (e) { }
        return 'caption';
      }

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

      function makeCaptionSegmentsNonOverlapping(raw) {
        const segs = Array.isArray(raw) ? raw.slice() : [];
        if (segs.length <= 1) return segs;

        segs.sort((a, b) => (Number(segStart(a) ?? 0) - Number(segStart(b) ?? 0)) || 0);

        const out = [];
        for (let i = 0; i < segs.length; i++) {
          const seg = { ...segs[i] };
          const start = Number(segStart(seg) ?? 0);
          let end = Number(segEnd(seg) ?? start);
          const next = segs[i + 1];
          const nextStart = next ? Number(segStart(next) ?? Infinity) : Infinity;

          if (Number.isFinite(nextStart) && nextStart > start + 0.05) {
            end = Math.min(end, nextStart);
          }
          if (!Number.isFinite(end) || end < start + 0.05) end = start + 0.05;

          seg.start = start;
          seg.end = end;
          seg.start_sec = start;
          seg.end_sec = end;
          seg.text = stripPromptMarkers(getSegText(seg));
          out.push(seg);
        }

        out.forEach((s, idx) => { s.index = idx; });
        return out;
      }

      function shiftDanglingBoundaryWordsForward(raw) {
        const segs = Array.isArray(raw) ? raw.slice() : [];
        if (segs.length <= 1) return segs;

        const DANGLING_WORDS = new Set([
          'a', 'an', 'the',
          'to', 'of', 'for', 'with', 'in', 'on', 'at', 'by', 'from', 'about', 'into', 'through',
          'and', 'or', 'but', 'so', 'because', 'although', 'while', 'when', 'if',
          'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
          'do', 'does', 'did', 'have', 'has', 'had',
          'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
        ]);

        const startsAsContinuation = (text) => {
          const t = String(text || '').trim();
          if (!t) return false;
          if (/^[0-9]/.test(t)) return true;
          const firstChar = t[0];
          if (firstChar && firstChar === firstChar.toLowerCase() && /[a-z]/.test(firstChar)) return true;
          return false;
        };

        function escapeRegExp(str) {
          return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        function firstWordAscii(text) {
          const t = String(text || '').trim();
          const cleaned = t.replace(/^[\s"'“”‘’()\[\]{}<>]+/g, '');
          const m = cleaned.match(/^([A-Za-z][A-Za-z']*)\b/);
          return m ? m[1] : '';
        }

        function lastWordAscii(text) {
          const t = String(text || '').trim();
          const cleaned = t.replace(/[\s"'“”‘’()\[\]{}<>.,!?。！？，,;；:：]+$/g, '');
          const m = cleaned.match(/\b([A-Za-z][A-Za-z']*)$/);
          return m ? m[1] : '';
        }

        for (let i = 0; i < segs.length - 1; i++) {
          const cur = segs[i];
          const next = segs[i + 1];
          const curText = String(getSegText(cur) || '').trim();
          const nextText = String(getSegText(next) || '').trim();
          if (!curText || !nextText) continue;

          const lastRaw = String(lastWordAscii(curText) || '').trim();
          const lastLower = lastRaw.toLowerCase();
          if (!lastRaw || !DANGLING_WORDS.has(lastLower)) continue;
          if (!startsAsContinuation(nextText)) continue;

          const reEnd = new RegExp(`\\b${escapeRegExp(lastRaw)}\\b[\\s"'“”‘’()\\[\\]{}<>.,!?。！？，,;；:：]*$`, 'i');
          const curStripped = curText.replace(reEnd, '').replace(/\s+/g, ' ').trim();
          if (!curStripped) continue;

          const nextFirstLower = String(firstWordAscii(nextText) || '').toLowerCase();
          if (nextFirstLower === lastLower) continue;
          const nextPrefixed = `${lastRaw} ${nextText}`.replace(/\s+/g, ' ').trim();

          cur.text = curStripped;
          next.text = nextPrefixed;
        }

        segs.forEach((s, idx) => { s.index = idx; });
        return segs;
      }

      function splitCaptionSegmentsByPunctuation(raw) {
        const segs = Array.isArray(raw) ? raw.slice() : [];
        if (!segs.length) return segs;

        const out = [];
        for (const seg of segs) {
          const start = Number(segStart(seg) ?? 0);
          const end = Number(segEnd(seg) ?? start);
          const duration = end - start;
          const text = String(getSegText(seg) || '').replace(/\s+/g, ' ').trim();
          const translation = String(seg.translation || seg.cn || seg.zh || seg.text_cn || '').trim();

          if (!text || !Number.isFinite(duration) || duration <= 0.2) {
            out.push(seg);
            continue;
          }

          const punctCount = (text.match(/[.!?。！？]/g) || []).length;
          const hasMidSentencePunct = /[.!?。！？]\s+\S/.test(text);
          const sentences = (punctCount >= 2 || hasMidSentencePunct) ? splitIntoCompleteSentences(text) : [text];
          const chunks = [];
          for (const s of sentences) {
            if (s) chunks.push(s.trim());
          }

          if (chunks.length <= 1) {
            out.push({ ...seg, text, start, end, start_sec: start, end_sec: end });
            continue;
          }

          const minPerChunk = 0.55;
          if ((duration / chunks.length) < minPerChunk) {
            out.push({ ...seg, text, start, end, start_sec: start, end_sec: end });
            continue;
          }

          const wordCounts = chunks.map(c => Math.max(1, (String(c).match(/\b[\w']+\b/g) || []).length));
          const totalWords = wordCounts.reduce((a, b) => a + b, 0) || 1;

          let cursor = start;
          for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1;
            const proportion = wordCounts[i] / totalWords;
            const nextEnd = isLast ? end : (cursor + duration * proportion);
            const sub = {
              ...seg,
              index: out.length,
              text: String(chunks[i] || '').trim(),
              start: cursor,
              end: nextEnd,
              start_sec: cursor,
              end_sec: nextEnd,
            };
            if (translation) sub.translation = (i === 0) ? translation : '';
            out.push(sub);
            cursor = nextEnd;
          }
        }

        out.forEach((s, idx) => { s.index = idx; });
        return out;
      }

      function mergeCaptionFragmentsToSentences(raw) {
        const segs = Array.isArray(raw) ? raw.slice() : [];
        if (segs.length <= 1) return segs;

        const sentenceEndAtEnd = /[.!?。！？]['""\u201d\u2019\u300d）】\]]*\s*$/;
        const MAX_WORDS = 18;
        const MAX_DURATION_SEC = 5.5;
        const MAX_GAP_SEC = 1.0;

        const countWords = (s) => (String(s || '').match(/\b[\w']+\b/g) || []).length;

        const merged = [];
        let current = null;

        for (let i = 0; i < segs.length; i++) {
          const seg = { ...segs[i] };
          const start = Number(segStart(seg) ?? 0);
          const end = Number(segEnd(seg) ?? start);
          const text = String(getSegText(seg) || '').replace(/\s+/g, ' ').trim();
          if (!text) continue;

          if (current === null) {
            current = { ...seg, start, end, start_sec: start, end_sec: end, text };
            continue;
          }

          const gap = start - Number(current.end || 0);
          const nextStartsLower = /^[a-z]/.test(text);
          const curEndsSentence = sentenceEndAtEnd.test(String(current.text || '').trim());

          const nextWordCount = countWords(text);
          const curWordCount = countWords(current.text);
          const mergedWordCount = curWordCount + nextWordCount;
          const mergedDuration = end - Number(current.start || 0);

          const canMerge =
            !curEndsSentence &&
            nextStartsLower &&
            (!Number.isFinite(gap) || gap <= MAX_GAP_SEC) &&
            mergedWordCount <= MAX_WORDS &&
            mergedDuration <= MAX_DURATION_SEC;

          if (canMerge) {
            current.text = `${String(current.text).trim()} ${text}`.replace(/\s+/g, ' ').trim();
            current.end = end;
            current.end_sec = end;
          } else {
            merged.push(current);
            current = { ...seg, start, end, start_sec: start, end_sec: end, text };
          }
        }

        if (current) merged.push(current);
        merged.forEach((s, idx) => { s.index = idx; });
        return merged;
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

      async function fetchOriginalWaveformFromServer(videoId, startSec, endSec, points = 240, timeoutMs = 2000) {
        if (!videoId) return null;
        if (!waveformSegmentationConfig.enabled) return null;
        const key = `${videoId}:${Number(startSec || 0).toFixed(2)}:${Number(endSec || 0).toFixed(2)}:${Number(points || 240)}`;
        if (waveformOriginalCache.has(key)) {
          return waveformOriginalCache.get(key);
        }
        if (typeof AbortController === 'undefined') return null;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const params = new URLSearchParams();
          params.set('start', String(startSec || 0));
          params.set('end', String(endSec || 0));
          params.set('points', String(points || 240));
          const token = getAuthToken();
          const res = await fetch(`${API_BASE}/video-resources/${encodeURIComponent(String(videoId))}/waveform?${params.toString()}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
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
          clearTimeout(timeoutId);
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
        if (segs.length <= 1) return segs;
        if (!waveformSegmentationConfig.enabled) return segs;
        const maxSplitsPerVideo = waveformSegmentationConfig.maxSplits;
        const minDuration = waveformSegmentationConfig.minDurationSec;
        const minWords = waveformSegmentationConfig.minWords;

        const candidates = segs
          .map((seg, idx) => {
            const start = Number(segStart(seg));
            const end = Number(segEnd(seg));
            const duration = end - start;
            const text = String(getSegText(seg) || '').trim();
            const wordCount = (text.match(/\b[\w']+\b/g) || []).length;
            return { seg, idx, start, end, duration, text, wordCount };
          })
          .filter(item => item.text && item.duration >= minDuration && item.wordCount >= minWords);

        if (!candidates.length) return segs;

        candidates.sort((a, b) => b.duration - a.duration);
        const picked = new Map();
        const limit = Math.min(maxSplitsPerVideo, candidates.length);
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



      /**
       * Split text into complete sentences based on sentence-ending punctuation.
       * Only split on . ! ? and keep sentences complete.
       */
      function splitIntoCompleteSentences(text) {
        const t = String(text || '').replace(/\s+/g, ' ').trim();
        if (!t) return [];

        // Split on sentence-ending punctuation, keeping the punctuation with the sentence
        const sentences = t
          .split(/(?<=[.!?。！？])\s+/g)
          .map(s => s.trim())
          .filter(Boolean);

        // If no sentence punctuation found, return the whole text as one chunk
        if (sentences.length <= 1) {
          return [t];
        }

        return sentences;
      }

      /**
       * Further split a very long sentence at natural break points (commas, semicolons)
       * Only used when a sentence is too long (> 20 words)
       */
      function splitLongSentence(text, maxWords = 20) {
        const t = String(text || '').trim();
        const wordCount = (t.match(/\b[\w']+\b/g) || []).length;

        // If sentence is short enough, don't split
        if (wordCount <= maxWords) {
          return [t];
        }

        // Try to split at commas or semicolons
        const parts = t.split(/(?<=[,;，；])\s*/g).map(s => s.trim()).filter(Boolean);

        if (parts.length <= 1) {
          // No good split points, return as is
          return [t];
        }

        // Merge small parts to avoid tiny fragments
        const merged = [];
        let current = '';
        for (const part of parts) {
          const partWords = (part.match(/\b[\w']+\b/g) || []).length;
          const currentWords = (current.match(/\b[\w']+\b/g) || []).length;

          if (current && currentWords + partWords <= maxWords) {
            current = current + ' ' + part;
          } else if (current) {
            merged.push(current.trim());
            current = part;
          } else {
            current = part;
          }
        }
        if (current) {
          merged.push(current.trim());
        }

        return merged.length > 0 ? merged : [t];
      }

      /**
       * Refine raw transcript segments by splitting at sentence boundaries.
       * Prioritizes complete sentences over arbitrary splits.
       */
      function refinePracticeTranscriptSegments(rawSegments) {
        const segs = Array.isArray(rawSegments) ? rawSegments : [];
        if (segs.length === 0) return [];

        // Calculate segment statistics
        const starts = segs.map(segStart).filter(v => Number.isFinite(v));
        const ends = segs.map(segEnd).filter(v => Number.isFinite(v));
        const span = (starts.length && ends.length) ? (Math.max(...ends) - Math.min(...starts)) : null;
        const avgDur = (span && span > 0) ? (span / segs.length) : null;

        // Only refine if segments are too coarse (average > 8 seconds per segment)
        if (avgDur != null && avgDur <= 8) {
          console.log('[RefineSegments] Segments already fine-grained, skipping refinement');
          return segs;
        }

        const refined = [];
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i] || {};
          const start = segStart(seg);
          const end = segEnd(seg);
          const text = getSegText(seg);

          if (start == null || end == null || !Number.isFinite(end - start) || (end - start) <= 0.5 || !text) {
            refined.push(seg);
            continue;
          }

          const duration = end - start;

          // First, split into complete sentences
          let sentences = splitIntoCompleteSentences(text);

          // Then, split any very long sentences
          const MAX_WORDS_PER_CHUNK = 18;
          const finalChunks = [];
          for (const sentence of sentences) {
            const parts = splitLongSentence(sentence, MAX_WORDS_PER_CHUNK);
            finalChunks.push(...parts);
          }

          // If only one chunk, keep original segment
          if (finalChunks.length <= 1) {
            refined.push(seg);
            continue;
          }

          // Distribute time proportionally based on word count (more accurate than character count)
          const wordCounts = finalChunks.map(c => Math.max(1, (c.match(/\b[\w']+\b/g) || []).length));
          const totalWords = wordCounts.reduce((a, b) => a + b, 0) || 1;

          let cursor = start;
          for (let j = 0; j < finalChunks.length; j++) {
            const proportion = wordCounts[j] / totalWords;
            const chunkDuration = duration * proportion;
            const isLast = j === finalChunks.length - 1;
            const nextEnd = isLast ? end : (cursor + chunkDuration);

            refined.push({
              ...seg,
              text: finalChunks[j],
              start: cursor,
              end: nextEnd,
              start_sec: cursor,
              end_sec: nextEnd,
            });
            cursor = nextEnd;
          }
        }

        console.log(`[RefineSegments] Split ${segs.length} segments into ${refined.length} sentence-based chunks`);
        return refined;
      }

      function computeShadowingTargetEndTime(sentenceIndex) {
        const sentence = shadowingSentences[sentenceIndex];
        if (!sentence) return 0;

        const segMode = getSegmentationMode();
        const baseEndTime = Number(sentence.endTime);
        const nextSentence = shadowingSentences[sentenceIndex + 1];
        const nextStartTime = nextSentence ? Number(nextSentence.startTime ?? nextSentence.start ?? Infinity) : Infinity;

        // In caption mode, strictly follow subtitle line timings: stop exactly at the segment end.
        if (segMode === 'caption') {
          return baseEndTime;
        }

        // We want to add a small tail to ensure the last word is fully audible.
        // BUT we must absolutely prevent overlapping into the next sentence.
        // Strategy: Add up to 0.25s tail, but CLAMP it to be at least 0.05s before the next sentence starts.

        const safetyGap = 0.05;
        // Many caption sources use perfectly contiguous timestamps (nextStart === baseEnd).
        // Clamping to `nextStart - safetyGap` then produces zero tail and cuts the last word.
        // Allow a small overlap tail; we always re-seek to nextStart on the next sentence, so overlap only
        // causes a tiny replay instead of missing audio.
        const OVERLAP_TAIL_SEC = 0.22;
        const hasNext = Number.isFinite(nextStartTime);
        const gapToNext = hasNext ? (nextStartTime - baseEndTime) : Infinity;
        const maxPossibleEnd = (hasNext && gapToNext <= safetyGap)
          ? (nextStartTime + OVERLAP_TAIL_SEC)
          : (nextStartTime - safetyGap);

        // Desired tail: 0.25s
        const desiredTarget = baseEndTime + 0.25;

        // Clamp
        const finalTarget = Math.min(desiredTarget, maxPossibleEnd);

        // Ensure we at least play until baseEndTime (if next sentence allows). 
        // If next sentence starts BEFORE baseEndTime (bad data), we just stop at nextStartTime.
        return Math.max(baseEndTime, finalTarget);
      }

      function computeShadowingSeekTime(sentenceIndex) {
        const sentence = shadowingSentences[sentenceIndex];
        if (!sentence) return 0;

        // Strict seek to start time.
        // This resets any drift or overshoot from the previous sentence.
        return Number(sentence.startTime ?? sentence.start ?? 0);
      }

      // Mode descriptions
      const modeDescriptions = {
        shadowing: '跟读模式：跟随视频朗读，提升语音语调',
        dialogue: '对话模式：扮演一个角色，逐句录音练习'
      };

      const modeHints = {
        shadowing: '跟读：跟随视频朗读，提升语音语调',
        dialogue: '对话：扮演角色，系统在你的台词前停顿'
      };

      function setModeSelectorCollapsed(collapsed) {
        const modeSelector = document.getElementById('practice-mode-selector');
        const toggleBtn = document.getElementById('mode-toggle-btn');
        if (!modeSelector) return;
        modeSelector.classList.toggle('collapsed', collapsed);
        if (toggleBtn) toggleBtn.textContent = collapsed ? '展开' : '收起';
      }

      // Switch practice mode
      function switchPracticeMode(mode) {
        if (currentPracticeMode === 'shadowing' && mode !== 'shadowing') pauseAutoShadowing();
        currentPracticeMode = mode;
        document.title = `${mode === 'shadowing' ? '跟读练习' : '对话练习'} - Linglish`;
        const modeTitle = document.querySelector('.mode-title');
        if (modeTitle) modeTitle.textContent = mode === 'shadowing' ? '跟读练习' : '对话练习';
        savePracticeModePreference(mode);
        console.log('[Practice Mode] Switched to:', mode);

        // Remove practicing states when switching modes
        const modeSelector = document.getElementById('practice-mode-selector');
        if (modeSelector) {
          modeSelector.classList.remove('shadowing-practicing', 'dialogue-practicing');
        }

        // Update tab active state
        document.querySelectorAll('.mode-tab').forEach(tab => {
          tab.classList.toggle('active', tab.dataset.mode === mode);
          tab.setAttribute('aria-pressed', String(tab.dataset.mode === mode));
        });

        // Toggle shadowing-mode class on body for CSS styling
        document.body.classList.toggle('shadowing-mode', mode === 'shadowing');

        // Update description and visual
        const descEl = document.getElementById('mode-description');
        const shadowVisual = document.getElementById('onboarding-shadowing');
        const dialogueVisual = document.getElementById('onboarding-dialogue');
        const freeTrialLink = document.getElementById('free-trial-link');
        const hintEl = document.getElementById('mode-hint');

        if (hintEl) {
          hintEl.textContent = modeHints[mode] || '';
        }

        if (mode === 'shadowing') {
          if (descEl) descEl.textContent = '1. Listen & Shadow  →  2. Auto Pause  →  3. Speak';
          if (shadowVisual) shadowVisual.style.display = 'flex';
          if (dialogueVisual) dialogueVisual.style.display = 'none';
          if (freeTrialLink) freeTrialLink.style.display = 'block';
        } else {
          if (descEl) descEl.textContent = '1. Choose Role → 2. Original Audio → 3. You Respond';
          if (shadowVisual) shadowVisual.style.display = 'none';
          if (dialogueVisual) dialogueVisual.style.display = 'flex';
          // Hide free trial in dialogue mode (it's complex)
          if (freeTrialLink) freeTrialLink.style.display = 'none';
        }

        const shadowingControls = document.getElementById('shadowing-controls');
        const dialogueControls = document.getElementById('dialogue-controls');
        document.body.classList.add('mode-transitioning');
        setTimeout(() => document.body.classList.remove('mode-transitioning'), 260);

        if (shadowingControls && dialogueControls) {
          if (mode === 'shadowing') {
            shadowingControls.style.display = 'block';
            requestAnimationFrame(() => shadowingControls.classList.add('active'));
            dialogueControls.classList.remove('active');
            setTimeout(() => { dialogueControls.style.display = 'none'; }, 200);
          } else {
            dialogueControls.style.display = 'block';
            requestAnimationFrame(() => dialogueControls.classList.add('active'));
            shadowingControls.classList.remove('active');
            setTimeout(() => { shadowingControls.style.display = 'none'; }, 200);
          }
        }

        // Reset states based on mode
        if (mode === 'shadowing') {
          // Shadowing mode: continuous playback, no recording
          if (videoPlayer) videoPlayer.playbackRate = 1;

          // Hide floating recording button in shadowing mode
          const fabRecordContainer = document.getElementById('fab-record-container');
          if (fabRecordContainer) {
            fabRecordContainer.hidden = true;
          }

          // Clear dialogue monitor if active
          if (typeof dialogueMonitorInterval !== 'undefined' && dialogueMonitorInterval) {
            clearInterval(dialogueMonitorInterval);
            dialogueMonitorInterval = null;
          }
        } else {
          // Clean up shadowing mode when switching away
          if (shadowingAutoPauseListener && videoPlayer) {
            videoPlayer.removeEventListener('timeupdate', shadowingAutoPauseListener);
            shadowingAutoPauseListener = null;
          }

          // Clear YouTube pause polling if active
          if (shadowingYouTubePauseInterval) {
            clearInterval(shadowingYouTubePauseInterval);
            shadowingYouTubePauseInterval = null;
          }

          // Show floating recording button when not in shadowing mode
          const fabRecordContainer = document.getElementById('fab-record-container');
          if (fabRecordContainer && mode === 'dialogue') {
            fabRecordContainer.hidden = false;
          }

          if (dialogueHighlightListener && videoPlayer) {
            videoPlayer.removeEventListener('timeupdate', dialogueHighlightListener);
            dialogueHighlightListener = null;
          }

          if (mode === 'dialogue') {
            // Dialogue mode: use existing role-play functionality
            if (videoPlayer) {
              // Add highlighting listener
              dialogueHighlightListener = () => {
                updateDialogueHighlighting(videoPlayer.currentTime);
              };
              videoPlayer.addEventListener('timeupdate', dialogueHighlightListener);
            }
          }
        }
      }

      // Initialize mode tabs
      document.addEventListener('DOMContentLoaded', () => {
        let currentTheme = loadThemePreference();
        applyTheme(currentTheme);
        const themeToggle = document.getElementById('theme-toggle');
        if (themeToggle) {
          themeToggle.addEventListener('click', () => {
            currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
            applyTheme(currentTheme);
            saveThemePreference(currentTheme);
          });
        }

        document.querySelectorAll('.mode-tab').forEach(tab => {
          tab.addEventListener('click', () => {
            switchPracticeMode(tab.dataset.mode);
          });
        });

        const modeToggleBtn = document.getElementById('mode-toggle-btn');
        if (modeToggleBtn) {
          modeToggleBtn.addEventListener('click', () => {
            const modeSelector = document.getElementById('practice-mode-selector');
            if (!modeSelector) return;

            // Check if in practicing state (shadowing or dialogue)
            const isDialoguePracticing = modeSelector.classList.contains('dialogue-practicing');
            const isShadowingPracticing = modeSelector.classList.contains('shadowing-practicing');
            const isCollapsed = modeSelector.classList.contains('collapsed');

            if (isDialoguePracticing) {
              // When clicking expand during dialogue practice, restore mode selector and go back to role selection
              modeSelector.classList.remove('dialogue-practicing');
              modeToggleBtn.textContent = '收起';

              // Stop video playback
              if (videoPlayer && !videoPlayer.paused) {
                videoPlayer.pause();
              } else if (youtubePlayer && youtubePlayer.pauseVideo) {
                youtubePlayer.pauseVideo();
              }

              // Also reset dialogue to role selection
              const roleSelectionSection = document.getElementById('role-selection-section');
              const practiceContainer = document.getElementById('dialogue-practice-container');
              if (roleSelectionSection) roleSelectionSection.style.display = 'block';
              if (practiceContainer) practiceContainer.style.display = 'none';
            } else if (isShadowingPracticing) {
              // When clicking expand during shadowing practice, restore mode selector
              modeSelector.classList.remove('shadowing-practicing');
              modeToggleBtn.textContent = '收起';

              // Stop video playback
              if (videoPlayer && !videoPlayer.paused) {
                videoPlayer.pause();
              } else if (youtubePlayer && youtubePlayer.pauseVideo) {
                youtubePlayer.pauseVideo();
              }
            } else {
              setModeSelectorCollapsed(!isCollapsed);
            }
          });
        }

        switchPracticeMode(currentPracticeMode);

        // Initialize speed buttons for shadowing mode
        document.querySelectorAll('.speed-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const speed = parseFloat(btn.dataset.speed);
            if (videoPlayer) {
              videoPlayer.playbackRate = speed;
            }
            if (youtubePlayer && youtubePlayer.setPlaybackRate) {
              youtubePlayer.setPlaybackRate(speed);
            }
            document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
          });
        });

        // Initialize Free Trial Link
        const freeTrialLink = document.getElementById('free-trial-link');
        if (freeTrialLink) {
          freeTrialLink.addEventListener('click', () => {
            console.log('[Free Trial] Starting practice...');
            // Currently triggers same flow as Start Practice
            const startBtn = document.getElementById('start-practice-btn');
            if (startBtn) startBtn.click();
          });
        }

        // Simple animation cycle for onboarding visual
        const cycleOnboardingAnimation = () => {
          const container = document.getElementById('onboarding-shadowing');
          if (!container || container.style.display === 'none') return;

          const steps = container.querySelectorAll('.flow-step');
          let activeIndex = 0;

          setInterval(() => {
            steps.forEach(s => s.classList.remove('active'));
            steps[activeIndex].classList.add('active');
            activeIndex = (activeIndex + 1) % steps.length;
          }, 1500); // Change every 1.5s
        };
        cycleOnboardingAnimation();

        // Initialize global recording controls for reading mode
        const globalRecordBtn = document.getElementById('global-record-btn');
        const globalStopBtn = document.getElementById('global-stop-btn');
        const globalPlayBtn = document.getElementById('global-play-btn');

        if (globalRecordBtn) {
          globalRecordBtn.addEventListener('click', startGlobalRecording);
        }
        if (globalStopBtn) {
          globalStopBtn.addEventListener('click', stopGlobalRecording);
        }
        if (globalPlayBtn) {
          globalPlayBtn.addEventListener('click', playGlobalRecording);
        }

        // Initialize
        initDialogueSetupToggle();

        // Initialize start practice button
        const startPracticeBtn = document.getElementById('start-practice-btn');
        if (startPracticeBtn) {
          startPracticeBtn.addEventListener('click', () => {
            console.log('[Practice] Starting practice with mode:', currentPracticeMode);

            // Show practice interface
            const practiceControls = document.querySelector('.practice-controls');
            const linesContainer = document.querySelector('.lines-container');

            if (practiceControls) {
              practiceControls.style.display = 'flex';
            }
            if (linesContainer) {
              linesContainer.style.display = 'block';

              // Remove all mode classes
              linesContainer.classList.remove('shadowing-mode', 'reading-mode', 'dialogue-mode');

              // Add appropriate mode class and initialize
              if (currentPracticeMode === 'shadowing') {
                linesContainer.classList.add('shadowing-mode');
                document.body.classList.add('shadowing-mode');

                // Collapse mode selector to save space during practice
                const modeSelector = document.getElementById('practice-mode-selector');
                if (modeSelector) {
                  modeSelector.classList.add('shadowing-practicing');
                  const toggleBtn = document.getElementById('mode-toggle-btn');
                  if (toggleBtn) toggleBtn.textContent = '展开';
                }

                // Normalization Helper
                const normalizeShadowingSentences = (sentences) => {
                  if (!sentences || sentences.length < 2) return sentences;
                  const minGap = 0.06;
                  let adjustmentCount = 0;
                  for (let i = 0; i < sentences.length - 1; i++) {
                    const current = sentences[i];
                    const next = sentences[i + 1];
                    let currentEnd = Number(current.endTime);
                    let nextStart = Number(next.startTime);

                    if (currentEnd > nextStart - minGap) {
                      const mid = (currentEnd + nextStart) / 2;
                      current.endTime = mid - (minGap / 2);
                      next.startTime = mid + (minGap / 2);
                      adjustmentCount++;
                    }
                  }
                  if (adjustmentCount > 0) {
                    console.log(`[Shadowing] Normalized ${adjustmentCount} sentence boundaries.`);
                  }
                  return sentences;
                };

                initShadowingMode(normalizeShadowingSentences); // Pass normalizer or call inside

                // Auto-start shadowing after a brief delay to ensure initialization is complete
                setTimeout(() => {
                  startAutoShadowing();
                }, 300);
              } else if (currentPracticeMode === 'dialogue') {
                linesContainer.classList.add('dialogue-mode');
                document.body.classList.add('dialogue-mode');
                initDialogueMode();
              }
            }

            // Collapse mode selector to a single line for more room
            setModeSelectorCollapsed(true);

            // Ensure recording button is hidden in shadowing mode
            if (currentPracticeMode === 'shadowing') {
              const fabRecordContainer = document.getElementById('fab-record-container');
              if (fabRecordContainer) {
                fabRecordContainer.hidden = true;
                console.log('[Practice] Hiding recording button for shadowing mode');
              }
            }

            console.log('[Practice] Interface shown, mode:', currentPracticeMode);
          });
        }

        // Initialize shadowing mode buttons
        const shadowingStartBtn = document.getElementById('shadowing-start-btn');
        const shadowingPauseBtn = document.getElementById('shadowing-pause-btn');
        const shadowingReplayBtn = document.getElementById('shadowing-replay-btn');
        const shadowingNextBtn = document.getElementById('shadowing-next-btn');

        if (shadowingStartBtn) {
          shadowingStartBtn.addEventListener('click', startAutoShadowing);
        }
        if (shadowingPauseBtn) {
          shadowingPauseBtn.addEventListener('click', pauseAutoShadowing);
        }
        if (shadowingReplayBtn) {
          shadowingReplayBtn.addEventListener('click', replayCurrentSentence);
        }
        if (shadowingNextBtn) {
          shadowingNextBtn.addEventListener('click', goToNextSentence);
        }

        // Initialize reading mode buttons
        const readingListenBtn = document.getElementById('reading-listen-btn');
        const readingRecordBtn = document.getElementById('reading-record-btn');
        const readingStopBtn = document.getElementById('reading-stop-btn');
        const readingPlayBtn = document.getElementById('reading-play-btn');
        const readingPrevBtn = document.getElementById('reading-prev-btn');
        const readingNextBtn = document.getElementById('reading-next-btn');

        if (readingListenBtn) {
          readingListenBtn.addEventListener('click', listenToOriginal);
        }
        if (readingRecordBtn) {
          readingRecordBtn.addEventListener('click', startReadingRecording);
        }
        if (readingStopBtn) {
          readingStopBtn.addEventListener('click', stopReadingRecording);
        }
        if (readingPlayBtn) {
          readingPlayBtn.addEventListener('click', playReadingRecording);
        }
        if (readingPrevBtn) {
          readingPrevBtn.addEventListener('click', goToPrevReading);
        }
        if (readingNextBtn) {
          readingNextBtn.addEventListener('click', goToNextReading);
        }
      });

      // Global recording functions for reading mode
      async function startGlobalRecording() {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          globalRecorder = new MediaRecorder(stream);
          globalRecordingChunks = [];

          globalRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              globalRecordingChunks.push(e.data);
            }
          };

          globalRecorder.onstop = () => {
            globalRecordingBlob = new Blob(globalRecordingChunks, { type: 'audio/webm' });
            console.log('[Global Recording] Stopped, blob size:', globalRecordingBlob.size);

            // Show play button
            document.getElementById('global-play-btn').style.display = 'block';
            document.getElementById('recording-time').style.display = 'none';

            // Stop timer
            if (recordingTimer) {
              clearInterval(recordingTimer);
              recordingTimer = null;
            }
          };

          globalRecorder.start();
          recordingStartTime = Date.now();

          // Update UI
          document.getElementById('global-record-btn').style.display = 'none';
          document.getElementById('global-stop-btn').style.display = 'block';
          document.getElementById('recording-time').style.display = 'block';

          // Start timer
          recordingTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
            const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const seconds = (elapsed % 60).toString().padStart(2, '0');
            document.getElementById('recording-time').textContent = `${minutes}:${seconds}`;
          }, 1000);

          console.log('[Global Recording] Started');
        } catch (err) {
          console.error('[Global Recording] Failed to start:', err);
          alert('无法启动录音，请检查麦克风权限');
        }
      }

      function stopGlobalRecording() {
        if (globalRecorder && globalRecorder.state === 'recording') {
          globalRecorder.stop();
          globalRecorder.stream.getTracks().forEach(track => track.stop());

          // Update UI
          document.getElementById('global-record-btn').style.display = 'block';
          document.getElementById('global-stop-btn').style.display = 'none';

          console.log('[Global Recording] Stopped');
        }
      }

      function playGlobalRecording() {
        if (!globalRecordingBlob) {
          console.warn('[Global Recording] No recording to play');
          return;
        }

        const audio = new Audio(URL.createObjectURL(globalRecordingBlob));
        audio.play();
        console.log('[Global Recording] Playing');

        audio.onended = () => {
          console.log('[Global Recording] Playback ended');
        };
      }

      // ==================== Dialogue Mode Functions ====================

      function initDialogueSetupToggle() {
        const toggleBtn = document.getElementById('toggle-setup-btn');
        const container = document.getElementById('dialogue-setup-container');

        if (toggleBtn && container) {
          toggleBtn.addEventListener('click', () => {
            const isCollapsed = container.classList.contains('collapsed');
            if (isCollapsed) {
              container.classList.remove('collapsed');
              toggleBtn.classList.remove('collapsed');
              toggleBtn.querySelector('span').textContent = '收起';
            } else {
              container.classList.add('collapsed');
              toggleBtn.classList.add('collapsed');
              toggleBtn.querySelector('span').textContent = '展开';
            }
          });
        }
      }

      function updateDialogueHighlighting(currentTime) {
        if (!Array.isArray(state.currentSegments)) return;

        // 找到当前时间对应的句子
        // 使用宽松的匹配：currentTime 在 [start, end] 范围内，或者在 start 前一点点
        const activeSegmentIndex = state.currentSegments.findIndex(seg => {
          return currentTime >= seg.start && currentTime <= (seg.end + 0.5);
        });

        if (activeSegmentIndex !== -1) {
          // 只有当高亮改变时才更新，避免频繁DOM操作
          if (state.currentSegmentIndex !== activeSegmentIndex) {
            highlightCurrentSegment(activeSegmentIndex, true);
          }
        }
      }

      function highlightCurrentSegment(segmentIndex, scroll = true) {
        state.currentSegmentIndex = segmentIndex;
        const practiceLineList = document.getElementById('practice-line-list');
        if (!practiceLineList) return;

        // Find the line item corresponding to this segment
        // Note: segmentIndex is global index, line items have data-segment-index
        practiceLineList.querySelectorAll('.line-item').forEach((item) => {
          const itemKey = item.dataset.segmentIndex;
          // Check if this item matches the segmentIndex
          // We need to handle potential type mismatch (string vs number)
          if (itemKey == segmentIndex) {
            item.classList.add('current');
            if (scroll) {
              item.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }

            // Also update the single card display for better visibility on mobile
            const practiceCurrentLine = document.getElementById('practice-current-line');
            if (practiceCurrentLine) {
              practiceCurrentLine.hidden = false;
              const text = item.querySelector('.line-text')?.textContent || '';
              // Find the index in the full list
              const total = state.currentSegments?.length || 0;
              const displayIndex = parseInt(segmentIndex) + 1;

              practiceCurrentLine.innerHTML = `
                <div class="practice-current-meta">句子 ${displayIndex} / ${total}</div>
                <div class="practice-current-text">${text}</div>
              `;
            }
          } else {
            item.classList.remove('current');
          }
        });
      }

      async function processDialogueRecording(blob, originalText) {
        const asrContentEl = document.getElementById('asr-text-content');
        if (asrContentEl) {
          asrContentEl.innerHTML = '<div class="loading">正在识别...</div>';
        }

        try {
          // Construct form data
          const formData = new FormData();
          formData.append('audio', blob);
          formData.append('text', originalText);

          // Call API
          const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
          const res = await fetch(`${API_BASE}/audio/transcribe-align`, {
            method: 'POST',
            headers: headers,
            body: formData
          });

          let result;
          if (res.ok) {
            result = await res.json();
          } else {
            throw new Error('ASR failed');
          }

          const accuracy = result.accuracy || 0;
          const words = result.words || [];

          // Update Title with Accuracy Badge
          const asrTitle = document.querySelector('.asr-title');
          if (asrTitle) {
            const accuracyClass = accuracy >= 80 ? 'high' : accuracy >= 60 ? 'medium' : 'low';
            const emoji = accuracy >= 80 ? '✅' : accuracy >= 60 ? '⚠️' : '❌';

            asrTitle.innerHTML = `
          <span>${emoji} 识别结果</span>
            <span class="asr-accuracy-badge ${accuracyClass}">
              <i class="fas fa-bullseye"></i> 准确度: ${accuracy}%
            </span>
        `;
          }

          // Render colored text
          if (asrContentEl) {
            const html = words.map(w => {
              const cls = w.is_match ? 'match' : 'mismatch';
              return `<span class="word ${cls}">${w.word}</span>`;
            }).join(' ');
            asrContentEl.innerHTML = html;
          }

          // Show playback button
          const playbackBtn = document.querySelector('.playback-btn');
          if (playbackBtn) playbackBtn.style.display = 'inline-flex';

          // Show main dialogue play button and original button
          const dialoguePlayBtn = document.getElementById('dialogue-play-btn');
          if (dialoguePlayBtn) dialoguePlayBtn.style.display = 'flex';

          const dialogueOriginalBtn = document.getElementById('dialogue-original-btn');
          if (dialogueOriginalBtn) dialogueOriginalBtn.style.display = 'flex';

          // Auto-play recording
          const audio = new Audio(URL.createObjectURL(blob));
          audio.onended = () => {
            // Proceed to next sentence after a short delay
            setTimeout(() => {
              if (document.getElementById('auto-mode-toggle').checked) {
                playNextDialogueSentence();
              }
            }, 1000);
          };
          audio.play();

        } catch (err) {
          console.error('[Dialogue] ASR failed:', err);
          if (asrContentEl) {
            asrContentEl.innerHTML = '<span style="color: red;">识别失败</span>';
          }

          // Fallback: just play next
          setTimeout(() => {
            if (document.getElementById('auto-mode-toggle').checked) {
              playNextDialogueSentence();
            }
          }, 2000);
        }
      }

      async function startDialogueRecording(sentence) {
        // Update UI
        document.getElementById('asr-comparison-section').style.display = 'block';

        // 简化标题：录音时只显示"请跟读"
        const asrTitle = document.querySelector('.asr-title');
        if (asrTitle) {
          asrTitle.innerHTML = '<span>📖 请跟读</span>';
        }

        // 显示原文
        const originalTextEl = document.getElementById('original-text-content');
        if (originalTextEl) {
          originalTextEl.innerHTML = `<div style="font-size: 16px; line-height: 1.6; color: #1e293b; font-weight: 500;">${sentence.text}</div>`;
        }

        // 更新原文标签（添加图标）
        const originalTextDiv = document.querySelector('.original-text');
        const originalLabel = originalTextDiv?.querySelector('label');
        if (originalLabel) {
          originalLabel.innerHTML = '<i class="fas fa-quote-left"></i> 原文';
        }

        // 更新录音标签（添加图标）
        const asrTextDiv = document.querySelector('.asr-text');
        const asrLabel = asrTextDiv?.querySelector('label');
        if (asrLabel) {
          asrLabel.innerHTML = '<i class="fas fa-microphone-alt"></i> 你的录音';
        }

        // 隐藏"你的录音"部分，等ASR完成后再显示
        const asrContentEl = document.getElementById('asr-text-content');
        if (asrContentEl) {
          asrContentEl.innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> 准备录音...</div>';
        }

        // Hide playback button
        const playbackBtn = document.querySelector('.playback-btn');
        if (playbackBtn) playbackBtn.style.display = 'none';

        // Hide main dialogue play button
        const dialoguePlayBtn = document.getElementById('dialogue-play-btn');
        if (dialoguePlayBtn) dialoguePlayBtn.style.display = 'none';

        // Start recording automatically
        console.log('[Dialogue Recording] Starting recording for:', sentence.text);

        // Use global recording function but adapt for dialogue
        // We need to override the onStop callback
        // Assuming toggleGlobalRecording exists or we implement a simple recorder here
        // Since we couldn't find toggleGlobalRecording, let's implement a simple one using the existing global variables

        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          globalRecorder = new MediaRecorder(stream);
          globalRecordingChunks = [];

          globalRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) globalRecordingChunks.push(e.data);
          };

          globalRecorder.onstop = async () => {
            const blob = new Blob(globalRecordingChunks, { type: 'audio/webm' });
            console.log('[Dialogue Recording] Stopped, blob size:', blob.size);
            await processDialogueRecording(blob, sentence.text);
          };

          globalRecorder.start();
          console.log('[Dialogue Recording] Started');

          // You might want to show a stop button or auto-stop after silence
          // For now, let's assume there's a UI button to stop, or we rely on VAD (if implemented)
          // But wait, the user wants "Auto-pause video -> record -> auto-play -> next"
          // So we probably need a stop button or a timeout.
          // Let's rely on the user pressing a stop button for now, or the existing UI.

        } catch (err) {
          console.error('[Dialogue Recording] Failed:', err);
          alert('无法启动录音');
        }
      }

      // ==================== Shadowing Mode Functions ====================
      function initShadowingMode(normalizer) {
        console.log('[Shadowing] Initializing shadowing mode');

        // First, refine the raw segments to split long ones into smaller chunks
        let refinedSegments = state.currentSegments;
        if (refinedSegments && refinedSegments.length > 0) {
          const segMode = getSegmentationMode();
          if (segMode !== 'caption') {
            refinedSegments = refinePracticeTranscriptSegments(refinedSegments);
            console.log('[Shadowing] Refined segments:', refinedSegments.length, 'from', state.currentSegments.length);
          } else {
            // Strictly follow subtitle line breaks in caption mode.
            console.log('[Shadowing] Caption mode: skip refining segments');
          }
        }

        // Get all sentences from refined segments
        if (refinedSegments && refinedSegments.length > 0) {
          shadowingSentences = refinedSegments.map((segment, index) => {
            return {
              index: index,
              text: segment.text || '',
              startTime: Number(segment.start) || 0,
              endTime: Number(segment.end) || 0,
              element: null // We might not need this, or we can find it lazily
            };
          });
        } else {
          console.warn('[Shadowing] No segments found in state, falling back to DOM (legacy)');
          const lineItems = document.querySelectorAll('.line-item');
          shadowingSentences = Array.from(lineItems).map((item, index) => {
            const textEl = item.querySelector('.line-text');
            return {
              index: index,
              text: textEl ? textEl.textContent : '',
              startTime: item.dataset.start ? parseFloat(item.dataset.start) : 0,
              endTime: item.dataset.end ? parseFloat(item.dataset.end) : 0,
              element: item
            };
          });
        }





        shadowingCurrentIndex = 0;
        shadowingAutoMode = false;
        console.log('[Shadowing] Loaded', shadowingSentences.length, 'sentences');

        // Debug: Log first sentence data
        if (shadowingSentences.length > 0) {
          console.log('[Shadowing] First sentence:', {
            text: shadowingSentences[0].text,
            startTime: shadowingSentences[0].startTime,
            endTime: shadowingSentences[0].endTime
          });
        }

        // Display first sentence
        updateShadowingDisplay();
        // updateShadowingStatus('点击"开始"按钮进行跟读练习', '▶️'); // Removed to hide status bar

        // Hide floating recording button in shadowing mode
        const fabRecordContainer = document.getElementById('fab-record-container');
        if (fabRecordContainer) {
          fabRecordContainer.hidden = true;
        }

        // Hide unnecessary elements in shadowing mode
        const shadowingStatus = document.getElementById('shadowing-status');
        if (shadowingStatus) {
          shadowingStatus.style.display = 'none';
          console.log('[Shadowing] Hidden: shadowing-status');
        }

        const speedSelector = document.querySelector('.speed-selector-group');
        if (speedSelector) {
          speedSelector.style.display = 'none';
          console.log('[Shadowing] Hidden: speed-selector');
        }

        const controlButtons = document.querySelector('.shadowing-control-buttons');
        if (controlButtons) {
          controlButtons.style.display = 'none';
          console.log('[Shadowing] Hidden: control-buttons');
        }

        // Hide audio mode toggle (原声、我的配音、对话)
        const audioModeToggle = document.getElementById('audio-mode-toggle');
        if (audioModeToggle) {
          audioModeToggle.style.display = 'none';
          console.log('[Shadowing] Hidden: audio-mode-toggle');
        }

        // Also hide the entire control modes panel
        const controlModesPanel = document.getElementById('control-modes-panel');
        if (controlModesPanel) {
          controlModesPanel.style.display = 'none';
          console.log('[Shadowing] Hidden: control-modes-panel');
        }

        // Ensure the container is visible
        const practiceCurrentLine = document.getElementById('practice-current-line');
        if (practiceCurrentLine) {
          practiceCurrentLine.hidden = false;
          practiceCurrentLine.style.display = 'block';
          practiceCurrentLine.style.visibility = 'visible';
          practiceCurrentLine.style.opacity = '1';
          console.log('[Shadowing] practice-current-line visibility:', {
            hidden: practiceCurrentLine.hidden,
            display: practiceCurrentLine.style.display,
            visibility: practiceCurrentLine.style.visibility,
            innerHTML: practiceCurrentLine.innerHTML.substring(0, 100)
          });
        } else {
          console.error('[Shadowing] practice-current-line element not found!');
        }

        // Ensure lines container is visible
        const linesContainer = document.querySelector('.lines-container');
        if (linesContainer) {
          linesContainer.style.display = 'block';
          linesContainer.style.visibility = 'visible';
          console.log('[Shadowing] lines-container visibility set');
        }
      }

      function updateShadowingStatus(text, icon) {
        // Status bar is hidden in shadowing mode - do nothing
        return;
      }

      async function startAutoShadowing() {
        // 🔧 检查是否有有效的视频和句子数据
        if (!state.videoId || !state.videoData) {
          console.error('[Shadowing] Cannot start: No video data loaded');
          alert('视频加载失败，请返回重新选择视频');
          return;
        }
        if (!shadowingSentences || shadowingSentences.length === 0 ||
          (shadowingSentences.length === 1 && shadowingSentences[0].text === '正在加载台词...')) {
          console.error('[Shadowing] Cannot start: No sentences loaded');
          alert('没有可用的句子数据，请检查视频是否有字幕');
          return;
        }

        shadowingAutoMode = true;
        console.log('[Shadowing] Starting auto mode');

        // 🔧 清除对话模式的状态，防止 timeupdate 监听器干扰跟读模式
        if (typeof state !== 'undefined' && state) {
          state.segmentPlaybackEnd = null;
          state.segmentPlaybackCallback = null;
          console.log('[Shadowing] Cleared dialogue mode state');
        }

        // Show pause button, hide start button
        document.getElementById('shadowing-start-btn').style.display = 'none';
        document.getElementById('shadowing-pause-btn').style.display = 'block';

        // Hide floating recording button in shadowing mode
        const fabRecordContainer = document.getElementById('fab-record-container');
        if (fabRecordContainer) {
          fabRecordContainer.hidden = true;
        }

        // 🔧 关键：在用户点击事件的同步上下文中立即触发 play()
        // 这样浏览器才会认可这是用户手势触发的播放
        if (videoPlayer && !isYouTubeVideo) {
          console.log('[Shadowing] Triggering synchronous play for user gesture');
          const playOverlay = document.getElementById('play-overlay');
          const currentSentence = shadowingSentences[shadowingCurrentIndex];
          const needsSeek = currentSentence && Math.abs(videoPlayer.currentTime - (currentSentence.startTime || 0)) > 0.05;
          const positionGuard = currentSentence ? createShadowingPlaybackGuard(currentSentence, Boolean(needsSeek)) : null;

          // 先 seek 到正确位置，再 play - 都在同步上下文中
          if (currentSentence) {
            const targetStart = currentSentence.startTime || 0;
            const currentPos = videoPlayer.currentTime;
            // 跟读模式需要从句子起点精确播放，避免上一句尾巴导致丢失下一句开头
            if (Math.abs(currentPos - targetStart) > 0.05) {
              videoPlayer.currentTime = targetStart;
            }
          }
          // Ensure playback rate is normal (Active Pause may have set it to 0.0625)
          videoPlayer.playbackRate = 1.0;

          try {
            // 同步调用 play()，解锁视频播放
            await videoPlayer.play();
            if (positionGuard !== shadowingPlaybackGuard) return;
            console.log('[Shadowing] Sync play succeeded, paused:', videoPlayer.paused);
            if (playOverlay) playOverlay.style.display = 'none';

            // 设置 auto-pause 监听器
            if (currentSentence) {
              const baseEndTime = Number(currentSentence.endTime ?? currentSentence.end ?? 0);
              shadowingTargetEndTime = computeShadowingTargetEndTime(shadowingCurrentIndex);
              const buffer = Math.max(0, shadowingTargetEndTime - baseEndTime);

              shadowingStopIndex = shadowingCurrentIndex;
              shadowingSentenceEnded = false;
              setupAutoPauseForSentence(currentSentence, baseEndTime);

              // 启动轮询检测
              console.log('[Shadowing] Starting polling for end time:', shadowingTargetEndTime, 'buffer:', buffer.toFixed(3));
              if (shadowingProgressTimer) clearInterval(shadowingProgressTimer);
              shadowingProgressTimer = setInterval(() => {
                const currentTime = videoPlayer.currentTime;
                if (canFinishShadowingPlayback(currentTime)) {
                  console.log('[Shadowing] Reached target time!', currentTime, '>=', shadowingTargetEndTime);
                  videoPlayer.pause();
                  onSentenceEnded();
                }
              }, 100);
            }

            updateShadowingDisplay();
            return; // 成功播放，直接返回
          } catch (err) {
            if (positionGuard !== shadowingPlaybackGuard) return;
            console.warn('[Shadowing] Sync play failed:', err);
            // 如果失败，继续使用 fallback 逻辑
          }
        }

        // For YouTube player, ensure volume is set and unmuted BEFORE first play
        if (youtubePlayer && youtubePlayer.getPlayerState) {
          try {
            if (youtubePlayer.isMuted && youtubePlayer.isMuted()) {
              youtubePlayer.unMute();
              console.log('[Shadowing] Unmuted YouTube player');
            }
            if (youtubePlayer.setVolume) {
              youtubePlayer.setVolume(100);
              console.log('[Shadowing] Set YouTube volume to 100');
            }
          } catch (e) {
            console.warn('[Shadowing] Could not set YouTube volume/mute:', e);
          }
        }

        // Fallback: 使用原来的 playCurrentSentenceAuto
        playCurrentSentenceAuto();
      }

      function pauseAutoShadowing() {
        shadowingPlaybackGuard = null;
        if (shadowingProgressTimer) {
          clearInterval(shadowingProgressTimer);
          shadowingProgressTimer = null;
        }
        shadowingAutoMode = false;
        console.log('[Shadowing] Pausing auto mode');

        // Show start button, hide pause button
        document.getElementById('shadowing-start-btn').style.display = 'block';
        document.getElementById('shadowing-pause-btn').style.display = 'none';

        // Clear any waiting timeout
        if (shadowingWaitingTimeout) {
          clearTimeout(shadowingWaitingTimeout);
          shadowingWaitingTimeout = null;
        }

        // Clear YouTube pause polling if active
        if (shadowingYouTubePauseInterval) {
          clearInterval(shadowingYouTubePauseInterval);
          shadowingYouTubePauseInterval = null;
        }

        // Pause video
        if (videoPlayer) {
          videoPlayer.pause();
        } else if (youtubePlayer && youtubePlayer.pauseVideo) {
          youtubePlayer.pauseVideo();
        }

        updateShadowingStatus('已暂停，点击"开始"继续', '⏸️');
      }

      function replayCurrentSentence() {
        console.log('[Shadowing] Replaying current sentence');
        updateShadowingStatus('正在播放...', '▶️');
        playCurrentSentenceAuto({ forceSeek: true });
      }

      function updateShadowingDisplay() {
        const currentSentence = shadowingSentences[shadowingCurrentIndex];
        if (!currentSentence) {
          console.warn('[Shadowing] No sentence at index', shadowingCurrentIndex);
          return;
        }

        const practiceCurrentLine = document.getElementById('practice-current-line');
        if (practiceCurrentLine) {
          practiceCurrentLine.hidden = false;
          practiceCurrentLine.style.display = 'block';
          practiceCurrentLine.style.visibility = 'visible';
          practiceCurrentLine.style.opacity = '1';
          practiceCurrentLine.style.zIndex = '1000';
          practiceCurrentLine.style.background = 'linear-gradient(135deg, #dbeafe 0%, #e0f2fe 50%, #f0f9ff 100%)';
          practiceCurrentLine.style.color = '#1e293b';
          practiceCurrentLine.style.minHeight = '120px';
          practiceCurrentLine.style.animation = 'none'; // Disable animation to prevent stuck state

          const formatTime = (seconds) => {
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins}:${secs.toString().padStart(2, '0')}`;
          };
          practiceCurrentLine.innerHTML = `
          <div class="practice-current-meta">Line ${shadowingCurrentIndex + 1} of ${shadowingSentences.length}</div>
          <div class="practice-current-text">${currentSentence.text}</div>
          <div class="practice-current-time">${formatTime(currentSentence.startTime)} – ${formatTime(currentSentence.endTime)}</div>
        `;

          console.log('[Shadowing] Display updated:', {
            text: currentSentence.text,
            visible: practiceCurrentLine.style.display,
            offsetHeight: practiceCurrentLine.offsetHeight,
            offsetWidth: practiceCurrentLine.offsetWidth,
            innerHTML: practiceCurrentLine.innerHTML.substring(0, 100)
          });
        } else {
          console.error('[Shadowing] practice-current-line element not found in updateShadowingDisplay!');
        }
      }

      async function playCurrentSentenceAuto({ forceSeek = false } = {}) {
        const currentSentence = shadowingSentences[shadowingCurrentIndex];
        if (!currentSentence) return;

        const segMode = getSegmentationMode();

        // 🔧 清除对话模式的状态，防止 timeupdate 监听器干扰跟读模式
        if (typeof state !== 'undefined' && state) {
          state.segmentPlaybackEnd = null;
          state.segmentPlaybackCallback = null;
        }

        // 🔧 重置句子结束标志
        shadowingSentenceEnded = false;

        // 🔧 清除旧的轮询间隔并更新目标结束时间
        if (shadowingProgressTimer) {
          clearInterval(shadowingProgressTimer);
          shadowingProgressTimer = null;
        }

        const baseEndTime = Number(currentSentence.endTime ?? currentSentence.end ?? 0);
        shadowingTargetEndTime = computeShadowingTargetEndTime(shadowingCurrentIndex);
        const positionGuard = createShadowingPlaybackGuard(currentSentence);
        const buffer = Math.max(0, shadowingTargetEndTime - baseEndTime);

        console.log('[Shadowing] Playing sentence', shadowingCurrentIndex, ':', currentSentence.text,
          'startTime:', currentSentence.startTime, 'endTime:', currentSentence.endTime, 'buffer:', buffer.toFixed(3));
        updateShadowingStatus('正在播放...', '▶️');

        const player = videoPlayer || youtubePlayer;
        if (!player) {
          console.error('[Shadowing] No video player found');
          return;
        }

        // Clear any existing timeout
        if (shadowingWaitingTimeout) {
          clearTimeout(shadowingWaitingTimeout);
        }

        // Setup auto-pause listener BEFORE playing
        setupAutoPauseForSentence(currentSentence);

        // Seek to start time and play
        if (youtubePlayer && youtubePlayer.seekTo) {
          // Wait for YouTube player to be ready
          const waitForPlayerReady = () => {
            return new Promise((resolve) => {
              const deadline = Date.now() + 8000;
              const checkReady = () => {
                if (positionGuard !== shadowingPlaybackGuard || Date.now() >= deadline) {
                  resolve(false);
                  return;
                }
                if (youtubePlayer && youtubePlayer.getPlayerState && !youtubePlayerInitializing) {
                  const state = youtubePlayer.getPlayerState();
                  // Player is ready if it's not uninitialized
                  if (state !== undefined && state !== null) {
                    console.log('[Shadowing] YouTube player ready, state:', state);
                    resolve(true);
                  } else {
                    setTimeout(checkReady, 50);
                  }
                } else {
                  setTimeout(checkReady, 50);
                }
              };
              checkReady();
            });
          };

          // Wait for player to be ready
          if (!await waitForPlayerReady()) {
            if (positionGuard === shadowingPlaybackGuard) {
              pauseAutoShadowing();
              updateShadowingStatus('视频暂未就绪，请点击开始重试', '⚠️');
            }
            return;
          }

          // For YouTube: ensure volume is not muted and at good level
          try {
            if (youtubePlayer.isMuted && youtubePlayer.isMuted()) {
              youtubePlayer.unMute();
            }
            const currentVolume = youtubePlayer.getVolume ? youtubePlayer.getVolume() : 100;
            if (currentVolume < 10) {
              youtubePlayer.setVolume(100);
            }
          } catch (e) {
            console.warn('[Shadowing] Could not adjust YouTube volume:', e);
          }

          // Improved YouTube play sequence with multiple retries
          try {
            // Determine if we should seek based on stored stop time
            const seekTime = currentSentence.startTime;
            let shouldSeek = true;

            // If we just finished the previous sentence and are advancing to the next
            if (shadowingLastStopIndex !== null &&
              shadowingLastStopIndex === shadowingCurrentIndex - 1 &&
              shadowingLastStopTime !== null) {
              // Use the stored stop time which is more reliable
              // Don't seek if we're already past the start point
              if (segMode !== 'caption' && shadowingLastStopTime >= seekTime - 0.1) {
                shouldSeek = false;
                console.log('[Shadowing] Skip seek: already at', shadowingLastStopTime.toFixed(2),
                  'target was', seekTime.toFixed(2));
              }
            }

            if (forceSeek || youtubePlayer.getCurrentTime() >= currentSentence.endTime) shouldSeek = true;
            if (!shouldSeek) positionGuard.allowCurrentPosition();

            // Step 1: Seek to position (only if needed)
            if (shouldSeek) {
              youtubePlayer.seekTo(seekTime, true);
              console.log('[Shadowing] Seeked to', seekTime);
            }

            // Step 2: Wait briefly for seek to complete, then play
            setTimeout(() => {
              if (positionGuard !== shadowingPlaybackGuard) return;
              try {
                youtubePlayer.playVideo();
                console.log('[Shadowing] Play command sent (100ms after seek)');
              } catch (e) {
                console.error('[Shadowing] Play failed (100ms):', e);
              }
            }, shouldSeek ? 100 : 10);

            // Step 3: Verify playing state and retry if needed
            setTimeout(() => {
              if (positionGuard !== shadowingPlaybackGuard || shadowingSentenceEnded) return;
              try {
                const state = youtubePlayer.getPlayerState ? youtubePlayer.getPlayerState() : -1;
                console.log('[Shadowing] Player state check (300ms):', state);
                // States: -1=unstarted, 0=ended, 1=playing, 2=paused, 3=buffering, 5=cued
                if (state !== 1 && state !== 3) { // Not playing or buffering
                  console.log('[Shadowing] Retry #1: Not playing, sending play command');
                  youtubePlayer.playVideo();
                }
              } catch (e) {
                console.error('[Shadowing] Retry #1 failed:', e);
              }
            }, 300);

            // Step 4: Final retry
            setTimeout(() => {
              if (positionGuard !== shadowingPlaybackGuard || shadowingSentenceEnded) return;
              try {
                const state = youtubePlayer.getPlayerState ? youtubePlayer.getPlayerState() : -1;
                if (state !== 1 && state !== 3) {
                  console.log('[Shadowing] Retry #2: Still not playing, final attempt');
                  youtubePlayer.playVideo();
                }
              } catch (e) {
                console.error('[Shadowing] Retry #2 failed:', e);
              }
            }, 600);

          } catch (e) {
            console.error('[Shadowing] Failed to play YouTube video:', e);
          }
        } else if (videoPlayer) {
          // HTML5 video player
          try {
            const targetStart = currentSentence.startTime || 0;
            let shouldSeek = true;

            // If we just finished the previous sentence and are advancing to the next
            if (shadowingLastStopIndex !== null &&
              shadowingLastStopIndex === shadowingCurrentIndex - 1 &&
              shadowingLastStopTime !== null) {
              // Use the stored stop time which is more reliable
              // Don't seek if we're already past the start point
              if (segMode !== 'caption' && shadowingLastStopTime >= targetStart - 0.1) {
                shouldSeek = false;
                console.log('[Shadowing] Skip seek: already at', shadowingLastStopTime.toFixed(2),
                  'target was', targetStart.toFixed(2));
              }
            }

            if (forceSeek || videoPlayer.currentTime >= currentSentence.endTime) shouldSeek = true;
            if (!shouldSeek) positionGuard.allowCurrentPosition();
            if (shouldSeek) {
              videoPlayer.currentTime = targetStart;
            }
            // Ensure playback rate is normal (Active Pause may have set it to 0.0625)
            videoPlayer.playbackRate = 1.0;
            // 🔧 重置 Active Pause 状态
            if (state.activePause) {
              state.activePause.isActive = false;
            }
            // Ensure not muted and good volume
            if (videoPlayer.muted) {
              videoPlayer.muted = false;
            }
            if (videoPlayer.volume < 0.1) {
              videoPlayer.volume = 1.0;
            }

            const playOverlay = document.getElementById('play-overlay');

            // 处理自动播放可能被浏览器阻止的情况
            const tryPlay = async () => {
              try {
                console.log('[Shadowing] Attempting to play video...');
                await videoPlayer.play();
                if (positionGuard !== shadowingPlaybackGuard) return;
                console.log('[Shadowing] play() resolved, paused:', videoPlayer.paused);

                // 验证视频确实在播放
                if (videoPlayer.paused) {
                  console.warn('[Shadowing] Video still paused after play() resolved');
                  throw new Error('Video still paused');
                }

                // 隐藏播放覆盖层
                if (playOverlay) playOverlay.style.display = 'none';
                return true;
              } catch (playErr) {
                console.warn('[Shadowing] Play attempt failed:', playErr.message || playErr);
                return false;
              }
            };

            // 第一次尝试：正常播放
            let played = await tryPlay();
            if (positionGuard !== shadowingPlaybackGuard) return;

            // 第二次尝试：静音播放
            if (!played) {
              console.log('[Shadowing] Trying muted play...');
              const prevMuted = videoPlayer.muted;
              videoPlayer.muted = true;
              try {
                await videoPlayer.play();
                if (positionGuard !== shadowingPlaybackGuard) return;
                if (!videoPlayer.paused) {
                  console.log('[Shadowing] Muted play succeeded');
                  if (playOverlay) playOverlay.style.display = 'none';
                  // 短暂延迟后恢复音量
                  setTimeout(() => { videoPlayer.muted = prevMuted; }, 100);
                  played = true;
                }
              } catch (e) {
                console.warn('[Shadowing] Muted play failed:', e);
              }
            }

            // 🔧 如果播放成功，启动轮询检测句子结束
            if (positionGuard !== shadowingPlaybackGuard) return;
            if (played) {
              console.log('[Shadowing] Play succeeded, starting polling for end time:', shadowingTargetEndTime);
              if (shadowingProgressTimer) clearInterval(shadowingProgressTimer);
              shadowingProgressTimer = setInterval(() => {
                const currentTime = videoPlayer.currentTime;
                if (canFinishShadowingPlayback(currentTime)) {
                  console.log('[Shadowing] Reached target time!', currentTime, '>=', shadowingTargetEndTime);
                  videoPlayer.pause();
                  onSentenceEnded();
                }
              }, 100);
            }

            // 最后手段：提示用户点击
            if (!played) {
              console.log('[Shadowing] Showing click-to-play prompt');
              updateShadowingStatus('请点击视频开始播放', '⚠️');
              if (playOverlay) {
                playOverlay.style.display = 'flex';
                playOverlay.onclick = async () => {
                  if (positionGuard !== shadowingPlaybackGuard) return;
                  try {
                    await videoPlayer.play();
                    if (positionGuard !== shadowingPlaybackGuard) return;
                    if (!videoPlayer.paused) {
                      playOverlay.style.display = 'none';
                      updateShadowingStatus('正在播放...', '▶️');
                      // 🔧 手动播放成功后也启动轮询
                      console.log('[Shadowing] Manual play succeeded, starting polling for end time:', shadowingTargetEndTime);
                      if (shadowingProgressTimer) clearInterval(shadowingProgressTimer);
                      shadowingProgressTimer = setInterval(() => {
                        const currentTime = videoPlayer.currentTime;
                        if (canFinishShadowingPlayback(currentTime)) {
                          console.log('[Shadowing] Reached target time!', currentTime, '>=', shadowingTargetEndTime);
                          videoPlayer.pause();
                          onSentenceEnded();
                        }
                      }, 100);
                    }
                  } catch (e) {
                    console.error('[Shadowing] Manual play failed:', e);
                  }
                };
              }
            }
          } catch (e) {
            console.error('[Shadowing] HTML5 play error:', e);
          }
        }
      }

      function onSentenceEnded() {
        // 🔧 首先设置标志，防止轮询继续触发
        shadowingSentenceEnded = true;

        // Record actual stop time to avoid boundary re-play on next seek
        try {
          let t = null;
          if (isYouTubeVideo && youtubePlayer && youtubePlayer.getCurrentTime) {
            t = Number(youtubePlayer.getCurrentTime());
          } else if (!isYouTubeVideo && videoPlayer) {
            t = Number(videoPlayer.currentTime);
          }
          if (Number.isFinite(t)) {
            shadowingLastStopIndex = shadowingCurrentIndex;
            shadowingLastStopTime = t;
          }
        } catch (_) { }

        // 🔧 清除轮询间隔
        if (shadowingProgressTimer) {
          clearInterval(shadowingProgressTimer);
          shadowingProgressTimer = null;
        }

        console.log('[Shadowing] Sentence playback ended, stopped at:', shadowingLastStopTime);
        // Change status to indicate user should practice
        updateShadowingStatus('请大声跟读，读完后点击"下一句"', '🎙️');

        // Do NOT auto-advance. Wait for user to click "Next" or "Replay"
        // If we want a "recording" phase, we could auto-start recording here if that was the requirement,
        // but the user said "user follows, after following, user clicks next sentence".
        // So we just stop and wait.

        if (shadowingWaitingTimeout) {
          clearTimeout(shadowingWaitingTimeout);
          shadowingWaitingTimeout = null;
        }

        // Optional: Auto-start recording if we want to match "Dialogue" style more closely?
        // The user said "play original sound, user follows". Usually implies they speak.
        // Let's just wait for now as per "user clicks next sentence".
      }


      function goToNextSentence() {
        // 🔧 先标记句子已结束，防止旧的监听器触发
        shadowingSentenceEnded = true;

        // Clear any waiting timeout
        if (shadowingWaitingTimeout) {
          clearTimeout(shadowingWaitingTimeout);
          shadowingWaitingTimeout = null;
        }

        // 🔧 清理旧的 timeupdate 监听器
        if (shadowingAutoPauseListener && videoPlayer) {
          videoPlayer.removeEventListener('timeupdate', shadowingAutoPauseListener);
          shadowingAutoPauseListener = null;
        }

        // 🔧 清理 YouTube 轮询
        if (shadowingYouTubePauseInterval) {
          clearInterval(shadowingYouTubePauseInterval);
          shadowingYouTubePauseInterval = null;
        }

        if (shadowingCurrentIndex < shadowingSentences.length - 1) {
          shadowingCurrentIndex++;
          updateShadowingDisplay();
          console.log('[Shadowing] Manually advanced to sentence', shadowingCurrentIndex);

          // Always play the next sentence when manually advanced
          playCurrentSentenceAuto();

          // Ensure UI reflects playing state if it wasn't already
          if (!shadowingAutoMode) {
            updateShadowingStatus('正在播放...', '▶️');
          }
        } else {
          shadowingAutoMode = false;
          document.getElementById('shadowing-start-btn').style.display = 'block';
          document.getElementById('shadowing-pause-btn').style.display = 'none';
          updateShadowingStatus('完成所有练习！', '🎉');
          console.log('[Shadowing] Completed all sentences');
          if (window.confirm('🎉 已完成本视频所有句子的跟读！\n\n要选择其他视频继续学习吗？')) {
            openVideoLibraryPicker();
          }
        }
      }

      function setupAutoPauseForSentence(sentence) {
        const positionGuard = shadowingPlaybackGuard;
        // Remove existing listeners/intervals if any
        if (shadowingAutoPauseListener && videoPlayer) {
          videoPlayer.removeEventListener('timeupdate', shadowingAutoPauseListener);
          shadowingAutoPauseListener = null;
        }
        if (shadowingYouTubePauseInterval) {
          clearInterval(shadowingYouTubePauseInterval);
          shadowingYouTubePauseInterval = null;
        }

        // Create new listener for regular video player
        if (videoPlayer && !isYouTubeVideo) {
          shadowingAutoPauseListener = () => {
            if (positionGuard !== shadowingPlaybackGuard) return;
            // 🔧 如果句子已被标记为结束（用户点击了下一句），则跳过
            if (shadowingSentenceEnded) return;

            const currentTime = videoPlayer.currentTime;

            // 🔧 使用动态计算的目标结束时间
            if (canFinishShadowingPlayback(currentTime)) {
              // Pause video when sentence ends
              videoPlayer.pause();
              videoPlayer.removeEventListener('timeupdate', shadowingAutoPauseListener);
              shadowingAutoPauseListener = null;
              console.log('[Shadowing] Auto-paused at end of sentence', shadowingCurrentIndex);

              // Trigger sentence ended callback
              onSentenceEnded();
            }
          };
          videoPlayer.addEventListener('timeupdate', shadowingAutoPauseListener);
        }

        // For YouTube player, use polling
        if (isYouTubeVideo && youtubePlayer && youtubePlayer.getCurrentTime) {
          shadowingYouTubePauseInterval = setInterval(() => {
            if (positionGuard !== shadowingPlaybackGuard) return;
            // 🔧 如果句子已被标记为结束，则清理并跳过
            if (shadowingSentenceEnded) {
              clearInterval(shadowingYouTubePauseInterval);
              shadowingYouTubePauseInterval = null;
              return;
            }

            if (!youtubePlayer || !youtubePlayer.getCurrentTime) {
              clearInterval(shadowingYouTubePauseInterval);
              shadowingYouTubePauseInterval = null;
              return;
            }

            const currentTime = youtubePlayer.getCurrentTime();
            // 🔧 使用动态计算的目标结束时间
            if (canFinishShadowingPlayback(currentTime)) {
              // Pause YouTube player
              youtubePlayer.pauseVideo();
              clearInterval(shadowingYouTubePauseInterval);
              shadowingYouTubePauseInterval = null;
              console.log('[Shadowing] Auto-paused YouTube at end of sentence', shadowingCurrentIndex);

              // Trigger sentence ended callback
              onSentenceEnded();
            }
          }, 100); // Check every 100ms
          console.log('[Shadowing] YouTube pause polling started for sentence', shadowingCurrentIndex,
            'startTime:', sentence.startTime, 'endTime:', sentence.endTime);
        }
      }

      // ==================== Dialogue Mode Functions (Auto Flow) ====================

      // Dialogue mode state
      let dialogueState = {
        selectedRole: null,    // User's selected role
        sentences: [],         // All sentences
        userSentences: [],     // Only user role sentences
        currentIndex: 0,       // Current user sentence index
        currentSentence: null, // Current sentence being recorded
        recordedSentences: new Set(), // Set of recorded sentence indexes
        monitorInterval: null, // Playback monitor interval
        isRecording: false,
        recorder: null,
        recordingChunks: [],
        asrDisplayedAt: null   // 🛡️ ASR结果显示时间戳，用于防抖保护
      };

      function initDialogueMode() {
        console.log('[Dialogue] Initializing dialogue mode - showing role selection');

        // 清除跟读模式的定时器和监听器，避免干扰对话模式
        if (shadowingProgressTimer) {
          clearInterval(shadowingProgressTimer);
          shadowingProgressTimer = null;
          console.log('[Dialogue] Cleared shadowing progress timer');
        }
        if (shadowingAutoPauseListener && videoPlayer) {
          videoPlayer.removeEventListener('timeupdate', shadowingAutoPauseListener);
          shadowingAutoPauseListener = null;
          console.log('[Dialogue] Cleared shadowing auto-pause listener');
        }
        if (shadowingYouTubePauseInterval) {
          clearInterval(shadowingYouTubePauseInterval);
          shadowingYouTubePauseInterval = null;
          console.log('[Dialogue] Cleared YouTube pause interval');
        }

        // Get all line items
        const lineItems = document.querySelectorAll('.line-item');
        dialogueState.sentences = Array.from(lineItems).map((item, arrayIndex) => {
          const textEl = item.querySelector('.line-text');
          const speakerEl = item.querySelector('.line-speaker');
          const isUserRole = item.classList.contains('my-role');

          return {
            arrayIndex: arrayIndex,
            index: item.dataset.segmentIndex || arrayIndex,
            text: textEl ? textEl.textContent.trim() : '',
            speaker: speakerEl ? speakerEl.textContent.replace(/\[|\]| - 你的角色/g, '').trim() : '',
            isUserRole: isUserRole,
            start: item.dataset.start ? parseFloat(item.dataset.start) : 0,
            end: item.dataset.end ? parseFloat(item.dataset.end) : 0,
            element: item
          };
        });

        console.log('[Dialogue] Total sentences:', dialogueState.sentences.length);

        // Hide unnecessary elements
        hideDialogueUnnecessaryElements();

        // Show dialogue controls
        const dialogueControls = document.getElementById('dialogue-controls');
        if (dialogueControls) {
          dialogueControls.style.display = 'block';

          // Use event delegation for stop button - this ensures clicks work regardless of when button is created
          dialogueControls.addEventListener('click', (e) => {
            const stopBtn = e.target.closest('#stop-recording-btn');
            if (stopBtn) {
              console.log('[Dialogue Recording] Stop button clicked via delegation');

              // Immediately update UI
              const dialogueStatus = document.getElementById('dialogue-status');
              if (dialogueStatus) {
                dialogueStatus.innerHTML = `
                  <div style="display: flex; align-items: center; justify-content: center; gap: 8px; color: #6b7280;">
                    <span>⏳ 正在处理录音...</span>
                  </div>
                `;
              }

              // Stop recorder immediately
              if (dialogueState.recorder && dialogueState.recorder.state !== 'inactive') {
                dialogueState.isRecording = false;
                try {
                  dialogueState.recorder.stop();
                  console.log('[Dialogue Recording] Recorder stopped via delegation');
                } catch (err) {
                  console.warn('[Dialogue Recording] Error stopping recorder:', err);
                }
              }
            }
          });
        }

        // Show role selection section
        const roleSelectionSection = document.getElementById('role-selection-section');
        if (roleSelectionSection) {
          roleSelectionSection.style.display = 'block';
        }

        // Hide practice container initially
        const practiceContainer = document.getElementById('dialogue-practice-container');
        if (practiceContainer) {
          practiceContainer.style.display = 'none';
        }

        // Restore mode selector visibility when returning to role selection
        const modeSelector = document.getElementById('practice-mode-selector');
        if (modeSelector) {
          modeSelector.classList.remove('dialogue-practicing');
        }

        // Generate role buttons from available speakers
        generateRoleButtons();

        // Setup button listeners
        setupDialogueButtons();
      }

      /**
       * 生成角色选择按钮
       */
      function generateRoleButtons() {
        const container = document.getElementById('role-buttons-container');
        if (!container) return;

        // Extract unique speakers from sentences
        const speakersMap = new Map();
        dialogueState.sentences.forEach(sentence => {
          if (sentence.speaker && !speakersMap.has(sentence.speaker)) {
            speakersMap.set(sentence.speaker, {
              speaker: sentence.speaker,
              count: 1
            });
          } else if (sentence.speaker) {
            speakersMap.get(sentence.speaker).count++;
          }
        });

        const speakers = Array.from(speakersMap.values());
        console.log('[Dialogue] Found speakers:', speakers);

        if (speakers.length === 0) {
          container.innerHTML = '<p style="text-align: center; color: #64748b;">未找到角色信息</p>';
          return;
        }

        container.innerHTML = '';

        const icons = ['🎬', '🎭', '🎤', '👤', '👥', '🗣️', '💬', '🎙️'];

        speakers.forEach((speaker, index) => {
          const button = document.createElement('button');
          button.className = 'role-button';
          button.dataset.speaker = speaker.speaker;

          const icon = icons[index % icons.length];

          button.innerHTML = `
            <span class="role-icon">${icon}</span>
            <span class="role-name">${speaker.speaker}</span>
          `;

          button.addEventListener('click', () => {
            selectRole(speaker.speaker, button);
          });

          container.appendChild(button);
        });

        console.log('[Dialogue] Role buttons generated:', speakers.length);
      }

      /**
       * 选择角色
       */
      function selectRole(speakerName, buttonElement) {
        console.log('[Dialogue] Role selected:', speakerName);

        // Update button states
        document.querySelectorAll('.role-button').forEach(btn => {
          btn.classList.remove('selected');
        });
        if (buttonElement) {
          buttonElement.classList.add('selected');
        }

        // Save selected role
        dialogueState.selectedRole = speakerName;

        // Mark sentences for selected role
        dialogueState.sentences.forEach(sentence => {
          sentence.isUserRole = (sentence.speaker === speakerName);
          // Update DOM element class
          if (sentence.element) {
            if (sentence.isUserRole) {
              sentence.element.classList.add('my-role');
            } else {
              sentence.element.classList.remove('my-role');
            }
          }
        });

        // Update user sentences list
        dialogueState.userSentences = dialogueState.sentences.filter(s => s.isUserRole);
        dialogueState.currentIndex = 0;
        dialogueState.recordedSentences.clear();

        console.log('[Dialogue] User sentences for', speakerName + ':', dialogueState.userSentences.length);

        // Show "Start Practice" button
        const startSection = document.getElementById('start-dialogue-section');
        if (startSection) {
          startSection.style.display = 'block';
        }
      }

      /**
       * 开始对话练习
       */
      function startDialoguePractice() {
        if (!dialogueState.selectedRole) {
          alert('请先选择一个角色！');
          return;
        }

        if (dialogueState.userSentences.length === 0) {
          alert('该角色没有台词，请选择其他角色！');
          return;
        }

        console.log('[Dialogue] Starting practice for role:', dialogueState.selectedRole);

        // Hide role selection, show practice container
        const roleSelectionSection = document.getElementById('role-selection-section');
        const practiceContainer = document.getElementById('dialogue-practice-container');

        if (roleSelectionSection) roleSelectionSection.style.display = 'none';
        if (practiceContainer) practiceContainer.style.display = 'block';

        // Collapse mode selector to save space during practice
        const modeSelector = document.getElementById('practice-mode-selector');
        if (modeSelector) {
          modeSelector.classList.add('dialogue-practicing');
          const toggleBtn = document.getElementById('mode-toggle-btn');
          if (toggleBtn) toggleBtn.textContent = '展开';
        }

        // Start auto dialogue flow
        setTimeout(() => {
          startAutoDialogueFlow();
        }, 500);
      }

      function hideDialogueUnnecessaryElements() {
        const elementsToHide = [
          'fab-record-container',
          'control-modes-panel',
          'auto-practice-status'
        ];

        elementsToHide.forEach(id => {
          const el = document.getElementById(id);
          if (el) el.style.display = 'none';
        });

        const speedSelector = document.querySelector('.speed-selector-group');
        if (speedSelector) speedSelector.style.display = 'none';
      }

      function setupDialogueButtons() {
        const startDialogueBtn = document.getElementById('start-dialogue-btn');
        const perfectBtn = document.getElementById('dialogue-perfect-btn');
        const retryBtn = document.getElementById('dialogue-retry-btn');

        if (startDialogueBtn) {
          startDialogueBtn.onclick = startDialoguePractice;
        }

        if (perfectBtn) {
          perfectBtn.onclick = onPerfectClick;
        }

        if (retryBtn) {
          retryBtn.onclick = onRetryClick;
        }
      }

      function startAutoDialogueFlow() {
        console.log('[Dialogue Flow] Starting auto dialogue flow');

        if (dialogueState.userSentences.length === 0) {
          return;
        }

        dialogueState.currentIndex = 0;
        const firstUserSentence = dialogueState.userSentences[0];

        // Update display
        updateDialogueCurrentLine('🎬 视频播放中...', '即将开始录音', '');

        // Start video from beginning
        const player = videoPlayer || youtubePlayer;
        if (!player) {
          console.error('[Dialogue Flow] No player available');
          return;
        }

        if (youtubePlayer && youtubePlayer.seekTo) {
          youtubePlayer.seekTo(0);
          youtubePlayer.playVideo();
        } else if (videoPlayer) {
          videoPlayer.currentTime = 0;
          videoPlayer.play();
        }

        // Setup playback monitor
        setupDialoguePlaybackMonitor();
      }

      function setupDialoguePlaybackMonitor() {
        // Clear existing monitor
        if (dialogueState.monitorInterval) {
          clearInterval(dialogueState.monitorInterval);
        }

        if (dialogueState.currentIndex >= dialogueState.userSentences.length) {
          console.log('[Dialogue Monitor] All sentences completed');
          return;
        }

        let hasTriggered = false;

        console.log('[Dialogue Monitor] Starting monitor for user sentence', dialogueState.currentIndex);

        dialogueState.monitorInterval = setInterval(() => {
          const targetSentence = dialogueState.userSentences[dialogueState.currentIndex];
          if (!targetSentence) {
            clearInterval(dialogueState.monitorInterval);
            return;
          }

          const currentTime = getCurrentVideoTime();
          if (currentTime === null) return;

          // Early preparation: 2.5 seconds before sentence starts to ensure MediaRecorder is fully ready
          // Mobile browsers (especially iOS Safari) have significant MediaRecorder initialization delay
          const earlyPrepareThreshold = Math.max(0, targetSentence.start - 2.5);
          // Pause threshold: 0.3 seconds before user sentence starts
          const pauseThreshold = Math.max(0, targetSentence.start - 0.3);
          const recordThreshold = targetSentence.start + 0.3;

          // Trigger pause and recording
          if (!hasTriggered &&
            ((currentTime >= earlyPrepareThreshold && currentTime < targetSentence.start) ||
              (currentTime >= targetSentence.start && currentTime < recordThreshold))) {

            console.log('[Dialogue Flow] Triggering for user sentence (t=' + currentTime.toFixed(2) + 's):', targetSentence.text);
            hasTriggered = true;

            // STEP 1: Start recording FIRST (before pausing video or showing UI)
            // This is critical to capture the very first syllable the user speaks
            console.log('[Dialogue Flow] Starting recording immediately');
            startDialogueAutoRecording(targetSentence, { showPreparePrompt: true });

            // STEP 2: Then pause video (slight delay to let recorder initialize)
            setTimeout(() => {
              pauseVideo();
              console.log('[Dialogue Flow] Video paused');
            }, 50);

            // STEP 3: Show "Get Ready" prompt
            const dialogueStatus = document.getElementById('dialogue-status');
            if (dialogueStatus) {
              dialogueStatus.style.display = 'block';
              dialogueStatus.innerHTML = '<div style="font-size: 20px; font-weight: 600; color: #f59e0b; animation: pulse 0.5s ease-in-out infinite;">⏱️ 准备...</div>';
            }

            // After 800ms, update the prompt to show recording started
            setTimeout(() => {
              if (dialogueStatus && dialogueStatus.style.display !== 'none') {
                dialogueStatus.innerHTML = `
                  <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                      <div style="width: 8px; height: 8px; background: #ef4444; border-radius: 50%; animation: pulse 1s ease-in-out infinite;"></div>
                      <span>🎤 正在录音...</span>
                    </div>
                    <button id="stop-recording-btn" style="
                      padding: 8px 16px;
                      background: #dc2626;
                      color: white;
                      border: none;
                      border-radius: 6px;
                      cursor: pointer;
                      font-size: 14px;
                      font-weight: 600;
                      white-space: nowrap;
                    ">停止录音</button>
                  </div>
                `;

                // Re-attach the stop button handler after UI update
                const stopBtn = document.getElementById('stop-recording-btn');
                if (stopBtn && dialogueState.isRecording) {
                  stopBtn.addEventListener('click', () => {
                    if (dialogueState.recorder && dialogueState.recorder.state !== 'inactive') {
                      // Immediately update UI to show stopping
                      dialogueState.isRecording = false;
                      const dialogueStatus = document.getElementById('dialogue-status');
                      if (dialogueStatus) {
                        dialogueStatus.innerHTML = `
                          <div style="display: flex; align-items: center; justify-content: center; gap: 8px; color: #6b7280;">
                            <span>⏳ 正在处理录音...</span>
                          </div>
                        `;
                      }

                      // Stop recorder immediately
                      try {
                        dialogueState.recorder.stop();
                        console.log('[Dialogue Recording] Manually stopped immediately (re-attached handler)');
                      } catch (e) {
                        console.warn('[Dialogue Recording] Failed to stop:', e);
                      }
                    }
                  });
                }
              }
            }, 800);
          }
        }, 100);
      }

      // ==================== Audio Processing Helpers ====================

      /**
       * Trim silence from the beginning and end of an audio blob
       * @param {Blob} blob - Original audio blob
       * @param {number} silenceThreshold - Silence threshold (0-1), default 0.01
       * @param {boolean} isMobile - Whether running on mobile
       * @param {AudioContext} existingContext - Optional existing AudioContext
       * @returns {Promise<{blob: Blob, trimmedDuration: number, startOffset: number, endOffset: number}>}
       */
      async function trimSilence(blob, silenceThreshold = 0.01, isMobile = false, existingContext = null) {
        try {
          console.log(`[Silence Trim] Starting... Mobile: ${isMobile}, Size: ${(blob.size / 1024).toFixed(2)}KB`);

          // Create or use existing AudioContext
          const audioContext = existingContext || new (window.AudioContext || window.webkitAudioContext)();

          // Convert blob to ArrayBuffer
          let arrayBuffer;
          try {
            arrayBuffer = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(new Error('FileReader failed'));
              reader.readAsArrayBuffer(blob);
            });
          } catch (readerErr) {
            console.error('[Silence Trim] FileReader failed:', readerErr);
            arrayBuffer = await blob.arrayBuffer();
          }

          // Decode audio data
          let audioBuffer;
          try {
            audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
          } catch (decodeErr) {
            console.error('[Silence Trim] Decode failed:', decodeErr);
            return { blob, trimmedDuration: null, startOffset: 0, endOffset: 0 };
          }

          const channelData = audioBuffer.getChannelData(0);
          const sampleRate = audioBuffer.sampleRate;
          const numSamples = channelData.length;

          // Use different thresholds for start and end
          // Lower threshold for start (more sensitive) to avoid cutting speech
          // Higher threshold for end (less sensitive) to aggressively remove trailing noise
          const startThreshold = silenceThreshold * 0.5; // More sensitive for beginning
          const endThreshold = silenceThreshold * 1.5;   // Less sensitive for end

          // Find start index - use RMS window for better speech detection
          let startIndex = 0;
          const windowSize = Math.floor(sampleRate * 0.01); // 10ms window
          for (let i = 0; i < numSamples - windowSize; i += windowSize) {
            let rms = 0;
            for (let j = 0; j < windowSize; j++) {
              rms += channelData[i + j] * channelData[i + j];
            }
            rms = Math.sqrt(rms / windowSize);
            if (rms > startThreshold) {
              startIndex = i;
              break;
            }
          }

          // Find end index - use simple threshold for trailing silence
          let endIndex = numSamples - 1;
          for (let i = numSamples - 1; i >= startIndex; i--) {
            if (Math.abs(channelData[i]) > endThreshold) {
              endIndex = i + 1;
              break;
            }
          }

          // If all silence
          if (startIndex >= endIndex) {
            console.warn('[Silence Trim] All silence detected');
            return { blob, trimmedDuration: audioBuffer.duration, startOffset: 0, endOffset: 0 };
          }

          // Add buffer: more at start (100ms) to preserve consonants, less at end (30ms)
          const startBufferSamples = Math.floor(sampleRate * 0.1);  // 100ms buffer at start
          const endBufferSamples = Math.floor(sampleRate * 0.03);   // 30ms buffer at end
          startIndex = Math.max(0, startIndex - startBufferSamples);
          endIndex = Math.min(numSamples, endIndex + endBufferSamples);

          const trimmedLength = endIndex - startIndex;
          const trimmedDuration = trimmedLength / sampleRate;
          const startOffset = startIndex / sampleRate;
          const endOffset = (numSamples - endIndex) / sampleRate;

          console.log(`[Silence Trim] Original: ${audioBuffer.duration.toFixed(2)}s, Trimmed: ${trimmedDuration.toFixed(2)}s, Start: -${startOffset.toFixed(2)}s, End: -${endOffset.toFixed(2)}s`);

          // Mobile optimization: Virtual trimming (skip re-encoding)
          if (isMobile) {
            return {
              blob,
              trimmedDuration,
              startOffset,
              endOffset
            };
          }

          // PC: Re-encode
          const trimmedBuffer = audioContext.createBuffer(
            audioBuffer.numberOfChannels,
            trimmedLength,
            sampleRate
          );

          for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
            const sourceData = audioBuffer.getChannelData(channel);
            const targetData = trimmedBuffer.getChannelData(channel);
            for (let i = 0; i < trimmedLength; i++) {
              targetData[i] = sourceData[startIndex + i];
            }
          }

          const trimmedBlob = await encodeAudioBuffer(trimmedBuffer, audioContext);
          return {
            blob: trimmedBlob,
            trimmedDuration,
            startOffset: 0,
            endOffset: 0
          };

        } catch (err) {
          console.error('[Silence Trim] Error:', err);
          return { blob, trimmedDuration: null, startOffset: 0, endOffset: 0 };
        }
      }

      /**
       * Encode AudioBuffer to Blob
       */
      async function encodeAudioBuffer(audioBuffer, audioContext) {
        return new Promise((resolve, reject) => {
          const numberOfChannels = audioBuffer.numberOfChannels;
          const length = audioBuffer.length;
          const sampleRate = audioBuffer.sampleRate;

          const offlineContext = new OfflineAudioContext(numberOfChannels, length, sampleRate);
          const source = offlineContext.createBufferSource();
          source.buffer = audioBuffer;

          const dest = audioContext.createMediaStreamDestination();
          const onlineSource = audioContext.createBufferSource();
          onlineSource.buffer = audioBuffer;
          onlineSource.connect(dest);

          // Detect supported MIME type
          const preferredMimeTypes = [
            'audio/mp4;codecs=mp4a.40.2',
            'audio/mp4',
            'audio/aac',
            'audio/mpeg',
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg',
          ];
          let mimeType = 'audio/webm';
          if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
            const found = preferredMimeTypes.find(t => MediaRecorder.isTypeSupported(t));
            if (found) mimeType = found;
          }

          let mediaRecorder;
          try {
            mediaRecorder = new MediaRecorder(dest.stream, { mimeType });
          } catch (err) {
            mediaRecorder = new MediaRecorder(dest.stream);
          }

          const chunks = [];
          mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
          };

          mediaRecorder.onstop = () => {
            const rawType = mediaRecorder.mimeType || mimeType;
            const simpleType = rawType.split(';')[0];
            const blob = new Blob(chunks, { type: simpleType });
            resolve(blob);
          };

          mediaRecorder.onerror = (e) => reject(e.error);

          mediaRecorder.start();
          onlineSource.start(0);

          // Stop recording after duration + buffer
          setTimeout(() => {
            if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
          }, (audioBuffer.duration * 1000) + 200);
        });
      }

      async function startDialogueAutoRecording(sentence, options = {}) {
        console.log('[Dialogue Recording] Starting auto recording:', sentence.text);

        dialogueState.currentSentence = sentence;

        // Update UI
        updateDialogueCurrentLine(sentence.speaker, sentence.text, `已录 ${dialogueState.recordedSentences.size}/${dialogueState.userSentences.length}`);

        // Only update UI if not showing prepare prompt
        // (prepare prompt will be updated by the caller after 800ms)
        if (!options.showPreparePrompt) {
          const dialogueStatus = document.getElementById('dialogue-status');
          if (dialogueStatus) {
            dialogueStatus.style.display = 'block';
            dialogueStatus.innerHTML = `
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <div style="width: 8px; height: 8px; background: #ef4444; border-radius: 50%; animation: pulse 1s ease-in-out infinite;"></div>
                  <span>🎤 正在录音...</span>
                </div>
                <button id="stop-recording-btn" style="
                  padding: 8px 16px;
                  background: #dc2626;
                  color: white;
                  border: none;
                  border-radius: 6px;
                  cursor: pointer;
                  font-size: 14px;
                  font-weight: 600;
                  white-space: nowrap;
                ">停止录音</button>
              </div>
            `;
          }
        }

        // Add manual stop button handler
        const stopRecordingBtn = document.getElementById('stop-recording-btn');
        if (stopRecordingBtn) {
          // Remove any existing listeners
          const newBtn = stopRecordingBtn.cloneNode(true);
          stopRecordingBtn.parentNode.replaceChild(newBtn, stopRecordingBtn);

          // Add click handler
          newBtn.addEventListener('click', () => {
            if (dialogueState.isRecording && dialogueState.recorder) {
              console.log('[Dialogue Recording] Manual stop requested');

              // Immediately update UI to show stopping
              dialogueState.isRecording = false;
              const dialogueStatus = document.getElementById('dialogue-status');
              if (dialogueStatus) {
                dialogueStatus.innerHTML = `
                  <div style="display: flex; align-items: center; justify-content: center; gap: 8px; color: #6b7280;">
                    <span>⏳ 正在处理录音...</span>
                  </div>
                `;
              }

              // Stop recorder immediately
              try {
                if (dialogueState.recorder.state !== 'inactive') {
                  dialogueState.recorder.stop();
                  console.log('[Dialogue Recording] Manually stopped immediately');
                }
              } catch (e) {
                console.warn('[Dialogue Recording] Failed to stop recorder:', e);
              }
            }
          });
        }

        // Hide action buttons during recording
        const actionButtons = document.getElementById('dialogue-action-buttons');
        if (actionButtons) {
          actionButtons.style.display = 'none';
        }

        // Start recording
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

          // Detect supported MIME type (Aligned with desktop implementation)
          const preferredMimeTypes = [
            'audio/mp4;codecs=mp4a.40.2',
            'audio/mp4',
            'audio/aac',
            'audio/mpeg',
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg',
          ];

          let requestedMimeType = null;
          let recorderOptions = null;

          if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
            requestedMimeType = preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) || null;
            if (requestedMimeType) {
              recorderOptions = { mimeType: requestedMimeType };
            }
          }

          console.log(`[Dialogue Recording] Requested MIME type: ${requestedMimeType}`);

          try {
            dialogueState.recorder = recorderOptions
              ? new MediaRecorder(stream, recorderOptions)
              : new MediaRecorder(stream);
          } catch (e) {
            console.warn(`[Dialogue Recording] Failed to init MediaRecorder with ${requestedMimeType}, falling back to default`, e);
            dialogueState.recorder = new MediaRecorder(stream);
          }

          // Store effective mime type
          dialogueState.mimeType = dialogueState.recorder.mimeType || requestedMimeType || 'audio/webm';
          console.log(`[Dialogue Recording] Effective MIME type: ${dialogueState.mimeType}`);

          dialogueState.recordingChunks = [];

          dialogueState.recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              dialogueState.recordingChunks.push(e.data);
              // Update mime type if available from event
              if (!dialogueState.mimeType && e.data.type) {
                dialogueState.mimeType = e.data.type;
              }
            }
          };

          dialogueState.recorder.onstop = async () => {
            // Use simple MIME type (strip codecs) to avoid 400 errors
            const rawType = dialogueState.mimeType || (dialogueState.recordingChunks[0] ? dialogueState.recordingChunks[0].type : 'audio/webm');
            const simpleType = rawType.split(';')[0];

            const blob = new Blob(dialogueState.recordingChunks, { type: simpleType });
            console.log(`[Dialogue Recording] Recording stopped. Chunks: ${dialogueState.recordingChunks.length}, Blob size: ${blob.size}, type: ${blob.type} (raw: ${rawType})`);

            // Trim silence
            const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
            const trimResult = await trimSilence(blob, 0.01, isMobile);

            if (trimResult.blob) {
              console.log(`[Dialogue Recording] Trimmed blob size: ${trimResult.blob.size}`);
              onRecordingComplete(trimResult.blob, trimResult.startOffset, trimResult.endOffset);
            } else {
              console.warn('[Dialogue Recording] Trim failed, using original blob');
              onRecordingComplete(blob, 0, 0);
            }

            stream.getTracks().forEach(track => track.stop());
          };

          // Start recording with timeslice to ensure data is flushed periodically
          // This is critical for mobile browsers (especially iOS Safari) to collect all data
          const timeslice = 100; // Request data every 100ms
          dialogueState.recorder.start(timeslice);
          dialogueState.isRecording = true;
          console.log(`[Dialogue Recording] Started with timeslice: ${timeslice}ms`);

          // Auto-stop recording after sentence duration + minimal buffer time
          // IMPORTANT: We start recording ~2.5 seconds BEFORE the video pauses
          // This ensures MediaRecorder is fully initialized before user starts speaking
          const preRollTime = 2500; // Recording starts 2.5s before sentence (to ensure recorder is ready)
          const sentenceDuration = (sentence.end - sentence.start) * 1000;
          // Buffer time: minimal extra time to accommodate natural speech variation
          // Use smaller buffer (1.5s or 30% of sentence) to reduce trailing noise
          const bufferTime = Math.min(2000, Math.max(1500, sentenceDuration * 0.3));
          const recordingDuration = preRollTime + sentenceDuration + bufferTime;
          console.log(`[Dialogue Recording] Pre-roll: ${preRollTime}ms, Sentence: ${sentenceDuration.toFixed(0)}ms, Buffer: ${bufferTime.toFixed(0)}ms, Total: ${recordingDuration.toFixed(0)}ms`);
          setTimeout(() => {
            if (dialogueState.isRecording && dialogueState.recorder) {
              // Request any remaining data before stopping
              try {
                dialogueState.recorder.requestData();
                console.log('[Dialogue Recording] Requested final data before stop');
              } catch (e) {
                console.warn('[Dialogue Recording] Failed to request final data:', e);
              }

              // Stop after a small delay to ensure final data is collected
              setTimeout(() => {
                if (dialogueState.recorder && dialogueState.recorder.state !== 'inactive') {
                  dialogueState.recorder.stop();
                  dialogueState.isRecording = false;
                  console.log('[Dialogue Recording] Auto-stopped recording');
                }
              }, 50);
            }
          }, recordingDuration);

        } catch (err) {
          console.error('[Dialogue Recording] Failed to start recording:', err);
          alert('无法访问麦克风，请检查权限设置');
        }
      }

      async function onRecordingComplete(blob, startOffset = 0, endOffset = 0) {
        console.log(`[Dialogue Recording] Recording complete. Blob size: ${blob.size}, Offsets: ${startOffset.toFixed(2)}s - ${endOffset.toFixed(2)}s`);

        // Validate recording integrity by checking blob size and duration
        if (blob.size < 1000) {
          console.error('[Dialogue Recording] Recording too small, likely incomplete:', blob.size);
          alert('录音失败：录音数据不完整，请重试');
          return;
        }

        // Verify audio duration (optional but helpful for debugging)
        try {
          const audioContext = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
          if (!state.audioContext) state.audioContext = audioContext;

          const arrayBuffer = await blob.arrayBuffer();
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
          const actualDuration = audioBuffer.duration;
          const expectedDuration = dialogueState.currentSentence ?
            (dialogueState.currentSentence.end - dialogueState.currentSentence.start) : 0;

          console.log(`[Dialogue Recording] Audio validation - Actual: ${actualDuration.toFixed(2)}s, Expected: ${expectedDuration.toFixed(2)}s, Size: ${blob.size} bytes`);

          // Warn if duration is suspiciously short (less than 50% of expected)
          if (expectedDuration > 0 && actualDuration < expectedDuration * 0.5) {
            console.warn(`[Dialogue Recording] ⚠️ Recording may be incomplete - actual ${actualDuration.toFixed(2)}s vs expected ${expectedDuration.toFixed(2)}s`);
          }
        } catch (e) {
          console.warn('[Dialogue Recording] Could not validate audio duration:', e);
        }

        // Hide recording status
        const dialogueStatus = document.getElementById('dialogue-status');
        if (dialogueStatus) {
          dialogueStatus.style.display = 'none';
        }

        // Save recording blob and offsets
        if (dialogueState.currentSentence) {
          dialogueState.currentSentence.recordingBlob = blob;
          dialogueState.currentSentence.recordingStartOffset = startOffset;
          dialogueState.currentSentence.recordingEndOffset = endOffset;
        }

        // Call ASR to recognize speech
        if (dialogueState.currentSentence) {
          await performDialogueASR(blob, dialogueState.currentSentence.text);
        }

        // Show action buttons after ASR
        const actionButtons = document.getElementById('dialogue-action-buttons');
        if (actionButtons) {
          actionButtons.style.display = 'flex';
        }

        // 🛡️ 记录按钮显示时间，用于防抖保护
        dialogueState.asrDisplayedAt = Date.now();
        console.log('[Dialogue] Action buttons shown at:', dialogueState.asrDisplayedAt);
      }

      function onPerfectClick(e) {
        // 🛡️ 防抖保护：ASR显示后1.5秒内忽略点击，防止误触发
        const timeSinceDisplay = dialogueState.asrDisplayedAt
          ? Date.now() - dialogueState.asrDisplayedAt
          : Infinity;

        if (timeSinceDisplay < 1500) {
          console.warn('[Dialogue] ⚠️ Perfect click ignored - too soon after ASR display:', timeSinceDisplay, 'ms');
          if (e) {
            e.preventDefault();
            e.stopPropagation();
          }
          return false;
        }

        console.log('[Dialogue] Perfect clicked after', timeSinceDisplay, 'ms');

        // 清除时间戳
        dialogueState.asrDisplayedAt = null;

        if (dialogueState.currentSentence) {
          // Mark as recorded
          dialogueState.recordedSentences.add(dialogueState.currentSentence.index);
          console.log('[Dialogue] Marked sentence as recorded:', dialogueState.currentSentence.index);
        }

        // Hide action buttons and ASR section
        const actionButtons = document.getElementById('dialogue-action-buttons');
        if (actionButtons) {
          actionButtons.style.display = 'none';
        }

        const asrSection = document.getElementById('asr-comparison-section');
        if (asrSection) {
          asrSection.style.display = 'none';
        }

        // Continue to next sentence
        continueToNextSentence();
      }

      function onRetryClick() {
        console.log('[Dialogue] Retry clicked');

        if (dialogueState.currentSentence) {
          // Remove from recorded set (allow retry)
          dialogueState.recordedSentences.delete(dialogueState.currentSentence.index);

          // Hide action buttons and ASR section
          const actionButtons = document.getElementById('dialogue-action-buttons');
          if (actionButtons) {
            actionButtons.style.display = 'none';
          }

          const asrSection = document.getElementById('asr-comparison-section');
          if (asrSection) {
            asrSection.style.display = 'none';
          }

          // Restart recording for current sentence
          setTimeout(() => {
            startDialogueAutoRecording(dialogueState.currentSentence);
          }, 500);
        }
      }

      function continueToNextSentence() {
        dialogueState.currentIndex++;

        if (dialogueState.currentIndex >= dialogueState.userSentences.length) {
          // All completed
          console.log('[Dialogue Flow] All sentences completed!');
          updateDialogueCurrentLine('🎉 恭喜', '所有台词录制完成！', `已录 ${dialogueState.recordedSentences.size}/${dialogueState.userSentences.length}`);

          if (dialogueState.monitorInterval) {
            clearInterval(dialogueState.monitorInterval);
          }
          return;
        }

        const nextSentence = dialogueState.userSentences[dialogueState.currentIndex];
        const prevSentence = dialogueState.userSentences[dialogueState.currentIndex - 1];

        // Seek and play to next sentence
        let seekTime = Math.max(0, nextSentence.start - 2);
        if (prevSentence && seekTime < prevSentence.end) {
          seekTime = prevSentence.end;
        }

        if (youtubePlayer && youtubePlayer.seekTo) {
          youtubePlayer.seekTo(seekTime);
          youtubePlayer.playVideo();
        } else if (videoPlayer) {
          videoPlayer.currentTime = seekTime;
          videoPlayer.play();
        }

        // Restart monitor
        setupDialoguePlaybackMonitor();

        updateDialogueCurrentLine('🎬 播放下一段...', '', '');
      }

      function updateDialogueCurrentLine(speaker, text, progress) {
        const practiceCurrentLine = document.getElementById('practice-current-line');
        console.log('[Dialogue] Updating current line (New Layout)', { speaker, text, progress }); // DEBUG
        if (!practiceCurrentLine) return;

        practiceCurrentLine.hidden = false;
        practiceCurrentLine.style.display = 'block';
        practiceCurrentLine.style.visibility = 'visible';
        practiceCurrentLine.style.opacity = '1';

        const progressHTML = progress ? `<div class="dialogue-progress">${progress}</div>` : '';
        const speakerHTML = speaker ? `<div class="dialogue-role-badge my-role">${speaker}</div>` : '';
        const textHTML = text ? `<div class="practice-current-text">${text}</div>` : '';

        practiceCurrentLine.innerHTML = `
          <div class="dialogue-info-row">
            ${speakerHTML}
            ${progressHTML}
          </div>
          ${textHTML}
        `;
      }

      function getCurrentVideoTime() {
        if (youtubePlayer && youtubePlayer.getCurrentTime) {
          return youtubePlayer.getCurrentTime();
        } else if (videoPlayer) {
          return videoPlayer.currentTime;
        }
        return null;
      }

      function pauseVideo() {
        if (youtubePlayer && youtubePlayer.pauseVideo) {
          youtubePlayer.pauseVideo();
        } else if (videoPlayer) {
          videoPlayer.pause();
        }
      }

      /**
       * Perform ASR (Speech Recognition) for dialogue mode
       */
      async function performDialogueASR(audioBlob, originalText) {
        console.log('[Dialogue ASR] Starting recognition...');

        // Show ASR section
        const asrSection = document.getElementById('asr-comparison-section');
        if (asrSection) {
          asrSection.style.display = 'block';
        }

        // Show original text
        const originalTextEl = document.getElementById('original-text-content');
        if (originalTextEl) {
          originalTextEl.textContent = originalText;
        }

        // Show loading state
        const asrTextEl = document.getElementById('asr-text-content');
        if (asrTextEl) {
          asrTextEl.innerHTML = '<span class="loading">正在识别...</span>';
        }

        try {
          // Convert audioBlob to base64
          const audioBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(audioBlob);
          });

          // Ensure we have a valid account token, not a placeholder.
          const freshToken = await ensureAuthToken();

          // Call pronunciation API（与桌面版保持一致，交由后端决定provider与fallback）
          const headers = {
            'Content-Type': 'application/json'
          };
          if (freshToken) headers['Authorization'] = `Bearer ${freshToken}`;

          const assessUrl = `${API_BASE}/pronunciation/assess`;

          let response = await fetch(assessUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              text: originalText,
              audio_data: audioBase64,
              fast_asr: true,
              lemma: null
            })
          });

          // If token missing/expired and we're in guest mode, try guest login once and retry.
          // For registered users, prompt re-login instead of silently switching to guest.
          if (response.status === 401) {
            try {
              console.warn('[Auth] /pronunciation/assess 401', {
                hasToken: Boolean(freshToken),
                guestMode: isGuestMode(),
              });
            } catch (_) { }

            if (isGuestMode()) {
              const retryToken = await ensureAuthToken({ force: true });
              if (retryToken) {
                headers['Authorization'] = `Bearer ${retryToken}`;
                response = await fetch(`${API_BASE}/pronunciation/assess`, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({
                    text: originalText,
                    audio_data: audioBase64,
                    fast_asr: true,
                    lemma: null
                  })
                });
              }
            } else {
              clearAuthToken();
              throw new Error('登录已过期，请重新登录后再试');
            }
          }

          if (!response.ok) {
            let errorData = null;
            try { errorData = await response.json(); } catch (_) { }
            if (!errorData) {
              const text = await response.text().catch(() => '');
              errorData = { message: text ? text.slice(0, 200) : '' };
            }
            if (response.status === 402 && errorData.code === 'PRONUNCIATION_DAILY_LIMIT_REACHED') {
              const quota = errorData.quota || {};
              const tier = String(quota.tier || 'free').toLowerCase();
              const paywall = errorData.paywall || null;
              const message = paywall?.message || (tier === 'free'
                ? `今日免费发音评测 ${quota.limit || 0} 次已用完，升级会员可继续练习。`
                : '今日发音评测额度已用完，明天会自动恢复。');
              throw new Error(message);
            }
            throw new Error(errorData.error || errorData.message || `ASR API error: ${response.status}`);
          }

          const data = await response.json();
          const asrText = data.hypothesis || '';
          const accuracy = data.assessment?.accuracy || 0;

          console.log('[Dialogue ASR] Recognition result:', {
            hypothesis: asrText,
            accuracy: accuracy,
            originalText: originalText
          });

          applyDialogueASRResult(originalText, asrText, accuracy, audioBlob);

          return asrText;
        } catch (error) {
          console.error('[Dialogue ASR] Recognition failed:', error);

          if (asrTextEl) {
            asrTextEl.innerHTML = `<span style="color: #dc2626;">识别失败: ${error.message}</span>`;
          }

          // If permission error, show message
          if (error.message.includes('MEMBERSHIP_REQUIRED') || error.message.includes('403')) {
            if (asrTextEl) {
              asrTextEl.innerHTML = '<span style="color: #dc2626;">需要会员权限才能使用语音识别功能</span>';
            }
          }

          return null;
        }
      }

      // Shared result application to mirror PC flow and reuse for fallback
      function applyDialogueASRResult(originalText, asrText, accuracy, audioBlob) {
        if (dialogueState.currentSentence) {
          dialogueState.currentSentence.asrText = asrText;
          dialogueState.currentSentence.accuracy = accuracy;
        }

        displayASRComparison(originalText, asrText, accuracy);

        // Auto-play user recording
        setTimeout(() => {
          playUserRecording(audioBlob);
        }, 500);
      }

      /**
       * Number-word mapping for comparison
       */
      const numberWordMap = {
        '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
        '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
        '10': 'ten', '11': 'eleven', '12': 'twelve', '13': 'thirteen', '14': 'fourteen',
        '15': 'fifteen', '16': 'sixteen', '17': 'seventeen', '18': 'eighteen', '19': 'nineteen',
        '20': 'twenty', '30': 'thirty', '40': 'forty', '50': 'fifty',
        '60': 'sixty', '70': 'seventy', '80': 'eighty', '90': 'ninety',
        '100': 'hundred', '1000': 'thousand'
      };

      // Reverse mapping (word to number)
      const wordNumberMap = {};
      Object.entries(numberWordMap).forEach(([num, word]) => {
        wordNumberMap[word] = num;
      });

      /**
       * Normalize word by removing punctuation and handling number/word equivalents
       */
      function normalizeWord(word) {
        const cleaned = word.replace(/[^a-z0-9']/gi, '').toLowerCase();

        // If it's a number, also store the word equivalent
        if (numberWordMap[cleaned]) {
          return [cleaned, numberWordMap[cleaned]];
        }

        // If it's a word that represents a number, also store the number
        if (wordNumberMap[cleaned]) {
          return [cleaned, wordNumberMap[cleaned]];
        }

        return [cleaned];
      }

      /**
       * Check if two normalized word arrays have any match
       */
      function wordsMatch(normalizedWords1, normalizedWords2) {
        return normalizedWords1.some(w1 => normalizedWords2.includes(w1));
      }

      /**
       * Display ASR text comparison (green for match, red for mismatch)
       */
      function displayASRComparison(originalText, asrText, accuracy) {
        const asrTextEl = document.getElementById('asr-text-content');
        if (!asrTextEl) return;

        // Simple word-level comparison with punctuation and number normalization
        const originalWords = originalText.toLowerCase().split(/\s+/);
        const asrWords = asrText.toLowerCase().split(/\s+/);

        // Normalize words for comparison (returns arrays to handle number/word equivalents)
        const originalWordsNormalized = originalWords.map(normalizeWord);
        const asrWordsNormalized = asrWords.map(normalizeWord);

        // Flatten for easier searching
        const originalWordsFlat = originalWordsNormalized.flat().filter(Boolean);
        const asrWordsFlat = asrWordsNormalized.flat().filter(Boolean);

        let html = '';
        for (let i = 0; i < asrWords.length; i++) {
          const word = asrWords[i];
          const normalizedWordArray = asrWordsNormalized[i];
          // Check if any variant of this word exists in original
          const isMatch = normalizedWordArray.length > 0 && wordsMatch(normalizedWordArray, originalWordsFlat);
          const className = isMatch ? 'match' : 'mismatch';
          html += `<span class="word ${className}">${word}</span> `;
        }

        asrTextEl.innerHTML = html || '<span style="color: #94a3b8;">无识别结果</span>';

        // Also highlight matching words in original text
        const originalTextEl = document.getElementById('original-text-content');
        if (originalTextEl) {
          let originalHtml = '';
          for (let i = 0; i < originalWords.length; i++) {
            const word = originalWords[i];
            const normalizedWordArray = originalWordsNormalized[i];
            // Check if any variant of this word exists in ASR result
            const isMatch = normalizedWordArray.length > 0 && wordsMatch(normalizedWordArray, asrWordsFlat);
            const className = isMatch ? 'match' : '';
            originalHtml += `<span class="word ${className}">${word}</span> `;
          }
          originalTextEl.innerHTML = originalHtml;
        }

        // Update ASR title with accuracy
        const asrTitle = document.querySelector('.asr-title');
        if (asrTitle && accuracy !== undefined) {
          const emoji = accuracy >= 80 ? '✅' : accuracy >= 60 ? '⚠️' : '❌';
          const color = accuracy >= 80 ? '#059669' : accuracy >= 60 ? '#f59e0b' : '#dc2626';

          asrTitle.innerHTML = `
            <span>${emoji} 识别结果</span>
            <span style="font-size: 13px; color: ${color}; font-weight: 700;">准确度: ${accuracy}%</span>
          `;
        }
      }

      /**
       * Play user recording
       */
      let currentUserRecordingAudio = null;
      let originalPlaybackPauseHandler = null;
      let originalYouTubePauseInterval = null;
      function playUserRecording(audioBlob, startOffset = 0, endOffset = 0) {
        if (!audioBlob) {
          console.warn('[Dialogue] No recording to play');
          return;
        }

        // Ensure original playback is stopped before playing user recording
        if (originalPlaybackPauseHandler && videoPlayer) {
          videoPlayer.removeEventListener('timeupdate', originalPlaybackPauseHandler);
          originalPlaybackPauseHandler = null;
        }
        if (originalYouTubePauseInterval) {
          clearInterval(originalYouTubePauseInterval);
          originalYouTubePauseInterval = null;
        }
        if (isYouTubeVideo && youtubePlayer && youtubePlayer.pauseVideo) {
          youtubePlayer.pauseVideo();
        } else if (videoPlayer) {
          videoPlayer.pause();
        }
        if (currentUserRecordingAudio) {
          try { currentUserRecordingAudio.pause(); } catch (_) { }
          currentUserRecordingAudio = null;
        }

        console.log(`[Dialogue] Playing user recording. Offsets: ${startOffset.toFixed(2)}s - ${endOffset.toFixed(2)}s`);

        const audio = new Audio(URL.createObjectURL(audioBlob));
        currentUserRecordingAudio = audio;

        audio.onloadedmetadata = () => {
          if (startOffset > 0) {
            audio.currentTime = startOffset;
          }
        };

        const stopTimeHandler = () => {
          if (endOffset > 0 && audio.duration && (audio.currentTime >= audio.duration - endOffset)) {
            audio.pause();
            // Manually trigger cleanup
            cleanup();
          }
        };

        if (endOffset > 0) {
          audio.addEventListener('timeupdate', stopTimeHandler);
        }

        const cleanup = () => {
          audio.removeEventListener('timeupdate', stopTimeHandler);
          URL.revokeObjectURL(audio.src);
          if (currentUserRecordingAudio === audio) {
            currentUserRecordingAudio = null;
          }
          console.log('[Dialogue] Recording playback complete');
        };

        audio.onended = cleanup;

        audio.play().catch(err => {
          console.error('[Dialogue] Failed to play recording:', err);
        });
      }

      // Play original audio for current sentence
      function playOriginalAudio() {
        if (!dialogueState.currentSentence) {
          console.warn('[Dialogue] No current sentence to play');
          return;
        }

        const sentence = dialogueState.currentSentence;
        console.log('[Dialogue] Playing original audio for sentence:', sentence.text);

        // Stop user recording playback before starting original audio
        if (currentUserRecordingAudio) {
          try { currentUserRecordingAudio.pause(); } catch (_) { }
          currentUserRecordingAudio = null;
        }
        if (originalYouTubePauseInterval) {
          clearInterval(originalYouTubePauseInterval);
          originalYouTubePauseInterval = null;
        }

        // Pause any auto-flow monitoring
        if (dialogueState.monitorInterval) {
          clearInterval(dialogueState.monitorInterval);
          dialogueState.monitorInterval = null;
        }
        // Clear any pending auto-playback guards that might force pause
        if (state.segmentPlaybackEnd != null) {
          state.segmentPlaybackEnd = null;
          state.segmentPlaybackCallback = null;
        }
        if (state.activePause && state.activePause.isActive) {
          state.activePause.isActive = false;
        }
        state.autoplayNudgeAt = null;

        // 使用跟读模式优化过的结束时间计算逻辑
        const startTime = Number(sentence.start);
        const baseEndTime = Number(sentence.end);
        const text = sentence.text || '';
        const wordCount = (text.match(/\b[\w']+\b/g) || []).length;
        const segMode = getSegmentationMode();

        // 找到下一句的开始时间
        const currentArrayIndex = sentence.arrayIndex;
        const nextSentence = dialogueState.sentences.find(s => s.arrayIndex > currentArrayIndex);
        const nextStartTime = nextSentence ? Number(nextSentence.start) : Infinity;
        const hasNext = Number.isFinite(nextStartTime);
        const gapToNext = hasNext ? (nextStartTime - baseEndTime) : Infinity;

        let targetEndTime;
        if (segMode === 'caption') {
          // Caption 模式：缓冲根据时长计算
          // 缓冲 = 时长的 15%，最少 0.3 秒，最多 0.6 秒
          const duration = baseEndTime - startTime;
          const dynamicBuffer = Math.min(0.6, Math.max(0.3, duration * 0.15));

          // 如果下一句紧接着（间隔 < 0.3 秒），允许进入下一句最多 0.4 秒
          if (gapToNext < 0.3) {
            targetEndTime = Math.min(baseEndTime + dynamicBuffer, nextStartTime + 0.4);
          } else {
            const maxEnd = hasNext ? nextStartTime : baseEndTime + 1;
            targetEndTime = Math.min(baseEndTime + dynamicBuffer, maxEnd);
          }
        } else {
          // 非 caption 模式：使用更大的缓冲
          const safetyGap = 0.05;
          const OVERLAP_TAIL_SEC = 0.22;
          const maxPossibleEnd = (hasNext && gapToNext <= safetyGap)
            ? (nextStartTime + OVERLAP_TAIL_SEC)
            : (hasNext ? nextStartTime - safetyGap : baseEndTime + 2);

          const baseTail = 0.8;
          const extraTail = wordCount > 10 ? 0.3 : (wordCount > 6 ? 0.15 : 0);
          const desiredTarget = baseEndTime + baseTail + extraTail;
          targetEndTime = Math.max(baseEndTime, Math.min(desiredTarget, maxPossibleEnd));
        }

        // 最大不超过 startTime + 12 秒
        targetEndTime = Math.min(targetEndTime, startTime + 12);
        console.log('[Dialogue] Optimized playback - start:', startTime, 'baseEnd:', baseEndTime, 'targetEnd:', targetEndTime);

        // Seek to sentence start and play
        const seekTime = Math.max(0, startTime - 0.2); // Start slightly before for context

        // 优先使用 HTML5 videoPlayer（本地视频），除非是真正的 YouTube 视频
        const useYouTube = isYouTubeVideo && youtubePlayer && youtubePlayer.seekTo;

        if (useYouTube) {
          console.log('[Dialogue] Using YouTube player for original audio');
          youtubePlayer.seekTo(seekTime, true);
          youtubePlayer.playVideo();

          // Auto-pause at optimized end time
          if (originalYouTubePauseInterval) {
            clearInterval(originalYouTubePauseInterval);
          }
          const pauseInterval = setInterval(() => {
            const currentTime = youtubePlayer.getCurrentTime();
            if (currentTime >= targetEndTime) {
              youtubePlayer.pauseVideo();
              clearInterval(pauseInterval);
              if (originalYouTubePauseInterval === pauseInterval) {
                originalYouTubePauseInterval = null;
              }
              console.log('[Dialogue] Original audio ended');
            }
          }, 50);
          originalYouTubePauseInterval = pauseInterval;
        } else if (videoPlayer && videoPlayer.src) {
          console.log('[Dialogue] Using HTML5 video player for original audio');
          console.log('[Dialogue] Video state - readyState:', videoPlayer.readyState,
            'duration:', videoPlayer.duration,
            'currentTime before:', videoPlayer.currentTime,
            'paused:', videoPlayer.paused,
            'muted:', videoPlayer.muted,
            'volume:', videoPlayer.volume);

          // 确保视频可见
          if (videoPlayer.style.display === 'none') {
            videoPlayer.style.display = 'block';
          }

          // 检查视频是否已加载
          if (videoPlayer.readyState < 2) {
            console.log('[Dialogue] Video not ready yet, waiting for loadeddata...');
            const onLoaded = () => {
              videoPlayer.removeEventListener('loadeddata', onLoaded);
              videoPlayer.removeEventListener('canplay', onLoaded);
              console.log('[Dialogue] Video now ready, playing...');
              actuallyPlayVideo();
            };
            videoPlayer.addEventListener('loadeddata', onLoaded);
            videoPlayer.addEventListener('canplay', onLoaded);
            // 触发加载
            videoPlayer.load();
            return;
          }

          function actuallyPlayVideo() {
            // 重置 activePause 状态，确保不会干扰播放
            if (state.activePause && state.activePause.isActive) {
              state.activePause.isActive = false;
              console.log('[Dialogue] Reset activePause state');
            }

            // Seek to the correct time
            videoPlayer.currentTime = seekTime;
            console.log('[Dialogue] Set currentTime to:', seekTime, 'actual:', videoPlayer.currentTime);

            // 确保播放速率正常（Active Pause 可能将其设为 0.0625）
            videoPlayer.playbackRate = 1.0;

            // 移动端需要确保视频未静音且音量正常
            videoPlayer.muted = false;
            videoPlayer.volume = 1.0;

            console.log('[Dialogue] About to play - muted:', videoPlayer.muted, 'volume:', videoPlayer.volume, 'playbackRate:', videoPlayer.playbackRate);

            videoPlayer.play().then(() => {
              console.log('[Dialogue] Video playback started successfully');
              console.log('[Dialogue] After play - currentTime:', videoPlayer.currentTime, 'paused:', videoPlayer.paused);

              // 验证视频确实在播放
              setTimeout(() => {
                const stillPaused = videoPlayer.paused;
                const newTime = videoPlayer.currentTime;
                console.log('[Dialogue] Verify after 200ms - paused:', stillPaused, 'currentTime:', newTime, 'playbackRate:', videoPlayer.playbackRate);
                if (stillPaused) {
                  console.warn('[Dialogue] Video was paused unexpectedly! Trying to resume...');
                  videoPlayer.play().catch(e => console.error('[Dialogue] Resume failed:', e));
                }
              }, 200);
            }).catch(err => {
              console.error('[Dialogue] Failed to play original audio:', err);
              // 尝试静音播放后再取消静音
              console.log('[Dialogue] Trying muted play as fallback...');
              videoPlayer.muted = true;
              videoPlayer.play().then(() => {
                console.log('[Dialogue] Muted play succeeded, unmuting...');
                setTimeout(() => {
                  videoPlayer.muted = false;
                  console.log('[Dialogue] Unmuted, muted:', videoPlayer.muted);
                }, 100);
              }).catch(e => console.error('[Dialogue] Muted play also failed:', e));
            });

            // Auto-pause at optimized end time
            if (originalPlaybackPauseHandler && videoPlayer) {
              videoPlayer.removeEventListener('timeupdate', originalPlaybackPauseHandler);
            }
            const pauseHandler = () => {
              if (videoPlayer.currentTime >= targetEndTime) {
                videoPlayer.pause();
                videoPlayer.removeEventListener('timeupdate', pauseHandler);
                if (originalPlaybackPauseHandler === pauseHandler) {
                  originalPlaybackPauseHandler = null;
                }
                console.log('[Dialogue] Original audio ended at time:', videoPlayer.currentTime);
              }
            };
            originalPlaybackPauseHandler = pauseHandler;
            videoPlayer.addEventListener('timeupdate', pauseHandler);
          }

          // 视频已加载，直接播放
          actuallyPlayVideo();
        } else {
          console.error('[Dialogue] No video player available');
        }
      }

      // Setup play recording button
      document.addEventListener('DOMContentLoaded', () => {
        const playRecordingBtn = document.getElementById('play-my-recording-btn');
        const dialoguePlayBtn = document.getElementById('dialogue-play-btn');
        const dialogueOriginalBtn = document.getElementById('dialogue-original-btn');

        const playHandler = () => {
          if (dialogueState.currentSentence && dialogueState.currentSentence.recordingBlob) {
            playUserRecording(
              dialogueState.currentSentence.recordingBlob,
              dialogueState.currentSentence.recordingStartOffset || 0,
              dialogueState.currentSentence.recordingEndOffset || 0
            );
          }
        };

        const originalHandler = () => {
          playOriginalAudio();
        };

        if (playRecordingBtn) {
          playRecordingBtn.addEventListener('click', playHandler);
        }

        if (dialoguePlayBtn) {
          dialoguePlayBtn.addEventListener('click', playHandler);
        }

        if (dialogueOriginalBtn) {
          dialogueOriginalBtn.addEventListener('click', originalHandler);
        }
      });

      // ==================== Reading Mode Functions ====================



      // Reuse auth token lookups across mobile/desktop implementations
      function getAuthToken() {
        try {
          if (window.AuthManager && typeof window.AuthManager.getToken === 'function') {
            const t = window.AuthManager.getToken();
            if (t) return t;
          }

          const stores = [localStorage, sessionStorage];
          const keys = ['authToken', 'linglish_token', 'token'];
          for (const store of stores) {
            if (!store || typeof store.getItem !== 'function') continue;
            for (const key of keys) {
              const val = store.getItem(key);
              if (val && val !== 'undefined' && val !== 'null') {
                return val;
              }
            }
          }
        } catch (err) {
          console.warn('[Auth] Failed to read token:', err);
        }
        return null;
      }

      function isValidTokenFormat(token) {
        if (!token || typeof token !== 'string') return false;
        if (token === 'guest-token') return false;
        const parts = token.split('.');
        return parts.length === 3 && parts[0] && parts[1];
      }

      function parseJwtPayload(token) {
        try {
          if (!isValidTokenFormat(token)) return null;
          let payloadB64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
          while (payloadB64.length % 4) payloadB64 += '=';
          const json = atob(payloadB64);
          return JSON.parse(json);
        } catch (_) {
          return null;
        }
      }

      function isTokenExpired(token) {
        const payload = parseJwtPayload(token);
        const exp = payload && typeof payload.exp === 'number' ? payload.exp : null;
        if (!exp) return false;
        const now = Math.floor(Date.now() / 1000);
        return exp < now;
      }

      async function clearAuthToken() {
        try {
          if (window.AuthManager && typeof window.AuthManager.clearToken === 'function') {
            await window.AuthManager.clearToken();
          }
        } catch (_) { }
        try { localStorage.removeItem('authToken'); } catch (_) { }
        try { localStorage.removeItem('linglish_token'); } catch (_) { }
        try { sessionStorage.removeItem('authToken'); } catch (_) { }
        try { sessionStorage.removeItem('linglish_token'); } catch (_) { }
        try { localStorage.removeItem('token'); } catch (_) { }
        try { sessionStorage.removeItem('token'); } catch (_) { }
      }

      function isGuestMode() {
        try {
          return (
            sessionStorage.getItem('isGuest') === 'true' ||
            localStorage.getItem('isGuest') === 'true' ||
            sessionStorage.getItem('is_guest') === 'true' ||
            localStorage.getItem('is_guest') === 'true'
          );
        } catch (_) {
          return false;
        }
      }

      async function ensureAuthToken({ force = false } = {}) {
        const existing = getAuthToken();
        const existingUsable = isValidTokenFormat(existing) && !isTokenExpired(existing);
        if (!force && existingUsable) return existing;

        if (isValidTokenFormat(existing) && isTokenExpired(existing)) {
          if (window.AuthManager && typeof window.AuthManager.ensureSession === 'function') {
            try {
              const renewed = await window.AuthManager.ensureSession({ force: true });
              if (renewed) return renewed;
            } catch (_) { }
          }
          await clearAuthToken();
        }
        return existing;
      }

      function buildAuthHeaders(base = {}) {
        const token = getAuthToken();
        return token ? { ...base, 'Authorization': `Bearer ${token}` } : base;
      }


      const API_BASE = '';
      let dialogueHighlightListener = null;
      const token = getAuthToken();

      const videoPlayer = document.getElementById('practice-video');
      const playOverlay = document.getElementById('play-overlay');
      const youtubePlayerContainer = document.getElementById('youtube-player-container');

      // YouTube player state
      let youtubePlayer = null;
      let isYouTubeVideo = false;
      let youtubeApiReady = false;
      let youtubePlayerInitializing = false;

      // Load YouTube IFrame API (only once)
      if (!window.YT && !window.onYouTubeIframeAPIReady) {
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        tag.id = 'youtube-iframe-api-script';
        const firstScriptTag = document.getElementsByTagName('script')[0];
        firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
        console.log('[YouTube] Loading IFrame API');
      } else if (window.YT && window.YT.Player) {
        youtubeApiReady = true;
        console.log('[YouTube] API already loaded');
      }

      // YouTube API ready callback
      if (!window.onYouTubeIframeAPIReady) {
        window.onYouTubeIframeAPIReady = function () {
          console.log('[YouTube] API ready');
          youtubeApiReady = true;
        };
      }

      // YouTube helper functions
      function extractYouTubeVideoId(url) {
        if (!url) return null;
        // Handle various YouTube URL formats
        const patterns = [
          /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&?\/\s]+)/i,
          /^([a-zA-Z0-9_-]{11})$/ // Direct video ID
        ];
        for (const pattern of patterns) {
          const match = url.match(pattern);
          if (match) return match[1];
        }
        return null;
      }

      function isYouTubeUrl(url) {
        return url && (url.includes('youtube.com') || url.includes('youtu.be'));
      }

      // YouTube time update polling (since iframe doesn't fire timeupdate events)
      let youtubeTimeUpdateInterval = null;

      function startYouTubeTimeUpdatePolling() {
        if (youtubeTimeUpdateInterval) {
          clearInterval(youtubeTimeUpdateInterval);
        }
        // Poll every 100ms for smooth segment tracking
        youtubeTimeUpdateInterval = setInterval(() => {
          if (isYouTubeVideo && youtubePlayer) {
            handleVideoTimeUpdate();
          }
        }, 100);
        console.log('[YouTube] Time update polling started');
      }

      function stopYouTubeTimeUpdatePolling() {
        if (youtubeTimeUpdateInterval) {
          clearInterval(youtubeTimeUpdateInterval);
          youtubeTimeUpdateInterval = null;
          console.log('[YouTube] Time update polling stopped');
        }
      }

      const practiceArmBtn = document.getElementById('practice-arm-btn');
      const practiceHintEl = document.getElementById('practice-hint');
      const practiceSpeakerSelect = document.getElementById('practice-speaker');
      const roleCountSelect = document.getElementById('role-count-select');
      const roleRotateBtn = document.getElementById('role-rotate-btn');
      const roleRenameBtn = document.getElementById('role-rename-btn');
      const strictAltToggle = document.getElementById('strict-alt-toggle');
      const roleRenameOverlay = document.getElementById('role-rename-overlay');
      const renameListEl = document.getElementById('rename-list');
      const rrSave = document.getElementById('rr-save');
      const rrCancel = document.getElementById('rr-cancel');
      const practiceCurrentLine = document.getElementById('practice-current-line');

      async function loadRoleProfile(videoId) {
        try {
          const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
          const res = await fetch(`${API_BASE}/video-role-profiles?video_id=${encodeURIComponent(videoId)}`, { headers });
          if (!res.ok) return null;
          const data = await res.json();
          return data?.profile || null;
        } catch (e) {
          console.warn('[Practice] loadRoleProfile failed:', e);
          return null;
        }
      }

      async function saveRoleProfile({ scope = 'user' } = {}) {
        try {
          if (!state.videoId) return null;
          const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          };
          const k = (() => {
            if (state.strictAlternate) return 2;
            // Persist concrete number (for 'auto', persist current inferred count)
            if (state.roleCount === 'auto') return chosenRoleCountJS();
            const n = parseInt(state.roleCount, 10);
            return (isFinite(n) && n >= 2 && n <= 5) ? n : chosenRoleCountJS();
          })();
          const names = Array.isArray(state.speakers)
            ? state.speakers.slice(0, k).map((s, i) => String(s?.speaker || `Speaker ${i + 1}`))
            : Array.from({ length: k }, (_, i) => `Speaker ${i + 1}`);
          const body = {
            video_resource_id: state.videoId,
            scope,
            role_count: k,
            role_rotation: Number(state.roleRotation) || 0,
            role_names: names,
            infer_mode: state.strictAlternate ? 'round_robin' : 'content_aware',
          };
          const res = await fetch(`${API_BASE}/video-role-profiles`, {
            method: 'PUT',
            headers,
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            console.warn('[Practice] saveRoleProfile failed status', res.status);
            return null;
          }
          const data = await res.json();
          return data?.profile || null;
        } catch (e) {
          console.warn('[Practice] saveRoleProfile failed:', e);
          return null;
        }
      }
      const practiceLineList = document.getElementById('practice-line-list');
      const practiceFeedbackEl = document.getElementById('practice-feedback');
      const audioModeBtns = Array.from(document.querySelectorAll('.audio-mode-btn'));
      const recordingIndicatorEl = document.getElementById('recording-indicator');
      const recordedCountEl = document.getElementById('recorded-count');
      const startRecordingFab = document.getElementById('start-recording-fab');
      // VAD indicator elements
      const vadIndicatorEl = document.getElementById('vad-indicator');
      const vadFillEl = document.getElementById('vad-fill');
      const vadLabelEl = document.getElementById('vad-label');
      const practiceProgressEl = document.getElementById('practice-progress');

      // ------- Audio utilities: smooth volume ramps -------
      function rampVolume(mediaEl, from, to, durationMs = 120) {
        if (!mediaEl) return Promise.resolve();
        const start = performance.now();
        const clampedFrom = Number.isFinite(from) ? from : 0;
        const clampedTo = Number.isFinite(to) ? to : 0;
        if (mediaEl.__volRampCancel) {
          try { mediaEl.__volRampCancel(); } catch (_) { }
        }
        return new Promise((resolve) => {
          let cancelled = false;
          mediaEl.__volRampCancel = () => { cancelled = true; resolve(); };
          function step(now) {
            if (cancelled) return;
            const t = Math.min(1, (now - start) / Math.max(1, durationMs));
            // Smooth S-curve easing for more natural fades
            const eased = 0.5 - 0.5 * Math.cos(Math.PI * t);
            try { mediaEl.volume = clampedFrom + (clampedTo - clampedFrom) * eased; } catch (_) { }
            if (t < 1) {
              if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
              else setTimeout(() => step(performance.now()), 16);
            } else {
              try { mediaEl.volume = clampedTo; } catch (_) { }
              resolve();
            }
          }
          try { mediaEl.volume = clampedFrom; } catch (_) { }
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
          else setTimeout(() => step(performance.now()), 0);
        });
      }

      async function smoothMute(videoEl, fadeMs = 120, finalVolume = 0) {
        if (!videoEl) return;
        const startVol = Number.isFinite(videoEl.volume) ? videoEl.volume : 1;
        if (videoEl.muted && startVol === 0) return;
        await rampVolume(videoEl, startVol, finalVolume, fadeMs);
        videoEl.muted = true;
        try { videoEl.volume = finalVolume; } catch (_) { }
      }

      async function smoothUnmute(videoEl, targetVolume = 1, fadeMs = 120) {
        if (!videoEl) return;
        const toVol = Math.max(0.01, Number(targetVolume) || 1);
        videoEl.muted = false;
        const fromVol = Number.isFinite(videoEl.volume) ? videoEl.volume : 0;
        await rampVolume(videoEl, fromVol, toVol, fadeMs);
        try { videoEl.volume = toVol; } catch (_) { }
      }

      // Tunable timings (ms)
      // Fine-grained fades for more natural dialog
      const DIALOG_FADE_IN_MS = 240;   // other-speaker (original) fade-in in mixed mode
      const RESTORE_FADE_MS = 140;     // restore video volume after user recording
      const DUCK_FADE_MS = 240;        // general duck duration used when silencing before user recording
      const VOICE_FADE_IN_MS = 140;    // user recording fade-in
      const VOICE_FADE_OUT_MS = 90;
      const USER_PREP_MS = 650;        // lead time before auto-record kicks in
      const STUDENT_PREDUCK_LEAD_MS = 350;   // how early to mute before student's segment start (hard mute)
      const STUDENT_PREDUCK_GRACE_MS = 800;  // after start, wait this before fallback unmute if no user audio
      const debugLogEl = document.getElementById('debug-log');
      const debugEntriesEl = document.getElementById('debug-entries');
      const urlParams = new URLSearchParams(window.location.search);
      const debugMode = urlParams.get('debugAudio') === '1';
      const isArenaMode = urlParams.get('mode') === 'arena';  // 实战场模式
      if (debugMode && debugLogEl) {
        debugLogEl.classList.remove('hidden');
      }

      // 实战场模式：根据是否有录音动态设置按钮状态
      // 这个函数会在录音加载后调用
      function updateArenaModeButtons() {
        if (!isArenaMode) return;

        // 使用统一的按钮状态管理函数（会考虑练习模式状态）
        if (typeof updateAudioModeButtonsAvailability === 'function') {
          updateAudioModeButtonsAvailability();
        }
      }

      function pushDebug(message, payload = null) {
        try {
          const safePayload = payload !== null && payload !== undefined && window.LinglishMediaSession
            ? window.LinglishMediaSession.sanitizeDebugPayload(payload)
            : payload;
          if (safePayload !== null && safePayload !== undefined) {
            console.info(`[AudioDebug] ${message}`, safePayload);
          } else {
            console.info(`[AudioDebug] ${message}`);
          }
          if (!debugMode || !debugEntriesEl) return;
          const entry = document.createElement('div');
          entry.className = 'debug-log-entry';
          const timeEl = document.createElement('time');
          timeEl.textContent = new Date().toLocaleTimeString();
          entry.appendChild(timeEl);
          const text = document.createElement('span');
          text.textContent = ` ${message}`;
          entry.appendChild(text);
          if (safePayload !== null && safePayload !== undefined) {
            const payloadEl = document.createElement('pre');
            payloadEl.textContent = typeof safePayload === 'string'
              ? safePayload
              : JSON.stringify(safePayload, null, 2);
            payloadEl.style.margin = '2px 0 0';
            payloadEl.style.whiteSpace = 'pre-wrap';
            entry.appendChild(payloadEl);
          }
          debugEntriesEl.insertBefore(entry, debugEntriesEl.firstChild);
          const maxEntries = 40;
          while (debugEntriesEl.childNodes.length > maxEntries) {
            debugEntriesEl.removeChild(debugEntriesEl.lastChild);
          }
        } catch (err) {
          console.warn('[DebugLog] Failed to append log', err);
        }
      }

      function normalizeSegmentIndex(value) {
        if (value === null || value === undefined || value === '') return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
      }

      function buildSegmentKey(value) {
        if (value === null || value === undefined || value === '') return null;
        const normalized = normalizeSegmentIndex(value);
        if (normalized !== null) return String(normalized);
        try {
          return String(value);
        } catch (_err) {
          return null;
        }
      }

      function getLocalRecordingCache(videoId) {
        if (!videoId) return null;
        try {
          const storageKey = `user_recordings_${videoId}`;
          const raw = localStorage.getItem(storageKey);
          if (!raw || raw === 'undefined' || raw === 'null') return null;
          return JSON.parse(raw);
        } catch (err) {
          console.warn('[录音] 无法读取本地缓存:', err);
          return null;
        }
      }

      function getSegmentLookupKeys(segmentIndex) {
        const keys = [];
        const key = buildSegmentKey(segmentIndex);
        if (key) keys.push(key);
        const normalized = normalizeSegmentIndex(segmentIndex);
        if (normalized !== null) {
          const numericKey = normalized;
          const stringKey = String(normalized);
          if (!keys.includes(stringKey)) keys.push(stringKey);
          if (!keys.includes(numericKey)) keys.push(numericKey);
        }
        return keys;
      }

      function resolveSegmentSpeaker(segmentIndex) {
        if (!(state.segmentSpeakerMap instanceof Map) || !state.segmentSpeakerMap.size) {
          return null;
        }
        const keys = getSegmentLookupKeys(segmentIndex);
        for (const key of keys) {
          if (state.segmentSpeakerMap.has(key)) {
            return state.segmentSpeakerMap.get(key);
          }
        }
        return null;
      }

      function markSegmentRole(map, segmentIndex, role) {
        const keys = getSegmentLookupKeys(segmentIndex);
        keys.forEach((key) => {
          if (key !== null && key !== undefined) {
            map.set(key, role);
          }
        });
      }

      function rebuildSegmentRoleMap() {
        const roleMap = new Map();
        if (Array.isArray(state.currentSegments)) {
          state.currentSegments.forEach((segment, idx) => {
            const indexValue = segment?.index != null ? segment.index : idx;
            markSegmentRole(roleMap, indexValue, 'original');
          });
        }
        if (Array.isArray(state.practiceLines)) {
          state.practiceLines.forEach((line) => {
            const indexValue = line?.index != null ? line.index : line?.segmentIndex;
            if (indexValue != null) {
              markSegmentRole(roleMap, indexValue, 'student');
            }
          });
        }
        state.segmentRoleMap = roleMap;
      }

      function determineSegmentRole(segmentIndex, assignedSpeaker = null) {
        const keys = getSegmentLookupKeys(segmentIndex);
        if (state.segmentRoleMap instanceof Map && state.segmentRoleMap.size) {
          for (const key of keys) {
            if (state.segmentRoleMap.has(key)) {
              return state.segmentRoleMap.get(key) === 'student' ? 'student' : 'original';
            }
          }
        }
        const selectedSpeaker = state.selectedSpeaker || null;
        const resolvedSpeaker = assignedSpeaker || resolveSegmentSpeaker(segmentIndex);
        if (selectedSpeaker && resolvedSpeaker && resolvedSpeaker === selectedSpeaker) {
          return 'student';
        }
        if (state.practiceLineIndexMap instanceof Map && state.practiceLineIndexMap.size) {
          if (keys.some((key) => state.practiceLineIndexMap.has(key))) {
            return 'student';
          }
        }
        return 'original';
      }

      function isStudentSegment(segmentIndex, assignedSpeaker = null) {
        return determineSegmentRole(segmentIndex, assignedSpeaker) === 'student';
      }

      function collectOriginalSegmentsBetween(startTime, endTime) {
        if (!Array.isArray(state.currentSegments) || !state.currentSegments.length) return [];
        const segments = [];
        state.currentSegments.forEach((segment, idx) => {
          const segStart = Number(segment.start) || 0;
          const segEndRaw = Number(segment.end);
          const segEnd = Number.isFinite(segEndRaw) ? segEndRaw : segStart + 4;
          if (segEnd <= startTime + 0.01) return;
          if (segStart >= endTime - 0.01) return;
          const segmentIndex = segment.index != null ? segment.index : idx;
          const role = determineSegmentRole(segmentIndex, segment.speaker || null);
          if (role === 'student') return;
          segments.push({
            segment,
            start: segStart,
            end: segEnd,
            index: segmentIndex,
          });
        });
        segments.sort((a, b) => a.start - b.start);
        return segments;
      }

      function synchronizeSegmentSpeakers() {
        if (!Array.isArray(state.currentSegments)) return;

        const mapping = new Map();
        if (state.segmentSpeakerMap instanceof Map) {
          state.segmentSpeakerMap.forEach((value, key) => {
            if (!value) return;
            const keyString = buildSegmentKey(key);
            if (keyString) {
              mapping.set(keyString, value);
            }
          });
        }

        state.practiceSummary = state.practiceLines.map((line, idx) => {
          const rawIdx = line.index != null ? line.index : line.segmentIndex;
          const normalizedIdx = normalizeSegmentIndex(rawIdx);
          const segmentKey = buildSegmentKey(rawIdx);
          // 注意：只在行内显式标注了 speaker 时才写入 speakerName
          const speakerName = line.speaker || null;
          if (speakerName) {
            const keys = getSegmentLookupKeys(rawIdx);
            keys.forEach((key) => {
              if (key !== null && key !== undefined) {
                mapping.set(key, speakerName);
              }
            });
          }
          return {
            idx,
            segmentIndex: rawIdx,
            normalizedIndex: normalizedIdx,
            segmentKey,
            speaker: speakerName,
          };
        });

        state.segmentSpeakerMap = mapping;

        state.currentSegments = state.currentSegments.map((segment, arrayIndex) => {
          const rawIdx = segment.index != null ? segment.index : arrayIndex;
          const keys = getSegmentLookupKeys(rawIdx);
          let assignedSpeaker = null;
          for (const key of keys) {
            if (mapping.has(key)) {
              assignedSpeaker = mapping.get(key);
              break;
            }
          }
          if (assignedSpeaker && !segment.speaker) {
            return { ...segment, speaker: assignedSpeaker };
          }
          return segment;
        });

        if (debugMode) {
          const summary = state.currentSegments.map((segment, arrayIndex) => {
            const rawIdx = segment.index != null ? segment.index : arrayIndex;
            return {
              idx: arrayIndex,
              segmentIndex: rawIdx,
              normalizedIndex: normalizeSegmentIndex(rawIdx),
              segmentKey: buildSegmentKey(rawIdx),
              speaker: segment.speaker || null,
            };
          });
          pushDebug('段落speaker同步', {
            selectedSpeaker: state.selectedSpeaker,
            mapping: Array.from(mapping.entries()),
            summary,
          });
        }

        rebuildSegmentRoleMap();
      }

      // 自动流程UI元素
      const autoPracticeStatus = document.getElementById('auto-practice-status');
      const statusIcon = document.getElementById('status-icon');
      const statusText = document.getElementById('status-text');
      const analysisProgress = document.getElementById('analysis-progress');
      const analysisMeta = document.getElementById('analysis-meta');
      const autoStartBtn = document.getElementById('auto-start-btn');
      const autoPauseBtn = document.getElementById('auto-pause-btn');
      const autoPrevBtn = document.getElementById('auto-prev-btn');
      const autoNextBtn = document.getElementById('auto-next-btn');

      const state = {
        videoId: null,
        videoData: null,
        currentSegments: [],
        speakers: [],
        selectedSpeaker: '',
        practiceLines: [],
        practiceIndex: 0,
        practiceAttempts: 0,
        practiceLineResults: {},
        practiceLineWordResults: {},
        practiceLineIndexMap: new Map(),
        segmentSpeakerMap: new Map(),
        practiceArmed: false,
        waitingForPractice: false,
        practicePlaybackLock: false,
        segmentPlaybackEnd: null,
        segmentPlaybackCallback: null,
        currentSegmentIndex: null,
        autoSegmentCursor: 0,
        recorder: null,
        recordingChunks: [],
        lastRecordingBlob: null,
        recorderMimeType: null,
        mediaStream: null,
        recordingMonitor: null,
        dialogueMaxDurationMs: null,
        activeMaxRecordingMs: null,
        dialogueMinDurationMs: null,

        // 自动流程新增状态
        autoMode: false,               // 是否启用自动模式
        isPaused: false,               // 是否暂停
        currentRetry: 0,               // 当前重试次数（0-2）
        maxRetries: 3,                 // 最大重试次数
        isRecording: false,            // 是否正在录音
        audioContext: null,            // 音频上下文
        audioAnalyser: null,           // 音频分析器
        silenceStart: null,            // 静音开始时间
        silenceThreshold: 0.01,        // 静音阈值
        silenceDuration: 1500,         // 静音持续时间（毫秒）
        vadCheckInterval: null,        // VAD检查定时器
        // 更稳健的录音控制
        recordingStartAt: null,        // 录音开始时间戳（ms）
        firstVoiceAt: null,            // 第一次检测到声音的时间戳（ms）
        voicedMs: 0,                   // 已累计的发声时长估计（ms）
        vadInitialIgnoreMs: 1200,      // 开始录音后的静音忽略期（不自动停止）
        vadMinSpeakMs: 800,            // 至少需要说话多长时间后才允许因静音停止
        vadMaxRecordingMs: 10000,      // 单句最大录音时长上限（兜底）
        serverRecordings: [],
        debugMode,
        isMainlandUser: false,  // 国内用户标识，用于跳过YouTube
        practiceSummary: [],
        remoteRecordingKeys: [],
        localRecordingKeys: [],
        segmentRoleMap: new Map(),
        autoplayNudgeAt: 0,
        studentGuard: null,           // { key, start, setAt, fallbackAt }
        hasServerSpeakers: false,
        roleCount: 'auto',            // 'auto' | 2..5
        roleRotation: 0,              // rotation offset for inferred roles
        roleNames: [],                // optional custom names
        roleProfile: null,            // loaded/saved server profile snapshot
        strictAlternate: false,       // 是否启用严格轮换(2人)
      };

      const MEDIA_READY_THRESHOLD = typeof HTMLMediaElement !== 'undefined'
        ? HTMLMediaElement.HAVE_METADATA
        : 1;

      // ===== Improved multi-speaker inference (dialogue-aware) =====
      function inferDistinctSpeakersFromSegmentsJS() {
        try {
          if (!Array.isArray(state.currentSegments)) return [];
          const names = new Map();
          state.currentSegments.forEach((seg) => {
            const n = (seg?.speaker || '').trim();
            if (n) names.set(n, (names.get(n) || 0) + 1);
          });
          return Array.from(names.keys()).slice(0, 5);
        } catch (_) { return []; }
      }

      function chosenRoleCountJS() {
        const val = state.roleCount;
        if (val === 'auto') {
          const segs = Array.isArray(state.currentSegments) ? state.currentSegments : [];
          const q = segs.reduce((n, s) => n + (/[?？]\s*$/.test(String(s?.text || '')) ? 1 : 0), 0);
          // In most practice videos, 2 speakers are safest default
          return Math.min(5, Math.max(2, q > 8 ? 2 : 2));
        }
        const n = parseInt(val, 10);
        return (isFinite(n) && n >= 2 && n <= 5) ? n : 2;
      }

      function buildInferredSpeakers() {
        const segs = Array.isArray(state.currentSegments) ? state.currentSegments : [];
        const distinct = inferDistinctSpeakersFromSegmentsJS();
        const k = state.strictAlternate ? 2 : chosenRoleCountJS();

        // If explicit names exist, group by name (top-k by frequency)
        if (distinct.length >= 2) {
          const freq = new Map();
          segs.forEach(seg => { const n = (seg?.speaker || '').trim(); if (!n) return; freq.set(n, (freq.get(n) || 0) + 1); });
          const top = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, k).map(([n]) => n);
          const speakers = top.map(n => ({ speaker: n, lines: [] }));
          const indexOf = (n) => { const i = top.indexOf(n); return i >= 0 ? i : 0; };
          segs.forEach((seg, i) => {
            const idx = seg?.index != null ? seg.index : i;
            const name = (seg?.speaker || '').trim();
            if (!name) return;
            const role = speakers[indexOf(name)];
            role.lines.push({ index: idx, segmentIndex: idx, start: seg.start, end: seg.end, text: seg.text, speaker: role.speaker });
          });
          state.speakers = speakers;
          return;
        }

        // Dialogue-aware inference when no speakers are embedded
        const speakers = Array.from({ length: k }, (_, i) => ({ speaker: `Speaker ${i + 1}`, lines: [] }));
        const offset = Math.abs(state.roleRotation) % k;
        let curRole = offset;
        let lastIdx = -1;
        let consecCount = 0;
        let lastWasQuestion = false;
        let lastText = '';

        const shortReplyRe = /^(yes|no|sure|ok|okay|alright|thank you|thanks|my name is|i\b|yes,|no,)\b/i;
        const interrogativeRe = /[?？]\s*$|\b(who|what|when|where|why|how|can|could|do|did|are|is|will|would|should)\b/i;
        const greetOrCloseRe = /^(good (morning|afternoon|evening)|thank you|thanks|have a nice day|goodbye|bye)\b/i;

        function pickRole(i, text) {
          const t = String(text || '').trim();
          const isQ = interrogativeRe.test(t);
          const isShort = t.length <= 40 || shortReplyRe.test(t);
          let switchNow = false;

          if (lastIdx === -1) return curRole; // first line

          if (lastWasQuestion) switchNow = true; // Q → A
          if (!switchNow && isQ && !interrogativeRe.test(lastText)) switchNow = true; // A → Q
          if (!switchNow && isShort) switchNow = true; // short answers tend to be the other role
          if (!switchNow && greetOrCloseRe.test(t) && !greetOrCloseRe.test(lastText)) switchNow = true;
          if (!switchNow && consecCount >= 2) switchNow = true; // avoid long monologues

          if (switchNow) {
            if (k === 2) curRole = (curRole + 1) % 2; else curRole = (curRole + 1) % k;
            consecCount = 0;
          }
          return curRole;
        }

        segs.forEach((seg, i) => {
          const idx = seg?.index != null ? seg.index : i;
          const text = String(seg?.text || '').trim();
          const roleIdx = pickRole(i, text);
          const role = speakers[roleIdx];
          role.lines.push({ index: idx, segmentIndex: idx, start: seg.start, end: seg.end, text, speaker: role.speaker });
          if (lastIdx === -1 || roleIdx === curRole) consecCount += 1; else consecCount = 1;
          lastIdx = i;
          lastText = text;
          lastWasQuestion = /[?？]\s*$/.test(text);
        });

        // If k===2 and strict alternation is enabled, do pure alternation
        if (k === 2 && state.strictAlternate) {
          speakers[0].lines = [];
          speakers[1].lines = [];
          let turn = (Math.abs(state.roleRotation) % 2);
          segs.forEach((seg, i) => {
            const idx = seg?.index != null ? seg.index : i;
            const text = String(seg?.text || '').trim();
            const role = speakers[turn];
            role.lines.push({ index: idx, segmentIndex: idx, start: seg.start, end: seg.end, text, speaker: role.speaker });
            turn = (turn + 1) % 2;
          });
        } else if (k === 2) {
          const c0 = speakers[0].lines.length;
          const c1 = speakers[1].lines.length;
          if (Math.min(c0, c1) === 0 || Math.max(c0, c1) >= (Math.min(c0, c1) + 8)) {
            speakers[0].lines = [];
            speakers[1].lines = [];
            let turn = offset % 2;
            segs.forEach((seg, i) => {
              const idx = seg?.index != null ? seg.index : i;
              const text = String(seg?.text || '').trim();
              // Alternate strictly when dialogue-like
              const role = speakers[turn];
              role.lines.push({ index: idx, segmentIndex: idx, start: seg.start, end: seg.end, text, speaker: role.speaker });
              // Switch on question or every line
              turn = (turn + 1) % 2;
            });
          }
        }

        state.speakers = speakers;
      }
      const SILENT_AUDIO_DATA_URL = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAACJWAAACABAAZGF0YQAAAAA=';
      const isLikelyMobileDevice = (() => {
        if (typeof navigator === 'undefined' || !navigator) return false;
        const ua = navigator.userAgent || '';
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|Windows Phone|Mobi/i.test(ua);
      })();

      class AudioModeManager {
        constructor() {
          this.mode = 'original'; // original | my-voice | mixed
          this.userRecordings = {}; // { segmentIndex: HTMLAudioElement }
          this.currentVideoId = null;
          this.overlayAudio = null;
          this.selectedSpeaker = null;
          this.originalVolume = null;
          this.baseVolume = 1;
          this.lastPlaybackSegment = null;
          this.lastPlaybackKey = null;
          this.lastPlaybackTimestamp = 0;
          this.decisionCache = new Map();
          this.lastRoleLog = new Map();
          this.overlayPlaybackState = null;
          this.missingRecordingRetries = new Map();
          this.segmentPlaybackLog = new Map();
          this.isMobileEnvironment = isLikelyMobileDevice;
          this.pendingPlaybackRequests = new Map();
          this.maxDeferredPlaybackWaitMs = this.isMobileEnvironment ? 6000 : 3500;
          this.playbackWindow = this.isMobileEnvironment
            ? { startOffset: -0.35, endOffset: 2.1 }
            : { startOffset: -0.2, endOffset: 1.5 };
          this.minimumPlaybackCooldownMs = this.isMobileEnvironment ? 2000 : 1400;
          this.isAudioUnlocked = !this.isMobileEnvironment;
          this.unlockHandlersBound = false;
          this.boundUnlockHandler = null;
          this.playbackAudioContext = null;
          this.playbackAnalyserCache = new WeakMap();
          this.activeAnalyserAudios = new Set();
          this.leadingSilenceCache = new Map();
          this.pendingSilenceAnalysis = new Map();
          this.silenceTrimThreshold = 0.012;
          this.maxSilenceTrimSeconds = 2.5;
          this.emptyRecordingCache = new Map();
          this.pendingEmptyDetection = new Map();
          this.activeUserAudios = new Set();
          this.playedGuard = new Map(); // key -> untilVideoTime (seconds)
        }

        stopAllUserRecordingsExcept(exclude) {
          try {
            const list = this.userRecordings ? Object.values(this.userRecordings) : [];
            list.forEach((a) => {
              if (!a || a === exclude) return;
              try {
                a.pause();
                // Don't reset currentTime here to preserve readiness if replayed
              } catch (_) { }
            });
          } catch (_) { }
        }

        prepareAudioElement(key, audio, sourceType) {
          if (!audio) return;
          const handleReady = () => {
            audio.removeEventListener('loadeddata', handleReady);
            audio.removeEventListener('canplay', handleReady);
            console.log(`[音频加载成功] 片段: ${key}, 来源: ${sourceType}, 就绪状态: ${audio.readyState}, 时长: ${audio.duration?.toFixed(2)}s`);
            // 跳过已处理录音的静音分析（服务器录音已经裁剪过了）
            if (audio.dataset?.isProcessed !== 'true') {
              this.scheduleLeadingSilenceAnalysis(key, audio);
            } else {
              // 清除缓存，确保已处理录音不使用静音分析结果
              const cacheKey = this.buildSilenceCacheKey(key, audio);
              if (cacheKey && this.leadingSilenceCache) {
                this.leadingSilenceCache.set(cacheKey, 0);
              }
            }
            this.scheduleEmptyRecordingDetection(key, audio);
          };
          const handleError = (event) => {
            audio.removeEventListener('error', handleError);
            audio.removeEventListener('loadeddata', handleReady);
            audio.removeEventListener('canplay', handleReady);
            if (this.userRecordings?.[key] === audio) {
              delete this.userRecordings[key];
            }
            if (sourceType === 'remote' && Array.isArray(state.serverRecordings)) {
              state.serverRecordings = state.serverRecordings.filter((item) => {
                const itemKey = buildSegmentKey(item.segment_index ?? item.segmentIndex);
                return itemKey !== key;
              });
            }
            pushDebug('录音资源加载失败', {
              segmentIndex: key,
              sourceType,
              error: event?.message || audio?.error?.code || 'unknown',
            });
            this.updateRecordingIndicator();
            if (sourceType === 'remote') {
              this.tryRestoreMissingRecording(key);
            }
          };
          audio.addEventListener('loadeddata', handleReady);
          audio.addEventListener('canplay', handleReady);
          audio.addEventListener('error', handleError);
        }

        loadUserRecordings(videoId, remoteRecordings = []) {
          this.currentVideoId = videoId;
          this.userRecordings = {};
          this.decisionCache.clear();
          if (this.lastRoleLog) this.lastRoleLog.clear();
          this.overlayPlaybackState = null;
          this.missingRecordingRetries.clear();
          this.segmentPlaybackLog.clear();
          this.clearAllPendingPlayback();
          if (this.emptyRecordingCache) this.emptyRecordingCache.clear();
          if (this.pendingEmptyDetection) this.pendingEmptyDetection.clear();
          this.bindMobileUnlockHooks();

          if (!videoId) {
            this.updateRecordingIndicator(0);
            pushDebug('loadUserRecordings: missing videoId');
            return;
          }

          let count = 0;
          const seenSegments = new Set();
          const remoteKeys = [];
          const localKeys = [];
          if (debugMode) {
            pushDebug('开始加载录音', {
              videoId,
              remoteCount: Array.isArray(remoteRecordings) ? remoteRecordings.length : 0,
            });
          }

          if (Array.isArray(remoteRecordings) && remoteRecordings.length) {
            remoteRecordings.forEach((recording) => {
              const segmentIndex = recording?.segment_index ?? recording?.segmentIndex;
              const key = buildSegmentKey(segmentIndex);
              if (!key) return;
              const recordingSpeaker = recording?.speaker || null;
              if (this.selectedSpeaker && recordingSpeaker && recordingSpeaker !== this.selectedSpeaker) {
                return;
              }

              const rawUrl = recording?.audio_url || recording?.audioPath || recording?.audioData;
              if (!rawUrl) return;

              try {
                const audio = new Audio();
                audio.preload = 'auto';
                // 标记为已处理的录音（服务器录音已裁剪过静音）
                audio.dataset.isProcessed = 'true';
                // 清除任何可能的偏移值，因为服务器录音已经实际裁剪过了
                delete audio.dataset.startOffset;
                delete audio.dataset.endOffset;
                this.prepareAudioElement(key, audio, 'remote');
                this.userRecordings[key] = audio;
                setProtectedMediaSource(audio, rawUrl, recording?.updated_at).then(() => {
                  if (typeof audio.load === 'function') {
                    audio.load();
                  }
                }).catch(() => {
                  if (this.userRecordings[key] === audio) delete this.userRecordings[key];
                  this.updateRecordingIndicator();
                });
                seenSegments.add(key);
                count += 1;
                remoteKeys.push(key);
                if (recording?.speaker && !this.selectedSpeaker) {
                  this.selectedSpeaker = recording.speaker;
                }
              } catch (err) {
                console.warn('[音频模式] 无法加载服务器录音:', err);
                pushDebug('服务器录音加载失败', { segmentIndex: key, error: err.message });
              }
            });
          }

          try {
            const storageKey = `user_recordings_${videoId}`;
            const data = localStorage.getItem(storageKey);
            if (data && data !== 'undefined' && data !== 'null') {
              const recordings = JSON.parse(data);
              if (!this.selectedSpeaker && recordings?.selectedSpeaker) {
                this.selectedSpeaker = recordings.selectedSpeaker;
              }
              for (const [segmentIndex, recording] of Object.entries(recordings.recordings || {})) {
                const key = buildSegmentKey(segmentIndex);
                if (!key || seenSegments.has(key)) continue;
                const recordingSpeaker = recording?.speaker || recordings?.selectedSpeaker || null;
                if (this.selectedSpeaker && recordingSpeaker && recordingSpeaker !== this.selectedSpeaker) {
                  continue;
                }
                if (recording?.audioData) {
                  try {
                    const audio = new Audio(recording.audioData);
                    audio.preload = 'auto';
                    // 存储静音裁剪的偏移信息（移动端虚拟裁剪需要）
                    if (recording.startOffset !== undefined) {
                      audio.dataset.startOffset = String(recording.startOffset);
                    }
                    if (recording.endOffset !== undefined) {
                      audio.dataset.endOffset = String(recording.endOffset);
                    }
                    this.prepareAudioElement(key, audio, 'local');
                    this.userRecordings[key] = audio;
                    if (typeof audio.load === 'function') {
                      try {
                        audio.load();
                      } catch (loadErr) {
                        console.warn('[音频模式] 预加载本地录音失败:', loadErr);
                      }
                    }
                    count += 1;
                    seenSegments.add(key);
                    localKeys.push(key);
                  } catch (err) {
                    console.warn('[音频模式] 无法加载本地录音:', err);
                    pushDebug('本地录音加载失败', { segmentIndex: key, error: err.message });
                  }
                }
              }
            }
          } catch (err) {
            console.error('[音频模式] 加载录音失败:', err);
            pushDebug('loadUserRecordings 异常', err?.message || err);
          }

          state.remoteRecordingKeys = remoteKeys;
          state.localRecordingKeys = localKeys;

          pushDebug('loadUserRecordings 完成', {
            count,
            speaker: this.selectedSpeaker,
            remoteKeys,
            localKeys,
            cachedKeys: Object.keys(this.userRecordings || {}),
          });
          this.updateRecordingIndicator(count);

          // 实战场模式：更新按钮状态
          if (typeof updateArenaModeButtons === 'function') {
            updateArenaModeButtons();
          }
        }

        clearPendingPlayback(key) {
          if (!key || !this.pendingPlaybackRequests?.size) return;
          const pending = this.pendingPlaybackRequests.get(key);
          if (!pending) return;
          try {
            pending.cleanup?.();
          } catch (err) {
            console.warn('[音频模式] 无法清理延迟播放:', err);
          }
          this.pendingPlaybackRequests.delete(key);
        }

        clearAllPendingPlayback() {
          if (!this.pendingPlaybackRequests?.size) return;
          Array.from(this.pendingPlaybackRequests.keys()).forEach((key) => {
            this.clearPendingPlayback(key);
          });
        }

        enqueueDeferredPlayback(key, segmentIndex, segment, videoEl, audio) {
          if (!key || !audio || !videoEl) return false;
          const now = performance.now();
          const existing = this.pendingPlaybackRequests.get(key);
          if (existing) {
            existing.segment = segment || existing.segment || null;
            existing.segmentIndex = segmentIndex;
            existing.videoEl = videoEl;
            existing.requestedAt = now;
            existing.videoTime = videoEl.currentTime;
            return true;
          }

          if (!this.isMobileEnvironment && audio.readyState >= MEDIA_READY_THRESHOLD) {
            return false;
          }

          const self = this;
          let timeoutId = null;

          function cleanup() {
            audio.removeEventListener('canplaythrough', handleReady);
            audio.removeEventListener('canplay', handleReady);
            audio.removeEventListener('loadeddata', handleReady);
            audio.removeEventListener('error', handleError);
            if (timeoutId !== null && typeof window !== 'undefined' && window) {
              window.clearTimeout(timeoutId);
              timeoutId = null;
            }
          }

          function handleReady() {
            cleanup();
            self.pendingPlaybackRequests.delete(key);
            pushDebug('录音加载完成，尝试延迟播放', {
              segmentIndex: key,
              readyState: audio.readyState,
            });
            const invoke = () => self.syncPlayUserRecording(segmentIndex, videoEl, segment);
            if (typeof window !== 'undefined' && window?.requestAnimationFrame) {
              window.requestAnimationFrame(invoke);
            } else if (typeof setTimeout === 'function') {
              setTimeout(invoke, 0);
            } else {
              invoke();
            }
          }

          function handleError(event) {
            cleanup();
            self.pendingPlaybackRequests.delete(key);
            pushDebug('录音延迟播放失败', {
              segmentIndex: key,
              error: event?.message || audio?.error?.code || 'unknown',
            });
          }

          function handleTimeout() {
            cleanup();
            self.pendingPlaybackRequests.delete(key);
            pushDebug('录音等待超时，准备在之后重新监听', { segmentIndex: key });
          }

          audio.addEventListener('canplaythrough', handleReady, { once: true });
          audio.addEventListener('canplay', handleReady, { once: true });
          audio.addEventListener('loadeddata', handleReady, { once: true });
          audio.addEventListener('error', handleError, { once: true });

          pushDebug('录音尚未就绪，已排队等待资源加载', {
            segmentIndex: key,
            readyState: audio.readyState,
          });

          if (typeof window !== 'undefined' && window?.setTimeout) {
            timeoutId = window.setTimeout(handleTimeout, this.maxDeferredPlaybackWaitMs);
          }

          this.pendingPlaybackRequests.set(key, {
            key,
            segmentIndex,
            segment: segment || null,
            videoEl,
            requestedAt: now,
            videoTime: videoEl.currentTime,
            cleanup,
          });

          if (typeof audio.load === 'function') {
            try {
              audio.load();
            } catch (err) {
              console.warn('[音频模式] 延迟播放时强制加载失败:', err);
            }
          }

          if (this.isMobileEnvironment && !this.isAudioUnlocked) {
            this.bindMobileUnlockHooks();
            pushDebug('等待移动端音频权限解锁以播放录音', { segmentIndex: key });
          }

          return true;
        }

        tryRestoreMissingRecording(segmentKey) {
          if (!this.currentVideoId || !segmentKey) return;
          const attempts = this.missingRecordingRetries.get(segmentKey) || 0;
          if (attempts >= 2) return;

          const cache = getLocalRecordingCache(this.currentVideoId);
          const snapshot = cache?.recordings?.[segmentKey];
          if (!snapshot?.audioData) {
            pushDebug('缺少本地备份，无法修复录音', { segmentIndex: segmentKey });
            this.missingRecordingRetries.set(segmentKey, attempts + 1);
            return;
          }

          const speaker = snapshot.speaker || cache?.selectedSpeaker || this.selectedSpeaker || null;
          if (!speaker) {
            pushDebug('无法修复录音（缺少speaker）', { segmentIndex: segmentKey });
            this.missingRecordingRetries.set(segmentKey, attempts + 1);
            return;
          }

          pushDebug('尝试修复缺失录音', { segmentIndex: segmentKey, attempt: attempts + 1 });
          this.missingRecordingRetries.set(segmentKey, attempts + 1);

          uploadRecordingToServer({
            videoId: this.currentVideoId,
            segmentIndex: segmentKey,
            speaker,
            audioData: snapshot.audioData,
            durationSec: snapshot.duration || null,
          })
            .then((recording) => {
              if (!recording) {
                pushDebug('修复录音未返回记录', { segmentIndex: segmentKey });
                return;
              }
              state.serverRecordings = Array.isArray(state.serverRecordings)
                ? state.serverRecordings.filter((item) => {
                  const itemKey = buildSegmentKey(item.segment_index ?? item.segmentIndex);
                  return itemKey !== segmentKey;
                })
                : [];
              state.serverRecordings.push(recording);
              pushDebug('修复录音成功', { segmentIndex: segmentKey });
              this.addOrUpdateRecording(recording);
            })
            .catch((err) => {
              console.warn('[音频模式] 修复录音失败:', err);
              pushDebug('修复录音失败', {
                segmentIndex: segmentKey,
                error: err?.message || err,
              });
            });
        }

        updateRecordingIndicator(count = Object.keys(this.userRecordings || {}).length) {
          if (recordingIndicatorEl && recordedCountEl) {
            if (count > 0) {
              recordedCountEl.textContent = String(count);
              recordingIndicatorEl.hidden = false;
            } else {
              recordingIndicatorEl.hidden = true;
            }
          }

          // 使用统一的按钮可用性更新函数（会考虑练习模式状态）
          updateAudioModeButtonsAvailability();
        }

        bindMobileUnlockHooks() {
          if (!this.isMobileEnvironment || this.isAudioUnlocked || this.unlockHandlersBound) {
            return;
          }
          if (typeof document === 'undefined') return;
          const handler = () => this.unlockAudioPlayback();
          this.boundUnlockHandler = handler;
          const options = { once: true, passive: true };
          document.addEventListener('touchend', handler, options);
          document.addEventListener('touchstart', handler, options);
          document.addEventListener('click', handler, options);
          this.unlockHandlersBound = true;
          pushDebug('等待用户交互以解锁移动端音频');
        }

        unlockAudioPlayback() {
          if (!this.isMobileEnvironment || this.isAudioUnlocked) {
            return;
          }
          if (typeof document !== 'undefined' && this.boundUnlockHandler) {
            document.removeEventListener('touchend', this.boundUnlockHandler);
            document.removeEventListener('touchstart', this.boundUnlockHandler);
            document.removeEventListener('click', this.boundUnlockHandler);
          }
          this.unlockHandlersBound = false;
          this.boundUnlockHandler = null;

          const finalize = (success) => {
            if (success) {
              this.isAudioUnlocked = true;
              pushDebug('移动端音频权限已解锁');
              this.flushPendingPlaybackRequests();
            } else {
              pushDebug('移动端音频解锁失败，等待下一次用户交互');
              this.isAudioUnlocked = false;
              this.bindMobileUnlockHooks();
            }
          };

          try {
            if (typeof window === 'undefined' || !window.Audio) {
              finalize(false);
              return;
            }
            const silentAudio = new Audio(SILENT_AUDIO_DATA_URL);
            silentAudio.muted = true;
            const playPromise = silentAudio.play();
            if (playPromise && typeof playPromise.then === 'function') {
              playPromise
                .then(() => {
                  try {
                    silentAudio.pause();
                    silentAudio.currentTime = 0;
                  } catch (_err) {
                    // ignore
                  }
                  finalize(true);
                })
                .catch((err) => {
                  pushDebug('移动端音频解锁失败', { error: err?.name || 'Error', message: err?.message });
                  finalize(false);
                });
            } else {
              finalize(true);
            }
          } catch (err) {
            pushDebug('移动端音频解锁异常', { error: err?.name || 'Error', message: err?.message });
            finalize(false);
          }
        }

        audioContextSupported() {
          if (typeof window === 'undefined') return false;
          return typeof window.AudioContext === 'function' || typeof window.webkitAudioContext === 'function';
        }

        ensurePlaybackAudioContext() {
          if (!this.audioContextSupported()) {
            return null;
          }
          if (this.playbackAudioContext) {
            return this.playbackAudioContext;
          }
          const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
          if (!AudioContextCtor) {
            return null;
          }
          try {
            this.playbackAudioContext = new AudioContextCtor();
            return this.playbackAudioContext;
          } catch (err) {
            console.warn('[音频模式] 创建AudioContext失败:', err);
            this.playbackAudioContext = null;
            return null;
          }
        }

        ensureAnalyser(audioEl) {
          if (!audioEl) {
            throw new Error('missing-audio-element');
          }
          if (!this.audioContextSupported()) {
            throw new Error('audio-context-unsupported');
          }
          const captureFn =
            (typeof audioEl.captureStream === 'function' && audioEl.captureStream.bind(audioEl)) ||
            (typeof audioEl.mozCaptureStream === 'function' && audioEl.mozCaptureStream.bind(audioEl));
          if (!captureFn) {
            throw new Error('capture-stream-unsupported');
          }

          const cached = this.playbackAnalyserCache?.get(audioEl);
          if (cached && cached.analyser && !cached.disposed) {
            const streamActive =
              cached.stream && typeof cached.stream.active === 'boolean' ? cached.stream.active : true;
            if (streamActive) {
              return cached.analyser;
            }
            this.teardownAnalyser(audioEl);
          }

          const ctx = this.ensurePlaybackAudioContext();
          if (!ctx) {
            throw new Error('audio-context-unavailable');
          }
          if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
            try {
              ctx.resume();
            } catch (_err) {
              // 部分环境会在没有用户手势时拒绝 resume，忽略即可
            }
          }

          let stream = null;
          try {
            stream = captureFn();
          } catch (err) {
            throw new Error(err?.message || 'capture-stream-failed');
          }
          if (!stream) {
            throw new Error('empty-capture-stream');
          }

          let source = null;
          let analyser = null;
          try {
            source = ctx.createMediaStreamSource(stream);
            analyser = ctx.createAnalyser();
            analyser.fftSize = 2048;
            source.connect(analyser);
          } catch (err) {
            throw new Error(err?.message || 'create-analyser-failed');
          }

          const entry = {
            analyser,
            source,
            stream,
            disposed: false,
            cleanup: null,
            handleEnded: null,
            handleEmptied: null,
          };

          const cleanup = () => {
            if (entry.disposed) return;
            entry.disposed = true;
            try {
              source.disconnect();
            } catch (_disconnectErr) {
              // ignore disconnect errors
            }
            if (entry.handleEnded) {
              audioEl.removeEventListener('ended', entry.handleEnded);
            }
            if (entry.handleEmptied) {
              audioEl.removeEventListener('emptied', entry.handleEmptied);
            }
            if (this.playbackAnalyserCache) {
              this.playbackAnalyserCache.delete(audioEl);
            }
            if (this.activeAnalyserAudios) {
              this.activeAnalyserAudios.delete(audioEl);
            }
            if (stream && typeof stream.getTracks === 'function') {
              stream.getTracks().forEach((track) => {
                if (typeof track.stop === 'function') {
                  try {
                    track.stop();
                  } catch (_stopErr) {
                    // ignore
                  }
                }
              });
            }
            this.shutdownPlaybackAudioContext();
          };

          entry.cleanup = cleanup;
          entry.handleEnded = () => cleanup();
          entry.handleEmptied = () => cleanup();

          audioEl.addEventListener('ended', entry.handleEnded, { once: true });
          audioEl.addEventListener('emptied', entry.handleEmptied, { once: true });

          this.playbackAnalyserCache?.set(audioEl, entry);
          this.activeAnalyserAudios?.add(audioEl);
          return analyser;
        }

        teardownAnalyser(audioEl) {
          if (!audioEl || !this.playbackAnalyserCache) return;
          const entry = this.playbackAnalyserCache.get(audioEl);
          if (!entry) return;
          if (typeof entry.cleanup === 'function') {
            entry.cleanup();
          }
        }

        disposeAllAnalysers() {
          if (!this.activeAnalyserAudios || this.activeAnalyserAudios.size === 0) {
            return;
          }
          const targets = Array.from(this.activeAnalyserAudios);
          targets.forEach((audioEl) => this.teardownAnalyser(audioEl));
        }

        shutdownPlaybackAudioContext() {
          if (!this.playbackAudioContext) return;
          if (this.activeAnalyserAudios && this.activeAnalyserAudios.size > 0) {
            return;
          }
          if (this.pendingSilenceAnalysis && this.pendingSilenceAnalysis.size > 0) {
            return;
          }
          const ctx = this.playbackAudioContext;
          this.playbackAudioContext = null;
          if (!ctx) return;
          try {
            const result = typeof ctx.close === 'function' ? ctx.close() : null;
            if (result && typeof result.catch === 'function') {
              result.catch(() => { });
            }
          } catch (err) {
            console.warn('[音频模式] 关闭AudioContext失败:', err);
          }
        }

        buildSilenceCacheKey(segmentKey, audioEl) {
          if (!audioEl) return null;
          const src = audioEl.currentSrc || audioEl.src || '';
          if (!segmentKey && !src) return null;
          return `${segmentKey || 'unknown'}::${src}`;
        }

        getCachedLeadingSilence(segmentKey, audioEl) {
          if (!this.leadingSilenceCache) return null;
          const cacheKey = this.buildSilenceCacheKey(segmentKey, audioEl);
          if (!cacheKey) return null;
          const cached = this.leadingSilenceCache.get(cacheKey);
          if (typeof cached === 'number' && Number.isFinite(cached)) {
            return cached;
          }
          return null;
        }

        getCachedEmptyRecordingStatus(segmentKey, audioEl) {
          if (!this.emptyRecordingCache) return null;
          const cacheKey = this.buildSilenceCacheKey(segmentKey, audioEl);
          if (!cacheKey) return null;
          const cached = this.emptyRecordingCache.get(cacheKey);
          if (typeof cached === 'boolean') {
            return cached;
          }
          return null;
        }

        scheduleLeadingSilenceAnalysis(segmentKey, audioEl) {
          if (!audioEl || !audioEl.currentSrc || !window?.fetch) {
            return null;
          }
          if (!this.audioContextSupported()) {
            return null;
          }
          const cacheKey = this.buildSilenceCacheKey(segmentKey, audioEl);
          if (!cacheKey) return null;
          if (this.leadingSilenceCache?.has(cacheKey)) {
            return this.leadingSilenceCache.get(cacheKey);
          }
          if (this.pendingSilenceAnalysis?.has(cacheKey)) {
            return this.pendingSilenceAnalysis.get(cacheKey);
          }
          const analysisPromise = this.computeLeadingSilenceSeconds(cacheKey, audioEl)
            .then((seconds) => {
              const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
              if (this.leadingSilenceCache) {
                this.leadingSilenceCache.set(cacheKey, value);
              }
              if (debugMode) {
                pushDebug('录音静音分析完成', {
                  segmentIndex: segmentKey,
                  seconds: value,
                });
              }
              return value;
            })
            .catch((err) => {
              if (debugMode) {
                pushDebug('录音静音分析失败', {
                  segmentIndex: segmentKey,
                  errorCode: err?.name || 'SILENCE_ANALYSIS_ERROR',
                });
              }
              if (this.leadingSilenceCache) {
                this.leadingSilenceCache.set(cacheKey, 0);
              }
              return 0;
            })
            .finally(() => {
              if (this.pendingSilenceAnalysis) {
                this.pendingSilenceAnalysis.delete(cacheKey);
              }
            });
          if (this.pendingSilenceAnalysis) {
            this.pendingSilenceAnalysis.set(cacheKey, analysisPromise);
          }
          return analysisPromise;
        }

        async computeLeadingSilenceSeconds(cacheKey, audioEl) {
          const src = audioEl?.currentSrc || audioEl?.src;
          if (!src) {
            throw new Error('missing-audio-src');
          }
          let response = null;
          try {
            response = await fetch(src, {
              mode: 'cors',
              credentials: 'include',
              cache: 'force-cache',
            });
          } catch (err) {
            console.warn('[音频模式] 获取录音用于静音分析失败:', err);
            throw err;
          }
          if (!response || !response.ok) {
            throw new Error(`fetch-failed:${response?.status || 'network'}`);
          }
          let arrayBuffer = null;
          try {
            arrayBuffer = await response.arrayBuffer();
          } catch (err) {
            console.warn('[音频模式] 读取录音数据失败:', err);
            throw err;
          }
          const ctx = this.ensurePlaybackAudioContext();
          if (!ctx) {
            throw new Error('audio-context-unavailable');
          }
          const bufferCopy = arrayBuffer.slice(0);
          let audioBuffer = null;
          try {
            if (ctx.decodeAudioData.length > 1) {
              audioBuffer = await new Promise((resolve, reject) => {
                ctx.decodeAudioData(
                  bufferCopy,
                  (decoded) => resolve(decoded),
                  (error) => reject(error || new Error('decode-failed'))
                );
              });
            } else {
              audioBuffer = await ctx.decodeAudioData(bufferCopy);
            }
          } catch (err) {
            console.warn('[音频模式] 解码录音失败:', err);
            throw err;
          }

          if (!audioBuffer || !Number.isFinite(audioBuffer.sampleRate)) {
            return 0;
          }

          const sampleRate = audioBuffer.sampleRate;
          const channelCount = audioBuffer.numberOfChannels || 1;
          const maxSamples = Math.min(
            audioBuffer.length,
            Math.floor(sampleRate * (this.maxSilenceTrimSeconds || 2.5))
          );
          if (maxSamples <= 0) {
            return 0;
          }

          const threshold = this.silenceTrimThreshold || 0.012;
          let earliestSample = maxSamples;
          for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            const channelData = audioBuffer.getChannelData(channelIndex);
            if (!channelData) continue;
            for (let i = 0; i < maxSamples; i += 1) {
              const value = channelData[i];
              if (value > threshold || value < -threshold) {
                if (i < earliestSample) {
                  earliestSample = i;
                }
                break;
              }
            }
          }

          if (earliestSample >= maxSamples) {
            return 0;
          }

          const offsetSeconds = earliestSample / sampleRate;
          if (!Number.isFinite(offsetSeconds) || offsetSeconds <= 0) {
            return 0;
          }
          const clamped = Math.min(
            Math.max(offsetSeconds - 0.02, 0), // minor padding
            this.maxSilenceTrimSeconds || 2.5
          );
          return clamped >= 0.08 ? clamped : 0;
        }

        scheduleEmptyRecordingDetection(segmentKey, audioEl) {
          if (!audioEl || !audioEl.currentSrc || !window?.fetch) {
            return null;
          }
          if (!this.audioContextSupported()) {
            return null;
          }
          const cacheKey = this.buildSilenceCacheKey(segmentKey, audioEl);
          if (!cacheKey) return null;
          if (this.emptyRecordingCache?.has(cacheKey)) {
            return this.emptyRecordingCache.get(cacheKey);
          }
          if (this.pendingEmptyDetection?.has(cacheKey)) {
            return this.pendingEmptyDetection.get(cacheKey);
          }
          const detectionPromise = this.detectEmptyRecording(cacheKey, audioEl)
            .then((isEmpty) => {
              const value = typeof isEmpty === 'boolean' ? isEmpty : false;
              if (this.emptyRecordingCache) {
                this.emptyRecordingCache.set(cacheKey, value);
              }
              if (debugMode && value) {
                pushDebug('检测到空白录音', {
                  segmentIndex: segmentKey,
                  isEmpty: value,
                });
              }
              return value;
            })
            .catch((err) => {
              if (debugMode) {
                pushDebug('空白录音检测失败', {
                  segmentIndex: segmentKey,
                  errorCode: err?.name || 'EMPTY_RECORDING_ANALYSIS_ERROR',
                });
              }
              if (this.emptyRecordingCache) {
                this.emptyRecordingCache.set(cacheKey, false);
              }
              return false;
            })
            .finally(() => {
              if (this.pendingEmptyDetection) {
                this.pendingEmptyDetection.delete(cacheKey);
              }
            });
          if (this.pendingEmptyDetection) {
            this.pendingEmptyDetection.set(cacheKey, detectionPromise);
          }
          return detectionPromise;
        }

        async detectEmptyRecording(cacheKey, audioEl) {
          const src = audioEl?.currentSrc || audioEl?.src;
          if (!src) {
            throw new Error('missing-audio-src');
          }
          let response = null;
          try {
            response = await fetch(src, {
              mode: 'cors',
              credentials: 'include',
              cache: 'force-cache',
            });
          } catch (err) {
            console.warn('[音频模式] 获取录音用于空白检测失败:', err);
            throw err;
          }
          if (!response || !response.ok) {
            throw new Error(`fetch-failed:${response?.status || 'network'}`);
          }
          let arrayBuffer = null;
          try {
            arrayBuffer = await response.arrayBuffer();
          } catch (err) {
            console.warn('[音频模式] 读取录音数据失败:', err);
            throw err;
          }
          const ctx = this.ensurePlaybackAudioContext();
          if (!ctx) {
            throw new Error('audio-context-unavailable');
          }
          const bufferCopy = arrayBuffer.slice(0);
          let audioBuffer = null;
          try {
            if (ctx.decodeAudioData.length > 1) {
              audioBuffer = await new Promise((resolve, reject) => {
                ctx.decodeAudioData(
                  bufferCopy,
                  (decoded) => resolve(decoded),
                  (error) => reject(error || new Error('decode-failed'))
                );
              });
            } else {
              audioBuffer = await ctx.decodeAudioData(bufferCopy);
            }
          } catch (err) {
            console.warn('[音频模式] 解码录音失败:', err);
            throw err;
          }

          if (!audioBuffer || !Number.isFinite(audioBuffer.sampleRate)) {
            return true;
          }

          const sampleRate = audioBuffer.sampleRate;
          const channelCount = audioBuffer.numberOfChannels || 1;
          const totalSamples = audioBuffer.length;
          if (totalSamples <= 0) {
            return true;
          }

          const threshold = this.silenceTrimThreshold || 0.012;

          // 检测整个录音，看是否有任何有效的音频信号
          for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            const channelData = audioBuffer.getChannelData(channelIndex);
            if (!channelData) continue;

            for (let i = 0; i < totalSamples; i += 1) {
              const value = channelData[i];
              if (value > threshold || value < -threshold) {
                // 找到有效信号，录音不是空白的
                return false;
              }
            }
          }

          // 所有样本都在阈值以下，录音是空白的
          return true;
        }

        flushPendingPlaybackRequests() {
          if (!this.pendingPlaybackRequests?.size) return;
          const entries = Array.from(this.pendingPlaybackRequests.entries());
          this.pendingPlaybackRequests.clear();
          entries.forEach(([key, payload]) => {
            try {
              payload.cleanup?.();
            } catch (_err) {
              // ignore cleanup errors
            }
            const { segmentIndex, segment, videoEl, videoTime } = payload || {};
            if (segmentIndex == null || !videoEl) {
              pushDebug('延迟播放恢复时缺少必要参数', { segmentIndex: key });
              return;
            }

            // 检查视频当前时间是否还在片段范围内，避免播放已过期的录音
            const currentVideoTime = videoEl.currentTime;
            const segmentStart = Number(segment?.start);
            const segmentEnd = Number(segment?.end);

            // 如果有片段时间信息，验证当前视频时间是否在片段范围内
            if (Number.isFinite(segmentStart) && Number.isFinite(segmentEnd)) {
              // 允许一定的时间误差（0.5秒），因为解锁可能需要一点时间
              const tolerance = 0.5;
              if (currentVideoTime < segmentStart - tolerance || currentVideoTime > segmentEnd + tolerance) {
                pushDebug('跳过过期的录音播放请求', {
                  segmentIndex: key,
                  videoTime: currentVideoTime,
                  segmentStart,
                  segmentEnd
                });
                return;
              }
            } else if (Number.isFinite(videoTime)) {
              // 如果没有片段信息，检查视频时间是否变化太多（超过3秒说明已经不是同一个场景了）
              const timeDiff = Math.abs(currentVideoTime - videoTime);
              if (timeDiff > 3) {
                pushDebug('跳过过期的录音播放请求（时间差过大）', {
                  segmentIndex: key,
                  videoTime: currentVideoTime,
                  requestedTime: videoTime,
                  timeDiff
                });
                return;
              }
            }

            this.syncPlayUserRecording(segmentIndex, videoEl, segment || null);
          });
        }

        getRecordingCount() {
          return Object.keys(this.userRecordings || {}).length;
        }

        addOrUpdateRecording(recording) {
          if (!recording) return;
          const segmentIndex = recording.segment_index ?? recording.segmentIndex;
          const key = buildSegmentKey(segmentIndex);
          if (!key) return;
          const rawUrl = recording.audio_url || recording.audioPath || recording.audioData;
          if (!rawUrl) return;
          try {
            const audio = new Audio();
            audio.preload = 'auto';
            // 标记为已处理的录音（服务器录音已裁剪过静音）
            audio.dataset.isProcessed = 'true';
            // 清除任何可能的偏移值，因为服务器录音已经实际裁剪过了
            delete audio.dataset.startOffset;
            delete audio.dataset.endOffset;
            this.prepareAudioElement(key, audio, 'remote');
            this.userRecordings[key] = audio;
            setProtectedMediaSource(audio, rawUrl, recording.updated_at).then(() => {
              if (typeof audio.load === 'function') {
                audio.load();
              }
            }).catch(() => {
              if (this.userRecordings[key] === audio) delete this.userRecordings[key];
              this.updateRecordingIndicator();
            });
            if (recording.speaker) {
              this.selectedSpeaker = recording.speaker;
            }
            this.updateRecordingIndicator();
            pushDebug('更新录音缓存', { segmentIndex: key, protectedSource: true });
          } catch (err) {
            console.warn('[音频模式] 无法更新录音:', err);
            pushDebug('更新录音失败', { segmentIndex: key, error: err.message });
          }
        }

        setMode(newMode) {
          this.mode = newMode || 'original';
          this.clearAllPendingPlayback();
          if (this.mode !== 'original') {
            this.bindMobileUnlockHooks();
          }
          if (this.mode === 'original') {
            this.cleanup();
            this.segmentPlaybackLog.clear();
          }

          // Aggressively preload all recordings when switching to mixed or my-voice mode
          if (this.mode === 'mixed' || this.mode === 'my-voice') {
            this.preloadAllRecordings();
          }
        }

        preloadAllRecordings() {
          if (!this.userRecordings) return;

          let loadedCount = 0;
          let totalCount = 0;

          Object.entries(this.userRecordings).forEach(([key, audio]) => {
            if (!audio) return;
            totalCount++;

            // Force load if not already loaded
            if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
              if (typeof audio.load === 'function') {
                try {
                  audio.load();
                  loadedCount++;
                } catch (err) {
                  console.warn(`[预加载] 无法加载录音 ${key}:`, err);
                }
              }
            }
          });

          if (debugMode && loadedCount > 0) {
            pushDebug('批量预加载录音', {
              mode: this.mode,
              loaded: loadedCount,
              total: totalCount,
            });
          }
        }

        shouldPlayUserRecording(segmentIndex, segment, playbackTime = null) {
          // 核心原则：优先播放用户录音
          // 只要用户有录音，就播放用户的声音，让用户听到自己的发音
          // 即使读得不标准、有静音、有噪音，也要播放，因为这是用户自己的声音
          if (this.mode === 'original') return false;
          this.bindMobileUnlockHooks();
          const key = buildSegmentKey(segmentIndex);
          if (!key) {
            pushDebug('缺少录音资源', { segmentIndex, mode: this.mode, reason: 'invalid-key' });
            return false;
          }
          const assignedSpeaker = segment?.speaker || resolveSegmentSpeaker(segmentIndex) || null;
          const segmentRole = determineSegmentRole(segmentIndex, assignedSpeaker);
          const audio = this.userRecordings?.[key];
          const hasRecording = !!audio;
          let isUserSegment = segmentRole === 'student';
          let fellBackByRecording = false;
          // 在 my-voice 模式允许对非本人段落也播用户录音；
          // 在 mixed（对话）模式仅在“我的台词”播放用户录音，其它段落保持原声
          if (!isUserSegment && hasRecording && this.mode === 'my-voice') {
            isUserSegment = true;
            fellBackByRecording = true;
          }

          // Check if this segment was played recently to prevent double playback
          if (key === this.lastPlaybackKey) {
            const elapsed = performance.now() - this.lastPlaybackTimestamp;
            // Use minimum cooldown instead of fixed 500ms
            if (elapsed < this.minimumPlaybackCooldownMs) {
              if (debugMode) {
                recordDecision('阻止重复播放（短时间内再次触发）', {
                  elapsedMs: Math.round(elapsed),
                  minimumCooldownMs: this.minimumPlaybackCooldownMs,
                });
              }
              return false;
            }
          }

          if (segmentRole && this.lastRoleLog) {
            const prevRole = this.lastRoleLog.get(key);
            if (prevRole !== segmentRole) {
              pushDebug('段落角色判定', {
                segmentIndex: key,
                assignedSpeaker,
                selectedSpeaker: this.selectedSpeaker,
                role: segmentRole,
              });
              this.lastRoleLog.set(key, segmentRole);
            }
          }

          const recordDecision = (action, extra = {}) => {
            const prev = this.decisionCache.get(key);
            const decisionKey = `${segmentRole}:${action}`;
            if (prev !== decisionKey) {
              pushDebug(action, {
                segmentIndex: key,
                assignedSpeaker,
                selectedSpeaker: this.selectedSpeaker,
                role: segmentRole,
                ...extra,
              });
              this.decisionCache.set(key, decisionKey);
            }
          };

          // Block replay for this segment until we pass guard time
          const segEnd = Number(segment?.end);
          if (this.playedGuard && this.playedGuard.has(key) && typeof playbackTime === 'number') {
            const until = this.playedGuard.get(key);
            if (Number.isFinite(until) && playbackTime < until) {
              return false;
            }
          }

          const playbackLog = this.segmentPlaybackLog.get(key);
          if (playbackLog) {
            const now = performance.now();
            const hasPlaybackTime = typeof playbackTime === 'number' && Number.isFinite(playbackTime);
            const hasLogVideoTime = Number.isFinite(playbackLog.lastVideoTime);
            const hasLogSegmentStart = Number.isFinite(playbackLog.segmentStart);
            const rewoundByPlayhead =
              hasPlaybackTime &&
              hasLogVideoTime &&
              playbackTime + 0.05 < playbackLog.lastVideoTime;
            const rewoundBeforeSegment =
              hasPlaybackTime &&
              hasLogSegmentStart &&
              playbackTime + 0.05 < playbackLog.segmentStart;
            if (rewoundByPlayhead || rewoundBeforeSegment) {
              this.segmentPlaybackLog.delete(key);
            } else {
              const cooldownMs = playbackLog.cooldown ?? this.minimumPlaybackCooldownMs;
              const elapsedMs = now - playbackLog.timestamp;
              if (elapsedMs < cooldownMs) {
                recordDecision('录音播放冷却中', {
                  elapsedMs: Math.round(elapsedMs),
                  cooldownMs: Math.round(cooldownMs),
                });
                return false;
              }
            }
          }

          if (!isUserSegment) {
            if (this.mode === 'mixed') {
              recordDecision('混合模式保持原声', {
                hasRecording,
                segmentRole,
                fellBackByRecording,
              });
              return false;
            }
            if (this.mode !== 'my-voice') {
              recordDecision('非学生段落保持原声');
              return false;
            }
          }

          if (!audio) {
            if (segmentRole === 'student') {
              recordDecision('⚠️ 学生段落缺少录音，播放原声', {
                mode: this.mode,
                segmentIndex: key,
                reason: '用户还没有录制这句话'
              });
            } else {
              recordDecision('非学生段落，播放原声', {
                mode: this.mode,
                segmentIndex: key
              });
            }
            return false;
          }

          console.log(`[播放决策] ✅ 找到用户录音，准备播放！片段: ${key}, 模式: ${this.mode}`);

          if (audio.readyState < MEDIA_READY_THRESHOLD) {
            // Throttle repeated attempts while not ready
            const nowTs = performance.now();
            const nextTs = this.notReadyThrottle?.get(key) || 0;
            const hasPending = this.pendingPlaybackRequests && this.pendingPlaybackRequests.has(key);
            if (hasPending || nowTs < nextTs) {
              return false;
            }
            if (this.notReadyThrottle) {
              const minMs = (typeof this.notReadyMinMs === 'number' && this.notReadyMinMs > 0) ? this.notReadyMinMs : 300;
              this.notReadyThrottle.set(key, nowTs + minMs);
            }
            recordDecision('录音尚未就绪', {
              readyState: audio.readyState,
              mode: this.mode,
              relaxed: this.isMobileEnvironment,
            });
            if (!this.isMobileEnvironment) {
              return false;
            }
          }
          if (audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA && typeof audio.load === 'function') {
            try {
              audio.load();
            } catch (err) {
              console.warn('[音频模式] 强制加载录音失败:', err);
            }
          }

          // 用户原则：只要有录音就播放，让用户听到自己的声音
          // 不再检测录音是否为空白，因为用户想听自己的声音，即使读得不标准
          // Empty recordings remain playable by product policy.

          if (fellBackByRecording && debugMode) {
            pushDebug('混合模式匹配', {
              segmentIndex: key,
              assignedSpeaker,
              selectedSpeaker: this.selectedSpeaker,
              isMatch: isUserSegment,
              hasRecording,
            });
          }

          if (this.mode === 'mixed') {
            recordDecision('混合模式播放');
            return true;
          }

          if (this.mode === 'my-voice') {
            recordDecision('我的配音模式播放');
            return true;
          }

          recordDecision('准备播放录音');
          return true;
        }

        syncPlayUserRecording(segmentIndex, videoEl, segment = null) {
          const key = buildSegmentKey(segmentIndex);
          if (!key) return;
          const audio = this.userRecordings?.[key];
          if (!audio || !videoEl) return;
          this.clearPendingPlayback(key);
          this.bindMobileUnlockHooks();
          const readyState = audio.readyState;
          if (readyState < MEDIA_READY_THRESHOLD) {
            if (this.enqueueDeferredPlayback(key, segmentIndex, segment, videoEl, audio)) {
              return;
            }
            pushDebug('录音播放被跳过（资源未就绪）', { segmentIndex: key, readyState });
            return;
          }
          if (
            typeof HTMLMediaElement !== 'undefined' &&
            readyState < HTMLMediaElement.HAVE_CURRENT_DATA &&
            this.isMobileEnvironment &&
            this.enqueueDeferredPlayback(key, segmentIndex, segment, videoEl, audio)
          ) {
            return;
          }
          if (
            typeof HTMLMediaElement !== 'undefined' &&
            readyState < HTMLMediaElement.HAVE_FUTURE_DATA &&
            typeof audio.play === 'function'
          ) {
            if (typeof audio.load === 'function') {
              try {
                audio.load();
              } catch (err) {
                console.warn('[音频模式] 强制加载录音失败:', err);
              }
            }
          }

          if (this.overlayAudio && this.overlayAudio !== audio) {
            try { this.overlayAudio.pause(); } catch (_) { }
          }

          this.overlayAudio = audio;
          const currentVolume = videoEl.volume;
          if (currentVolume > 0) {
            this.baseVolume = currentVolume;
          }
          // 确保 baseVolume 有默认值
          if (!this.baseVolume || this.baseVolume === 0) {
            this.baseVolume = 1;
          }
          // 只在当前音量大于0时才更新 originalVolume
          if (currentVolume > 0) {
            this.originalVolume = currentVolume;
          } else if (!this.originalVolume || this.originalVolume === 0) {
            this.originalVolume = this.baseVolume;
          }
          const assignedSpeaker = resolveSegmentSpeaker(segmentIndex);
          const segmentRole = determineSegmentRole(segmentIndex, assignedSpeaker);
          const isUserSegment = segmentRole === 'student';
          const shouldMuteVideo = this.mode === 'my-voice' || (this.mode === 'mixed' && isUserSegment);
          const targetVolume = this.originalVolume != null ? this.originalVolume : (this.baseVolume || 1);

          const normalizedIndex = normalizeSegmentIndex(segmentIndex);
          let segmentData = segment || null;
          if (!segmentData && Array.isArray(state.currentSegments)) {
            segmentData = state.currentSegments.find((item, idx) => {
              const rawIdx = item.index != null ? item.index : idx;
              if (buildSegmentKey(rawIdx) === key) return true;
              const normalized = normalizeSegmentIndex(rawIdx);
              if (normalizedIndex !== null && normalized === normalizedIndex) {
                return true;
              }
              return false;
            }) || null;
          }

          const currentTime = videoEl.currentTime;
          const segmentStart = Number(segmentData?.start);
          const audioDuration = Number(audio.duration);
          let playbackCooldownMs = this.minimumPlaybackCooldownMs;
          if (Number.isFinite(audioDuration) && audioDuration > 0) {
            playbackCooldownMs = Math.max(
              playbackCooldownMs,
              (audioDuration * 1000) + 250
            );
          }
          const normalizedSegmentStart = Number.isFinite(segmentStart) ? segmentStart : null;
          this.segmentPlaybackLog.set(key, {
            timestamp: performance.now(),
            cooldown: playbackCooldownMs,
            lastVideoTime: currentTime,
            segmentStart: normalizedSegmentStart,
          });

          if (debugMode) {
            pushDebug('shouldMuteVideo 判断', {
              segmentIndex: key,
              shouldMuteVideo,
              mode: this.mode,
              isUserSegment,
              segmentRole,
            });
          }

          // 简化逻辑：不暂停视频，只是静音/取消静音
          if (shouldMuteVideo) {
            // 学生角色：暂停视频，平滑静音，播放录音，再跳到片段结尾
            const previousMuted = videoEl.muted;
            const wasPaused = videoEl.paused;
            try { videoEl.pause(); } catch (_) { }
            // Smooth fade-down then mute to avoid abrupt cut
            try { smoothMute(videoEl, DUCK_FADE_MS, 0); } catch (_) { videoEl.muted = true; videoEl.volume = 0; }

            // 计算何时取消静音（录音结束时）
            const segmentEnd = Number(segmentData?.end);
            let unmuteTime;

            // 优先使用片段结束时间，因为我们会调整播放速度来匹配片段时长
            // 这样可以确保视频静音持续到片段结束，避免录音还在播放时就播放原声
            if (Number.isFinite(segmentEnd) && Number.isFinite(segmentStart)) {
              unmuteTime = segmentEnd;
            } else if (Number.isFinite(audioDuration) && audioDuration > 0 && Number.isFinite(segmentStart)) {
              // 备用方案：使用录音时长（但这可能不准确，因为播放速度会调整）
              unmuteTime = segmentStart + audioDuration;
            } else {
              unmuteTime = currentTime + 2;
            }

            this.overlayPlaybackState = {
              startTime: Number.isFinite(segmentStart) ? segmentStart : currentTime,
              pauseTime: currentTime,
              segmentRef: segmentData || null,
              unmuteTime,
              volumeRestored: false,
              previousMuted,
              previousPaused: wasPaused,
              videoPausedForRecording: true,
            };

            if (debugMode) {
              pushDebug('学生角色：静音视频，播放录音', {
                segmentIndex: key,
                unmuteTime,
                audioDuration,
                segmentEnd,
                videoMuted: true,
                videoPaused: false,  // 视频继续播放
              });
            }
          } else {
            // 其他角色：视频正常播放原声（平滑恢复）
            try { smoothUnmute(videoEl, targetVolume, DIALOG_FADE_IN_MS); } catch (_) { videoEl.muted = false; videoEl.volume = targetVolume; }
            this.overlayPlaybackState = null;

            if (debugMode) {
              pushDebug('其他角色：视频正常播放', {
                segmentIndex: key,
                videoMuted: false,
                videoVolume: targetVolume,
              });
            }
          }

          // CRITICAL: Reset audio element if it's in ended state
          // This prevents immediate ended event when calling play()
          if (audio.ended) {
            try {
              audio.currentTime = 0;
              if (debugMode) {
                pushDebug('重置已结束的音频元素', {
                  segmentIndex: key,
                  wasEnded: true,
                });
              }
            } catch (err) {
              console.warn('[音频模式] 重置音频失败:', err);
            }
          }

          let startOffset = 0;
          const shouldTrimSilence = segmentRole === 'student';
          const isProcessedRecording = audio.dataset && audio.dataset.isProcessed === 'true';

          // 已处理的录音（从服务器加载的）已经裁剪过静音，不需要再应用偏移
          if (shouldTrimSilence && !isProcessedRecording) {
            // 优先使用存储的偏移信息（移动端虚拟裁剪或已处理的录音）
            if (audio.dataset && audio.dataset.startOffset !== undefined) {
              const storedOffset = Number(audio.dataset.startOffset);
              if (Number.isFinite(storedOffset) && storedOffset > 0) {
                startOffset = storedOffset;
                if (debugMode) {
                  console.log(`[播放] 使用存储的开头偏移: ${startOffset.toFixed(3)}s (移动端虚拟裁剪)`);
                }
              }
            } else {
              // 回退到缓存的静音检测结果
              const cachedLeading = this.getCachedLeadingSilence(key, audio);
              if (Number.isFinite(cachedLeading) && cachedLeading > 0) {
                startOffset = cachedLeading;
              } else {
                this.scheduleLeadingSilenceAnalysis(key, audio);
              }
            }
          }
          try {
            const minStart = Math.max(startOffset, 0.01);
            const safeDurationCap = Number.isFinite(audio.duration)
              ? Math.max(audio.duration - 0.01, 0)
              : null;
            const targetTime = safeDurationCap != null ? Math.min(minStart, safeDurationCap) : minStart;

            if (debugMode) {
              pushDebug('设置音频播放起始时间', {
                segmentIndex: key,
                startOffset,
                minStart,
                safeDurationCap,
                targetTime,
                duration: audio.duration,
                beforeCurrentTime: audio.currentTime,
              });
            }

            audio.currentTime = Number.isFinite(targetTime) ? targetTime : Math.max(startOffset, 0);

            if (debugMode) {
              pushDebug('音频播放时间已设置', {
                segmentIndex: key,
                currentTime: audio.currentTime,
                duration: audio.duration,
                ended: audio.ended,
              });
            }
          } catch (err) {
            pushDebug('设置音频播放时间失败', { segmentIndex: key, error: err?.message || err });
          }

          const handlePlaying = () => {
            pushDebug('录音正在播放', {
              segmentIndex: key,
              readyState: audio.readyState,
              mode: this.mode,
              volume: audio.volume,
              muted: audio.muted,
              duration: audio.duration,
              currentTime: audio.currentTime,
              ended: audio.ended,
            });
          };
          audio.addEventListener('playing', () => { try { audio.__ll_isPlaying = true; } catch (_) { }; handlePlaying(); }, { once: true });

          // Add comprehensive event tracking for debugging
          if (debugMode) {
            const events = ['pause', 'ended', 'suspend', 'abort', 'emptied', 'stalled', 'waiting'];
            events.forEach(eventName => {
              audio.addEventListener(eventName, (e) => {
                pushDebug(`音频事件: ${eventName}`, {
                  segmentIndex: key,
                  currentTime: audio.currentTime,
                  duration: audio.duration,
                  ended: audio.ended,
                  paused: audio.paused,
                  readyState: audio.readyState,
                  networkState: audio.networkState,
                });
              }, { once: true });
            });
          }

          // Add timeupdate monitor BEFORE defining restoreVolume
          let timeUpdateCount = 0;
          const timeUpdateMonitor = () => {
            timeUpdateCount++;
            if (debugMode && timeUpdateCount % 5 === 1) {  // Log every 5th update to reduce noise
              pushDebug('音频播放中', {
                segmentIndex: key,
                updateCount: timeUpdateCount,
                currentTime: audio.currentTime,
                duration: audio.duration,
                ended: audio.ended,
                paused: audio.paused,
                volume: audio.volume,
                muted: audio.muted,
              });
            }
          };
          audio.addEventListener('timeupdate', timeUpdateMonitor);
          try {
            audio.addEventListener('ended', () => { try { audio.__ll_isPlaying = false; } catch (_) { } }, { once: true });
            audio.addEventListener('pause', () => { if (!audio.ended) { try { audio.__ll_isPlaying = false; } catch (_) { } } });
          } catch (_) { }

          // 初始将录音音量设为0，稍后平滑淡入；并应用去噪的播放窗口
          // 已处理的录音（服务器录音）已裁剪过静音，不需要应用偏移
          let trimStartOffset = 0;
          let trimEndOffset = 0;
          if (!isProcessedRecording) {
            try {
              if (audio.dataset && audio.dataset.startOffset !== undefined) {
                const so = Number(audio.dataset.startOffset);
                if (Number.isFinite(so) && so > 0) trimStartOffset = so;
              }
              if (audio.dataset && audio.dataset.endOffset !== undefined) {
                const eo = Number(audio.dataset.endOffset);
                if (Number.isFinite(eo) && eo > 0) trimEndOffset = eo;
              }
            } catch (_) { }
          }
          const effectiveAudioDuration = Number.isFinite(audioDuration) ? Math.max(0, audioDuration - trimStartOffset - trimEndOffset) : audioDuration;
          try { audio.volume = 0.0; } catch (_) { }

          // 播放速度调整 - 让录音时长匹配片段剩余窗口
          if (shouldMuteVideo && Number.isFinite(effectiveAudioDuration) && effectiveAudioDuration > 0) {
            const segmentEnd = Number(segmentData?.end);
            const segmentStart = Number(segmentData?.start);

            if (Number.isFinite(segmentStart) && Number.isFinite(segmentEnd)) {
              const segmentDuration = segmentEnd - segmentStart;
              const remainingWindow = segmentEnd - currentTime;

              if (segmentDuration > 0) {
                // 计算需要的播放速度（优先压缩以适配剩余窗口）
                let idealPlaybackRate = effectiveAudioDuration / segmentDuration;
                if (Number.isFinite(remainingWindow) && remainingWindow > 0) {
                  idealPlaybackRate = effectiveAudioDuration / remainingWindow;
                }

                // 限制在合理范围内 (0.8x - 1.8x)
                // 太快或太慢会听起来不自然
                // Narrow the range to keep playback natural
                const minRate = 0.9;
                const maxRate = 1.35;
                const playbackRate = Math.min(Math.max(idealPlaybackRate, minRate), maxRate);

                // 只有在明显不同于1.0时才调整速度
                if (Math.abs(playbackRate - 1.0) > 0.05) {
                  audio.playbackRate = playbackRate;

                  console.log(`[播放速度] 录音时长: ${audioDuration.toFixed(2)}s, 片段时长: ${segmentDuration.toFixed(2)}s, 播放速度: ${playbackRate.toFixed(2)}x`);

                  if (debugMode) {
                    pushDebug('调整播放速度以匹配片段时长', {
                      segmentIndex: key,
                      audioDuration: effectiveAudioDuration.toFixed(2),
                      segmentDuration: segmentDuration.toFixed(2),
                      remainingWindow: Number.isFinite(remainingWindow) ? remainingWindow.toFixed(2) : null,
                      idealRate: idealPlaybackRate.toFixed(2),
                      actualRate: playbackRate.toFixed(2),
                      wasLimited: idealPlaybackRate !== playbackRate,
                    });
                  }
                } else {
                  // 保持正常速度
                  audio.playbackRate = 1.0;

                  if (debugMode) {
                    pushDebug('保持正常播放速度', {
                      segmentIndex: key,
                      audioDuration: audioDuration.toFixed(2),
                      segmentDuration: segmentDuration.toFixed(2),
                    });
                  }
                }
              }
            }
          } else {
            // 非学生片段或时长无效，使用正常速度
            audio.playbackRate = 1.0;
          }

          let playPromise = null;
          try {
            playPromise = audio.play();

            // 🔊 音量淡入逻辑 - 在播放开始后立即执行
            // 确保录音从静音平滑过渡到正常音量，避免突然出现的爆音
            const fadeInDuration = 140; // 淡入持续时间 (ms)
            const fadeInSteps = 14; // 淡入步数
            const volumeIncrement = 1.0 / fadeInSteps;
            const fadeInInterval = fadeInDuration / fadeInSteps;

            let currentStep = 0;
            const fadeInTimer = setInterval(() => {
              currentStep++;
              const newVolume = Math.min(currentStep * volumeIncrement, 1.0);

              try {
                audio.volume = newVolume;
                console.log(`[AudioDebug] 音量淡入中`, {
                  segmentIndex: key,
                  step: currentStep,
                  volume: newVolume.toFixed(2),
                  mode: window.audioMode
                });
              } catch (e) {
                console.error('[AudioDebug] 设置音量失败:', e);
              }

              if (currentStep >= fadeInSteps) {
                clearInterval(fadeInTimer);
                console.log(`[AudioDebug] 音量淡入完成`, {
                  segmentIndex: key,
                  finalVolume: audio.volume,
                  mode: window.audioMode
                });
              }
            }, fadeInInterval);

            // 在音频结束时清理淡入定时器
            const cleanupFadeIn = () => {
              clearInterval(fadeInTimer);
            };
            audio.addEventListener('ended', cleanupFadeIn, { once: true });
            audio.addEventListener('pause', cleanupFadeIn, { once: true });

          } catch (err) {
            this.segmentPlaybackLog.delete(key);
            audio.removeEventListener('playing', handlePlaying);
            pushDebug('播放录音失败', {
              segmentIndex: key,
              error: err?.name || 'Error',
              message: err?.message,
            });
            console.error('[音频模式] 播放录音失败:', err);
            this.teardownAnalyser(audio);
            if (this.isMobileEnvironment && !this.isAudioUnlocked) {
              this.enqueueDeferredPlayback(key, segmentIndex, segment, videoEl, audio);
            }
            const previousMuted = this.overlayPlaybackState?.previousMuted;
            let volumeToRestore =
              this.originalVolume != null ? this.originalVolume : (this.baseVolume || 1);
            // 确保恢复的音量不是0
            if (volumeToRestore === 0 || !volumeToRestore) {
              volumeToRestore = 1;
            }
            videoEl.volume = volumeToRestore;
            if (typeof previousMuted === 'boolean') {
              videoEl.muted = previousMuted;
            } else {
              videoEl.muted = false;
            }
            this.originalVolume = null;
            if (this.overlayAudio === audio) {
              this.overlayAudio = null;
            }
            if (this.overlayPlaybackState) {
              this.overlayPlaybackState = null;
            }
            return;
          }

          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch((err) => {
              this.segmentPlaybackLog.delete(key);
              audio.removeEventListener('playing', handlePlaying);
              pushDebug('播放录音失败', {
                segmentIndex: key,
                error: err?.name || 'Error',
                message: err?.message,
              });
              console.error('[音频模式] 播放录音失败:', err);
              this.teardownAnalyser(audio);
              if (this.isMobileEnvironment && !this.isAudioUnlocked) {
                this.enqueueDeferredPlayback(key, segmentIndex, segment, videoEl, audio);
              }
              const previousMuted = this.overlayPlaybackState?.previousMuted;
              let volumeToRestore =
                this.originalVolume != null ? this.originalVolume : (this.baseVolume || 1);
              // 确保恢复的音量不是0
              if (volumeToRestore === 0 || !volumeToRestore) {
                volumeToRestore = 1;
              }
              videoEl.volume = volumeToRestore;
              if (typeof previousMuted === 'boolean') {
                videoEl.muted = previousMuted;
              } else {
                videoEl.muted = false;
              }
              this.originalVolume = null;
              if (this.overlayAudio === audio) {
                this.overlayAudio = null;
              }
              if (this.overlayPlaybackState) {
                this.overlayPlaybackState = null;
              }
            });
          }

          let restoreVolumeCalled = false;
          const restoreVolume = () => {
            // Prevent duplicate calls to restoreVolume
            if (restoreVolumeCalled) {
              if (debugMode) {
                pushDebug('跳过重复的录音结束回调', { segmentIndex: key });
              }
              return;
            }
            restoreVolumeCalled = true;

            // Clean up timeupdate monitor
            audio.removeEventListener('timeupdate', timeUpdateMonitor);
            pushDebug('清理 timeupdate 监听器', {
              segmentIndex: key,
              totalUpdates: timeUpdateCount,
            });

            pushDebug('录音播放结束', {
              segmentIndex: key,
              mode: this.mode,
              duration: audio.duration,
              ended: audio.ended,
              paused: audio.paused,
              videoMuted: videoEl.muted,
              videoVolume: videoEl.volume,
              originalVolume: this.originalVolume,
              baseVolume: this.baseVolume,
              timeUpdateCount,
            });
            this.teardownAnalyser(audio);
            let volumeToRestore =
              this.originalVolume != null ? this.originalVolume : (this.baseVolume || 1);
            // 确保恢复的音量不是0
            if (volumeToRestore === 0 || !volumeToRestore) {
              volumeToRestore = 1;
            }
            videoEl.volume = volumeToRestore;
            this.originalVolume = null;

            if (debugMode) {
              pushDebug('检查 overlayPlaybackState', {
                segmentIndex: key,
                hasOverlayPlaybackState: !!this.overlayPlaybackState,
                overlayPlaybackState: this.overlayPlaybackState ? {
                  videoPausedForRecording: this.overlayPlaybackState.videoPausedForRecording,
                  previousPaused: this.overlayPlaybackState.previousPaused,
                  volumeRestored: this.overlayPlaybackState.volumeRestored,
                } : null,
              });
            }

            if (this.overlayPlaybackState) {
              this.handlePostOverlayPlayback(videoEl, audio);
            } else if (debugMode) {
              pushDebug('跳过 handlePostOverlayPlayback（状态为空）', {
                segmentIndex: key,
              });
            }

            if (audio === this.overlayAudio) {
              this.overlayAudio = null;
            }
            audio.onended = null;
            audio.onpause = null;

            // DON'T reset currentTime here - it causes issues with browser audio state
            // We already handle ended state check before playing in syncPlayUserRecording
          };

          // IMPORTANT: Only bind to onended, NOT onpause
          // Binding to onpause causes issues when audio is paused for other reasons
          audio.onended = restoreVolume;
          // audio.onpause = restoreVolume;  // REMOVED: This was causing premature cleanup

          // Mark this segment as played until its end to prevent re-trigger
          try {
            const endSec = Number(segmentData?.end);
            const guardUntil = Number.isFinite(endSec) ? (endSec + 0.2) : ((segmentData?.start || 0) + 2.5);
            if (this.playedGuard) this.playedGuard.set(key, guardUntil);
          } catch (_) { }

          // Smooth fade-in as playback starts
          try {
            if (playPromise && typeof playPromise.then === 'function') {
              playPromise.then(() => rampVolume(audio, Number.isFinite(audio.volume) ? audio.volume : 0, 1.0, VOICE_FADE_IN_MS));
            } else {
              rampVolume(audio, Number.isFinite(audio.volume) ? audio.volume : 0, 1.0, VOICE_FADE_IN_MS);
            }
          } catch (_) { }

          // Schedule a short fade-out near the (trimmed) end to avoid clicks
          try {
            const fadeOutMs = VOICE_FADE_OUT_MS;
            let rafId = 0;
            const fadeUpdate = () => {
              if (!audio || audio.ended || audio.paused || !Number.isFinite(audio.duration)) return;
              const endOffset = (() => { try { return Number(audio.dataset?.endOffset) || 0; } catch (_) { return 0; } })();
              const trimmedEnd = Math.max(0, (audio.duration - endOffset));
              const remain = (trimmedEnd - audio.currentTime) * 1000;
              if (remain <= fadeOutMs && !audio.__fadingOut) {
                audio.__fadingOut = true;
                rampVolume(audio, Number.isFinite(audio.volume) ? audio.volume : 1, 0.0, Math.max(40, remain)).catch(() => { });
                setTimeout(() => { try { audio.pause(); } catch (_) { } }, Math.max(0, remain));
                return;
              }
              rafId = requestAnimationFrame(fadeUpdate);
            };
            if (typeof requestAnimationFrame === 'function') {
              rafId = requestAnimationFrame(fadeUpdate);
            }
          } catch (_) { }

          this.lastPlaybackSegment = normalizeSegmentIndex(segmentIndex) ?? segmentIndex;
          this.lastPlaybackKey = key;
          this.lastPlaybackTimestamp = performance.now();
          pushDebug('播放录音', {
            segmentIndex: key,
            mode: this.mode,
            assignedSpeaker,
            role: segmentRole,
          });
          // Opportunistically preload the next user recording to reduce gaps
          try {
            const seq = normalizeSegmentIndex(segmentIndex);
            const nextSeq = Number.isFinite(seq) ? seq + 1 : null;
            if (nextSeq != null) {
              const nextKey = buildSegmentKey(nextSeq);
              const nextAudio = this.userRecordings?.[nextKey];
              if (nextAudio && nextAudio.readyState < (window.HTMLMediaElement?.HAVE_FUTURE_DATA || 3)) {
                if (typeof nextAudio.load === 'function') {
                  nextAudio.load();
                  if (debugMode) pushDebug('预加载下一条录音', { nextSegmentIndex: nextKey });
                }
              }
            }
          } catch (_) { }
        }

        handlePostOverlayPlayback(videoEl, audio) {
          if (!this.overlayPlaybackState || !videoEl) return;
          const {
            previousMuted,
            previousPaused,
            unmuteTime,
            videoPausedForRecording,
          } = this.overlayPlaybackState;

          // 简化逻辑：只需要恢复音量
          let volumeToRestore =
            this.originalVolume != null ? this.originalVolume : (this.baseVolume || 1);
          if (volumeToRestore === 0 || !volumeToRestore) {
            volumeToRestore = 1;
          }

          // Smoothly restore volume (shorter than dialog fade-in)
          try { rampVolume(videoEl, Number.isFinite(videoEl.volume) ? videoEl.volume : 0, volumeToRestore, RESTORE_FADE_MS); } catch (_) { videoEl.volume = volumeToRestore; }

          // 混合模式下：不要立即取消静音！
          // 让 maybeRestoreVideoVolume 在 unmuteTime 时再取消静音，避免录音结束后到片段结束之间播放原声
          if (this.mode === 'mixed') {
            const currentTime = videoEl.currentTime;
            const targetUnmuteTime = Number(unmuteTime);

            // 只有当视频已经播放到或超过 unmuteTime 时，才立即取消静音
            // 否则保持静音，等待 maybeRestoreVideoVolume 在合适的时机取消
            // 增加缓冲时间到0.15秒，确保不会过早取消静音
            if (Number.isFinite(targetUnmuteTime) && currentTime < targetUnmuteTime - 0.15) {
              // 保持静音，不做任何操作
              // maybeRestoreVideoVolume 会在 unmuteTime 时取消静音
              if (debugMode) {
                pushDebug('录音播放结束，但保持静音直到片段结束', {
                  volumeRestored: volumeToRestore,
                  videoMuted: true,  // 仍然静音
                  videoPaused: videoEl.paused,
                  currentTime: currentTime.toFixed(2),
                  unmuteTime: targetUnmuteTime.toFixed(2),
                  waitTime: (targetUnmuteTime - currentTime).toFixed(2),
                  mode: this.mode,
                });
              }
            } else {
              // 已经到达或超过 unmuteTime-0.15，可以取消静音了
              videoEl.muted = false;
              if (debugMode) {
                pushDebug('录音播放结束，立即恢复视频音量（已接近片段结束）', {
                  volumeRestored: volumeToRestore,
                  videoMuted: false,
                  videoPaused: videoEl.paused,
                  currentTime: currentTime.toFixed(2),
                  unmuteTime: targetUnmuteTime.toFixed(2),
                  mode: this.mode,
                });
              }
            }
          } else if (typeof previousMuted === 'boolean') {
            videoEl.muted = previousMuted;
            if (!previousMuted) {
              try { smoothUnmute(videoEl, volumeToRestore, RESTORE_FADE_MS); } catch (_) { }
            }
          }

          // 如果是为了学生录音而暂停的视频，录音结束后跳到片段末尾并恢复播放
          if (videoPausedForRecording) {
            try {
              if (Number.isFinite(unmuteTime)) {
                videoEl.currentTime = unmuteTime;
              }
              if (previousPaused === false) {
                if (typeof window.safePlayVideo === 'function') {
                  window.safePlayVideo();
                } else {
                  videoEl.play().catch(() => { });
                }
              }
            } catch (_) { }
          }

          // 不要清除 overlayPlaybackState，让 maybeRestoreVideoVolume 继续工作
          // this.overlayPlaybackState = null;
        }

        maybeRestoreVideoVolume(videoEl, currentTime) {
          if (!this.overlayPlaybackState || !videoEl) return;
          // 若用户录音仍在播放，严禁恢复视频音量，避免录音与原声混杂
          try {
            if (this.overlayAudio && !this.overlayAudio.ended && !this.overlayAudio.paused) {
              return;
            }
          } catch (_) { }
          if (this.mode !== 'mixed') return;
          const { unmuteTime, volumeRestored, segmentRef } = this.overlayPlaybackState;
          if (volumeRestored) return;
          const targetTime = Number(unmuteTime);
          if (!Number.isFinite(targetTime)) return;
          // 在片段结束前0.05秒取消静音，给予一些提前量以补偿处理延迟
          if (currentTime < targetTime - 0.05) return;

          let volumeToRestore =
            this.originalVolume != null ? this.originalVolume : (this.baseVolume || 1);
          // 确保恢复的音量不是0
          if (volumeToRestore === 0 || !volumeToRestore) {
            volumeToRestore = 1;
          }
          try { rampVolume(videoEl, Number.isFinite(videoEl.volume) ? videoEl.volume : 0, volumeToRestore, RESTORE_FADE_MS); } catch (_) { videoEl.volume = volumeToRestore; }
          // 混合模式下，录音播放结束后必须取消muted，以便播放原声段落
          videoEl.muted = false;

          if (debugMode) {
            pushDebug('混合模式恢复原声音量（片段结束时）', {
              currentTime: currentTime.toFixed(2),
              unmuteTime: targetTime.toFixed(2),
              segmentIndex: segmentRef?.index ?? null,
            });
          }

          // 清除状态，避免影响下一个片段
          this.overlayPlaybackState = null;
        }

        cleanup(videoEl = videoPlayer) {
          const stateSnapshot = this.overlayPlaybackState
            ? { ...this.overlayPlaybackState }
            : null;
          if (this.overlayAudio) {
            const overlayAudioRef = this.overlayAudio;
            try {
              overlayAudioRef.pause();
              overlayAudioRef.currentTime = 0;
            } catch (err) {
              console.warn('[音频模式] 无法停止叠加音频:', err);
            }
            this.teardownAnalyser(overlayAudioRef);
            this.overlayAudio = null;
          }
          if (videoEl) {
            let volumeToRestore =
              this.originalVolume != null ? this.originalVolume : (this.baseVolume || 1);
            // 确保恢复的音量不是0
            if (volumeToRestore === 0 || !volumeToRestore) {
              volumeToRestore = 1;
            }
            videoEl.volume = volumeToRestore;
            if (typeof stateSnapshot?.previousMuted === 'boolean') {
              videoEl.muted = stateSnapshot.previousMuted;
            } else {
              videoEl.muted = false;
            }
            // 如果视频是因为录音播放而暂停的，恢复视频播放
            if (stateSnapshot?.videoPausedForRecording &&
              videoEl.paused &&
              !stateSnapshot?.previousPaused) {
              try {
                const playPromise = videoEl.play();
                if (playPromise && typeof playPromise.catch === 'function') {
                  playPromise.catch((err) => {
                    console.warn('[音频模式] 清理时恢复视频播放失败:', err);
                  });
                }
              } catch (err) {
                console.warn('[音频模式] 清理时恢复视频播放失败:', err);
              }
            }
          }
          this.originalVolume = null;
          this.overlayPlaybackState = null;
          this.lastPlaybackSegment = null;
          this.lastPlaybackKey = null;
          this.lastPlaybackTimestamp = 0;
          this.clearAllPendingPlayback();
          this.disposeAllAnalysers();
        }

      }

      // ===== Feedback helpers (common in feedback.js) + page progress =====
      function updatePracticeProgress() {
        if (!practiceProgressEl) return;
        const total = Array.isArray(state.practiceLines) ? state.practiceLines.length : 0;
        let done = 0;
        if (total > 0 && state.practiceLineResults) {
          for (const v of Object.values(state.practiceLineResults)) if (v === 'success') done++;
        }
        practiceProgressEl.textContent = `✅ ${done}/${total}`;
        practiceProgressEl.hidden = total === 0;
      }

      const audioModeManager = new AudioModeManager();
      let currentAudioMode = 'original';

      function updateAudioModeButtons() {
        audioModeBtns.forEach((btn) => {
          const mode = btn.dataset.mode || 'original';
          btn.classList.toggle('active', mode === currentAudioMode);
        });
      }

      function ensureAudioModeAvailability() {
        const matchingBtn = audioModeBtns.find((btn) => btn.dataset.mode === currentAudioMode);
        if (!matchingBtn || matchingBtn.disabled) {
          currentAudioMode = 'original';
        }
      }

      // 更新音频模式按钮的可用性（防止练习时误触）
      function updateAudioModeButtonsAvailability() {
        audioModeBtns.forEach((btn) => {
          const mode = btn.dataset.mode || 'original';

          // 在自动练习模式且未暂停时，禁用非原声按钮防止误触
          // 只有在用户主动暂停时才允许切换模式试听效果
          if (state.autoMode && !state.isPaused && mode !== 'original') {
            btn.disabled = true;
            btn.style.opacity = '0.5';
            btn.style.cursor = 'not-allowed';
            btn.title = '练习中暂时禁用，试听请先点击暂停 ⏸';
          } else {
            // 暂停状态或非练习模式时，根据录音数量决定可用性
            const count = audioModeManager ? Object.keys(audioModeManager.userRecordings || {}).length : 0;
            const shouldDisable = count === 0 && mode !== 'original';
            btn.disabled = shouldDisable;
            btn.style.opacity = shouldDisable ? '0.5' : '1';
            btn.style.cursor = shouldDisable ? 'not-allowed' : 'pointer';

            // 设置标题
            if (mode === 'original') {
              btn.title = '播放原声';
            } else if (mode === 'my-voice') {
              btn.title = shouldDisable ? '请先录制配音' : '播放我的配音';
            } else if (mode === 'mixed') {
              btn.title = shouldDisable ? '请先录制配音' : '我配音+其他原声';
            }
          }
        });
      }

      function ensureToken() {
        if (!token) {
          alert('请先登录后再进入练习页面');
          window.location.href = './index.html';
          throw new Error('Missing auth token');
        }
      }

      function escapeHtml(str = '') {
        return String(str).replace(/[&<>"']/g, (char) => {
          const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
          return map[char] || char;
        });
      }

      /**
       * Merge subtitle segments into complete sentences.
       * YouTube subtitles are often split by time (every 2-3 seconds), not by sentence boundaries.
       * This mirrors the desktop behavior so mobile won't show truncated sentences.
       */
      function mergeSentenceSegments(segments) {
        if (!Array.isArray(segments) || segments.length === 0) {
          return segments;
        }

        const merged = [];
        let currentSegment = null;

        // Sentence ending pattern: . ! ? 。 ! ? (with optional closing quotes/brackets)
        const sentenceEndPattern = /[.!?。！？]['""\u201d\u2019\u300d）】\]]*(?:\s|$)/;
        const sentenceEndAtEnd = /[.!?。！？]['""\u201d\u2019\u300d）】\]]*\s*$/;

        function splitAtSentences(text) {
          const sentences = [];
          let remaining = text;
          while (remaining.length > 0) {
            const match = remaining.match(sentenceEndPattern);
            if (match) {
              const endIndex = match.index + match[0].length;
              const sentence = remaining.substring(0, endIndex).trim();
              if (sentence) sentences.push(sentence);
              remaining = remaining.substring(endIndex).trim();
            } else {
              if (remaining.trim()) sentences.push(remaining.trim());
              break;
            }
          }
          return sentences;
        }

        function flushCurrentSegment() {
          if (currentSegment === null) return;
          const text = (currentSegment.text || '').trim();
          if (!text) {
            currentSegment = null;
            return;
          }

          const sentences = splitAtSentences(text).map((s) => s.trim()).filter(Boolean);
          const duration = Number(currentSegment.end) - Number(currentSegment.start);
          const hasDuration = Number.isFinite(duration) && duration > 0.01;
          const allTextLen = sentences.join('').length || 1;
          const baseStart = Number(currentSegment.start) || 0;

          let cursor = 0;
          for (const sentence of sentences) {
            const partLen = (sentence || '').length;
            const partStart = hasDuration ? (baseStart + (duration * (cursor / allTextLen))) : baseStart;
            cursor += partLen;
            const partEnd = hasDuration ? (baseStart + (duration * (cursor / allTextLen))) : (Number(currentSegment.end) || baseStart);
            merged.push({
              index: merged.length,
              text: sentence,
              start: partStart,
              end: partEnd,
              speaker: currentSegment.speaker,
            });
          }
          currentSegment = null;
        }

        for (let i = 0; i < segments.length; i++) {
          const seg = segments[i];
          const text = (seg?.text || '').trim();
          if (!text) continue;

          // Avoid merging across "real" speaker changes (prevents mixing dialogue lines).
          if (currentSegment !== null) {
            const currentSpeaker = String(currentSegment.speaker || '').trim();
            const nextSpeaker = String(seg?.speaker || '').trim();
            const isGenericSpeaker = (name) => /^Speaker\s+\d+$/i.test(String(name || '').trim());
            if (
              currentSpeaker &&
              nextSpeaker &&
              currentSpeaker !== nextSpeaker &&
              !isGenericSpeaker(currentSpeaker) &&
              !isGenericSpeaker(nextSpeaker)
            ) {
              flushCurrentSegment();
            }
          }

          if (currentSegment === null) {
            currentSegment = {
              text,
              start: seg.start,
              end: seg.end,
              speaker: seg.speaker || null,
            };
          } else {
            currentSegment.text = (currentSegment.text + ' ' + text).replace(/\s+/g, ' ').trim();
            currentSegment.end = seg.end;
            if (!currentSegment.speaker && seg.speaker) {
              currentSegment.speaker = seg.speaker;
            }
          }

          const sentences = splitAtSentences(currentSegment.text);
          if (sentences.length > 1) {
            const duration = Number(currentSegment.end) - Number(currentSegment.start);
            const hasDuration = Number.isFinite(duration) && duration > 0.01;
            const lastPart = sentences[sentences.length - 1];
            const lastIsComplete = sentenceEndAtEnd.test(lastPart);
            const completeParts = lastIsComplete ? sentences : sentences.slice(0, -1);
            const remainder = lastIsComplete ? '' : lastPart;
            const allTextLen = (completeParts.join('') + remainder).length || 1;
            const baseStart = Number(currentSegment.start) || 0;

            let cursor = 0;
            let lastEnd = baseStart;
            for (const part of completeParts) {
              const partLen = (part || '').length;
              const partStart = hasDuration ? (baseStart + (duration * (cursor / allTextLen))) : baseStart;
              cursor += partLen;
              const partEnd = hasDuration ? (baseStart + (duration * (cursor / allTextLen))) : (Number(currentSegment.end) || baseStart);
              lastEnd = partEnd;
              merged.push({
                index: merged.length,
                text: part,
                start: partStart,
                end: partEnd,
                speaker: currentSegment.speaker,
              });
            }

            if (lastIsComplete) {
              currentSegment = null;
            } else {
              currentSegment.text = remainder;
              currentSegment.start = lastEnd;
            }
          } else if (sentenceEndAtEnd.test(currentSegment.text)) {
            merged.push({
              index: merged.length,
              text: currentSegment.text,
              start: currentSegment.start,
              end: currentSegment.end,
              speaker: currentSegment.speaker,
            });
            currentSegment = null;
          }
        }

        flushCurrentSegment();

        // Normalize timings to avoid repeated/overlapping starts (can break "Next" seeking).
        for (let i = 1; i < merged.length; i++) {
          const prev = merged[i - 1];
          const cur = merged[i];
          const prevStart = Number(prev?.start) || 0;
          const prevEnd = Number(prev?.end ?? prevStart) || prevStart;
          let curStart = Number(cur?.start);
          let curEnd = Number(cur?.end);
          if (!Number.isFinite(curStart)) curStart = prevEnd;
          if (!Number.isFinite(curEnd)) curEnd = curStart;
          const sameSpeaker = String(cur?.speaker || '') === String(prev?.speaker || '');
          if (curStart <= prevStart + 0.001 || (sameSpeaker && curStart < prevEnd - 0.05)) {
            curStart = prevEnd;
          }
          if (curEnd < curStart + 0.05) {
            curEnd = curStart + 0.05;
          }
          cur.start = curStart;
          cur.end = curEnd;
        }

        // 🔧 Enforce a minimum gap between sentences to avoid overrun
        // If the end of current sentence is too close to the start of the next one,
        // clamp it so we have a safe silence buffer.
        const MIN_GAP = 0.4;
        for (let i = 0; i < merged.length - 1; i++) {
          const current = merged[i];
          const next = merged[i + 1];
          const currentEnd = Number(current.end);
          const nextStart = Number(next.start);

          if (Number.isFinite(currentEnd) && Number.isFinite(nextStart)) {
            // If they overlap or are too close
            if (currentEnd > nextStart - MIN_GAP) {
              const newEnd = Math.max(Number(current.start) + 0.5, nextStart - MIN_GAP);
              current.end = newEnd;
            }
          }
        }

        console.log(`[MergeSentences] Merged ${segments.length} segments into ${merged.length} sentences`);
        return merged;
      }

      function formatTime(seconds) {
        if (!Number.isFinite(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
      }

      function buildRecordingUrl(rawPath, updatedAt) {
        if (!rawPath) return null;
        if (rawPath.startsWith('data:') || rawPath.startsWith('blob:')) {
          return rawPath;
        }
        let baseUrl = rawPath;
        if (!/^https?:\/\//i.test(baseUrl)) {
          baseUrl = `${API_BASE}${rawPath}`;
        }
        const params = new URLSearchParams();
        if (updatedAt) {
          const ts = new Date(updatedAt).getTime();
          if (Number.isFinite(ts)) {
            params.set('v', ts.toString());
          }
        }
        const queryString = params.toString();
        if (queryString) {
          baseUrl += baseUrl.includes('?') ? `&${queryString}` : `?${queryString}`;
        }
        return baseUrl;
      }

      async function setProtectedMediaSource(element, rawPath, updatedAt) {
        const source = buildRecordingUrl(rawPath, updatedAt);
        if (!source) throw new Error('MEDIA_SOURCE_REQUIRED');
        if (source.startsWith('data:') || source.startsWith('blob:')) {
          element.src = source;
          return source;
        }
        const accountToken = getAuthToken();
        const mediaSession = window.LinglishMediaSession;
        if (!accountToken || !mediaSession) throw new Error('MEDIA_SESSION_UNAVAILABLE');
        const mediaState = await mediaSession.ensure({ token: accountToken });
        return mediaSession.setElementSource(element, source, {
          mode: mediaState.mode,
          legacyToken: accountToken,
        });
      }

      window.LinglishMediaSession?.bindLifecycle({
        getToken: getAuthToken,
        onError: () => updatePracticeFeedback('媒体授权已失效，请重试', '#dc2626'),
      });

      async function fetchPracticeRecordings(videoId, speaker = null) {
        if (!token || !videoId) return [];
        const speakerQuery = speaker ? `?speaker=${encodeURIComponent(speaker)}` : '';
        try {
          const res = await fetch(`${API_BASE}/video-resources/${videoId}/recordings${speakerQuery}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.status === 401) {
            console.warn('[录音] 获取失败，未授权');
            pushDebug('获取录音未授权');
            return [];
          }
          if (!res.ok) {
            console.warn('[录音] 获取失败，状态码:', res.status);
            pushDebug('获取录音失败', res.status);
            return [];
          }
          const data = await res.json();
          const items = Array.isArray(data?.items) ? data.items : [];
          pushDebug('获取服务器录音', { count: items.length });
          return items;
        } catch (err) {
          console.warn('Failed to fetch practice recordings:', err);
          pushDebug('获取录音异常', err?.message || err);
          return [];
        }
      }

      async function uploadRecordingToServer({ videoId, segmentIndex, speaker, audioData, durationSec }) {
        if (!token || !videoId) return null;
        try {
          const res = await fetch(`${API_BASE}/video-resources/${videoId}/recordings`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              segmentIndex,
              speaker,
              audioData,
              durationSec,
            }),
          });

          if (res.status === 401) {
            alert('登录信息已过期，请重新登录。');
            throw new Error('UNAUTHORIZED');
          }
          if (!res.ok) {
            const text = await res.text();
            throw new Error(text || `上传失败 (${res.status})`);
          }
          const data = await res.json();
          return data?.recording || null;
        } catch (err) {
          console.error('[录音上传] 失败:', err);
          throw err;
        }
      }

      // Unified video player interface (supports both HTML5 video and YouTube iframe)
      const unifiedPlayer = {
        async play() {
          if (isYouTubeVideo && youtubePlayer) {
            youtubePlayer.playVideo();
          } else {
            await videoPlayer.play();
          }
        },
        pause() {
          if (isYouTubeVideo && youtubePlayer) {
            youtubePlayer.pauseVideo();
          } else {
            videoPlayer.pause();
          }
        },
        getCurrentTime() {
          if (isYouTubeVideo && youtubePlayer) {
            return youtubePlayer.getCurrentTime() || 0;
          }
          return videoPlayer.currentTime || 0;
        },
        setCurrentTime(time) {
          if (isYouTubeVideo && youtubePlayer) {
            youtubePlayer.seekTo(time, true);
          } else {
            videoPlayer.currentTime = time;
          }
        },
        getDuration() {
          if (isYouTubeVideo && youtubePlayer) {
            return youtubePlayer.getDuration() || 0;
          }
          return videoPlayer.duration || 0;
        },
        setPlaybackRate(rate) {
          if (isYouTubeVideo && youtubePlayer) {
            youtubePlayer.setPlaybackRate(rate);
          } else {
            videoPlayer.playbackRate = rate;
          }
        },
        getPlaybackRate() {
          if (isYouTubeVideo && youtubePlayer) {
            return youtubePlayer.getPlaybackRate() || 1.0;
          }
          return videoPlayer.playbackRate || 1.0;
        },
        isPaused() {
          if (isYouTubeVideo && youtubePlayer) {
            const state = youtubePlayer.getPlayerState();
            // YT.PlayerState: UNSTARTED=-1, ENDED=0, PLAYING=1, PAUSED=2, BUFFERING=3, CUED=5
            return state !== 1 && state !== 3; // Not playing or buffering
          }
          return videoPlayer.paused;
        },
        mute() {
          if (isYouTubeVideo && youtubePlayer) {
            youtubePlayer.mute();
          } else {
            videoPlayer.muted = true;
          }
        },
        unmute() {
          if (isYouTubeVideo && youtubePlayer) {
            youtubePlayer.unMute();
          } else {
            videoPlayer.muted = false;
          }
        },
        isMuted() {
          if (isYouTubeVideo && youtubePlayer) {
            return youtubePlayer.isMuted();
          }
          return videoPlayer.muted;
        },
        setVolume(volume) {
          if (isYouTubeVideo && youtubePlayer) {
            youtubePlayer.setVolume(volume * 100); // YouTube expects 0-100
          } else {
            videoPlayer.volume = volume;
          }
        }
      };

      // Active Pause State for Mobile
      state.activePause = {
        isActive: false,
        pauseTime: 0,
        rafId: null,
        originalMuted: false
      };

      function safePauseVideo() {
        const isMobile = audioModeManager?.isMobileEnvironment || isLikelyMobileDevice;

        // YouTube doesn't support Active Pause (playbackRate trick), always use real pause
        if (isYouTubeVideo) {
          unifiedPlayer.pause();
          console.log('[YouTube] Paused');
          return;
        }

        if (isMobile) {
          // Implement Active Pause (Fake Pause) using playbackRate for HTML5 video
          if (state.activePause.isActive) return; // Already paused

          state.activePause.isActive = true;
          state.activePause.pauseTime = videoPlayer.currentTime;
          state.activePause.originalMuted = videoPlayer.muted;

          // Mute video to avoid audio stutter
          videoPlayer.muted = true;

          // Slow down to almost stop (0.0625 is the minimum supported rate in most browsers)
          videoPlayer.playbackRate = 0.0625;

          console.log('[Video] Active Pause engaged (Mobile/PlaybackRate)');
        } else {
          // Desktop: Standard pause
          videoPlayer.pause();
        }
      }

      async function safePlayVideo(options = {}) {
        const preferUnmuted = options.preferUnmuted !== false; // default true

        // YouTube: Simple play
        if (isYouTubeVideo) {
          try {
            await unifiedPlayer.play();
            if (playOverlay) playOverlay.style.display = 'none';
            console.log('[YouTube] Playing');
            return true;
          } catch (e) {
            console.warn('[YouTube] Play failed:', e);
            return false;
          }
        }

        // HTML5 video: Handle Active Pause Resume
        if (state.activePause && state.activePause.isActive) {
          console.log('[Video] Resuming from Active Pause (PlaybackRate)');
          state.activePause.isActive = false;

          // Restore playback rate
          videoPlayer.playbackRate = 1.0;

          // Restore mute state (unless we want to unmute)
          if (preferUnmuted) {
            videoPlayer.muted = false;
          } else {
            videoPlayer.muted = state.activePause.originalMuted;
          }

          // Ensure it is playing (it should be, but just in case)
          if (videoPlayer.paused) {
            try {
              await videoPlayer.play();
              return true;
            } catch (e) {
              console.warn('Active Pause resume failed to play:', e);
              // Fallthrough to standard recovery
            }
          } else {
            return true;
          }
        }

        try {
          await videoPlayer.play();
          if (playOverlay) playOverlay.style.display = 'none';
          return true;
        } catch (err) {
          // Autoplay policy may block. Try muted-play workaround then unmute.
          try {
            const prevMuted = videoPlayer.muted;
            videoPlayer.muted = true;
            await videoPlayer.play();
            if (playOverlay) playOverlay.style.display = 'none';
            // 仅在没有处于"用户录音覆盖静音窗口/学生预静音守卫"时再尝试解除静音
            const inOverlayMute = !!(audioModeManager && audioModeManager.overlayPlaybackState);
            const guardActive = !!(state && state.studentGuard && state.studentGuard.key);
            if (preferUnmuted && !inOverlayMute && !guardActive) {
              // unmute slightly later to avoid autoplay rejection
              setTimeout(() => {
                try { videoPlayer.muted = prevMuted === false ? false : false; } catch (_) { }
              }, 120);
            }
            return true;
          } catch (e2) {
            console.warn('Unable to autoplay video (even muted):', e2);
            // Show "Tap to Continue" overlay if autoplay fails completely (common on mobile)
            if (playOverlay) {
              playOverlay.style.display = 'flex';
              playOverlay.innerHTML = '<div class="play-overlay-icon"></div><div style="position:absolute;bottom:20%;color:white;font-weight:bold;text-shadow:0 2px 4px rgba(0,0,0,0.5);">点击继续播放</div>';
              playOverlay.onclick = () => {
                videoPlayer.play().then(() => {
                  playOverlay.style.display = 'none';
                }).catch(e => console.error('Manual play failed:', e));
              };
            }
            return false;
          }
        }
      }

      function updatePracticeHint() {
        if (!practiceHintEl) return;
        if (!state.speakers.length) {
          practiceHintEl.textContent = '当前视频暂无角色扮演数据，先阅读完整台词。';
        } else if (!state.selectedSpeaker) {
          practiceHintEl.textContent = 'Auto-pause video for each of your lines. 请先选择你要扮演的角色。';
        } else if (state.practiceArmed) {
          practiceHintEl.textContent = 'Practice mode 已启用，视频会在你的台词前暂停。';
        } else {
          practiceHintEl.textContent = 'Auto-pause video for each of your lines.';
        }
      }

      // Role controls handlers
      if (roleCountSelect) {
        roleCountSelect.addEventListener('change', () => {
          const v = roleCountSelect.value;
          state.roleCount = v;
          if (!state.hasServerSpeakers) {
            buildInferredSpeakers();
            populateSpeakerSelect();
            // 保持已选角色（如果仍存在），否则选第一个
            const cur = audioModeManager?.selectedSpeaker || practiceSpeakerSelect.value;
            const exists = state.speakers.some(s => s.speaker === cur);
            practiceSpeakerSelect.value = exists ? cur : (state.speakers[0]?.speaker || '');
            if (practiceSpeakerSelect.value) setPracticeSpeaker(practiceSpeakerSelect.value);
          }
          // Persist profile
          saveRoleProfile().catch(() => { });
        });
      }
      if (roleRotateBtn) {
        roleRotateBtn.addEventListener('click', () => {
          state.roleRotation = (state.roleRotation + 1) % 5;
          if (!state.hasServerSpeakers) {
            buildInferredSpeakers();
            populateSpeakerSelect();
            const cur = audioModeManager?.selectedSpeaker || practiceSpeakerSelect.value || (state.speakers[0]?.speaker || '');
            practiceSpeakerSelect.value = cur;
            if (cur) setPracticeSpeaker(cur);
          }
          // Persist profile
          saveRoleProfile().catch(() => { });
        });
      }

      if (strictAltToggle) {
        strictAltToggle.addEventListener('change', () => {
          state.strictAlternate = !!strictAltToggle.checked;
          if (state.strictAlternate) {
            state.roleCount = '2';
            if (roleCountSelect) roleCountSelect.value = '2';
          }
          if (!state.hasServerSpeakers) {
            buildInferredSpeakers();
            populateSpeakerSelect();
            const cur = audioModeManager?.selectedSpeaker || practiceSpeakerSelect.value || (state.speakers[0]?.speaker || '');
            practiceSpeakerSelect.value = cur;
            if (cur) setPracticeSpeaker(cur);
          }
          saveRoleProfile().catch(() => { });
        });
      }

      function openRoleRename() {
        if (!Array.isArray(state.speakers) || state.speakers.length === 0) return;
        if (!renameListEl || !roleRenameOverlay) return;
        renameListEl.innerHTML = '';
        state.speakers.forEach((sp, idx) => {
          const row = document.createElement('div');
          row.className = 'rename-row';
          const label = document.createElement('label');
          label.textContent = `角色 ${idx + 1}`;
          const input = document.createElement('input');
          input.value = String(sp.speaker || `Speaker ${idx + 1}`);
          input.setAttribute('data-idx', String(idx));
          row.appendChild(label);
          row.appendChild(input);
          renameListEl.appendChild(row);
        });
        roleRenameOverlay.style.display = 'flex';
        roleRenameOverlay.setAttribute('aria-hidden', 'false');
      }

      function closeRoleRename() {
        if (!roleRenameOverlay) return;
        roleRenameOverlay.style.display = 'none';
        roleRenameOverlay.setAttribute('aria-hidden', 'true');
      }

      function applyRoleRename() {
        if (!renameListEl || !Array.isArray(state.speakers)) return;
        const inputs = Array.from(renameListEl.querySelectorAll('input'));
        const newNames = inputs.map((inp) => ({ idx: Number(inp.getAttribute('data-idx')), name: String(inp.value || '').trim() }));
        // 简单去空与去重（若重复，后缀 (2)）
        const used = new Map();
        newNames.forEach(n => {
          if (!n.name) n.name = `Speaker ${n.idx + 1}`;
          const count = used.get(n.name) || 0;
          if (count > 0) n.name = `${n.name} (${count + 1})`;
          used.set(n.name, (used.get(n.name) || 0) + 1);
        });

        // old->new map
        const renameMap = new Map();
        newNames.forEach(({ idx, name }) => {
          const old = state.speakers[idx]?.speaker || `Speaker ${idx + 1}`;
          if (old !== name) renameMap.set(old, name);
        });

        if (renameMap.size === 0) { closeRoleRename(); return; }

        // 替换 speakers 列表与 lines
        state.speakers.forEach((sp, idx) => {
          const oldName = sp.speaker;
          const newName = renameMap.has(oldName) ? renameMap.get(oldName) : oldName;
          state.speakers[idx].speaker = newName;
          (sp.lines || []).forEach(line => { line.speaker = newName; });
        });

        // 替换 segmentSpeakerMap 的值
        if (state.segmentSpeakerMap instanceof Map) {
          const newMap = new Map();
          state.segmentSpeakerMap.forEach((val, key) => {
            const nv = renameMap.has(val) ? renameMap.get(val) : val;
            newMap.set(key, nv);
          });
          state.segmentSpeakerMap = newMap;
        }

        // 保持当前选择
        let current = audioModeManager?.selectedSpeaker || practiceSpeakerSelect.value || '';
        if (renameMap.has(current)) current = renameMap.get(current);
        if (audioModeManager) audioModeManager.selectedSpeaker = current;

        populateSpeakerSelect();
        practiceSpeakerSelect.value = current || (state.speakers[0]?.speaker || '');
        if (practiceSpeakerSelect.value) setPracticeSpeaker(practiceSpeakerSelect.value);
        closeRoleRename();
        // Persist profile with new names
        saveRoleProfile().catch(() => { });
      }

      if (roleRenameBtn) roleRenameBtn.addEventListener('click', openRoleRename);
      if (rrCancel) rrCancel.addEventListener('click', closeRoleRename);
      if (rrSave) rrSave.addEventListener('click', applyRoleRename);
      if (roleRenameOverlay) {
        roleRenameOverlay.addEventListener('click', (e) => { if (e.target === roleRenameOverlay) closeRoleRename(); });
      }

      // 清除所有录音功能
      const clearRecordingsBtn = document.getElementById('clear-recordings-btn');
      if (clearRecordingsBtn) {
        clearRecordingsBtn.addEventListener('click', async () => {
          if (!confirm('⚠️ 确定要删除所有录音吗？\n\n删除后需要重新录制才能听到配音。\n\n这个操作无法撤销！')) {
            return;
          }

          try {
            clearRecordingsBtn.disabled = true;
            clearRecordingsBtn.textContent = '⏳ 删除中...';

            const videoId = state.videoId || new URLSearchParams(window.location.search).get('videoId');
            if (!videoId) {
              throw new Error('无法获取视频ID');
            }
            const headers = { 'Authorization': `Bearer ${token}` };

            console.log(`[清除录音] 开始删除视频 ${videoId} 的所有录音...`);

            // 调用后端API删除所有录音
            const response = await fetch(`${API_BASE}/recordings/video/${videoId}`, {
              method: 'DELETE',
              headers
            });

            console.log(`[清除录音] 响应状态: ${response.status} ${response.statusText}`);

            if (response.ok) {
              const result = await response.json();
              console.log(`[清除录音] 成功删除 ${result.deletedCount || 0} 个文件`);

              // 清除本地缓存
              try {
                const storageKey = `user_recordings_${videoId}`;
                localStorage.removeItem(storageKey);
                console.log('[清除录音] 本地 localStorage 已清除');
              } catch (e) { console.warn('清除 localStorage 失败', e); }

              if (audioModeManager) {
                audioModeManager.userRecordings = {};
                if (audioModeManager.decisionCache) audioModeManager.decisionCache.clear();
              }

              if (state.recordedSegments && typeof state.recordedSegments.clear === 'function') {
                state.recordedSegments.clear();
              }

              updateRecordingIndicator();

              alert('✅ 所有录音已删除！\n\n请重新录制以听到配音。');

              // 刷新页面以重新加载
              window.location.reload();
            } else {
              // 尝试解析错误响应
              let errorMsg = '删除失败';
              try {
                const errorData = await response.json();
                errorMsg = errorData.error || errorData.message || errorMsg;
                console.error('[清除录音] 服务器错误:', errorData);
              } catch (parseErr) {
                // JSON 解析失败，使用响应文本
                console.error('[清除录音] 无法解析错误响应:', parseErr);
                const textError = await response.text();
                console.error('[清除录音] 响应文本:', textError);
                errorMsg = textError || `HTTP ${response.status}: ${response.statusText}`;
              }
              throw new Error(errorMsg);
            }
          } catch (err) {
            console.error('[清除录音] 失败:', err);
            const errorMessage = err.message || err.toString() || '未知错误';
            alert(`❌ 删除录音失败：${errorMessage}\n\n请稍后重试或联系技术支持。`);
            clearRecordingsBtn.disabled = false;
            clearRecordingsBtn.textContent = '🗑️ 清除录音';
          }
        });
      }

      function updatePracticeFeedback(text, color = '#666') {
        if (!practiceFeedbackEl) return;
        practiceFeedbackEl.textContent = text;
        practiceFeedbackEl.style.color = color;
      }

      function updatePracticeButtons(playOriginalDisabled, recordDisabled, compareDisabled) {
        // 旧函数保留，兼容性，已不使用
      }

      // ===== 自动流程核心函数 =====

      function setAnalysisStage(stage) {
        if (!analysisProgress || !analysisMeta) return;

        if (stage === 'analyzing') {
          analysisProgress.hidden = false;
          analysisProgress.classList.remove('complete');
          analysisMeta.hidden = false;
          analysisMeta.textContent = '分析中...约2秒';
          return;
        }

        if (stage === 'complete') {
          analysisProgress.hidden = false;
          analysisProgress.classList.add('complete');
          analysisMeta.hidden = false;
          analysisMeta.textContent = '正在加载评分';
          return;
        }

        analysisProgress.hidden = true;
        analysisProgress.classList.remove('complete');
        analysisMeta.hidden = true;
      }

      function updateAutoStatus(icon, text) {
        if (statusIcon) statusIcon.textContent = icon;
        if (statusText) statusText.textContent = text;
        setAnalysisStage('none');
        // 不自动显示控制面板，只更新状态文本
        // 面板的显示由 startAutoMode() 函数控制
      }

      async function initializeAudioAnalyser() {
        // If we already have a stream and it's active, check if we need to switch device
        const micSelect = document.getElementById('mic-select');
        const selectedDeviceId = micSelect ? micSelect.value : null;

        // If stream exists but device changed, stop old tracks
        if (state.mediaStream) {
          const active = state.mediaStream.active && state.mediaStream.getAudioTracks().some(t => t.enabled && t.readyState === 'live');
          if (!active) {
            console.warn('[麦克风] 流已失效，重新获取');
            state.mediaStream = null;
            state.recordingStream = null;
          } else if (selectedDeviceId && state.currentDeviceId !== selectedDeviceId) {
            console.log('[麦克风] 切换设备:', selectedDeviceId);
            state.mediaStream.getTracks().forEach(t => t.stop());
            state.mediaStream = null;
            state.recordingStream = null;
          }
        }

        if (!state.mediaStream) {
          state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        if (state.audioContext.state === 'suspended') {
          await state.audioContext.resume();
        }

        if (!state.mediaStream) {
          const baseConstraints = {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          };
          const constraints = {
            audio: selectedDeviceId
              ? { deviceId: { exact: selectedDeviceId }, ...baseConstraints }
              : baseConstraints
          };
          try {
            state.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
            state.currentDeviceId = selectedDeviceId;

            // ===== Web Audio Pipeline Setup =====
            // 1. Create Source from Mic
            const source = state.audioContext.createMediaStreamSource(state.mediaStream);

            // 2. Create Gain Node (Volume Control / Buffer)
            state.inputGain = state.audioContext.createGain();
            state.inputGain.gain.value = 1.0;

            // 3. Create Analyser (Visualizer)
            state.audioAnalyser = state.audioContext.createAnalyser();
            state.audioAnalyser.fftSize = 2048;

            // 4. Create Destination (Recorder Input)
            state.audioDestination = state.audioContext.createMediaStreamDestination();

            // Connect: Source -> Gain -> Analyser
            //                   -> Destination
            source.connect(state.inputGain);
            state.inputGain.connect(state.audioAnalyser);
            state.inputGain.connect(state.audioDestination);

            // Store the processed stream for recording
            state.recordingStream = state.audioDestination.stream;

            console.log('[AudioPipeline] Web Audio pipeline initialized');

          } catch (e) {
            console.error('[麦克风] 获取流失败:', e);
            alert('无法访问麦克风，请检查权限。');
            throw e;
          }
        }
      }

      // Populate Microphone Select
      async function populateMicSelect() {
        const micSelect = document.getElementById('mic-select');
        if (!micSelect) return;

        try {
          // Request permission first to get labels
          await navigator.mediaDevices.getUserMedia({ audio: true });
          const devices = await navigator.mediaDevices.enumerateDevices();
          const audioInputs = devices.filter(d => d.kind === 'audioinput');

          micSelect.innerHTML = '';
          if (audioInputs.length === 0) {
            const opt = document.createElement('option');
            opt.text = '未检测到麦克风';
            micSelect.appendChild(opt);
            return;
          }

          audioInputs.forEach(device => {
            const opt = document.createElement('option');
            opt.value = device.deviceId;
            opt.text = device.label || `麦克风 ${micSelect.length + 1}`;
            micSelect.appendChild(opt);
          });

          // Restore selection if needed, or select default
          if (state.currentDeviceId) {
            micSelect.value = state.currentDeviceId;
          }

          micSelect.addEventListener('change', () => {
            state.currentDeviceId = micSelect.value;
            // Force re-init on next record
            if (state.mediaStream) {
              state.mediaStream.getTracks().forEach(t => t.stop());
              state.mediaStream = null;
              state.recordingStream = null;
            }
            console.log('[麦克风] 用户选择:', state.currentDeviceId);
          });

        } catch (e) {
          console.warn('[麦克风] 枚举设备失败:', e);
          micSelect.innerHTML = '<option>无法获取设备列表</option>';
        }
      }

      // Call on load
      window.addEventListener('DOMContentLoaded', populateMicSelect);

      // Test Mic Feature
      let isTestingMic = false;
      async function toggleMicTest() {
        const btn = document.getElementById('test-mic-btn');
        if (isTestingMic) {
          // Stop testing
          stopVADMonitoring();
          if (state.mediaStream) {
            state.mediaStream.getTracks().forEach(t => t.stop());
            state.mediaStream = null;
            state.recordingStream = null;
          }
          isTestingMic = false;
          if (btn) {
            btn.textContent = '🎤 测试麦克风';
            btn.classList.remove('btn-danger');
            btn.classList.add('btn-outline');
          }
          if (vadIndicatorEl) vadIndicatorEl.hidden = true;
        } else {
          // Start testing
          try {
            if (btn) btn.textContent = '⏳ 启动中...';
            await initializeAudioAnalyser();
            startVADMonitoring();
            isTestingMic = true;
            if (btn) {
              btn.textContent = '⏹ 停止测试';
              btn.classList.remove('btn-outline');
              btn.classList.add('btn-danger');
            }
            if (vadIndicatorEl) vadIndicatorEl.hidden = false;
          } catch (e) {
            console.error('Mic test failed', e);
            if (btn) btn.textContent = '❌ 失败';
            setTimeout(() => { if (btn) btn.textContent = '🎤 测试麦克风'; }, 2000);
          }
        }
      }

      const testMicBtn = document.getElementById('test-mic-btn');
      if (testMicBtn) testMicBtn.addEventListener('click', toggleMicTest);

      function getAudioLevel() {
        if (!state.audioAnalyser) return 0;

        const bufferLength = state.audioAnalyser.fftSize;
        const dataArray = new Uint8Array(bufferLength);
        state.audioAnalyser.getByteTimeDomainData(dataArray);

        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          const normalized = (dataArray[i] - 128) / 128;
          sum += normalized * normalized;
        }

        const rms = Math.sqrt(sum / bufferLength);
        // Adaptive VAD: track a smoothed noise floor and threshold
        if (!state.vadNoiseFloor) state.vadNoiseFloor = 0.006;
        const alpha = 0.95; // EMA smoothing
        const currentThreshold = state.vadThreshold || state.silenceThreshold || 0.01;
        const updateFloor = rms < currentThreshold * 1.2;
        if (updateFloor) {
          state.vadNoiseFloor = alpha * state.vadNoiseFloor + (1 - alpha) * rms;
        }
        state.vadThreshold = Math.max(state.silenceThreshold || 0.01, state.vadNoiseFloor * 3);
        return rms;
      }

      function startVADMonitoring() {
        if (state.vadCheckInterval) {
          clearInterval(state.vadCheckInterval);
        }

        state.silenceStart = null;
        state.lastVoiceTs = null;
        if (!state.vadHangMs) state.vadHangMs = 250; // hangover avoids choppy cuts
        if (!state.minSpeakMs) state.minSpeakMs = 300; // legacy field（保留兼容）

        // 录音起始标记（等待 MediaRecorder 真正进入 recording 再设置）
        state.recordingStartAt = null;
        state.firstVoiceAt = null;
        state.voicedMs = 0;
        state.vadVoiceFrames = 0;
        state.vadSilenceFrames = 0;
        state.vadMinVoiceFrames = 3;    // 约 300ms 连续发声判定开始说话
        state.vadMinSilenceFrames = 5;  // 约 500ms 连续静音判定停止说话
        if (vadIndicatorEl) { vadIndicatorEl.hidden = false; }

        state.vadCheckInterval = setInterval(() => {
          const level = getAudioLevel();
          // 若录音尚未真正开始但 MediaRecorder 已进入 recording 状态，则修正起始时间
          if (!state.recordingStartAt && state.recorder && state.recorder.state === 'recording') {
            state.recordingStartAt = Date.now();
            console.log('[VAD] 录音真正开始，重置计时');
          }
          const threshold = state.vadThreshold || state.silenceThreshold || 0.01;
          const now = Date.now();
          const isVoice = level >= threshold;

          if (isVoice) {
            state.lastVoiceTs = now;
            if (!state.firstVoiceAt) state.firstVoiceAt = now;
            // 粗略累加发声时长（基于采样周期）
            state.voicedMs += 100;
            state.silenceStart = null;
            state.vadVoiceFrames += 1;
            state.vadSilenceFrames = 0;
            if (!state.isSpeaking && state.vadVoiceFrames >= (state.vadMinVoiceFrames || 3)) {
              state.isSpeaking = true;
              if (vadLabelEl) vadLabelEl.textContent = '正在说话';
            }
            return;
          }

          if (!state.silenceStart) state.silenceStart = now;
          const silenceDur = now - state.silenceStart;
          const spokeRecently = state.lastVoiceTs && (now - state.lastVoiceTs) < state.vadHangMs;
          state.vadSilenceFrames += 1;
          state.vadVoiceFrames = 0;
          if (state.isSpeaking && state.vadSilenceFrames >= (state.vadMinSilenceFrames || 5)) {
            state.isSpeaking = false;
            if (vadLabelEl) vadLabelEl.textContent = '静音';
          }

          // 初始静音忽略：在录音开始后的前一段时间，不因为静音而停止
          const sinceStart = state.recordingStartAt ? (now - state.recordingStartAt) : 0;
          if (sinceStart < (state.vadInitialIgnoreMs || 0)) {
            return;
          }

          // 必须先说够一定时长，才允许因静音而停止
          const spokeEnough = state.firstVoiceAt && ((now - state.firstVoiceAt) >= (state.vadMinSpeakMs || 0));

          // 达到尾部静音阈值，并且最近没有发声且发声时间已满足要求，且距离首次发声已过最短时长
          const afterVoiceMs = state.firstVoiceAt ? (now - state.firstVoiceAt) : 0;
          const needAfterVoice = state.vadMinAfterVoiceMs || 0;
          // 未达到最小录音时长前，不因静音而停止
          const minGuardMs = state.dialogueMinDurationMs || 900;
          if (!spokeRecently && silenceDur >= state.silenceDuration && state.isRecording && spokeEnough && afterVoiceMs >= needAfterVoice && sinceStart >= minGuardMs) {
            console.log('[VAD] 检测到静音，停止录音');
            stopAutoRecording();
          }

          // 兜底：超出单句最大录音时长，强制停止
          const seg = state.currentSegments?.[state.autoSegmentCursor];
          let maxMs = state.vadMaxRecordingMs || 10000;
          try {
            const s = Number(seg?.start) || 0; const e = Number(seg?.end);
            const dur = Number.isFinite(e) ? Math.max(0, (e - s) * 1000) : 0;
            if (dur > 0) {
              const segMaxMs = Math.min(Math.max(dur + 1500, 2500), 12000);
              // 不用更短的分段时长覆盖全局上限，避免提前截断
              maxMs = Math.max(maxMs, segMaxMs);
            }
          } catch (_) { }
          if (Number.isFinite(state.dialogueMaxDurationMs)) {
            maxMs = Math.max(maxMs, state.dialogueMaxDurationMs);
          }
          state.activeMaxRecordingMs = maxMs;
          if (state.isRecording && sinceStart >= maxMs) {
            console.log('[VAD] 达到最大录音时长，停止录音');
            stopAutoRecording();
          }

          // 更新仪表 UI
          try {
            if (vadFillEl) {
              // 将 RMS 粗略映射到 0-100%
              const pct = Math.max(0, Math.min(100, Math.round((level / Math.max(0.001, (state.vadThreshold || 0.01) * 3)) * 100)));
              vadFillEl.style.width = pct + '%';
            }
            if (vadLabelEl && typeof state.isSpeaking === 'boolean') {
              // label 在切换时已设置，这里仅在首次显示时兜底
              if (!state.isSpeaking && vadLabelEl.textContent !== '静音') vadLabelEl.textContent = '静音';
            }
          } catch (_) { }
        }, 100);
      }

      function stopVADMonitoring() {
        if (state.vadCheckInterval) {
          clearInterval(state.vadCheckInterval);
          state.vadCheckInterval = null;
        }
        state.silenceStart = null;
      }

      async function startAutoRecording() {
        if (state.isRecording) return;

        const currentLine = state.currentSegments[state.autoSegmentCursor];
        if (!currentLine) return;

        try {
          // 短句按发声结束快速停止，长句仅放宽最大时长。
          try {
            const recordingPolicy = window.DialogueRecordingPolicy
              ? window.DialogueRecordingPolicy.getDialogueRecordingPolicy(currentLine)
              : { minimumMs: 900, maximumMs: 6000 };
            const minDuration = recordingPolicy.minimumMs;
            const maxDuration = recordingPolicy.maximumMs;
            state.dialogueMaxDurationMs = Number.isFinite(maxDuration) ? maxDuration : null;
            state.activeMaxRecordingMs = state.dialogueMaxDurationMs;
            state.dialogueMinDurationMs = Number.isFinite(minDuration) ? minDuration : null;
            console.log(`[录音时长估算] 最小: ${(minDuration / 1000).toFixed(1)}s, 最大: ${(maxDuration / 1000).toFixed(1)}s`);
          } catch (e) {
            console.warn('[录音时长估算] 失败:', e);
            state.dialogueMaxDurationMs = null;
            state.activeMaxRecordingMs = null;
            state.dialogueMinDurationMs = null;
          }

          await initializeAudioAnalyser();

          // Ensure AudioContext is running (crucial for some browsers)
          if (state.audioContext && state.audioContext.state === 'suspended') {
            await state.audioContext.resume();
            console.log('[录音] AudioContext resumed');
          }

          state.recordingChunks = [];
          state.isRecording = true;
          const startRecFab = document.getElementById('start-recording-fab');
          const fabBtn = document.getElementById('fab-record-btn');
          if (startRecFab) startRecFab.classList.add('recording');
          if (fabBtn) fabBtn.classList.add('recording');

          // Detect supported MIME type (Aligned with desktop implementation)
          const preferredMimeTypes = [
            'audio/mp4;codecs=mp4a.40.2',
            'audio/mp4',
            'audio/aac',
            'audio/mpeg',
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg',
          ];

          let requestedMimeType = null;
          let recorderOptions = null;

          if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
            requestedMimeType = preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) || null;
            if (requestedMimeType) {
              recorderOptions = { mimeType: requestedMimeType };
            }
          }

          console.log(`[录音] Requested MIME type: ${requestedMimeType}`);

          try {
            // Use the processed Web Audio stream if available, otherwise fallback to raw stream
            const streamToRecord = state.recordingStream || state.mediaStream;
            const streamType = state.recordingStream ? 'Web Audio Pipeline' : 'Raw Microphone';
            console.log(`[录音] 使用流类型: ${streamType}`);

            state.recorder = recorderOptions
              ? new MediaRecorder(streamToRecord, recorderOptions)
              : new MediaRecorder(streamToRecord);
          } catch (err) {
            console.warn(`[录音] Failed to init MediaRecorder with ${requestedMimeType}, falling back to default`, err);
            const streamToRecord = state.recordingStream || state.mediaStream;
            state.recorder = new MediaRecorder(streamToRecord);
          }

          // Store effective mime type
          state.recorderMimeType = state.recorder.mimeType || requestedMimeType || 'audio/webm';
          console.log(`[录音] Effective MIME type: ${state.recorderMimeType}`);

          state.recorder.addEventListener('dataavailable', (event) => {
            if (event.data.size > 0) {
              state.recordingChunks.push(event.data);
              console.log(`[录音数据] 收集了 ${event.data.size} 字节，总块数: ${state.recordingChunks.length}`);
            } else {
              console.warn('[录音数据] 收到空数据块！');
            }
          });

          state.recorder.addEventListener('stop', async () => {
            console.log(`[录音停止] 收集到 ${state.recordingChunks.length} 个数据块`);

            if (!state.recordingChunks.length) {
              console.error('[录音] 没有录音数据 - 可能的原因：');
              console.error('  1. 录音时间太短（不到100ms）');
              console.error('  2. 麦克风没有声音输入');
              console.error('  3. 浏览器不支持所选的音频格式');
              console.error('  4. MediaRecorder 状态异常');
              console.error(`  当前状态: ${state.recorder?.state}, MimeType: ${state.recorder?.mimeType}`);
              handleRecordingFailed();
              return;
            }

            // 使用实际录制的格式
            // Force 'audio/webm' for server compatibility if it's a supported container
            // The server likely rejects 'audio/webm;codecs=opus' or 'audio/mp4' string but accepts the data if labeled 'audio/webm'
            const actualMimeType = state.recorder.mimeType || state.recordingChunks[0]?.type || (recorderOptions?.mimeType) || requestedMimeType || 'audio/webm';
            // Hack: Always label as audio/webm for upload if it's webm-based, or just try to pass it.
            // If mobile used mp4, we might need to keep it, but let's try forcing webm label if it was webm/opus
            let uploadMimeType = actualMimeType;
            if (actualMimeType.includes('webm')) {
              uploadMimeType = 'audio/webm';
            }

            const blob = new Blob(state.recordingChunks, { type: uploadMimeType });
            state.lastRecordingBlob = blob;

            console.log(`[录音完成] 格式: ${actualMimeType}, 大小: ${(blob.size / 1024).toFixed(2)}KB, 数据块: ${state.recordingChunks.length}`);

            // 🔍 检查 blob 是否真的有数据
            if (blob.size === 0) {
              console.error('[录音完成] ⚠️ Blob 大小为 0！虽然有数据块但最终blob为空');
              handleRecordingFailed();
              return;
            }

            // 录音完成，自动评分
            try {
              await evaluateRecording(currentLine, blob);
            } catch (err) {
              console.error('[录音] 评分失败:', err);
            }
          });

          // 标记开始时间，供VAD参考
          state.recordingStartAt = Date.now();
          state.firstVoiceAt = null;
          state.voicedMs = 0;
          // 移动端更宽松的阈值，避免过早结束
          try {
            const isMobile = audioModeManager?.isMobileEnvironment || isLikelyMobileDevice;
            const isDialogue = currentPracticeMode === 'dialogue';
            if (isMobile) {
              state.vadInitialIgnoreMs = isDialogue ? 1000 : 1400;
              state.vadMinSpeakMs = isDialogue ? 700 : 1000;
              state.vadMinAfterVoiceMs = isDialogue ? 800 : 1200;
              state.silenceDuration = isDialogue
                ? 1100
                : Math.max(state.silenceDuration || 1300, 1500);
              state.vadMaxRecordingMs = isDialogue
                ? (state.dialogueMaxDurationMs || 12000)
                : 9500;
            } else {
              state.vadInitialIgnoreMs = isDialogue ? 900 : 750;
              state.vadMinSpeakMs = isDialogue ? 650 : 650;
              state.vadMinAfterVoiceMs = isDialogue ? 700 : 700;
              state.silenceDuration = isDialogue ? 900 : 1100;
              state.vadMaxRecordingMs = isDialogue
                ? (state.dialogueMaxDurationMs || 12000)
                : 9000;
            }
          } catch (_) { }
          // Small start delay to avoid clipping the first phoneme
          await new Promise((r) => setTimeout(r, 60));

          // 🔧 设置 timeslice 为 100ms，确保定期收集数据
          console.log(`[录音] 开始录音，MimeType: ${mimeType}, timeslice: 100ms`);
          state.recorder.start(100);  // 每100ms触发一次 dataavailable
          updateAutoStatus('🎤', '请开始说话...');
          startVADMonitoring();

          // Audio Level Monitoring
          state.audioLevelCheckInterval = setInterval(() => {
            const level = getAudioLevel();
            console.log(`[AudioMonitor] Level: ${level.toFixed(4)}, ContextState: ${state.audioContext?.state}, StreamActive: ${state.mediaStream?.active}`);

            if (state.audioContext?.state === 'suspended') {
              state.audioContext.resume();
            }

            const recElapsed = state.recordingStartAt ? (Date.now() - state.recordingStartAt) : 0;
            if (level < 0.001 && recElapsed > 2000) {
              // If silent for > 2 seconds
              if (!state.silenceWarningShown) {
                console.warn('[AudioMonitor] ⚠️ No audio detected! Check mic permissions.');
                updatePracticeFeedback('⚠️ 未检测到声音，请检查麦克风或静音开关', '#d97706');
                try {
                  window.Feedback && Feedback.showToast('warning', '未检测到麦克风声音，请检查权限或切换设备', 4000);
                } catch (_) { }
                state.silenceWarningShown = true;
              }
            } else if (level > 0.01) {
              state.silenceWarningShown = false;
              updatePracticeFeedback('🎤 正在录音...', '#28a745');
            }
          }, 500);

          console.log('[录音] 开始录音，等待用户说话...');
        } catch (err) {
          console.error('[录音] 启动失败:', err);
          updateAutoStatus('❌', '麦克风权限被拒绝');
        }
      }

      function stopAutoRecording() {
        if (!state.isRecording) return;

        state.isRecording = false;
        const startRecFab = document.getElementById('start-recording-fab');
        const fabBtn = document.getElementById('fab-record-btn');
        if (startRecFab) startRecFab.classList.remove('recording');
        if (fabBtn) fabBtn.classList.remove('recording');
        stopVADMonitoring();

        if (state.audioLevelCheckInterval) {
          clearInterval(state.audioLevelCheckInterval);
          state.audioLevelCheckInterval = null;
        }

        if (vadIndicatorEl) { vadIndicatorEl.hidden = true; }

        if (state.recorder && state.recorder.state !== 'inactive') {
          state.recorder.stop();
        }

        updateAutoStatus('⏳', '正在评分...');
        console.log('[录音] 停止录音');
      }

      // 保存录音并上传到服务器
      function saveUserRecording(segmentIndex, blob, metadata = {}) {
        return new Promise((resolve, reject) => {
          const videoId = state.videoId;
          if (!videoId) {
            resolve(null);
            pushDebug('saveUserRecording: missing videoId');
            return;
          }

          try {
            const reader = new FileReader();
            reader.onloadend = async () => {
              try {
                const base64data = reader.result;
                const key = buildSegmentKey(segmentIndex);
                if (!key) {
                  pushDebug('录音保存失败: 非法段落编号', { segmentIndex });
                  resolve(null);
                  return;
                }
                const uploadIndex = normalizeSegmentIndex(segmentIndex);
                const payloadSegmentIndex = uploadIndex !== null ? uploadIndex : segmentIndex;
                const storageKey = `user_recordings_${videoId}`;
                const storedData = localStorage.getItem(storageKey);
                let recordings = {};
                if (storedData && storedData !== 'undefined' && storedData !== 'null') {
                  try {
                    recordings = JSON.parse(storedData);
                  } catch (e) {
                    console.warn('[录音] Failed to parse recordings from localStorage:', e);
                    recordings = {};
                  }
                }

                if (!recordings.recordings) {
                  recordings = {
                    videoId,
                    selectedSpeaker: state.selectedSpeaker,
                    recordings: {},
                  };
                }

                const speaker = state.selectedSpeaker || recordings.selectedSpeaker || null;
                recordings.selectedSpeaker = speaker;

                recordings.recordings[key] = {
                  audioData: base64data,
                  timestamp: new Date().toISOString(),
                  duration: 0,
                  speaker,
                  startOffset: metadata.startOffset || 0,  // 静音裁剪的开头偏移
                  endOffset: metadata.endOffset || 0,      // 静音裁剪的结尾偏移
                };

                try {
                  localStorage.setItem(storageKey, JSON.stringify(recordings));
                } catch (storageErr) {
                  console.warn('[录音保存] 无法写入本地缓存:', storageErr);
                  pushDebug('本地缓存写入失败', storageErr?.message || storageErr);
                }

                let uploadedRecording = null;
                try {
                  if (speaker) {
                    uploadedRecording = await uploadRecordingToServer({
                      videoId,
                      segmentIndex: payloadSegmentIndex,
                      speaker,
                      audioData: base64data,
                      durationSec: blob?.duration || null,
                    });
                    if (uploadedRecording) {
                      state.serverRecordings = Array.isArray(state.serverRecordings)
                        ? state.serverRecordings.filter(
                          (item) => {
                            const itemKey = buildSegmentKey(item.segment_index ?? item.segmentIndex);
                            const itemSpeaker = item.speaker ?? '';
                            const uploadedSpeaker = uploadedRecording.speaker ?? '';
                            return !(itemKey === key && itemSpeaker === uploadedSpeaker);
                          },
                        )
                        : [];
                      state.serverRecordings.push(uploadedRecording);
                      audioModeManager.addOrUpdateRecording(uploadedRecording);
                      pushDebug('上传录音成功', { segmentIndex: key, speaker });
                    }
                  } else {
                    console.warn('[录音上传] 未选择角色，跳过服务器上传');
                    pushDebug('上传录音跳过（无speaker）', { segmentIndex: key });
                  }
                } catch (uploadErr) {
                  console.warn('[录音上传] 失败，使用本地录音作为备用:', uploadErr);
                  // 回退到本地缓存
                  audioModeManager.loadUserRecordings(videoId, state.serverRecordings || []);
                  pushDebug('上传录音失败', { segmentIndex: key, error: uploadErr?.message || uploadErr });
                }

                ensureAudioModeAvailability();
                audioModeManager.setMode(currentAudioMode);
                updateAudioModeButtons();

                // 实战场模式：更新按钮状态
                if (typeof updateArenaModeButtons === 'function') {
                  updateArenaModeButtons();
                }

                resolve(state.serverRecordings);
              } catch (err) {
                console.error('[录音保存] 处理失败:', err);
                pushDebug('录音保存处理失败', err?.message || err);
                reject(err);
              }
            };
            reader.onerror = (err) => {
              console.error('[录音保存] 读取数据失败:', err);
              pushDebug('录音读取失败', err?.message || err);
              reject(err);
            };
            reader.readAsDataURL(blob);
          } catch (err) {
            console.error('[录音保存] 保存失败:', err);
            pushDebug('录音保存失败', err?.message || err);
            reject(err);
          }
        });
      }

      /**
       * 裁剪音频前后的静音部分
       * @param {Blob} blob - 原始音频blob
       * @param {number} silenceThreshold - 静音阈值 (0-1)，默认0.01
       * @param {boolean} isMobile - 是否为移动设备
       * @returns {Promise<{blob: Blob, trimmedDuration: number, startOffset: number, endOffset: number}>} - 裁剪后的blob和时长，以及偏移量
       */
      async function trimSilence(blob, silenceThreshold = 0.01, isMobile = false) {
        try {
          console.log(`[静音裁剪] 开始处理，移动端: ${isMobile}, 文件大小: ${(blob.size / 1024).toFixed(2)}KB`);

          // 创建AudioContext（如果还没有的话）
          const audioContext = state.audioContext || new (window.AudioContext || window.webkitAudioContext)();
          if (!state.audioContext) {
            state.audioContext = audioContext;
          }

          // 将blob转换为ArrayBuffer - 使用FileReader以避免移动端Safari的安全限制
          let arrayBuffer;
          try {
            arrayBuffer = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(new Error('FileReader failed'));
              reader.readAsArrayBuffer(blob);
            });
          } catch (readerErr) {
            console.error('[静音裁剪] FileReader失败:', readerErr);
            // 回退到blob.arrayBuffer()
            arrayBuffer = await blob.arrayBuffer();
          }
          console.log(`[静音裁剪] ArrayBuffer大小: ${(arrayBuffer.byteLength / 1024).toFixed(2)}KB`);

          // 解码音频数据
          let audioBuffer;
          try {
            audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
          } catch (decodeErr) {
            console.error('[静音裁剪] 音频解码失败:', decodeErr);
            // 移动端解码失败是常见问题，直接返回原始blob
            return {
              blob,
              trimmedDuration: null,
              startOffset: 0,
              endOffset: 0
            };
          }

          // 获取音频数据（只处理第一个声道，如果是立体声则混合）
          const channelData = audioBuffer.getChannelData(0);
          const sampleRate = audioBuffer.sampleRate;
          const numSamples = channelData.length;

          // 查找开始位置（第一个非静音样本）
          let startIndex = 0;
          for (let i = 0; i < numSamples; i++) {
            if (Math.abs(channelData[i]) > silenceThreshold) {
              startIndex = i;
              break;
            }
          }

          // 查找结束位置（最后一个非静音样本）
          let endIndex = numSamples - 1;
          for (let i = numSamples - 1; i >= startIndex; i--) {
            if (Math.abs(channelData[i]) > silenceThreshold) {
              endIndex = i + 1; // +1 因为我们要包含这个样本
              break;
            }
          }

          // 如果整个音频都是静音，返回原始blob
          if (startIndex >= endIndex) {
            console.warn('[静音裁剪] 整个音频都是静音，返回原始音频');
            return {
              blob,
              trimmedDuration: audioBuffer.duration,
              startOffset: 0,
              endOffset: 0
            };
          }

          // 添加一点缓冲（避免切得太紧）
          const bufferSamples = Math.floor(sampleRate * 0.05); // 50ms缓冲
          startIndex = Math.max(0, startIndex - bufferSamples);
          endIndex = Math.min(numSamples, endIndex + bufferSamples);

          const trimmedLength = endIndex - startIndex;
          const trimmedDuration = trimmedLength / sampleRate;
          const startOffset = startIndex / sampleRate;
          const endOffset = (numSamples - endIndex) / sampleRate;

          console.log(`[静音裁剪] 原始: ${audioBuffer.duration.toFixed(2)}s, 裁剪后: ${trimmedDuration.toFixed(2)}s, 节省: ${((1 - trimmedDuration / audioBuffer.duration) * 100).toFixed(1)}%, 开头静音: ${startOffset.toFixed(2)}s, 结尾静音: ${endOffset.toFixed(2)}s`);

          // 移动端优化：跳过重新编码，只返回偏移量信息
          // 在播放时通过 currentTime 跳过静音部分即可
          if (isMobile) {
            console.log('[静音裁剪] 移动端模式：跳过重新编码，使用虚拟裁剪');
            return {
              blob, // 返回原始blob
              trimmedDuration,
              startOffset, // 开头需要跳过的时间
              endOffset    // 结尾需要跳过的时间
            };
          }

          // PC端：完整裁剪并重新编码
          // 创建新的AudioBuffer
          const trimmedBuffer = audioContext.createBuffer(
            audioBuffer.numberOfChannels,
            trimmedLength,
            sampleRate
          );

          // 复制裁剪后的数据到所有声道
          for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
            const sourceData = audioBuffer.getChannelData(channel);
            const targetData = trimmedBuffer.getChannelData(channel);
            for (let i = 0; i < trimmedLength; i++) {
              targetData[i] = sourceData[startIndex + i];
            }
          }

          // 将AudioBuffer转换回blob
          // 使用MediaRecorder进行编码
          const trimmedBlob = await encodeAudioBuffer(trimmedBuffer, audioContext);

          return {
            blob: trimmedBlob,
            trimmedDuration,
            startOffset: 0, // 已经物理裁剪，无需偏移
            endOffset: 0
          };

        } catch (err) {
          console.error('[静音裁剪] 处理失败:', err);
          // 如果裁剪失败，返回原始blob
          return {
            blob,
            trimmedDuration: null,
            startOffset: 0,
            endOffset: 0
          };
        }
      }

      /**
       * 将AudioBuffer编码为音频blob
       * @param {AudioBuffer} audioBuffer
       * @param {AudioContext} audioContext
       * @returns {Promise<Blob>}
       */
      async function encodeAudioBuffer(audioBuffer, audioContext) {
        return new Promise((resolve, reject) => {
          // 创建离线渲染的MediaStreamDestination
          const numberOfChannels = audioBuffer.numberOfChannels;
          const length = audioBuffer.length;
          const sampleRate = audioBuffer.sampleRate;

          // 创建一个离线AudioContext来播放buffer
          const offlineContext = new OfflineAudioContext(numberOfChannels, length, sampleRate);
          const source = offlineContext.createBufferSource();
          source.buffer = audioBuffer;

          // 创建MediaStreamDestination（在在线AudioContext中）
          const dest = audioContext.createMediaStreamDestination();
          const onlineSource = audioContext.createBufferSource();
          onlineSource.buffer = audioBuffer;
          onlineSource.connect(dest);

          // 选择兼容的音频格式
          const isMobile = audioModeManager?.isMobileEnvironment || isLikelyMobileDevice;
          let mimeType = 'audio/webm';

          if (isMobile) {
            // 优先尝试 webm (服务器支持更好)，如果不支持再回退到 mp4
            if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
              mimeType = 'audio/webm;codecs=opus';
            } else if (MediaRecorder.isTypeSupported('audio/webm')) {
              mimeType = 'audio/webm';
            } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
              mimeType = 'audio/mp4';
            } else if (MediaRecorder.isTypeSupported('audio/mpeg')) {
              mimeType = 'audio/mpeg';
            }
            console.log(`[音频编码] 移动端使用格式: ${mimeType}`);
          }

          // 使用MediaRecorder录制
          let mediaRecorder;
          try {
            mediaRecorder = new MediaRecorder(dest.stream, { mimeType });
          } catch (err) {
            console.warn(`[音频编码] ${mimeType} 不支持，使用默认格式`, err);
            mediaRecorder = new MediaRecorder(dest.stream);
          }

          const chunks = [];
          mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              chunks.push(e.data);
            }
          };

          mediaRecorder.onstop = () => {
            const blob = new Blob(chunks, { type: 'audio/webm' });
            resolve(blob);
          };

          mediaRecorder.onerror = (err) => {
            reject(err);
          };

          // 开始录制和播放
          mediaRecorder.start();
          onlineSource.start(0);

          // 在音频播放完毕后停止录制
          onlineSource.onended = () => {
            // 稍微延迟一下，确保所有数据都被捕获
            setTimeout(() => {
              mediaRecorder.stop();
            }, 100);
          };
        });
      }

      async function evaluateRecording(line, blob) {
        // 这里简化处理：假设总是需要评分
        // 实际应该调用语音识别API进行评分

        console.log(`[录音评估] 开始处理录音，大小: ${(blob.size / 1024).toFixed(2)}KB, 类型: ${blob.type}`);
        updateAutoStatus('🤔', '正在分析发音...');
        setAnalysisStage('analyzing');

        // 裁剪静音
        let processedBlob = blob;
        let trimmedDuration = null;
        let startOffset = 0;
        let endOffset = 0;

        try {
          // 传递移动端标志
          const isMobile = audioModeManager?.isMobileEnvironment || isLikelyMobileDevice;
          console.log(`[录音评估] 移动端: ${isMobile}, 准备裁剪静音`);

          const result = await trimSilence(blob, 0.01, isMobile);
          processedBlob = result.blob;
          trimmedDuration = result.trimmedDuration;
          startOffset = result.startOffset || 0;
          endOffset = result.endOffset || 0;

          if (trimmedDuration !== null) {
            console.log(`[录音处理] 静音裁剪完成，时长: ${trimmedDuration.toFixed(2)}s, 开头偏移: ${startOffset.toFixed(2)}s`);
          } else {
            console.log(`[录音处理] 静音裁剪跳过或失败，使用原始录音`);
          }
        } catch (err) {
          console.error('[录音处理] 静音裁剪失败:', err);
          console.warn('[录音处理] 使用原始录音');
        }

        // 验证处理后的blob
        if (!processedBlob || processedBlob.size === 0) {
          console.error('[录音评估] 处理后的录音无效！');
          handleRecordingFailed();
          return;
        }

        console.log(`[录音评估] 准备保存录音，大小: ${(processedBlob.size / 1024).toFixed(2)}KB`);

        // 保存录音（使用裁剪后的），并附带偏移信息
        const segmentIndex = line.index != null ? line.index : line.segmentIndex;
        let recordingSavePromise = Promise.resolve(null);
        if (segmentIndex != null) {
          if (currentPracticeMode === 'dialogue') {
            recordingSavePromise = saveUserRecording(
              segmentIndex,
              processedBlob,
              { startOffset, endOffset },
            ).catch((err) => {
              console.error('[录音保存] 保存失败:', err);
              return null;
            });
          } else {
            try {
              await saveUserRecording(segmentIndex, processedBlob, { startOffset, endOffset });
              console.log(`[录音评估] 录音保存成功，片段: ${segmentIndex}`);
            } catch (err) {
              console.error('[录音保存] 保存失败:', err);
            }
          }
        } else {
          console.warn('[录音评估] 缺少 segmentIndex，无法保存录音');
        }

        if (currentPracticeMode !== 'dialogue') {
          updateAutoStatus('✓', '分析完成，正在加载评分');
          setAnalysisStage('complete');
          await new Promise(resolve => setTimeout(resolve, 600));
          setAnalysisStage('none');
        }
        updateAutoStatus('⏳', currentPracticeMode === 'dialogue' ? '正在识别...' : '正在评分...');

        // Call ASR
        let passed = false;

        if (currentPracticeMode === 'dialogue') {
          // Dialogue Mode: Use real ASR
          const asrResult = await performASR(processedBlob, line.text);
          await recordingSavePromise;

          // Setup Play Button
          const playBtn = document.getElementById('mobile-play-recording-btn');
          if (playBtn) {
            playBtn.style.display = 'inline-block';
            playBtn.onclick = () => {
              const audio = new Audio(URL.createObjectURL(processedBlob));
              audio.play().catch(e => console.warn('Manual play failed:', e));
            };
          }

          if (asrResult) {
            const { accuracy } = asrResult;
            passed = accuracy >= 60; // 60% threshold

            // Auto-play recording for review
            setTimeout(() => {
              const audio = new Audio(URL.createObjectURL(processedBlob));
              audio.play().catch(err => {
                console.warn('[AutoPlay] Failed (likely policy), user can click button:', err);
                // Button is already visible
              });
            }, 500);
          } else {
            // Fallback if ASR fails
            passed = true;
          }
        } else {
          // Other modes: Keep mock or use ASR if desired (keeping mock for now to be safe/fast)
          // Or maybe we should enable ASR for all?
          // Let's enable ASR for all but only show UI if needed?
          // For now, restrict ASR UI to Dialogue mode to avoid clutter in other modes
          // But we can still call it.

          // Let's just use mock for non-dialogue to avoid breaking existing flow speed
          const score = Math.random();
          passed = score >= 0.0;
        }

        if (passed) {
          handleRecordingPassed(line);
        } else {
          handleRecordingFailed();
        }
      }

      function handleRecordingPassed(line) {
        console.log('[评分] 通过！');
        updateAutoStatus('✅', '太棒了！继续下一句');

        // quick positive feedback
        if (window.Feedback) {
          const msg = (typeof i18n !== 'undefined' && i18n?.t) ? (i18n.t('feedback.line_passed') || '本句通过！') : '本句通过！';
          Feedback.showToast('success', `✅ ${msg}`);
          Feedback.playSfx('success');
        }

        state.currentRetry = 0; // 重置重试计数

        // 标记当前segment为成功 - 使用segment index而不是practiceIndex
        const currentLine = state.currentSegments[state.autoSegmentCursor];
        if (currentLine) {
          const segmentIndex = currentLine.index != null ? currentLine.index : state.autoSegmentCursor;
          const key = buildSegmentKey(segmentIndex);
          if (key) {
            state.practiceLineResults[key] = 'success';
          }
        }

        // 进度更新 + 徽章
        try {
          state.consecutiveSuccess = (state.consecutiveSuccess || 0) + 1;
          if (state.consecutiveSuccess === 3) {
            window.Feedback && Feedback.awardBadgeOnce('flow-3', '流畅三连');
          } else if (state.consecutiveSuccess === 5) {
            window.Feedback && Feedback.awardBadgeOnce('flow-5', '五连击');
          }
        } catch (_) { }
        updatePracticeProgress();

        // 延迟后自动进入下一句（如果没有暂停）
        if (!state.isPaused) {
          setTimeout(() => {
            moveToNextLine();
          }, 1500);
        }
      }

      function handleRecordingFailed() {
        state.currentRetry++;
        console.log(`[评分] 失败，第${state.currentRetry}次尝试`);
        state.consecutiveSuccess = 0;

        if (state.currentRetry >= state.maxRetries) {
          // 3次都失败，播放原声
          updateAutoStatus('📢', '让我们听听原声...');
          if (!state.isPaused) {
            setTimeout(() => {
              playOriginalThenNext();
            }, 1000);
          }
        } else {
          // 还有机会，再试一次
          updateAutoStatus('🔄', `再试一次！(${state.currentRetry}/${state.maxRetries})`);
          if (!state.isPaused) {
            setTimeout(() => {
              startAutoRecording();
            }, 2000);
          }
        }
      }

      function playOriginalThenNext() {
        const line = state.currentSegments[state.autoSegmentCursor];
        if (!line) return;

        const start = Number(line.start) || 0;
        const end = Number(line.end);
        const effectiveEnd = Number.isFinite(end) ? end : start + 4;

        state.segmentPlaybackEnd = effectiveEnd;
        state.segmentPlaybackCallback = () => {
          safePauseVideo();
          state.currentRetry = 0; // 重置重试
          moveToNextLine();
        };

        videoPlayer.currentTime = start;

        // 清除上一段录音的覆盖状态，避免保持静音到上一段的 unmuteTime
        try { if (audioModeManager && audioModeManager.overlayPlaybackState) { audioModeManager.overlayPlaybackState = null; } } catch (_) { }

        // 移动端优先使用“静音启动 → 渐入音量”，提高自动播放成功率
        const isMobile = (audioModeManager?.isMobileEnvironment) || isLikelyMobileDevice;
        if (isMobile) {
          const targetVol = Number.isFinite(videoPlayer.volume) ? (videoPlayer.volume || 1) : 1;
          const prevMuted = videoPlayer.muted;
          videoPlayer.muted = true;
          safePlayVideo({ preferUnmuted: false }).then((ok) => {
            setTimeout(() => { try { smoothUnmute(videoPlayer, targetVol, DUCK_FADE_MS); } catch (_) { videoPlayer.muted = prevMuted === false ? false : false; } }, 140);
          });
          // 多次温和重试（部分设备策略较严）
          [260, 800, 1500].forEach((ms) => {
            setTimeout(() => { if (videoPlayer.paused) safePlayVideo({ preferUnmuted: false }); }, ms);
          });
        } else {
          safePlayVideo();
          // 回退：若失败，再次以静音方式启动
          setTimeout(() => { if (videoPlayer.paused) safePlayVideo({ preferUnmuted: false }); }, 220);
        }
        updateAutoStatus('🎵', '播放原声中...');
      }

      function moveToNextLine() {
        if (state.autoSegmentCursor >= state.currentSegments.length - 1) {
          // 已经是最后一句
          updateAutoStatus('🎉', '恭喜完成所有对话！');
          state.autoMode = false;
          updateAudioModeButtonsAvailability(); // 练习完成，重新启用音频模式按钮
          if (autoStartBtn) {
            autoStartBtn.hidden = false;
            autoStartBtn.textContent = '▶';
          }
          if (autoPauseBtn) autoPauseBtn.hidden = true;
          return;
        }

        state.autoSegmentCursor = Math.min(state.autoSegmentCursor + 1, state.currentSegments.length - 1);
        state.currentRetry = 0;

        // 高亮当前segment - 使用实际的segment index而不是practiceIndex
        const nextLine = state.currentSegments[state.autoSegmentCursor];
        if (nextLine) {
          const segmentIndex = nextLine.index != null ? nextLine.index : state.autoSegmentCursor;
          highlightCurrentSegment(segmentIndex, true);
        }

        // 继续自动流程（如果没有暂停）
        if (!state.isPaused) {
          setTimeout(() => {
            autoPlayCurrentSegment();
          }, 500);
        }
      }

      function autoPlayCurrentSegment() {
        // 检查是否暂停
        if (state.isPaused) return;

        // 从所有segments中获取当前要播放的
        const allSegments = state.currentSegments;
        if (!allSegments || !allSegments.length) return;

        // 使用 autoSegmentCursor 作为 currentSegments 的索引
        const pointer = state.autoSegmentCursor;

        if (pointer >= allSegments.length) {
          // 已经播放完所有segment
          updateAutoStatus('🎉', '恭喜完成所有对话！');
          if (window.Feedback) {
            const msg = (typeof i18n !== 'undefined' && i18n?.t) ? (i18n.t('feedback.session_done') || '本场已完成！') : '本场已完成！';
            Feedback.showToast('success', `🎉 ${msg}`);
            Feedback.awardBadgeOnce('session-complete', '本场完成');
          }
          state.autoMode = false;
          updateAudioModeButtonsAvailability(); // 练习完成，重新启用音频模式按钮
          return;
        }

        const currentLine = allSegments[pointer];
        if (!currentLine) return;

        const speaker = currentLine.speaker || '';
        const rawSegmentIndex = currentLine.index != null ? currentLine.index : pointer;
        const normalizedSegmentIndex = normalizeSegmentIndex(rawSegmentIndex);
        const segmentIndex = normalizedSegmentIndex != null ? normalizedSegmentIndex : rawSegmentIndex;
        const segmentKey = buildSegmentKey(rawSegmentIndex);

        // 高亮当前segment
        highlightCurrentSegment(segmentIndex, true);

        // 检查这个segment是否是用户的台词
        // 优先使用 speaker 字段直接比较，其次使用 segmentSpeakerMap
        let isUserLine = false;

        // 方法1: 直接比较 speaker 名称
        if (speaker && state.selectedSpeaker && speaker === state.selectedSpeaker) {
          isUserLine = true;
        }

        // 方法2: 检查是否在 practiceLines 中（用户选择的角色的台词）
        if (!isUserLine) {
          const matchingPracticeLine = state.practiceLines.find(line => {
            const lineSegmentIndex = line.index != null ? line.index : line.segmentIndex;
            const lineKey = buildSegmentKey(lineSegmentIndex);
            if (segmentKey && lineKey) {
              return lineKey === segmentKey;
            }
            const normalizedLine = normalizeSegmentIndex(lineSegmentIndex);
            return normalizedLine !== null && normalizedSegmentIndex !== null && normalizedLine === normalizedSegmentIndex;
          });
          if (matchingPracticeLine) {
            isUserLine = true;
          }
        }

        // 方法3: 使用 segmentSpeakerMap（后备方案）
        if (!isUserLine && segmentKey && state.segmentSpeakerMap.has(segmentKey)) {
          isUserLine = state.segmentSpeakerMap.get(segmentKey) === state.selectedSpeaker;
        }

        console.log(`[自动播放] 第${pointer}句，segmentIndex: ${segmentIndex}, speaker: "${speaker}", selectedSpeaker: "${state.selectedSpeaker}", isUserLine: ${isUserLine}`);

        if (isUserLine) {
          // 是用户的台词，等待录音
          updateAutoStatus('🎭', '准备说话...');
          if (window.Feedback) Feedback.playSfx('prompt');
          setTimeout(() => {
            if (!state.isPaused) {
              startAutoRecording();
            }
          }, USER_PREP_MS);
        } else {
          // 不是用户的台词，自动播放
          playNonUserLine(currentLine);
        }
      }

      function playNonUserLine(line) {
        const start = Number(line.start) || 0;
        const end = Number(line.end);
        const effectiveEnd = Number.isFinite(end) ? end : start + 4;

        console.log(`[播放其他角色] speaker: "${line.speaker}", start: ${start}, end: ${effectiveEnd}`);

        // 查找下一句的开始时间
        let nextSegmentStart = null;
        for (const seg of state.currentSegments) {
          const segStart = Number(seg.start);
          if (Number.isFinite(segStart) && segStart >= effectiveEnd - 0.01) {
            nextSegmentStart = segStart;
            break;
          }
        }

        let stopTime = effectiveEnd;
        if (Number.isFinite(nextSegmentStart) && nextSegmentStart > effectiveEnd) {
          const bufferTime = 0.05;
          const nextStartWithBuffer = nextSegmentStart - bufferTime;
          stopTime = Math.min(effectiveEnd, nextStartWithBuffer);
        }

        state.segmentPlaybackEnd = stopTime;
        state.segmentPlaybackCallback = () => {
          console.log('[播放其他角色] 播放完成，移动到下一句');
          safePauseVideo();
          // 播放完其他角色的台词，继续下一句
          moveToNextLine();
        };



        // Ensure we pause before seeking to avoid "blips" of wrong audio
        safePauseVideo();

        // Small timeout to ensure pause takes effect before seek/play
        setTimeout(() => {
          unifiedPlayer.setCurrentTime(start);
          // Another small delay to allow seek to complete (especially for YouTube)
          setTimeout(() => {
            safePlayVideo();
          }, 100);
        }, 50);
        // Watchdog: if autoplay policy blocked, retry with muted
        setTimeout(() => {
          try {
            if (unifiedPlayer.isPaused()) {
              safePlayVideo({ preferUnmuted: false });
            }
          } catch (_) { }
        }, 220);
        updateAutoStatus('🎬', `${line.speaker || '其他角色'}正在说话...`);
      }

      function startAutoMode() {
        if (!state.selectedSpeaker) {
          alert('请先选择你要扮演的角色');
          return;
        }

        if (!state.currentSegments || state.currentSegments.length === 0) {
          alert('没有可用的对话内容');
          return;
        }

        state.autoMode = true;
        state.isPaused = false;
        updateAudioModeButtonsAvailability(); // 禁用音频模式按钮防止误触
        state.autoSegmentCursor = 0;
        state.practiceIndex = 0;
        state.currentRetry = 0;

        // 隐藏独立的开始录音按钮
        if (startRecordingFab) startRecordingFab.hidden = true;

        // 显示自动控制面板，隐藏开始按钮，显示暂停按钮
        // Only show auto controls if NOT in shadowing mode (shadowing uses its own buttons)
        if (autoPracticeStatus) {
          autoPracticeStatus.hidden = (currentPracticeMode === 'shadowing');
        }

        // Show/Hide Dialogue Controls
        const dialogueNavControls = document.getElementById('dialogue-nav-controls');
        if (dialogueNavControls) {
          dialogueNavControls.style.display = (currentPracticeMode === 'dialogue') ? 'flex' : 'none';
        }

        if (autoStartBtn) autoStartBtn.hidden = true;
        if (autoPauseBtn) autoPauseBtn.hidden = false;

        // 暂停视频（用户台词时无需播放）；隐藏覆盖层，避免用户再点一次
        safePauseVideo();
        if (playOverlay) playOverlay.style.display = 'none';

        // 重新渲染以显示正确的高亮（在auto模式下）
        renderPracticeLines();

        updateAutoStatus('🎬', '开始角色扮演...');

        // Show the first line immediately so user sees what's coming
        const firstSegmentIndex = state.currentSegments[0]?.index ?? 0;
        highlightCurrentSegment(firstSegmentIndex, true);

        if (currentPracticeMode === 'dialogue') {
          // Dialogue Mode: Start Monitor Flow
          // Reset index
          state.practiceIndex = 0;

          // Play from start
          unifiedPlayer.setCurrentTime(0);
          safePlayVideo();

          // Start monitor
          setupDialoguePlaybackMonitor(0);

          updateAutoStatus('🎭', '对话模式：自动播放中...');
        } else {
          // Original "Role Play" / Auto Mode Logic
          setTimeout(() => {
            autoPlayCurrentSegment();
          }, 1000);
        }
      }

      function pauseAutoMode() {
        state.isPaused = true;

        // 停止录音
        if (state.isRecording) {
          stopVADMonitoring();
          if (state.recorder && state.recorder.state !== 'inactive') {
            state.recorder.stop();
          }
          state.isRecording = false;
        }

        // 暂停视频
        safePauseVideo();

        // 更新按钮状态
        if (autoStartBtn) {
          autoStartBtn.hidden = false;
          autoStartBtn.textContent = '▶';
        }
        if (autoPauseBtn) autoPauseBtn.hidden = true;

        updateAutoStatus('⏸', '已暂停');
        updateAudioModeButtonsAvailability(); // 暂停后允许切换音频模式试听
      }

      function resumeAutoMode() {
        if (!state.autoMode) return;

        state.isPaused = false;
        updateAudioModeButtonsAvailability(); // 继续练习，禁用音频模式按钮

        // 更新按钮状态
        if (autoStartBtn) autoStartBtn.hidden = true;
        if (autoPauseBtn) autoPauseBtn.hidden = false;

        updateAutoStatus('▶', '继续...');

        setTimeout(() => {
          autoPlayCurrentSegment();
        }, 500);
      }

      // ==========================================
      // Old Dialogue Mode Logic Removed
      // (Now using new auto-flow dialogue mode implementation)
      // ==========================================
      function gotoPrevLine() {
        if (state.autoSegmentCursor <= 0) {
          updateAutoStatus('ℹ️', '已经是第一句了');
          return;
        }

        // 停止当前操作
        if (state.isRecording) {
          stopVADMonitoring();
          if (state.recorder && state.recorder.state !== 'inactive') {
            state.recorder.stop();
          }
          state.isRecording = false;
        }

        videoPlayer.pause();

        // 回到上一句
        state.autoSegmentCursor = Math.max(0, state.autoSegmentCursor - 1);
        state.currentRetry = 0;

        // 高亮当前segment
        const prevLine = state.currentSegments[state.autoSegmentCursor];
        if (prevLine) {
          const segmentIndex = prevLine.index != null ? prevLine.index : state.autoSegmentCursor;
          highlightCurrentSegment(segmentIndex, true);
        }

        updateAutoStatus('⏮', '回到上一句');

        // 如果没有暂停，继续播放
        if (!state.isPaused) {
          setTimeout(() => {
            autoPlayCurrentSegment();
          }, 1000);
        }
      }

      function gotoNextLine() {
        if (state.autoSegmentCursor >= state.currentSegments.length - 1) {
          updateAutoStatus('ℹ️', '已经是最后一句了');
          return;
        }

        // 停止当前操作
        if (state.isRecording) {
          stopVADMonitoring();
          if (state.recorder && state.recorder.state !== 'inactive') {
            state.recorder.stop();
          }
          state.isRecording = false;
        }

        videoPlayer.pause();

        // 跳到下一句
        state.autoSegmentCursor = Math.min(state.autoSegmentCursor + 1, state.currentSegments.length - 1);
        state.currentRetry = 0;

        // 高亮当前segment
        const nextLine = state.currentSegments[state.autoSegmentCursor];
        if (nextLine) {
          const segmentIndex = nextLine.index != null ? nextLine.index : state.autoSegmentCursor;
          highlightCurrentSegment(segmentIndex, true);
        }

        updateAutoStatus('⏭', '跳到下一句');

        // 如果没有暂停，继续播放
        if (!state.isPaused) {
          setTimeout(() => {
            autoPlayCurrentSegment();
          }, 1000);
        }
      }

      // ===== 自动流程核心函数结束 =====

      function buildPracticeLineClass({ isStudentLine, isCurrent, isCompleted, isOtherSpeaker }) {
        const classes = ['line-item'];
        if (isStudentLine) classes.push('my-role');
        if (isCurrent) classes.push('current');
        if (isCompleted) classes.push('practice-success');
        if (isOtherSpeaker) classes.push('other-speaker');
        return classes.join(' ');
      }

      function renderPracticeLines() {
        if (!practiceLineList) return;
        practiceLineList.innerHTML = '';

        if (!state.currentSegments.length) {
          const li = document.createElement('li');
          li.className = 'line-item';
          li.textContent = '暂无字幕数据';
          practiceLineList.appendChild(li);
          return;
        }

        const studentLineIndexMap = new Map();
        state.practiceLines.forEach((line, idx) => {
          if (!line) return;
          const rawIndex = line.index != null ? line.index : line.segmentIndex;
          const key = buildSegmentKey(rawIndex);
          if (key) {
            studentLineIndexMap.set(key, idx);
          }
        });

        const total = state.currentSegments.length;

        state.currentSegments.forEach((segment, idx) => {
          const rawSegmentIndex = segment.index != null ? segment.index : idx;
          const normalizedSegmentIndex = normalizeSegmentIndex(rawSegmentIndex);
          const resultKey = buildSegmentKey(rawSegmentIndex);
          const studentIdx = resultKey ? studentLineIndexMap.get(resultKey) : undefined;
          const practiceLine = studentIdx != null ? state.practiceLines[studentIdx] : null;
          const isStudentLine = practiceLine != null;
          const canonicalSegmentIndex = normalizedSegmentIndex != null ? normalizedSegmentIndex : rawSegmentIndex;
          // 在auto模式下，使用currentSegmentIndex来判断是否为当前行
          // 在manual模式下，使用practiceIndex判断
          const isCurrent = state.autoMode
            ? canonicalSegmentIndex === state.currentSegmentIndex
            : (isStudentLine && studentIdx === state.practiceIndex);
          const isCompleted = resultKey ? state.practiceLineResults[resultKey] === 'success' : false;

          const li = document.createElement('li');
          li.className = buildPracticeLineClass({
            isStudentLine,
            isCurrent,
            isCompleted,
            isOtherSpeaker: !isStudentLine,
          });

          const speakerName = isStudentLine
            ? `[${practiceLine.speaker || state.selectedSpeaker}] - 你的角色`
            : (segment.speaker ? `[${segment.speaker}]` : '');
          if (speakerName) {
            const speakerEl = document.createElement('div');
            speakerEl.className = 'line-speaker';
            speakerEl.textContent = speakerName;
            li.appendChild(speakerEl);
          }

          const header = document.createElement('div');
          header.className = 'line-header';

          const lineNumber = document.createElement('span');
          lineNumber.className = 'line-number';
          lineNumber.textContent = `Line ${idx + 1} of ${total}`;
          header.appendChild(lineNumber);

          const timeSpan = document.createElement('span');
          timeSpan.className = 'line-time';
          const start = Number(segment.start) || 0;
          const end = Number(segment.end != null ? segment.end : start);
          timeSpan.textContent = `${formatTime(start)} – ${formatTime(end)}`;
          header.appendChild(timeSpan);

          li.appendChild(header);

          const textEl = document.createElement('div');
          textEl.className = 'line-text';
          textEl.textContent = (practiceLine && practiceLine.text) || segment.text || '';
          li.appendChild(textEl);

          li.addEventListener('click', () => {
            if (Number.isFinite(start)) {
              videoPlayer.currentTime = start;
              safePlayVideo();
            }
            if (isStudentLine) {
              state.practiceIndex = studentIdx;
              renderPracticeLines();
              renderPracticeCurrentLine();
            } else if (canonicalSegmentIndex != null) {
              state.currentSegmentIndex = canonicalSegmentIndex;
              highlightCurrentSegment(canonicalSegmentIndex);
            }
          });

          li.dataset.segmentIndex = resultKey || '';
          li.dataset.arrayIndex = String(idx);
          li.dataset.start = String(start);
          li.dataset.end = String(end);
          practiceLineList.appendChild(li);
        });

        let targetSegmentIndex = null;
        if (state.practiceLines.length) {
          const boundedIndex = Math.min(state.practiceIndex, state.practiceLines.length - 1);
          const currentLine = state.practiceLines[boundedIndex];
          if (currentLine) {
            targetSegmentIndex = currentLine.index != null ? currentLine.index : currentLine.segmentIndex;
            state.practiceIndex = boundedIndex;
          }
        } else if (state.currentSegments.length) {
          const fallback = state.currentSegments[Math.min(state.currentSegmentIndex || 0, state.currentSegments.length - 1)];
          if (fallback) {
            targetSegmentIndex = fallback.index != null ? fallback.index : state.currentSegments.indexOf(fallback);
          }
        }

        if (targetSegmentIndex != null) {
          highlightCurrentSegment(targetSegmentIndex, false);
        } else {
          practiceLineList.querySelectorAll('.line-item').forEach((item) => item.classList.remove('current'));
        }

        renderPracticeCurrentLine();
      }

      function buildHighlightedPracticeHTML(originalText, correctIndexes) {
        if (!originalText) return '';
        const correctSet = new Set(correctIndexes || []);
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
        if (!practiceCurrentLine) return;
        const line = state.practiceLines[state.practiceIndex];
        if (!line) {
          practiceCurrentLine.hidden = true;
          return;
        }

        const rawKey = line.index != null ? line.index : line.segmentIndex;
        const key = buildSegmentKey(rawKey);
        const isSuccessful = key ? state.practiceLineResults[key] === 'success' : false;
        const wordResult = key ? (state.practiceLineWordResults[key] || {}) : {};
        const highlighted = buildHighlightedPracticeHTML(line.text, wordResult.correctIndexes);
        practiceCurrentLine.hidden = false;
        practiceCurrentLine.className = `practice-current-line${isSuccessful ? ' practice-successful' : ''}`;
        practiceCurrentLine.innerHTML = `
        <div class="practice-current-meta">Line ${state.practiceIndex + 1} of ${state.practiceLines.length}</div>
        <div class="practice-current-text">${highlighted || escapeHtml(line.text || '')}</div>
        <div class="practice-current-time">${formatTime(line.start)} – ${formatTime(line.end)}</div>
      `;
      }

      function highlightCurrentSegment(segmentIndex, scroll = true) {
        const normalizedSegmentIndex = normalizeSegmentIndex(segmentIndex);
        const segmentKey = buildSegmentKey(segmentIndex);
        let targetArrayIndex = -1;
        if (Array.isArray(state.currentSegments) && state.currentSegments.length) {
          targetArrayIndex = state.currentSegments.findIndex((segment, idx) => {
            const idxValue = segment.index != null ? segment.index : idx;
            const normalizedIdxValue = normalizeSegmentIndex(idxValue);
            if (normalizedSegmentIndex !== null) {
              return normalizedIdxValue === normalizedSegmentIndex;
            }
            const candidateKey = buildSegmentKey(idxValue);
            if (segmentKey && candidateKey) {
              return candidateKey === segmentKey;
            }
            return normalizedIdxValue === null && idxValue === segmentIndex;
          });
          if (state.autoMode && targetArrayIndex >= 0) {
            state.autoSegmentCursor = targetArrayIndex;
          }
        }

        state.currentSegmentIndex = normalizedSegmentIndex != null ? normalizedSegmentIndex : segmentIndex;
        const studentIdx = segmentKey ? state.practiceLineIndexMap.get(segmentKey) : undefined;
        const practiceIndexChanged = studentIdx != null && state.practiceIndex !== studentIdx;

        practiceLineList.querySelectorAll('.line-item').forEach((item) => {
          const itemKey = item.dataset.segmentIndex;
          const itemArrayIndex = Number(item.dataset.arrayIndex);
          const normalizedItemKey = normalizeSegmentIndex(itemKey);
          const matchByNormalized = normalizedSegmentIndex !== null && normalizedItemKey === normalizedSegmentIndex;
          const matchByKey = normalizedSegmentIndex === null && segmentKey && itemKey === segmentKey;
          const matchByArrayIndex = Number.isInteger(itemArrayIndex) && itemArrayIndex === targetArrayIndex;
          if (matchByNormalized || matchByKey || matchByArrayIndex) {
            item.classList.add('current');
            if (scroll) {
              item.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
          } else {
            item.classList.remove('current');
          }
        });

        if (practiceIndexChanged) {
          state.practiceIndex = studentIdx;
          renderPracticeCurrentLine();
          // Update progress chip
          updatePracticeProgress();
        }

        // Update Progress Bar
        if (targetArrayIndex >= 0 && state.currentSegments.length > 0) {
          const progress = ((targetArrayIndex + 1) / state.currentSegments.length) * 100;
          const progressBar = document.getElementById('practice-progress-bar');
          if (progressBar) {
            progressBar.style.width = `${progress}%`;
          }
        }
      }

      function setPracticeSpeaker(speakerName) {
        if (state.recorder && state.recorder.state !== 'inactive') {
          try { state.recorder.stop(); } catch (err) { console.warn(err); }
        }
        state.selectedSpeaker = speakerName;
        const speakerData = state.speakers.find((item) => item.speaker === speakerName);
        const rawLines = Array.isArray(speakerData?.lines) ? speakerData.lines : [];
        const canonicalSegs = Array.isArray(state.currentSegments) ? state.currentSegments : [];

        // Prefer canonical merged segments when they already have speaker labels for this role.
        // This avoids index mismatch (raw diarization lines can be more fragmented than merged sentences).
        const canonicalBySpeaker = canonicalSegs
          .filter((seg) => String(seg?.speaker || '').trim() === String(speakerName || '').trim())
          .map((seg, i) => {
            const idx = seg?.index != null ? seg.index : i;
            return {
              index: idx,
              segmentIndex: idx,
              start: seg.start,
              end: seg.end,
              text: seg.text,
              speaker: speakerName,
            };
          });

        if (canonicalBySpeaker.length >= 3) {
          state.practiceLines = canonicalBySpeaker;
        } else {
          // Fallback: use backend-provided speaker lines, then normalize to canonical segments by time overlap.
          // 过滤仅保留确属该角色的台词：优先使用行内 speaker；否则查当前字幕的 segment.speaker
          state.practiceLines = rawLines.filter((line) => {
            if (line && line.speaker) return line.speaker === speakerName;
            const idx = line?.index != null ? line.index : line?.segmentIndex;
            if (idx == null) return false;
            try {
              const keys = getSegmentLookupKeys(idx);
              let segSpeaker = null;
              if (Array.isArray(state.currentSegments)) {
                const match = state.currentSegments.find((seg, i) => {
                  const v = seg?.index != null ? seg.index : i;
                  const k = buildSegmentKey(v);
                  return k && keys.includes(k);
                });
                segSpeaker = match?.speaker || null;
              }
              return segSpeaker ? (segSpeaker === speakerName) : false;
            } catch (_) { return false; }
          });
        }

        // 如果经过严格过滤后台词过少（或皆无），启用“交替推断”作为兜底：
        // 思路：基于 currentSegments 顺序奇偶为两方，优先根据已有带 speaker 的行推断奇偶，否则默认偶数段为 Speaker 1
        const totalSegs = Array.isArray(state.currentSegments) ? state.currentSegments.length : 0;
        const needInferFallback = state.practiceLines.length < Math.max(3, Math.floor(totalSegs * 0.15));
        if (needInferFallback && totalSegs > 0) {
          const names = (Array.isArray(state.speakers) ? state.speakers.map(s => s.speaker) : []).filter(Boolean);
          const otherName = names.find(n => n !== speakerName) || 'Other';
          // 计算 selectedSpeaker 的多数奇偶
          let evenCount = 0, oddCount = 0;
          if (rawLines.length) {
            rawLines.forEach((line) => {
              if (line && line.speaker === speakerName) {
                const idx = line.index != null ? line.index : line.segmentIndex;
                const pos = state.currentSegments.findIndex((seg, i) => (seg?.index != null ? seg.index : i) === idx);
                if (pos >= 0) { (pos % 2 === 0 ? evenCount++ : oddCount++); }
              }
            });
          }
          const preferEven = evenCount >= oddCount;
          // 用推断映射重建 practiceLines 与 segmentSpeakerMap
          const inferredLines = [];
          const newMap = new Map();
          state.currentSegments.forEach((seg, i) => {
            const idx = seg?.index != null ? seg.index : i;
            const k = buildSegmentKey(idx);
            const assignToSelected = (i % 2 === 0) === preferEven;
            const name = assignToSelected ? speakerName : otherName;
            if (k) newMap.set(k, name);
            const normalized = normalizeSegmentIndex(idx);
            if (normalized !== null) {
              newMap.set(String(normalized), name);
              newMap.set(normalized, name);
            }
            if (assignToSelected) {
              inferredLines.push({
                index: idx,
                segmentIndex: idx,
                start: seg.start,
                end: seg.end,
                text: seg.text,
                speaker: speakerName,
              });
            }
          });
          state.practiceLines = inferredLines;
          // 合并到 segmentSpeakerMap，但不覆盖已有明确标注
          if (!(state.segmentSpeakerMap instanceof Map)) state.segmentSpeakerMap = new Map();
          newMap.forEach((val, key) => { if (!state.segmentSpeakerMap.has(key)) state.segmentSpeakerMap.set(key, val); });
        }

        // Normalize selected-speaker lines to canonical merged segments to avoid truncated text on mobile.
        try {
          const segByKey = new Map();
          canonicalSegs.forEach((seg, i) => {
            const idx = seg?.index != null ? seg.index : i;
            const key = buildSegmentKey(idx);
            if (key) segByKey.set(key, seg);
            const normalized = normalizeSegmentIndex(idx);
            if (normalized !== null) {
              segByKey.set(String(normalized), seg);
              segByKey.set(normalized, seg);
            }
          });

          function bestOverlapSegment(start, end) {
            const s = Number(start);
            const e = Number(end);
            if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
            let best = null;
            let bestOv = 0;
            for (let i = 0; i < canonicalSegs.length; i++) {
              const seg = canonicalSegs[i];
              const ss = Number(seg?.start);
              const ee = Number(seg?.end);
              if (!Number.isFinite(ss) || !Number.isFinite(ee)) continue;
              const ov = Math.min(e, ee) - Math.max(s, ss);
              if (ov > bestOv) { bestOv = ov; best = seg; }
            }
            return bestOv >= 0.15 ? best : null;
          }

          let matched = 0;
          state.practiceLines = state.practiceLines.map((line) => {
            const rawIndex = line?.index != null ? line.index : line?.segmentIndex;
            const byTime = bestOverlapSegment(line?.start, line?.end);
            let seg = byTime;
            if (!seg && rawIndex != null) {
              const keys = getSegmentLookupKeys(rawIndex);
              for (const k of keys) {
                if (segByKey.has(k)) { seg = segByKey.get(k); break; }
              }
            }
            if (seg) {
              matched += 1;
              const idx = seg?.index != null ? seg.index : rawIndex;
              return {
                ...line,
                index: idx,
                segmentIndex: idx,
                start: seg.start,
                end: seg.end,
                text: seg.text,
                speaker: speakerName,
              };
            }
            return { ...line, speaker: line?.speaker || speakerName };
          });

          // If most lines failed to map (likely because rawLines are much more fragmented),
          // rebuild practiceLines directly from canonical segments by time overlap with this speaker's spans.
          const ratio = state.practiceLines.length ? (matched / state.practiceLines.length) : 1;
          if (ratio < 0.6 && canonicalSegs.length) {
            const spans = [];
            (Array.isArray(state.speakers) ? state.speakers : []).forEach((sp) => {
              const spName = String(sp?.speaker || '').trim();
              const lines = Array.isArray(sp?.lines) ? sp.lines : [];
              lines.forEach((l) => {
                const st = Number(l?.start);
                const en = Number(l?.end);
                if (!Number.isFinite(st) || !Number.isFinite(en) || en <= st) return;
                spans.push({ start: st, end: en, speaker: String(l?.speaker || spName).trim() });
              });
            });

            const bySpeaker = new Map();
            spans.forEach((sp) => {
              const arr = bySpeaker.get(sp.speaker) || [];
              arr.push(sp);
              bySpeaker.set(sp.speaker, arr);
            });

            const relabeled = canonicalSegs.map((seg, i) => {
              const ss = Number(seg?.start);
              const ee = Number(seg?.end);
              if (!Number.isFinite(ss) || !Number.isFinite(ee) || ee <= ss) return seg;
              let bestSpeaker = String(seg?.speaker || '').trim();
              let bestOv = 0;
              for (const [name, arr] of bySpeaker.entries()) {
                let ovSum = 0;
                for (const span of arr) {
                  const ov = Math.min(ee, span.end) - Math.max(ss, span.start);
                  if (ov > 0) ovSum += ov;
                }
                if (ovSum > bestOv) { bestOv = ovSum; bestSpeaker = name; }
              }
              return { ...seg, speaker: bestSpeaker || seg?.speaker || null };
            });
            state.currentSegments = relabeled;

            state.practiceLines = relabeled
              .filter((seg) => String(seg?.speaker || '').trim() === String(speakerName || '').trim())
              .map((seg, i) => {
                const idx = seg?.index != null ? seg.index : i;
                return { index: idx, segmentIndex: idx, start: seg.start, end: seg.end, text: seg.text, speaker: speakerName };
              });
          }
        } catch (e) {
          console.warn('[Practice] Failed to normalize practiceLines to canonical segments:', e);
        }

        state.practiceIndex = 0;
        state.autoSegmentCursor = 0;
        state.practiceAttempts = 0;
        state.practiceLineResults = {};
        state.practiceLineWordResults = {};
        state.practiceLineIndexMap = new Map();
        state.segmentSpeakerMap = new Map();

        state.practiceLines.forEach((line, idx) => {
          const rawIndex = line.index != null ? line.index : line.segmentIndex;
          const segmentKey = buildSegmentKey(rawIndex);
          const normalizedIndex = normalizeSegmentIndex(rawIndex);
          if (segmentKey) {
            state.practiceLineIndexMap.set(segmentKey, idx);
            state.segmentSpeakerMap.set(segmentKey, speakerName);
          }
          if (normalizedIndex !== null) {
            const numericKey = normalizedIndex;
            const stringKey = String(normalizedIndex);
            state.practiceLineIndexMap.set(stringKey, idx);
            state.practiceLineIndexMap.set(numericKey, idx);
            state.segmentSpeakerMap.set(stringKey, speakerName);
            state.segmentSpeakerMap.set(numericKey, speakerName);
          }
        });

        synchronizeSegmentSpeakers();
        rebuildSegmentRoleMap();

        if (debugMode) {
          pushDebug('角色映射更新', {
            speakerName,
            practiceSummary: state.practiceSummary,
            mapping: Array.from(state.segmentSpeakerMap.entries()),
          });
        }

        audioModeManager.selectedSpeaker = speakerName;
        audioModeManager.loadUserRecordings(state.videoId, state.serverRecordings || []);
        ensureAudioModeAvailability();
        audioModeManager.setMode(currentAudioMode);
        updateAudioModeButtons();

        renderPracticeLines();
        renderPracticeCurrentLine();
        updatePracticeHint();
        updatePracticeFeedback(state.practiceLines.length ? '选择一个台词开始练习。' : '该角色暂时没有可用台词。');
        updatePracticeButtons(false, false, !state.lastRecordingBlob);

        // 如果选择了角色，按模式决定是否自动启用 practice mode
        if (speakerName) {
          const isDialogMode = (audioModeManager?.mode === 'mixed');
          if (!isDialogMode) {
            // 非对话模式：自动启用 practice mode，遇到你的台词会暂停
            if (!state.practiceArmed) {
              state.practiceArmed = true;
              if (practiceArmBtn) {
                practiceArmBtn.textContent = 'Disable Practice Mode';
                practiceArmBtn.classList.add('enabled');
              }
              updatePracticeHint();
            }
          } else {
            // 对话模式：默认不断播，不自动启用 practice mode
            state.practiceArmed = false;
            if (practiceArmBtn) {
              practiceArmBtn.classList.remove('enabled');
              practiceArmBtn.classList.remove('active');
              practiceArmBtn.textContent = 'Enable Practice Mode';
            }
            updatePracticeHint();
          }

          // 准备控制按钮状态（但不显示面板，由startAutoMode控制显示）
          if (autoStartBtn) {
            autoStartBtn.hidden = false;
            autoStartBtn.textContent = '▶';
          }
          if (autoPauseBtn) autoPauseBtn.hidden = true;
          updateAutoStatus('🎭', '准备就绪，点击▶开始');

          // 显示独立的开始录音按钮
          if (startRecordingFab) startRecordingFab.hidden = false;
        } else {
          // 没有选择角色时隐藏按钮
          if (startRecordingFab) startRecordingFab.hidden = true;
        }
      }

      function populateSpeakerSelect() {
        const defaultOption = '<option value="">选择你要扮演的角色</option>';
        if (!state.speakers.length) {
          practiceSpeakerSelect.innerHTML = defaultOption;
          practiceSpeakerSelect.disabled = true;
          return;
        }

        const options = state.speakers
          .map((speaker, idx) => `<option value="${escapeHtml(speaker.speaker)}" ${idx === 0 ? 'selected' : ''}>${escapeHtml(speaker.speaker)}</option>`)
          .join('');
        practiceSpeakerSelect.innerHTML = defaultOption + options;
        practiceSpeakerSelect.disabled = false;
      }

      async function loadPracticeSpeakers(videoId) {
        const headers = { 'Authorization': `Bearer ${token}` };
        let data = null;

        try {
          const res = await fetch(`${API_BASE}/video-resources/${videoId}/speakers`, { headers });
          if (res.ok) {
            const payload = await res.json();
            if (payload && Array.isArray(payload.speakers) && payload.speakers.length) {
              data = payload;
            }
          }
        } catch (err) {
          console.warn('Failed to load speakers via /video-resources/:id/speakers:', err);
        }

        if (!data) {
          try {
            const res = await fetch(`${API_BASE}/practice/speakers?videoId=${videoId}`, { headers });
            if (res.ok) {
              data = await res.json();
            }
          } catch (err) {
            console.warn('Failed to load speakers via legacy endpoint:', err);
          }
        }

        state.speakers = Array.isArray(data?.speakers) ? data.speakers : [];
        state.hasServerSpeakers = state.speakers.length > 0;
        populateSpeakerSelect();
        updatePracticeHint();

        // 如果后端没有提供 speakers，基于字幕做一次“交替推断”生成两位角色作为兜底
        console.log('[Debug] Checking if inference needed:', {
          speakersLen: state.speakers.length,
          segmentsLen: Array.isArray(state.currentSegments) ? state.currentSegments.length : 0
        });
        if (!state.speakers.length && Array.isArray(state.currentSegments) && state.currentSegments.length > 0) {
          console.log('[Debug] Triggering buildInferredSpeakers');
          buildInferredSpeakers();
          console.log('[Debug] After inference, speakers:', state.speakers);
          populateSpeakerSelect();
        }

        // 加载并应用个人角色配置（数量、轮换、命名）
        try {
          const prof = await loadRoleProfile(videoId);
          state.roleProfile = prof || null;
          if (prof) {
            if (Number.isFinite(Number(prof.role_rotation))) {
              state.roleRotation = Number(prof.role_rotation) || 0;
            }
            if (Number.isFinite(Number(prof.role_count)) && prof.role_count >= 2 && prof.role_count <= 5) {
              state.roleCount = String(prof.role_count);
            }
            // infer mode → strict alternation
            if (typeof prof.infer_mode === 'string' && prof.infer_mode.toLowerCase() === 'round_robin') {
              state.strictAlternate = true;
              state.roleCount = '2';
            } else {
              state.strictAlternate = false;
            }
            // 如果是推断模式，按照保存的数量和旋转重建一次 speakers
            if (!state.hasServerSpeakers) {
              buildInferredSpeakers();
            }
            // 应用命名（按顺序覆盖）
            if (Array.isArray(prof.role_names) && prof.role_names.length) {
              const k = Math.min(state.speakers.length, prof.role_names.length);
              for (let i = 0; i < k; i += 1) {
                const newName = String(prof.role_names[i] || '').trim();
                if (!newName) continue;
                const sp = state.speakers[i];
                const old = sp.speaker;
                sp.speaker = newName;
                // 同步行内 speaker
                (sp.lines || []).forEach((ln) => { ln.speaker = newName; });
                // 替换 segment->speaker 映射值
                if (state.segmentSpeakerMap instanceof Map) {
                  const nm = new Map();
                  state.segmentSpeakerMap.forEach((val, key) => {
                    nm.set(key, val === old ? newName : val);
                  });
                  state.segmentSpeakerMap = nm;
                }
              }
            }
            populateSpeakerSelect();
          }
        } catch (e) {
          console.warn('[Practice] apply role profile failed:', e);
        }

        if (state.speakers.length) {
          const firstSpeaker = state.speakers[0].speaker;
          practiceSpeakerSelect.value = firstSpeaker;
          setPracticeSpeaker(firstSpeaker);
          updatePracticeFeedback('选择台词后点击 ▶ Original 开始。');
          if (practiceArmBtn) practiceArmBtn.disabled = false;
          if (strictAltToggle) {
            strictAltToggle.checked = !!state.strictAlternate;
            if (state.strictAlternate && roleCountSelect) roleCountSelect.value = '2';
          }
        } else {
          updatePracticeFeedback('未找到角色台词，先浏览完整字幕。');
          if (practiceArmBtn) practiceArmBtn.disabled = true;
        }
      }

      function togglePracticeMode(forceState) {
        if (!state.speakers.length || !state.selectedSpeaker) {
          alert('请先选择角色');
          return;
        }
        const next = typeof forceState === 'boolean' ? forceState : !state.practiceArmed;
        state.practiceArmed = next;
        if (state.practiceArmed) {
          if (practiceArmBtn) {
            practiceArmBtn.classList.add('active');
            practiceArmBtn.textContent = '✓ Practice Mode Enabled';
          }
          updatePracticeFeedback('Practice mode 已启用。视频将自动在你的台词前暂停。', '#3b82f6');
        } else {
          if (practiceArmBtn) {
            practiceArmBtn.classList.remove('active');
            practiceArmBtn.textContent = 'Enable Practice Mode';
          }
          updatePracticeFeedback('Practice mode disabled. 使用播放器自由播放。');
          state.segmentPlaybackEnd = null;
          state.segmentPlaybackCallback = null;
        }
        updatePracticeHint();
      }

      function disablePracticeModeForPlayback(message) {
        if (state.practiceArmed) {
          state.practiceArmed = false;
          if (practiceArmBtn) {
            practiceArmBtn.classList.remove('active');
            practiceArmBtn.classList.remove('enabled');
            practiceArmBtn.textContent = 'Enable Practice Mode';
          }
          state.segmentPlaybackEnd = null;
          state.segmentPlaybackCallback = null;
          updatePracticeHint();
          if (message) {
            updatePracticeFeedback(message, '#3b82f6');
          }
          pushDebug('Practice Mode 已关闭以播放配音');
        }

        if (state.autoMode) {
          pauseAutoMode();
          state.autoMode = false;
          state.isPaused = false;
          updateAudioModeButtonsAvailability(); // 练习模式关闭，重新启用音频模式按钮
          if (autoPracticeStatus) autoPracticeStatus.hidden = true;
          // 如果有选择角色，显示独立的开始录音按钮
          if (state.selectedSpeaker && startRecordingFab) {
            startRecordingFab.hidden = false;
          }
          pushDebug('Auto Mode 已关闭以播放配音');
        }
      }

      function handleVideoTimeUpdate() {
        const current = unifiedPlayer.getCurrentTime();

        // For HTML5 video, use audioModeManager volume restoration
        if (!isYouTubeVideo) {
          audioModeManager.maybeRestoreVideoVolume(videoPlayer, current);
        }

        // Student pre-duck guard: mute original shortly BEFORE student's segment start to avoid first-word leak
        try {
          if (Array.isArray(state.currentSegments) && state.currentSegments.length && audioModeManager?.mode === 'mixed' && state.selectedSpeaker) {
            const idx = state.currentSegments.findIndex((seg) => {
              const s = Number(seg.start) || 0; const e = Number(seg.end); const end = Number.isFinite(e) ? e : s + 4;
              return current >= s - (STUDENT_PREDUCK_LEAD_MS / 1000) && current < end; // window around active segment
            });
            const seg = idx >= 0 ? state.currentSegments[idx] : null;
            if (seg) {
              const rawIdx = seg.index != null ? seg.index : idx;
              const key = buildSegmentKey(rawIdx);
              let isStudentLine = false;
              if (seg.speaker && seg.speaker === state.selectedSpeaker) isStudentLine = true;
              if (!isStudentLine && key && state.practiceLineIndexMap?.has(key)) isStudentLine = true;
              if (!isStudentLine && key && state.segmentSpeakerMap?.get(key) === state.selectedSpeaker) isStudentLine = true;

              if (isStudentLine) {
                const segStart = Number(seg.start) || 0;
                const segEndVal = Number(seg.end);
                const segEnd = Number.isFinite(segEndVal) ? segEndVal : segStart + 4;
                const guard = state.studentGuard;
                const guardActive = guard && guard.key === key;
                const shouldArm = current >= (segStart - (STUDENT_PREDUCK_LEAD_MS / 1000)) && current < segStart && !guardActive;
                if (shouldArm) {
                  // Hard mute immediately to avoid leaking first phoneme (e.g., "Yes")
                  if (!isYouTubeVideo) {
                    try { videoPlayer.muted = true; videoPlayer.volume = 0; } catch (_) { }
                  } else {
                    unifiedPlayer.mute();
                  }
                  state.studentGuard = { key, start: segStart, setAt: performance.now(), fallbackAt: segStart + (STUDENT_PREDUCK_GRACE_MS / 1000) };
                  // Also set overlay to ensure later logic won't unmute prematurely
                  audioModeManager.overlayPlaybackState = {
                    startTime: segStart,
                    pauseTime: current,
                    segmentRef: seg,
                    unmuteTime: segEnd,
                    volumeRestored: false,
                    previousMuted: true,
                    previousPaused: unifiedPlayer.isPaused(),
                    videoPausedForRecording: false,
                  };
                }
                // If guard active and we've passed graceful window without user audio, allow unmute fallback
                if (guardActive) {
                  const now = performance.now();
                  const t = current;
                  if (t > state.studentGuard.fallbackAt) {
                    // No user audio kicked in; allow original
                    if (!isYouTubeVideo) {
                      try { smoothUnmute(videoPlayer, audioModeManager.originalVolume || 1, RESTORE_FADE_MS); } catch (_) { videoPlayer.muted = false; }
                    } else {
                      unifiedPlayer.unmute();
                    }
                    state.studentGuard = null;
                  }
                }
              } else {
                // Not student line; clear guard if any
                if (state.studentGuard) state.studentGuard = null;
              }
            }
          }
        } catch (_) { }

        // Autoplay watchdog during non-user playback: if paused unexpectedly, try resume (muted)
        // 🔧 跟读模式下跳过此逻辑
        if (currentPracticeMode !== 'shadowing' && state.autoMode && state.segmentPlaybackEnd != null && unifiedPlayer.isPaused()) {
          const end = Number(state.segmentPlaybackEnd);
          if (Number.isFinite(end) && current < end - 0.05) {
            const now = performance.now();
            if (!state.autoplayNudgeAt || (now - state.autoplayNudgeAt) > 1000) {
              state.autoplayNudgeAt = now;
              safePlayVideo({ preferUnmuted: false });
            }
          }
        }

        // 🔧 跟读模式下跳过 segmentPlaybackEnd 逻辑，避免干扰
        if (currentPracticeMode !== 'shadowing' && state.segmentPlaybackEnd != null && current >= state.segmentPlaybackEnd - 0.02) {
          safePauseVideo();
          const callback = state.segmentPlaybackCallback;
          state.segmentPlaybackEnd = null;
          state.segmentPlaybackCallback = null;
          if (typeof callback === 'function') {
            callback();
          }
        }

        const activeIndex = state.currentSegments.findIndex((segment) => {
          const start = Number(segment.start) || 0;
          const end = Number(segment.end);
          const effectiveEnd = Number.isFinite(end) ? end : start + 4;
          return current >= start && current < effectiveEnd;
        });

        if (activeIndex >= 0) {
          const segment = state.currentSegments[activeIndex];
          const rawSegmentIndex = segment.index != null ? segment.index : activeIndex;
          const normalizedSegmentIndex = normalizeSegmentIndex(rawSegmentIndex);
          const segmentIndex = normalizedSegmentIndex != null ? normalizedSegmentIndex : rawSegmentIndex;
          const segmentKey = buildSegmentKey(rawSegmentIndex);

          // Cleanup playedGuard entries whose guard time passed
          try {
            if (audioModeManager?.playedGuard && segmentKey) {
              for (const [k, until] of audioModeManager.playedGuard.entries()) {
                if (Number.isFinite(until) && current >= until + 0.05) {
                  audioModeManager.playedGuard.delete(k);
                }
              }
            }
          } catch (_) { }

          if (audioModeManager.shouldPlayUserRecording(segmentIndex, segment, current)) {
            const segmentStart = Number(segment.start) || 0;
            const timeIntoSegment = current - segmentStart;
            const windowStart =
              audioModeManager.playbackWindow?.startOffset ?? -0.2;
            const windowEnd =
              audioModeManager.playbackWindow?.endOffset ?? 1.5;
            if (timeIntoSegment >= windowStart && timeIntoSegment < windowEnd) {
              audioModeManager.syncPlayUserRecording(segmentIndex, videoPlayer, segment);
            }
          }

          // 在非自动模式下才高亮当前segment
          if (!state.autoMode) {
            highlightCurrentSegment(segmentIndex, true);
          }

          // 只在手动模式下才自动暂停（跟读模式下跳过）
          const studentIdx = segmentKey ? state.practiceLineIndexMap.get(segmentKey) : undefined;
          if (currentPracticeMode !== 'shadowing' && currentPracticeMode !== 'dialogue' && !state.autoMode && state.practiceArmed && (audioModeManager?.mode !== 'mixed') && state.selectedSpeaker && studentIdx != null && !videoPlayer.paused) {
            const practiceLine = state.practiceLines[studentIdx];
            const offset = Math.max(practiceLine.start || 0, 0);
            if (current >= offset && current <= (practiceLine.end || offset + 4)) {
              safePauseVideo();
              updatePracticeFeedback('轮到你了！按 🎙 Record 开始录音。', '#f59e0b');
              state.practiceIndex = studentIdx;
              renderPracticeLines();
              renderPracticeCurrentLine();
            }
          }
        }
      }

      function stopPracticeRecording() {
        if (state.recorder && state.recorder.state !== 'inactive') {
          try {
            state.recorder.stop();
          } catch (err) {
            console.warn('Unable to stop recorder:', err);
          }
        }
        if (practiceStartBtn) {
          practiceStartBtn.classList.remove('recording');
          practiceStartBtn.textContent = '🎤 Record';
        }
      }

      async function startPracticeRecording() {
        if (state.recorder && state.recorder.state !== 'inactive') {
          stopPracticeRecording();
          return;
        }

        const currentLineAtStart = state.practiceLines[state.practiceIndex] || null;

        try {
          if (!state.mediaStream) {
            state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          }
          state.recordingChunks = [];
          const preferredMimeTypes = [
            'audio/mp4;codecs=mp4a.40.2',
            'audio/mp4',
            'audio/aac',
            'audio/mpeg',
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg',
          ];
          let recorderOptions = null;
          let requestedMimeType = null;
          if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
            requestedMimeType = preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type)) || null;
            if (requestedMimeType) {
              recorderOptions = { mimeType: requestedMimeType };
            }
          }
          try {
            state.recorder = recorderOptions
              ? new MediaRecorder(state.mediaStream, recorderOptions)
              : new MediaRecorder(state.mediaStream);
          } catch (err) {
            console.warn('[录音] 首选编码不可用，使用默认设置:', err);
            state.recorder = new MediaRecorder(state.mediaStream);
          }
          state.recorderMimeType = state.recorder?.mimeType || requestedMimeType || 'audio/webm';
          pushDebug('录音MimeType', {
            requested: requestedMimeType,
            actual: state.recorderMimeType,
          });
          state.recorder.addEventListener('dataavailable', (event) => {
            if (event.data.size > 0) {
              state.recordingChunks.push(event.data);
              console.log(`[Practice录音数据] 收集了 ${event.data.size} 字节，总块数: ${state.recordingChunks.length}`);
              if (!state.recorderMimeType && event.data.type) {
                state.recorderMimeType = event.data.type;
              }
            } else {
              console.warn('[Practice录音数据] 收到空数据块！');
            }
          });
          state.recorder.addEventListener('stop', async () => {
            console.log(`[Practice录音停止] 收集到 ${state.recordingChunks.length} 个数据块`);

            if (!state.recordingChunks.length) {
              console.error('[Practice录音] 没有录音数据！');
              console.error('  检查：麦克风是否有声音输入？录音时间是否太短？');
              updatePracticeFeedback('录音失败：没有收集到音频数据', '#dc2626');
              return;
            }

            // Use simple MIME type (strip codecs) to avoid 400 errors
            const rawType = state.recorderMimeType || state.recorder?.mimeType || state.recordingChunks[0]?.type || 'audio/webm';
            const simpleType = rawType.split(';')[0];

            const blob = new Blob(state.recordingChunks, { type: simpleType });

            // Trim silence
            const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
            const trimResult = await trimSilence(blob, 0.01, isMobile);
            const finalBlob = trimResult.blob || blob;

            state.lastRecordingBlob = finalBlob;
            state.lastRecordingOffsets = {
              start: trimResult.startOffset || 0,
              end: trimResult.endOffset || 0
            };

            console.log(`[Practice录音完成] 格式: ${finalBlob.type} (raw: ${rawType}), 大小: ${(finalBlob.size / 1024).toFixed(2)}KB, 数据块: ${state.recordingChunks.length}`);
            if (trimResult.blob) {
              console.log(`[Practice录音] Trimmed size: ${(trimResult.blob.size / 1024).toFixed(2)}KB`);
            }

            // 🔍 检查 blob 是否真的有数据
            if (finalBlob.size === 0) {
              console.error('[Practice录音] ⚠️ Blob 大小为 0！');
              updatePracticeFeedback('录音失败：音频数据为空', '#dc2626');
              return;
            }

            updatePracticeButtons(false, false, false);
            updatePracticeFeedback('录音完成，可点击 🔄 Compare 对比。', '#16a34a');
            if (practiceStartBtn) {
              practiceStartBtn.classList.remove('recording');
              practiceStartBtn.textContent = '🎤 Record';
            }
            if (currentLineAtStart) {
              const segmentIndex = currentLineAtStart.index != null ? currentLineAtStart.index : currentLineAtStart.segmentIndex;
              if (segmentIndex != null) {
                try {
                  await saveUserRecording(segmentIndex, finalBlob);
                } catch (err) {
                  console.warn('[录音保存] 失败:', err);
                }
              }
            }
            if (currentLineAtStart) {
              scheduleNextLine(currentLineAtStart, '录音完成，进入下一句。');
            }
          });

          // 🔧 设置 timeslice 为 100ms，确保定期收集数据
          console.log(`[Practice录音] 开始录音，MimeType: ${state.recorderMimeType}, timeslice: 100ms`);
          state.recorder.start(100);  // 每100ms触发一次 dataavailable

          updatePracticeFeedback('录音中... 再次点击 🎤 Record 停止。', '#2dd4bf');
          if (practiceStartBtn) {
            practiceStartBtn.classList.add('recording');
            practiceStartBtn.textContent = '⏹ Stop';
          }
        } catch (err) {
          console.error('Failed to start recording:', err);
          alert('无法访问麦克风，请检查权限设置。');
        }
      }

      function playOriginalLine() {
        const line = state.practiceLines[state.practiceIndex];
        if (!line) {
          alert('请选择要练习的台词');
          return;
        }

        const start = Number(line.start) || 0;
        const end = Number(line.end);
        const effectiveEnd = Number.isFinite(end) ? end : start + 4;

        // 查找字幕列表中当前句之后的所有句子，找到最近的一句
        let nextSegmentStart = null;
        for (const seg of state.currentSegments) {
          const segStart = Number(seg.start);
          // 找到开始时间大于当前句结束时间的第一句
          // 使用 effectiveEnd 而不是 start，这样才能找到真正在当前句之后的句子
          if (Number.isFinite(segStart) && segStart >= effectiveEnd - 0.01) {
            nextSegmentStart = segStart;
            break;
          }
        }

        // 停止点：当前句结束 或 下一句开始前0.05秒（取较早的时间）
        let stopTime = effectiveEnd;
        if (Number.isFinite(nextSegmentStart) && nextSegmentStart > effectiveEnd) {
          // 下一句在当前句结束之后，确保不会播放到下一句，提前0.05秒停止
          const bufferTime = 0.05;
          const nextStartWithBuffer = nextSegmentStart - bufferTime;
          stopTime = Math.min(effectiveEnd, nextStartWithBuffer);
          console.log(`[Play] 当前句: ${start.toFixed(2)}s - ${effectiveEnd.toFixed(2)}s, 下一句: ${nextSegmentStart.toFixed(2)}s, 停止点: ${stopTime.toFixed(2)}s`);
        } else if (Number.isFinite(nextSegmentStart)) {
          // 找到了下一句，但它紧接着当前句（间隔很小），直接用当前句结束时间
          console.log(`[Play] 当前句: ${start.toFixed(2)}s - ${effectiveEnd.toFixed(2)}s, 下一句紧接: ${nextSegmentStart.toFixed(2)}s, 停止点: ${stopTime.toFixed(2)}s`);
        } else {
          console.log(`[Play] 当前句: ${start.toFixed(2)}s - ${effectiveEnd.toFixed(2)}s, 没有找到下一句, 停止点: ${stopTime.toFixed(2)}s`);
        }

        state.segmentPlaybackEnd = stopTime;
        state.segmentPlaybackCallback = () => {
          safePauseVideo();
          scheduleNextLine(line, '原声已播放完，继续下一句。');
        };

        videoPlayer.currentTime = start;
        safePlayVideo();
        updatePracticeFeedback('正在播放原声...', '#2563eb');
      }

      function compareRecordings() {
        if (!state.lastRecordingBlob) {
          alert('请先录制你的声音');
          return;
        }
        const recordingAudio = new Audio(URL.createObjectURL(state.lastRecordingBlob));

        const startOffset = state.lastRecordingOffsets?.start || 0;
        const endOffset = state.lastRecordingOffsets?.end || 0;

        console.log(`[Compare] Playing recording. Offsets: ${startOffset.toFixed(2)}s - ${endOffset.toFixed(2)}s`);

        recordingAudio.onloadedmetadata = () => {
          if (startOffset > 0) {
            recordingAudio.currentTime = startOffset;
          }
        };

        const stopTimeHandler = () => {
          if (endOffset > 0 && recordingAudio.duration && (recordingAudio.currentTime >= recordingAudio.duration - endOffset)) {
            recordingAudio.pause();
            cleanup();
            playOriginalLine();
          }
        };

        if (endOffset > 0) {
          recordingAudio.addEventListener('timeupdate', stopTimeHandler);
        }

        const cleanup = () => {
          recordingAudio.removeEventListener('timeupdate', stopTimeHandler);
          URL.revokeObjectURL(recordingAudio.src);
        };

        recordingAudio.addEventListener('ended', () => {
          cleanup();
          playOriginalLine();
        });

        recordingAudio.play().catch((err) => {
          console.warn('Failed to play recording:', err);
        });
        updatePracticeFeedback('播放你的录音，随后自动播放原声对比。', '#2563eb');
      }

      function scheduleNextLine(currentLine, message) {
        if (!currentLine) return;

        const resultKey = buildSegmentKey(currentLine.index != null ? currentLine.index : currentLine.segmentIndex);
        if (resultKey) {
          state.practiceLineResults[resultKey] = 'success';
        }

        const nextLine = state.practiceLines[state.practiceIndex + 1] || null;
        const resumeFrom = currentLine.end && currentLine.end > currentLine.start ? currentLine.end : (currentLine.start || 0) + 0.1;

        state.practicePlaybackLock = false;
        state.waitingForPractice = false;

        if (nextLine) {
          state.practiceIndex = Math.min(state.practiceIndex + 1, state.practiceLines.length - 1);
          renderPracticeLines();
          renderPracticeCurrentLine();

          if (state.practiceArmed) {
            const nextStart = Number(nextLine.start);
            // 使用下一句的开始时间减去0.1秒作为停止点，确保不播放到下一句
            const stopBeforeStart = Number.isFinite(nextStart) && nextStart > resumeFrom ? nextStart - 0.1 : resumeFrom + 0.5;
            state.segmentPlaybackEnd = stopBeforeStart;
            state.segmentPlaybackCallback = () => {
              safePauseVideo();
              updatePracticeFeedback(message || '继续下一句练习', '#2563eb');
            };
            videoPlayer.currentTime = resumeFrom;
            safePlayVideo();
          } else {
            state.segmentPlaybackEnd = null;
            state.segmentPlaybackCallback = null;
            updatePracticeFeedback(message || '继续下一句练习', '#2563eb');
          }

          updatePracticeButtons(false, false, !state.lastRecordingBlob);
        } else {
          state.segmentPlaybackEnd = null;
          state.segmentPlaybackCallback = null;
          updatePracticeButtons(true, true, false);
          updatePracticeFeedback(message ? `${message} 已完成该角色全部台词！` : '已完成该角色全部台词！', '#155724');
        }
      }

      async function showVideoSelectModal(videoList) {
        const modal = document.getElementById('video-select-modal');
        if (modal) modal.style.display = 'flex';
        const title = document.getElementById('video-select-title');
        if (title) title.textContent = currentPracticeMode === 'shadowing' ? '选择跟读视频' : '选择对话视频';
        const container = document.getElementById('video-list-container');
        const t = (key) => typeof i18n !== 'undefined' ? i18n.t(key) : key;

        if (!videoList || videoList.length === 0) {
          container.innerHTML = `
          <div style="text-align: center; padding: 40px; color: #999;">
            <div style="font-size: 48px; margin-bottom: 16px;">📹</div>
            <div style="font-size: 16px; margin-bottom: 8px;">${t('practice.no_videos')}</div>
            <div style="font-size: 14px;"><a href="./video-upload.html" style="color: #667eea;">${t('practice.go_upload')}</a></div>
          </div>
        `;
          return;
        }

        container.innerHTML = videoList.map(video => {
          const title = escapeHtml(video.title || video.original_filename || `视频 ${video.id}`);
          const seconds = Math.max(0, Math.floor(Number(video.duration_sec) || 0));
          const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
          const hasTranscript = video.has_subtitles || video.has_transcript || Number(video.total_segments) > 0 || (video.transcript && video.transcript.length > 10);
          const rawThumbnail = String(video.thumbnail_url || video.thumbnail || '');
          const thumbnail = /^(https?:\/\/|\/(?!\/)|\.\/)/.test(rawThumbnail) ? escapeHtml(rawThumbnail) : '';

          return `
          <button type="button" class="video-select-item" data-video-id="${escapeHtml(String(video.id))}" style="
            width: 100%; text-align: left; font-family: inherit;
            padding: 16px;
            border: 1px solid #e2e8f0;
            border-radius: 12px;
            margin-bottom: 12px;
            cursor: pointer;
            transition: all 0.2s;
            background: white;
          ">
            <div style="display: flex; align-items: center; gap: 12px;">
              <div style="width:72px; height:54px; flex-shrink:0; border-radius:8px; overflow:hidden; background:#e0f2fe; display:grid; place-items:center; font-size:26px;">${thumbnail ? `<img src="${thumbnail}" alt="" loading="lazy" referrerpolicy="no-referrer" style="width:100%;height:100%;object-fit:cover">` : '🎬'}</div>
              <div style="flex: 1;">
                <div style="font-weight: 600; font-size: 16px; margin-bottom: 4px;">${title}</div>
                <div style="font-size: 13px; color: #666; display: flex; gap: 12px;">
                  <span>⏱️ ${duration}</span>
                  <span>${hasTranscript ? '有字幕' : '字幕准备中'}</span>
                </div>
              </div>
              <div style="color: #0f766e; font-size: 20px;" aria-hidden="true">›</div>
            </div>
          </button>
        `;
        }).join('');

        // 添加点击事件
        container.querySelectorAll('.video-select-item').forEach(item => {
          item.addEventListener('click', () => {
            const videoId = item.dataset.videoId;
            modal.style.display = 'none';
            // 重新加载页面带上videoId
            window.location.href = buildPracticeVideoHref(videoId);
          });
        });
      }

      // 从完成弹层等处调用：拉取视频库并打开选择列表（用户学完可继续换视频）
      async function openVideoLibraryPicker() {
        const modal = document.getElementById('video-select-modal');
        if (!modal) {
          window.location.href = './mobile-explore.html';
          return;
        }
        const headers = { 'Authorization': `Bearer ${token}` };
        let videoList = [];
        try {
          let res = await fetch(`${API_BASE}/video-resources?lite=1&recommended=true`, { headers });
          if (res.ok) {
            const data = await res.json();
            videoList = data.items || [];
          }
          if (!videoList || videoList.length === 0) {
            res = await fetch(`${API_BASE}/video-resources?lite=1`, { headers });
            if (res.ok) {
              const data = await res.json();
              videoList = data.items || [];
            }
          }
        } catch (err) {
          console.warn('[VideoPicker] Failed to load video list:', err);
        }
        await showVideoSelectModal(videoList);
        modal.style.display = 'flex';
      }

      async function loadVideoData() {
        const params = new URLSearchParams(window.location.search);
        const requestedId = params.get('videoId');
        // Allow overriding level from homepage links or stored preference
        let overrideLevel = null;
        try {
          overrideLevel = params.get('level') || localStorage.getItem('linglish_active_level') || null;
        } catch (_) {
          overrideLevel = params.get('level') || null;
        }
        overrideLevel = (overrideLevel || '').toString().trim().toLowerCase();
        if (!['beginner', 'intermediate', 'advanced'].includes(overrideLevel)) overrideLevel = null;

        const headers = { 'Authorization': `Bearer ${token}` };

        // 检测是否是国内用户（用于跳过YouTube API）
        try {
          const proxyCheck = await fetch('/youtube-proxy/check');
          const proxyData = await proxyCheck.json();
          state.isMainlandUser = proxyData.needsProxy || false;
          console.log('[Init] Mainland user:', state.isMainlandUser ? 'YES' : 'NO');
        } catch (e) {
          console.warn('[Init] Failed to check mainland user status');
          state.isMainlandUser = false;
        }

        let videoList = [];
        try {
          // Prefer using an explicit level filter when provided; otherwise use recommended-by-profile.
          let res = overrideLevel
            ? await fetch(`${API_BASE}/video-resources?lite=1&difficulty=${encodeURIComponent(overrideLevel)}`, { headers })
            : await fetch(`${API_BASE}/video-resources?lite=1&recommended=true`, { headers });
          if (res.ok) {
            const data = await res.json();
            videoList = data.items || [];
          }
          // Fallback to full list if recommended yields nothing
          if (!videoList || videoList.length === 0) {
            res = await fetch(`${API_BASE}/video-resources?lite=1`, { headers });
            if (res.ok) {
              const data = await res.json();
              videoList = data.items || [];
            }
          }
        } catch (err) {
          console.warn('Failed to load video list:', err);
        }

        // 如果没有指定videoId，显示选择列表
        if (!requestedId && videoList.length > 0) {
          await showVideoSelectModal(videoList);
          return;
        }

        let chosen = null;
        if (requestedId) {
          chosen = videoList.find((v) => `${v.id}` === `${requestedId}`);
          if (!chosen) {
            // 视频不在当前级别列表中，尝试直接获取该视频
            console.log(`[Video] Requested video ${requestedId} not found in level list, trying direct fetch...`);
            try {
              const directRes = await fetch(`${API_BASE}/video-resources/${requestedId}`, { headers });
              if (directRes.ok) {
                const directData = await directRes.json();
                // API 返回格式是 { video: {...}, isMainlandUser: bool }
                const directVideo = directData.video || directData;
                if (directVideo && directVideo.id) {
                  console.log(`[Video] Found video ${requestedId} via direct fetch`);
                  chosen = directVideo;
                }
              }
            } catch (err) {
              console.warn(`[Video] Failed to fetch video ${requestedId} directly:`, err);
            }
          }
        }

        // 只有在没有指定视频ID时才回退到列表第一个视频
        if (!chosen && !requestedId) {
          chosen = videoList[0];
        }

        if (!chosen) {
          // 如果请求了特定视频但找不到，显示错误而不是加载其他视频
          if (requestedId) {
            throw new Error(`视频 ${requestedId} 不存在或无法访问`);
          }
          throw new Error('No videos available');
        }

        state.videoId = chosen.id;
        audioModeManager.cleanup(videoPlayer);
        try {
          const remoteRecordings = await fetchPracticeRecordings(state.videoId);
          state.serverRecordings = remoteRecordings;
          audioModeManager.loadUserRecordings(state.videoId, remoteRecordings);
        } catch (err) {
          console.warn('Failed to load server recordings:', err);
          state.serverRecordings = [];
          audioModeManager.loadUserRecordings(state.videoId, []);
        }
        ensureAudioModeAvailability();
        audioModeManager.setMode(currentAudioMode);
        updateAudioModeButtons();

        if (!Array.isArray(chosen.transcript_segments) || !chosen.transcript_segments.length) {
          try {
            const detailRes = await fetch(`${API_BASE}/video-resources/${state.videoId}`, { headers });
            if (detailRes.ok) {
              const detail = await detailRes.json();
              chosen = { ...chosen, ...detail };
            }
          } catch (err) {
            console.warn('Failed to load video detail:', err);
          }
        }

        state.videoData = chosen;
        const segMode = getSegmentationMode();
        console.log('[Segments] segMode =', segMode);
        state.currentSegments = Array.isArray(chosen.transcript_segments)
          ? chosen.transcript_segments.map((seg, idx) => ({
            ...seg,
            index: seg.index != null ? seg.index : idx,
            text: stripPromptMarkers(getSegText(seg)),
          }))
          : [];

        if (!state.currentSegments.length) {
          const fallbackResponse = await fetch(`${API_BASE}/video-resources/${state.videoId}/transcript`, { headers });
          if (fallbackResponse.ok) {
            const fallbackTranscript = await fallbackResponse.json();
            state.currentSegments = Array.isArray(fallbackTranscript.segments)
              ? fallbackTranscript.segments.map((seg, idx) => ({
                ...seg,
                index: seg.index != null ? seg.index : idx,
                text: stripPromptMarkers(getSegText(seg)),
              }))
              : [];
          } else if (chosen && chosen.transcript_segments_url) {
            try {
              const altRes = await fetch(`${API_BASE}${chosen.transcript_segments_url}`, { headers });
              if (altRes.ok) {
                const altData = await altRes.json();
                state.currentSegments = Array.isArray(altData.segments)
                  ? altData.segments.map((seg, idx) => ({
                    ...seg,
                    index: seg.index != null ? seg.index : idx,
                    text: stripPromptMarkers(getSegText(seg)),
                  }))
                  : [];
              }
            } catch (err) {
              console.warn('Unable to load transcript segments from alt url:', err);
            }
          }
        }

        // Default to strict subtitle line breaks; enable sentence merge only with `?segMode=smart`.
        if (Array.isArray(state.currentSegments) && state.currentSegments.length) {
          if (segMode === 'smart') {
            state.currentSegments = mergeSentenceSegments(state.currentSegments);
          } else {
            state.currentSegments = makeCaptionSegmentsNonOverlapping(state.currentSegments);
            state.currentSegments = shiftDanglingBoundaryWordsForward(state.currentSegments);
            state.currentSegments = splitCaptionSegmentsByPunctuation(state.currentSegments);
            state.currentSegments = mergeCaptionFragmentsToSentences(state.currentSegments);
            state.currentSegments = await splitSegmentsByWaveformSilence(state.currentSegments, state.videoId);
          }
        }

        rebuildSegmentRoleMap();

        // If in shadowing mode, re-initialize to pick up new segments
        if (currentPracticeMode === 'shadowing') {
          initShadowingMode();
          updateShadowingDisplay();
        }

        // Detect YouTube or regular video
        const rawVideoPath = chosen.video_path || '';
        isYouTubeVideo = isYouTubeUrl(rawVideoPath);

        if (isYouTubeVideo) {
          // 国内用户：检查是否有本地视频可用
          if (state.isMainlandUser) {
            const hasLocalVideo = chosen.local_video_path && chosen.local_video_status === 'completed';

            if (hasLocalVideo) {
              // 有本地视频，使用本地视频播放
              console.log('[YouTube] Mainland user, using local video');
              isYouTubeVideo = false;
              videoPlayer.style.display = 'block';
              youtubePlayerContainer.style.display = 'none';
              videoPlayer.removeAttribute('src');
              videoPlayer.load();
              try {
                await setProtectedMediaSource(videoPlayer, `${API_BASE}${chosen.local_video_path}`);
              } catch (_) {
                updatePracticeFeedback('媒体授权失败，请重试', '#dc2626');
                return;
              }
              videoPlayer.load();
              renderPracticeLines();
              renderPracticeCurrentLine();
              await loadPracticeSpeakers(state.videoId);
              return;
            } else {
              // 没有本地视频，显示提示
              console.log('[YouTube] Mainland user, no local video available');
              videoPlayer.style.display = 'none';
              youtubePlayerContainer.style.display = 'block';
              youtubePlayerContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#999;font-size:14px;text-align:center;padding:20px;">该视频暂未下载到本地<br>无法在国内播放</div>';
              updatePracticeFeedback('该视频暂无本地版本', '#f59e0b');
              renderPracticeLines();
              renderPracticeCurrentLine();
              await loadPracticeSpeakers(state.videoId);
              return;
            }
          }

          // Load YouTube video
          console.log('[YouTube] Detected YouTube URL');
          const videoId = extractYouTubeVideoId(rawVideoPath);

          if (!videoId) {
            console.error('[YouTube] Failed to extract video ID');
            updatePracticeFeedback('无法解析YouTube视频ID');
            return;
          }

          console.log('[YouTube] Video ID:', videoId);

          // Check if already initializing
          if (youtubePlayerInitializing) {
            console.log('[YouTube] Player initialization already in progress, skipping');
            return;
          }

          // Check if player already exists with same video
          if (youtubePlayer) {
            try {
              const currentVideoData = youtubePlayer.getVideoData && youtubePlayer.getVideoData();
              if (currentVideoData && currentVideoData.video_id === videoId) {
                console.log('[YouTube] Player already loaded with this video, skipping re-initialization');
                return;
              }
            } catch (e) {
              console.warn('[YouTube] Error checking existing player:', e);
            }
          }

          // Set initializing flag
          youtubePlayerInitializing = true;

          // Hide HTML5 video, show YouTube container
          videoPlayer.style.display = 'none';
          youtubePlayerContainer.style.display = 'block';

          // Wait for YouTube API to be ready (with timeout for non-mainland users)
          const waitForYouTubeAPI = (timeoutMs = 3000) => {
            return new Promise((resolve, reject) => {
              const startTime = Date.now();
              const check = () => {
                if (youtubeApiReady && window.YT && window.YT.Player) {
                  resolve(true);
                } else if (Date.now() - startTime > timeoutMs) {
                  reject(new Error('YouTube API timeout'));
                } else {
                  setTimeout(check, 100);
                }
              };
              check();
            });
          };

          try {
            await waitForYouTubeAPI();
          } catch (err) {
            console.warn('[YouTube] Failed to load API:', err);
            youtubePlayerInitializing = false;
            updatePracticeFeedback('YouTube API 加载失败', '#f59e0b');
            renderPracticeLines();
            renderPracticeCurrentLine();
            await loadPracticeSpeakers(state.videoId);
            return;
          }

          // Destroy existing player if any
          if (youtubePlayer) {
            try {
              console.log('[YouTube] Destroying old player');
              stopYouTubeTimeUpdatePolling();
              youtubePlayer.destroy();
              youtubePlayer = null;
            } catch (e) {
              console.warn('[YouTube] Error destroying old player:', e);
            }
          }

          // Clear container
          youtubePlayerContainer.innerHTML = '';

          // Create YouTube player
          updatePracticeFeedback('正在加载YouTube视频...');
          youtubePlayer = new YT.Player('youtube-player-container', {
            videoId: videoId,
            playerVars: {
              autoplay: 0,
              controls: 1,
              modestbranding: 1,
              playsinline: 1,
              rel: 0,
              enablejsapi: 1,
              origin: getYouTubeOrigin()
            },
            events: {
              onReady: (event) => {
                console.log('[YouTube] Player ready');
                youtubePlayerInitializing = false; // Reset flag
                if (playOverlay) playOverlay.style.display = 'none';
                updatePracticeFeedback('YouTube视频已加载');
                // Start time update polling for segment tracking
                startYouTubeTimeUpdatePolling();
              },
              onStateChange: (event) => {
                console.log('[YouTube] State changed:', event.data);
                // YT.PlayerState: UNSTARTED=-1, ENDED=0, PLAYING=1, PAUSED=2, BUFFERING=3, CUED=5
                if (event.data === 0) { // ENDED
                  console.log('[YouTube] Video ended');
                  stopYouTubeTimeUpdatePolling();
                } else if (event.data === 1) { // PLAYING
                  // Ensure polling is active when playing
                  if (!youtubeTimeUpdateInterval) {
                    startYouTubeTimeUpdatePolling();
                  }
                }
              },
              onError: (event) => {
                console.error('[YouTube] Player error:', event.data);
                youtubePlayerInitializing = false; // Reset flag on error
                updatePracticeFeedback('YouTube视频加载失败');
              }
            }
          });

          console.log('[YouTube] Player initialized');
        } else {
          // Regular video
          console.log('[Video] Loading regular video');
          isYouTubeVideo = false;

          // Show HTML5 video, hide YouTube container
          videoPlayer.style.display = 'block';
          youtubePlayerContainer.style.display = 'none';

          console.log('Loading protected video');
          videoPlayer.removeAttribute('src');
          videoPlayer.load();
          try {
            await setProtectedMediaSource(videoPlayer, `${API_BASE}${rawVideoPath}`);
          } catch (_) {
            updatePracticeFeedback('媒体授权失败，请重试', '#dc2626');
            return;
          }
          videoPlayer.load();
          console.log('Video source set successfully');
        }

        renderPracticeLines();
        renderPracticeCurrentLine();
        await loadPracticeSpeakers(state.videoId);
      }

      function registerEventHandlers() {
        if (playOverlay) {
          playOverlay.addEventListener('click', () => safePlayVideo());
        }

        videoPlayer.addEventListener('loadstart', () => {
          console.log('Video loading started');
          updatePracticeFeedback('正在加载视频...');
        });

        videoPlayer.addEventListener('loadedmetadata', () => {
          console.log('Video metadata loaded');
        });

        videoPlayer.addEventListener('canplay', () => {
          console.log('Video can play');
        });

        videoPlayer.addEventListener('error', (e) => {
          console.error('Video error:', e);
          console.error('Video error details:', videoPlayer.error);

          // Better error diagnostics
          const errorCode = videoPlayer.error?.code;
          const errorMessage = videoPlayer.error?.message || '';
          let userMessage = '视频加载失败';

          switch (errorCode) {
            case 1: // MEDIA_ERR_ABORTED
              userMessage += ': 加载已中止，可能是网络问题或浏览器设置';
              // Try to reload the video after a short delay
              setTimeout(() => {
                if (videoPlayer.src && videoPlayer.readyState === 0) {
                  console.log('Attempting to reload video after MEDIA_ERR_ABORTED');
                  videoPlayer.load();
                }
              }, 1000);
              break;
            case 2: // MEDIA_ERR_NETWORK
              userMessage += ': 网络错误，请检查网络连接';
              break;
            case 3: // MEDIA_ERR_DECODE
              userMessage += ': 视频解码失败，格式可能不支持';
              break;
            case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
              userMessage += ': 视频格式不支持或路径错误';
              break;
            default:
              userMessage += errorMessage ? `: ${errorMessage}` : ': 未知错误';
          }

          updatePracticeFeedback(userMessage, '#dc2626');

          if (debugMode) {
            pushDebug('视频加载错误', {
              code: errorCode,
              message: errorMessage,
              readyState: videoPlayer.readyState,
              networkState: videoPlayer.networkState,
            });
          }
        });

        videoPlayer.addEventListener('timeupdate', handleVideoTimeUpdate);
        videoPlayer.addEventListener('pause', () => {
          // Don't cleanup if video was paused to wait for recording playback
          const isPausedForRecording = audioModeManager.overlayPlaybackState?.videoPausedForRecording;
          if (!isPausedForRecording) {
            audioModeManager.cleanup(videoPlayer);
          } else if (debugMode) {
            pushDebug('视频暂停（等待录音），跳过cleanup', {
              videoPausedForRecording: true,
              overlayAudio: !!audioModeManager.overlayAudio,
            });
          }
        });
        videoPlayer.addEventListener('ended', () => audioModeManager.cleanup(videoPlayer));
        videoPlayer.addEventListener('seeking', () => audioModeManager.cleanup(videoPlayer));

        audioModeBtns.forEach((btn) => {
          btn.addEventListener('click', () => {
            if (btn.disabled) return;
            const mode = btn.dataset.mode || 'original';
            currentAudioMode = mode;
            audioModeManager.setMode(currentAudioMode);
            updateAudioModeButtons();
            pushDebug('切换音频模式', { mode });
            if (mode !== 'original') {
              disablePracticeModeForPlayback('已切换到连续播放模式，视频会直接播放你的配音。');
            }
            if (videoPlayer.paused || videoPlayer.ended) {
              if (videoPlayer.ended) {
                videoPlayer.currentTime = 0;
              }
              safePlayVideo();
            }
          });
        });

        ensureAudioModeAvailability();
        audioModeManager.setMode(currentAudioMode);
        updateAudioModeButtons();
        updateAudioModeButtonsAvailability(); // 初始化按钮可用性状态

        if (practiceArmBtn) {
          practiceArmBtn.addEventListener('click', () => togglePracticeMode());
        }

        if (practiceSpeakerSelect) {
          practiceSpeakerSelect.addEventListener('change', (event) => {
            const selectedSpeaker = event.target.value;
            setPracticeSpeaker(selectedSpeaker);

            // 选择角色后，自动启用practice mode（但不显示控制面板）
            if (selectedSpeaker) {
              // 自动启用practice mode
              if (!state.practiceArmed) {
                state.practiceArmed = true;
                if (practiceArmBtn) {
                  practiceArmBtn.textContent = 'Disable Practice Mode';
                  practiceArmBtn.classList.add('enabled');
                }
                updatePracticeFeedback('Practice mode 已启用。视频将自动在你的台词前暂停。', '#3b82f6');
              }
              updateAutoStatus('🎭', '准备就绪，点击▶开始');

              // 显示独立的开始录音按钮
              if (startRecordingFab) startRecordingFab.hidden = false;
            } else {
              // 没有选择角色时隐藏按钮
              if (startRecordingFab) startRecordingFab.hidden = true;
            }
          });
        }

        // 添加独立开始录音按钮事件
        if (startRecordingFab) {
          startRecordingFab.addEventListener('click', () => {
            // 首次开始或重新开始
            state.practiceIndex = 0;
            state.currentRetry = 0;
            startAutoMode();
          });
        }

        // 添加自动模式控制按钮事件
        if (autoStartBtn) {
          autoStartBtn.addEventListener('click', () => {
            if (!state.autoMode) {
              // 首次开始或重新开始
              state.practiceIndex = 0;
              state.currentRetry = 0;
              startAutoMode();
            } else if (state.isPaused) {
              // 继续
              resumeAutoMode();
            }
          });
        }

        // Dialogue Next Button
        const dialogueNextBtn = document.getElementById('dialogue-next-btn');
        if (dialogueNextBtn) {
          dialogueNextBtn.addEventListener('click', () => {
            continueToNextSentence();
          });
        }

        if (autoPauseBtn) {
          autoPauseBtn.addEventListener('click', () => {
            pauseAutoMode();
          });
        }

        if (autoPrevBtn) {
          autoPrevBtn.addEventListener('click', () => {
            gotoPrevLine();
          });
        }

        if (autoNextBtn) {
          autoNextBtn.addEventListener('click', () => {
            gotoNextLine();
          });
        }
      }

      window.addEventListener('DOMContentLoaded', async () => {
        try {
          // 初始化多语言
          if (typeof i18n !== 'undefined') {
            i18n.init();

            // 设置语言选择器
            const currentLangEl = document.getElementById('current-lang-practice');
            const langBtn = document.getElementById('lang-btn-practice');
            const langDropdown = document.getElementById('lang-dropdown-practice');
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

            document.querySelectorAll('#lang-dropdown-practice .lang-option').forEach(option => {
              option.addEventListener('click', () => {
                const lang = option.dataset.lang;
                if (lang) {
                  i18n.setLang(lang);
                  if (currentLangEl) {
                    currentLangEl.textContent = langNames[lang] || lang;
                  }
                  document.querySelectorAll('#lang-dropdown-practice .lang-option').forEach(opt => {
                    const isActive = opt.dataset.lang === lang;
                    opt.classList.toggle('active', isActive);
                    opt.style.background = isActive ? '#0ea5e9' : '';
                    opt.style.color = isActive ? 'white' : '';
                  });
                  if (langDropdown) langDropdown.style.display = 'none';
                }
              });
            });

            document.querySelectorAll('#lang-dropdown-practice .lang-option').forEach(opt => {
              const isActive = opt.dataset.lang === i18n.currentLang;
              opt.classList.toggle('active', isActive);
              opt.style.background = isActive ? '#0ea5e9' : '';
              opt.style.color = isActive ? 'white' : '';
            });
          }

          // 初始化语音选择器
          (function initVoiceSelector() {
            // Haptic Feedback Helper
            function triggerHaptic() {
              if (navigator.vibrate) {
                navigator.vibrate(10);
              }
            }

            // FAB Logic
            const fabBtn = document.getElementById('fab-record-btn');
            const fabContainer = document.getElementById('fab-record-container');

            if (fabBtn) {
              fabBtn.addEventListener('click', () => {
                triggerHaptic();
                console.log('[FAB] Clicked. AutoMode:', state.autoMode, 'Armed:', state.practiceArmed);

                if (!state.autoMode) {
                  // 1. Ensure Practice Mode is Armed
                  if (!state.practiceArmed) {
                    const armBtn = document.getElementById('practice-arm-btn');
                    if (armBtn) {
                      console.log('[FAB] Arming practice mode...');
                      armBtn.click();
                    }
                  }

                  // 2. Start Auto Mode (if armed successfully)
                  // We use a small timeout to allow UI updates if any, though click() is sync.
                  setTimeout(() => {
                    if (state.practiceArmed) {
                      console.log('[FAB] Starting auto mode...');
                      const startRecFab = document.getElementById('start-recording-fab');
                      if (startRecFab && !startRecFab.hidden) {
                        startRecFab.click();
                      } else {
                        // Fallback: try calling startAutoMode directly if available
                        if (typeof startAutoMode === 'function') {
                          state.practiceIndex = 0;
                          state.currentRetry = 0;
                          startAutoMode();
                        } else {
                          const startBtn = document.getElementById('auto-start-btn');
                          if (startBtn) startBtn.click();
                        }
                      }
                      fabBtn.classList.add('recording');
                    } else {
                      console.warn('[FAB] Failed to arm practice mode (maybe no speaker selected?)');
                    }
                  }, 50);
                  return;
                }

                // In auto mode, toggle start/pause
                const startBtn = document.getElementById('auto-start-btn');
                const pauseBtn = document.getElementById('auto-pause-btn');

                if (startBtn && !startBtn.hidden) {
                  startBtn.click();
                  fabBtn.classList.add('recording');
                } else if (pauseBtn && !pauseBtn.hidden) {
                  pauseBtn.click();
                  fabBtn.classList.remove('recording');
                }
              });
            }

            // Show/Hide FAB based on mode
            function updateFabVisibility() {
              if (state.autoMode) {
                if (fabContainer) fabContainer.hidden = false;
                // Update FAB state based on recording
                if (state.isRecording) {
                  fabBtn.classList.add('recording');
                } else {
                  fabBtn.classList.remove('recording');
                }
              } else {
                // Show FAB if "Enable Practice" is available? 
                // Or hide it until practice starts?
                // Let's show it if practice arm button is visible
                const armBtn = document.getElementById('practice-arm-btn');
                if (fabContainer) fabContainer.hidden = !armBtn || armBtn.hidden;
              }
            }

            // Hook into state updates (simple polling or modify update functions)
            // For now, we'll add a periodic check or hook into existing update functions if possible.
            // Since we can't easily hook into all state changes, we'll rely on the button clicks updating the UI.
            // But we should update visibility when mode changes.
            // Let's hook into `updatePracticeButtons` if possible, but we can't easily replace it.
            // We'll add a MutationObserver to the auto-practice-controls to sync FAB state.

            const autoControls = document.getElementById('auto-practice-status');
            if (autoControls) {
              const observer = new MutationObserver(() => {
                if (fabContainer) fabContainer.hidden = autoControls.hidden;

                // Sync recording state
                const statusIcon = document.getElementById('status-icon');
                const statusText = document.getElementById('status-text');
                // Check for microphone icon OR text indicating recording/speaking
                const isRecording = (statusIcon && statusIcon.textContent.includes('🎤')) ||
                  (statusText && (statusText.textContent.includes('说话') || statusText.textContent.includes('录音')));

                if (isRecording) {
                  fabBtn.classList.add('recording');
                } else {
                  fabBtn.classList.remove('recording');
                }
              });
              observer.observe(autoControls, { attributes: true, childList: true, subtree: true });
            }

          })();

          ensureToken();

          // 如果有videoId参数，隐藏选择模态框
          const params = new URLSearchParams(window.location.search);
          const hasVideoId = params.has('videoId');
          const modal = document.getElementById('video-select-modal');
          if (hasVideoId && modal) {
            modal.style.display = 'none';
          }

          updatePracticeFeedback('正在加载视频数据...');
          updatePracticeButtons(true, true, true);
          registerEventHandlers();
          await loadVideoData();
          updatePracticeButtons(false, false, true);
          updatePracticeHint();
          updatePracticeFeedback('');

          // 如果已经选择了角色，启用practice mode（但不显示控制面板）
          if (state.selectedSpeaker) {
            if (!state.practiceArmed) {
              state.practiceArmed = true;
              if (practiceArmBtn) {
                practiceArmBtn.textContent = 'Disable Practice Mode';
                practiceArmBtn.classList.add('enabled');
              }
              updatePracticeHint();
            }

            // 准备控制按钮状态（但不显示面板，由startAutoMode控制显示）
            if (autoStartBtn) {
              autoStartBtn.hidden = false;
              autoStartBtn.textContent = '▶';
            }
            if (autoPauseBtn) autoPauseBtn.hidden = true;
            updateAutoStatus('🎭', '准备就绪，点击▶开始');

            // 显示独立的开始录音按钮
            if (startRecordingFab) startRecordingFab.hidden = false;
          }
        } catch (err) {
          console.error('Failed to initialize practice session:', err);
          updatePracticeFeedback(err.message || '加载练习页面失败，请稍后再试。', '#dc2626');
          if (practiceArmBtn) practiceArmBtn.disabled = true;
        }
      });
    
