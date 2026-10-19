const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const modulePath = path.resolve(__dirname, '../../frontend/js/game/api-client.js');

function loadModule() {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return {};
    throw error;
  }
}

function createStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function recordingFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  fn.calls = calls;
  return fn;
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test('fetchReviewQueue calls the vocab review-queue endpoint with the limit', async () => {
  const { createApiClient } = loadModule();
  const fetch = recordingFetch(() => ok({ items: [] }));
  const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage() });
  await client.fetchReviewQueue(4);
  assert.match(fetch.calls[0].url, /^\/vocab\/review-queue\?limit=4$/);
});

test('fetchReviewQueue sends the bearer token', async () => {
  const { createApiClient } = loadModule();
  const fetch = recordingFetch(() => ok({ items: [] }));
  const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage() });
  await client.fetchReviewQueue(4);
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer tok');
});

test('fetchReviewQueue normalizes the legacy word field into lemma', async () => {
  const { createApiClient } = loadModule();
  const fetch = recordingFetch(() => ok({ items: [{ word: 'apple' }, { lemma: 'banana' }] }));
  const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage() });
  const items = await client.fetchReviewQueue(4);
  assert.deepEqual(items.map((i) => i.lemma), ['apple', 'banana']);
});

test('fetchReviewQueue returns an empty list when the request fails', async () => {
  const { createApiClient } = loadModule();
  const fetch = recordingFetch(() => { throw new Error('offline'); });
  const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage() });
  assert.deepEqual(await client.fetchReviewQueue(4), []);
});

test('submitReview posts lemma and quality to the vocab review endpoint', async () => {
  const { createApiClient } = loadModule();
  const fetch = recordingFetch(() => ok({ success: true }));
  const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage() });
  await client.submitReview('apple', 'good');
  assert.equal(fetch.calls[0].url, '/vocab/review');
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { lemma: 'apple', quality: 'good' });
});

test('submitReview never sends the mastered outcome', async () => {
  const { createApiClient } = loadModule();
  const fetch = recordingFetch(() => ok({ success: true }));
  const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage() });
  await client.submitReview('apple', 'easy');
  assert.equal(fetch.calls[0].init.body.includes('mastered'), false);
});

test('a failed review is queued for retry', async () => {
  const { createApiClient, RETRY_QUEUE_KEY } = loadModule();
  const storage = createStorage();
  const fetch = recordingFetch(() => { throw new Error('offline'); });
  const client = createApiClient({ fetch, getToken: () => 'tok', storage });
  assert.equal(await client.submitReview('apple', 'good'), false);
  const queued = JSON.parse(storage.getItem(RETRY_QUEUE_KEY));
  assert.equal(typeof queued[0].id, 'string');
  assert.deepEqual(
    queued.map(({ lemma, quality }) => ({ lemma, quality })),
    [{ lemma: 'apple', quality: 'good' }],
  );
});

test('flushRetryQueue resends queued reviews and empties the queue', async () => {
  const { createApiClient, RETRY_QUEUE_KEY } = loadModule();
  const storage = createStorage();
  let online = false;
  const fetch = recordingFetch(() => {
    if (!online) throw new Error('offline');
    return ok({ success: true });
  });
  const client = createApiClient({ fetch, getToken: () => 'tok', storage });
  await client.submitReview('apple', 'good');
  online = true;
  assert.equal(await client.flushRetryQueue(), 1);
  assert.deepEqual(JSON.parse(storage.getItem(RETRY_QUEUE_KEY)), []);
});

test('flushRetryQueue preserves reviews queued while a flush is in flight', async () => {
  const { createApiClient, RETRY_QUEUE_KEY } = loadModule();
  const storage = createStorage();
  let phase = 'offline';
  let releaseFlush;
  const fetch = recordingFetch((_url, init) => {
    const { lemma } = JSON.parse(init.body);
    if (phase === 'offline' || lemma === 'banana') throw new Error('offline');
    return new Promise((resolve) => {
      releaseFlush = () => resolve(ok({ success: true }));
    });
  });
  const client = createApiClient({ fetch, getToken: () => 'tok', storage });

  await client.submitReview('apple', 'good');
  phase = 'flushing';
  const flush = client.flushRetryQueue();
  await new Promise((resolve) => setImmediate(resolve));
  await client.submitReview('banana', 'again');
  releaseFlush();
  await flush;

  assert.deepEqual(
    JSON.parse(storage.getItem(RETRY_QUEUE_KEY)).map(({ lemma, quality }) => ({ lemma, quality })),
    [{ lemma: 'banana', quality: 'again' }],
  );
});

test('logSession posts to the stats endpoint with an allowed activity type', async () => {
  const { createApiClient, STATS_TYPE } = loadModule();
  const fetch = recordingFetch(() => ok({ logged: true, xp_earned: 20, current_streak: 3, unlocked: [] }));
  const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage() });
  const result = await client.logSession({ minutes: 5, wordsLearned: 6 });
  assert.equal(fetch.calls[0].url, '/api/stats/log');
  assert.equal(JSON.parse(fetch.calls[0].init.body).type, STATS_TYPE);
  assert.equal(result.xp_earned, 20);
});

