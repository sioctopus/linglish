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

    // 一局连连看里同一个词会被念很多次,不缓存就是几十次 TTS 生成请求。
    const audioUrls = new Map();
    const inflightUrls = new Map();
    let speakGeneration = 0;
    let locallyPaused = false;
    let onSpeakIdle = null;
    // 整页会话锁死一个神经音色，避免翻卡时 Ava/浏览器音来回跳
    let lockedVoiceId = null;
    let lockedLocalVoice = null;
    const DEFAULT_VOICE = 'en-US-AvaMultilingualNeural';

    function synthesisHost() {
      const host = typeof window !== 'undefined' ? window : null;
      if (!host || !host.speechSynthesis || typeof host.SpeechSynthesisUtterance !== 'function') {
        return null;
      }
      return host;
    }

    // 与会员页 LinglishTtsVoice 共用同一把钥匙；首次选用后本页不再换。
    function selectedVoice() {
      if (lockedVoiceId) return lockedVoiceId;
      const host = typeof window !== 'undefined' ? window : null;
      let voice = DEFAULT_VOICE;
      if (host && host.LinglishTtsVoice && typeof host.LinglishTtsVoice.current === 'function') {
        const picked = host.LinglishTtsVoice.current();
        if (picked) voice = picked;
      }
      lockedVoiceId = voice;
      return lockedVoiceId;
    }

    function pickLocalVoice(host) {
      if (lockedLocalVoice) return lockedLocalVoice;
      try {
        const list = host.speechSynthesis.getVoices() || [];
        const wantUk = /en-GB/i.test(selectedVoice());
        const langPref = wantUk ? /^en(-GB)?$/i : /^en(-US)?$/i;
        const ranked = list.filter(function (v) { return langPref.test(v.lang || ''); });
        const pool = ranked.length ? ranked : list.filter(function (v) { return /^en/i.test(v.lang || ''); });
        // 优先女声名，尽量贴近 Ava/Libby；选中后锁定
        const preferred = pool.find(function (v) {
          return /Ava|Jenny|Sara|Emma|Libby|Zira|Samantha|Google US English|Microsoft Aria/i.test(v.name || '');
        }) || pool.find(function (v) {
          return /female|woman|girl/i.test(v.name || '');
        }) || pool[0] || null;
        lockedLocalVoice = preferred;
        return lockedLocalVoice;
      } catch (_) {
        return null;
      }
    }

    function noteIdle(generation) {
      if (generation === speakGeneration && !locallyPaused && onSpeakIdle) onSpeakIdle();
    }

    function setSpeakIdle(fn) {
      onSpeakIdle = typeof fn === 'function' ? fn : null;
    }

    function speakLocally(text, generation, rate) {
      const host = synthesisHost();
      if (!host) return false;
      const token = generation == null ? ++speakGeneration : generation;
      locallyPaused = false;
      host.speechSynthesis.cancel();
      const utter = new host.SpeechSynthesisUtterance(String(text));
      utter.lang = /en-GB/i.test(selectedVoice()) ? 'en-GB' : 'en-US';
      const localVoice = pickLocalVoice(host);
      if (localVoice) utter.voice = localVoice;
      const speed = Number(rate);
      // 本地合成略慢于 1.0 更稳；新手句再按传入 rate 压低
      utter.rate = speed > 0 ? Math.min(1.15, Math.max(0.55, speed)) : 0.92;
      utter.onend = function () { noteIdle(token); };
      host.speechSynthesis.speak(utter);
      return true;
    }

    function audioIsPaused() {
      return Boolean(audio && typeof audio.paused === 'function' && audio.paused());
    }

    function audioIsPlaying() {
      return Boolean(audio && typeof audio.playing === 'function' && audio.playing());
    }

    // 生成与预取共用同一路请求,翻卡时不必再等一轮。
    function ensureAudioUrl(text) {
      const voice = selectedVoice();
      const cacheKey = voice + '\n' + String(text);
      if (audioUrls.has(cacheKey)) return Promise.resolve(audioUrls.get(cacheKey));
      if (inflightUrls.has(cacheKey)) return inflightUrls.get(cacheKey);
      const pending = postJson('/tts/generate', { text: String(text), lang: 'en', voice })
        .then(function (body) {
          const url = body && body.audioUrl ? body.audioUrl : null;
          if (url) audioUrls.set(cacheKey, url);
          return url;
        })
        .finally(function () { inflightUrls.delete(cacheKey); });
      inflightUrls.set(cacheKey, pending);
      return pending;
    }

    function warmUrl(url) {
      if (url && audio && typeof audio.warm === 'function') audio.warm(url);
    }

    function prefetchSpeak(texts) {
      if (!audio || !Array.isArray(texts)) return;
      texts.forEach(function (text) {
        if (!text) return;
        ensureAudioUrl(text).then(warmUrl).catch(function () {});
      });
    }

    async function speak(text, options) {
      if (!text) return false;
      const rate = options && Number(options.rate) > 0 ? Number(options.rate) : 1;
      // 先占住 generation:快速翻卡时丢弃过期请求,避免旧词后响。
      const generation = ++speakGeneration;
      locallyPaused = false;
      if (audio && audioIsPlaying() && typeof audio.pause === 'function') audio.pause();
      const host = synthesisHost();
      if (host) host.speechSynthesis.cancel();
      if (audio && typeof audio.setRate === 'function') audio.setRate(rate);

      const voice = selectedVoice();
      const cacheKey = voice + '\n' + String(text);

      try {
        if (audio) {
          let url = audioUrls.get(cacheKey) || null;
          if (!url) {
            // 等神经 TTS 完成再播，不再用浏览器音垫播（垫播会造成一词一音色）
            try {
              url = await ensureAudioUrl(text);
            } catch (_) {
              url = null;
            }
            if (generation !== speakGeneration) return false;
          }
          if (!url) {
            // 仅在服务端彻底失败时才本地合成，并锁定同一本地音色
            return speakLocally(text, generation, rate);
          }
          warmUrl(url);
          if (typeof audio.setRate === 'function') audio.setRate(rate);
          if (typeof audio.setEnded === 'function') {
            audio.setEnded(function () { noteIdle(generation); });
          }
          await audio.play(url);
          return generation === speakGeneration;
        }
      } catch (_) {
        if (generation !== speakGeneration) return false;
      }
      if (generation !== speakGeneration) return false;
      // 神经 TTS 不可用时才回落浏览器合成。
      return speakLocally(text, generation, rate);
    }

    // 空格:正在念就暂停,暂停中就续上,没在念就从头播放。
    async function toggleSpeak(text, options) {
      if (audio) {
        if (audioIsPaused()) {
          locallyPaused = false;
          if (typeof audio.resume === 'function') await audio.resume();
          return 'playing';
        }
        if (audioIsPlaying()) {
          locallyPaused = true;
          if (typeof audio.pause === 'function') audio.pause();
          return 'paused';
        }
      } else {
        const host = synthesisHost();
        if (host) {
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
        }
      }
      const started = await speak(text, options);
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
      prefetchSpeak,
      setSpeakIdle,
      track,
    };
  }

  return { createApiClient, RETRY_QUEUE_KEY, STATS_TYPE };
});
