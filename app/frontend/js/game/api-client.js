(function (root, factory) {
  const wordPool = typeof module === 'object' && module.exports
    ? require('./word-pool.js')
    : (root && root.GameWordPool);
  const api = factory(wordPool);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GameApiClient = api;
})(typeof window !== 'undefined' ? window : null, function (wordPool) {
  'use strict';

  const RETRY_QUEUE_KEY = 'linglish_game_retry_queue';
  const STATS_TYPE = 'other';
  let queueIdSequence = 0;

  function createQueueId() {
    queueIdSequence += 1;
    return Date.now().toString(36)
      + '-' + queueIdSequence.toString(36)
      + '-' + Math.random().toString(36).slice(2, 10);
  }

  function ensureQueueIds(queue) {
    return queue.map(function (entry) {
      return entry && typeof entry.id === 'string' && entry.id
        ? entry
        : { ...entry, id: createQueueId() };
    });
  }

  function createApiClient(options) {
    const settings = options || {};
    const doFetch = settings.fetch;
    const getToken = settings.getToken || function () { return null; };
    const storage = settings.storage;
    const audio = settings.audio || null;

    function headers() {
      const token = getToken();
      const base = { 'Content-Type': 'application/json' };
      if (token) base.Authorization = 'Bearer ' + token;
      return base;
    }

    function readQueue() {
      try {
        const raw = storage && storage.getItem(RETRY_QUEUE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    }

    function writeQueue(queue) {
      try {
        storage.setItem(RETRY_QUEUE_KEY, JSON.stringify(queue));
      } catch (_) {
        // A full or unavailable storage must not break gameplay.
      }
    }

    async function postJson(url, payload) {
      const response = await doFetch(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(payload),
      });
      if (!response || !response.ok) throw new Error('Request failed: ' + url);
      return response.json();
    }

    async function fetchReviewQueue(limit) {
      const safeLimit = Math.min(50, Math.max(1, Number(limit) || 4));
      try {
        const response = await doFetch('/vocab/review-queue?limit=' + safeLimit, {
          method: 'GET',
          headers: headers(),
        });
        if (!response || !response.ok) return [];
        const body = await response.json();
        const items = Array.isArray(body && body.items) ? body.items : [];
        return items
          .map(wordPool.normalizeReviewItem)
          .filter(function (item) { return item !== null; });
      } catch (_) {
        return [];
      }
    }

    async function submitReview(lemma, quality) {
      try {
        await postJson('/vocab/review', { lemma, quality });
        return true;
      } catch (_) {
        writeQueue(readQueue().concat({ id: createQueueId(), lemma, quality }));
        return false;
      }
    }

    async function addWord(lemma) {
      try {
        // 后端没有 POST /vocabulary(spec §8 的表写错了);真实入口是 /vocab/mark,
        // 顺带自动补翻译。词进了 user_vocabulary,review-queue 才有东西可发。
        await postJson('/vocab/mark', { lemma, state: 'learning' });
        return true;
      } catch (_) {
        return false;
      }
    }

    async function logSession(session) {
      try {
        // 词数必须放在 details.words_learned 里:learning-stats.js:222 只读这个字段,
        // 放顶层会被静默忽略,XP 就只按分钟数算了。
        return await postJson('/api/stats/log', {
          type: STATS_TYPE,
          duration_minutes: Number(session.minutes) || 0,
          details: { words_learned: Number(session.wordsLearned) || 0 },
        });
      } catch (_) {
        return null;
      }
    }

    async function flushRetryQueue() {
      const original = readQueue();
      const pending = ensureQueueIds(original);
      if (pending.length === 0) return 0;
      if (pending.some(function (entry, index) { return entry !== original[index]; })) {
        writeQueue(pending);
      }

      const succeeded = new Set();
      let sent = 0;
      for (const entry of pending) {
        try {
          await postJson('/vocab/review', { lemma: entry.lemma, quality: entry.quality });
          succeeded.add(entry.id);
          sent += 1;
        } catch (_) {
          // Keep failed snapshot entries in the queue for the next visit.
        }
      }
      const latest = ensureQueueIds(readQueue());
      writeQueue(latest.filter(function (entry) { return !succeeded.has(entry.id); }));
      return sent;
    }

    // 埋点:走既有 POST /events 管线进 events 表,管理后台游戏漏斗从那里聚合。
    // 失败静默——统计丢一条不能打断游戏。
    async function track(eventName, properties) {
      try {
        await postJson('/events', { event_name: eventName, properties: properties || {} });
        return true;
      } catch (_) {
        return false;
      }
    }

    // A stable media URL lets the browser start loading inside the original tap.
    let speakGeneration = 0;
    let locallyPaused = false;
    let onSpeakIdle = null;
    let speechSource = null;

    function synthesisHost() {
      const host = typeof window !== 'undefined' ? window : null;
      if (!host || !host.speechSynthesis || typeof host.SpeechSynthesisUtterance !== 'function') {
        return null;
      }
      return host;
    }

    function noteIdle(generation) {
      if (generation === speakGeneration && !locallyPaused && onSpeakIdle) onSpeakIdle();
    }

    function setSpeakIdle(fn) {
      onSpeakIdle = typeof fn === 'function' ? fn : null;
    }

    // 词卡发音跟随全站所选音色；后端只认白名单内的音色，未加载模块时回退默认 Ava。
    function wordAudioVoice() {
      const host = typeof window !== 'undefined' ? window : null;
      const tts = host && host.LinglishTtsVoice;
      return (tts && typeof tts.current === 'function') ? tts.current() : 'en-US-AvaMultilingualNeural';
    }

    function speakLocally(text) {
      const host = synthesisHost();
      if (!host) return false;
      locallyPaused = false;
      speechSource = 'local';
      const generation = ++speakGeneration;
      host.speechSynthesis.cancel();
      const utter = new host.SpeechSynthesisUtterance(String(text));
      const tts = host.LinglishTtsVoice;
      if (tts && typeof tts.synthesisLang === 'function') {
        utter.lang = tts.synthesisLang();
        try {
          const systemVoice = typeof tts.findSystemVoice === 'function'
            ? tts.findSystemVoice(host.speechSynthesis.getVoices())
            : null;
          if (systemVoice) utter.voice = systemVoice;
        } catch (_) { }
      } else {
        utter.lang = 'en-US';
      }
      utter.rate = 0.92;
      utter.onend = function () { noteIdle(generation); };
      host.speechSynthesis.speak(utter);
      return true;
    }

    function audioIsPaused() {
      return Boolean(audio && typeof audio.paused === 'function' && audio.paused());
    }

    function audioIsPlaying() {
      return Boolean(audio && typeof audio.playing === 'function' && audio.playing());
    }

    function audioState() {
      return audioIsPlaying() ? 'playing' : (audioIsPaused() ? 'paused' : 'idle');
    }

    async function speak(text) {
      if (!text) return false;
      const generation = ++speakGeneration;
      locallyPaused = false;
      const host = synthesisHost();
      if (host) host.speechSynthesis.cancel();
      if (audio) {
        speechSource = 'audio';
        if (typeof audio.setEnded === 'function') {
          audio.setEnded(function () { noteIdle(generation); });
        }
        try {
          // Do not await a JSON request before play(): iOS requires the original gesture.
          // voice 进 URL，浏览器按 URL 缓存，同一文本在不同音色下不会互相污染。
          await audio.play('/tts/word?text=' + encodeURIComponent(String(text)) + '&voice=' + encodeURIComponent(wordAudioVoice()) + '&v=2');
          return generation === speakGeneration;
        } catch (error) {
          if (generation !== speakGeneration || (error && error.name === 'AbortError')) return false;
          if (error && error.name === 'NotAllowedError') {
            speechSource = null;
            noteIdle(generation);
            return false;
          }
        }
      }
      if (speakLocally(text)) return true;
      speechSource = null;
      noteIdle(generation);
      return false;
    }

    // 空格:正在念就暂停,暂停中就续上,没在念就从头播放。
    async function toggleSpeak(text) {
      const host = synthesisHost();
      if (speechSource === 'local' && host) {
        const synth = host.speechSynthesis;
        if (locallyPaused) {
          locallyPaused = false;
          synth.resume();
          return 'playing';
        }
        if (synth.speaking || synth.pending) {
          locallyPaused = true;
          synth.pause();
          return 'paused';
        }
      } else if (audioIsPaused()) {
        locallyPaused = false;
        const generation = speakGeneration;
        try {
          if (typeof audio.resume === 'function') await audio.resume();
        } catch (error) {
          if (generation !== speakGeneration || (error && error.name === 'AbortError')) return audioState();
          return (await speak(text)) ? 'playing' : 'idle';
        }
        return audioState();
      } else if (audioIsPlaying()) {
        locallyPaused = true;
        if (typeof audio.pause === 'function') audio.pause();
        return 'paused';
      }
      const started = await speak(text);
      return started ? 'playing' : 'idle';
    }

    return {
      fetchReviewQueue,
      submitReview,
      addWord,
      logSession,
      flushRetryQueue,
      speak,
      toggleSpeak,
      setSpeakIdle,
      track,
    };
  }

  return { createApiClient, RETRY_QUEUE_KEY, STATS_TYPE };
});