test('logSession nests the word count where the stats route reads it', async () => {
  const { createApiClient } = loadModule();
  const fetch = recordingFetch(() => ok({ logged: true, xp_earned: 20, current_streak: 3, unlocked: [] }));
  const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage() });
  await client.logSession({ minutes: 5, wordsLearned: 6 });
  // learning-stats.js:222 读的是 details.words_learned,不是顶层字段。
  const body = JSON.parse(fetch.calls[0].init.body);
  assert.equal(body.duration_minutes, 5);
  assert.deepEqual(body.details, { words_learned: 6 });
});

test('logSession returns null when the request fails', async () => {
  const { createApiClient } = loadModule();
  const fetch = recordingFetch(() => { throw new Error('offline'); });
  const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage() });
  assert.equal(await client.logSession({ minutes: 5, wordsLearned: 6 }), null);
});

function fakeAudio() {
  const played = [];
  return { played, play: async (url) => { played.push(url); } };
}

test('speak requests audio for the word and plays it', async () => {
  const { createApiClient } = loadModule();
  const fetch = recordingFetch(() => ok({ audioUrl: '/tts-audio/apple.mp3' }));
  const audio = fakeAudio();
  const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage(), audio });
  assert.equal(await client.speak('apple'), true);
  assert.equal(fetch.calls[0].url, '/tts/generate');
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { text: 'apple', lang: 'en' });
  assert.deepEqual(audio.played, ['/tts-audio/apple.mp3']);
});

test('speaking the same word twice only generates the audio once', async () => {
  const { createApiClient } = loadModule();
  const fetch = recordingFetch(() => ok({ audioUrl: '/tts-audio/apple.mp3' }));
  const audio = fakeAudio();
  const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage(), audio });
  await client.speak('apple');
  await client.speak('apple');
  assert.equal(fetch.calls.length, 1);
  assert.equal(audio.played.length, 2);
});

function controllableAudio() {
  const state = { played: [], playing: false, paused: false, pauses: 0, resumes: 0 };
  return {
    state,
    play: async (url) => {
      state.played.push(url);
      state.playing = true;
      state.paused = false;
    },
    playing: () => state.playing && !state.paused,
    paused: () => state.paused,
    pause: () => {
      state.pauses += 1;
      state.paused = true;
    },
    resume: async () => {
      state.resumes += 1;
      state.paused = false;
      state.playing = true;
    },
  };
}

test('toggleSpeak pauses a playing clip and resumes it without another request', async () => {
  const { createApiClient } = loadModule();
  const fetch = recordingFetch(() => ok({ audioUrl: '/tts-audio/apple.mp3' }));
  const audio = controllableAudio();
  const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage(), audio });
  assert.equal(await client.toggleSpeak('apple'), 'playing');
  assert.equal(await client.toggleSpeak('apple'), 'paused');
  assert.equal(await client.toggleSpeak('apple'), 'playing');
  assert.equal(fetch.calls.length, 1);
  assert.equal(audio.state.played.length, 1);
  assert.equal(audio.state.pauses, 1);
  assert.equal(audio.state.resumes, 1);
});

test('toggleSpeak pauses speech and resumes it without requesting audio', async () => {
  const { createApiClient } = loadModule();
  const fetch = recordingFetch(() => ok({ audioUrl: '/tts-audio/apple.mp3' }));
  const synth = {
    speaking: false,
    paused: false,
    pending: false,
    cancel() {},
    pause() { this.paused = true; },
    resume() { this.paused = false; },
    speak() { this.speaking = true; this.paused = false; },
  };
  const previous = global.window;
  global.window = {
    speechSynthesis: synth,
    SpeechSynthesisUtterance: function SpeechSynthesisUtterance() {},
  };
  try {
    const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage(), audio: fakeAudio() });
    assert.equal(await client.toggleSpeak('dragon fruit'), 'playing');
    assert.equal(await client.toggleSpeak('dragon fruit'), 'paused');
    assert.equal(synth.paused, true);
    assert.equal(await client.toggleSpeak('dragon fruit'), 'playing');
    assert.equal(synth.paused, false);
    assert.equal(fetch.calls.length, 0);
  } finally {
    if (previous === undefined) delete global.window;
    else global.window = previous;
  }
});

test('speak fails silently when tts is unavailable', async () => {
  const { createApiClient } = loadModule();
  const fetch = recordingFetch(() => { throw new Error('offline'); });
  const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage(), audio: fakeAudio() });
  assert.equal(await client.speak('apple'), false);
});

test('addWord marks the word as learning on the real vocab endpoint', async () => {
  const { createApiClient } = loadModule();
  const fetch = recordingFetch(() => ok({ success: true }));
  const client = createApiClient({ fetch, getToken: () => 'tok', storage: createStorage() });
  await client.addWord('apple');
  assert.equal(fetch.calls[0].url, '/vocab/mark');
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { lemma: 'apple', state: 'learning' });
});
