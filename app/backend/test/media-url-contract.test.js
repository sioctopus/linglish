const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FRONTEND = path.resolve(__dirname, '../../frontend');
const read = relativePath => fs.readFileSync(path.join(FRONTEND, relativePath), 'utf8');

const protectedMediaConsumers = [
  'js/video-reader/main.js',
  'video-reader-desktop.html',
  'video-reader.html',
  'practice-session.html',
  'practice-session-desktop.html',
  'practice-session-refactored.html',
  'js/practice-session/main.js',
  'js/practice-session/api-client.js',
  'js/practice-session/audio-manager.js',
  'pdf-reader.html',
];

test('every Task 2 media consumer is covered and constructs no account-JWT query URL', () => {
  for (const relativePath of protectedMediaConsumers) {
    const source = read(relativePath);
    assert.doesNotMatch(
      source,
      /[?&]token=\$\{?[^\n]*(?:token|freshToken|retryToken|savedToken|tk)/i,
      `${relativePath} must not construct an account-token query URL`,
    );
    assert.doesNotMatch(
      source,
      /(?:params|searchParams)\.(?:set|append)\(['"]token['"]/i,
      `${relativePath} must not add account tokens through URLSearchParams`,
    );
    assert.doesNotMatch(
      source,
      /pronunciation\/assess\?token=|function\s+withToken\s*\(/i,
      `${relativePath} must use Authorization or the shared media-session client`,
    );
    assert.doesNotMatch(
      source,
      /(?:pdfPath|local_video_path|rawVideoPath|baseUrl)[^\n]*\?token=/i,
      `${relativePath} must keep protected media/document URLs clean`,
    );
  }
});

test('all HTML entry points load the shared media client before protected-media code', () => {
  const pages = [
    ['video-reader.html', '<script src="./js/video-reader/main.js'],
    ['video-reader-desktop.html', 'function needsToken'],
    ['practice-session.html', 'async function setProtectedMediaSource'],
    ['practice-session-desktop.html', 'async function setProtectedMediaSource'],
    ['practice-session-refactored.html', '<script type="module" src="./js/practice-session/main.js'],
    ['pdf-reader.html', 'async function buildProtectedDocumentUrl'],
  ];

  for (const [relativePath, consumerMarker] of pages) {
    const source = read(relativePath);
    const mediaClientIndex = source.indexOf('js/media-session.js');
    const consumerIndex = source.indexOf(consumerMarker);
    assert.ok(mediaClientIndex >= 0, `${relativePath} must load media-session.js`);
    assert.ok(consumerIndex >= 0, `${relativePath} consumer marker must remain present`);
    assert.ok(mediaClientIndex < consumerIndex, `${relativePath} must load media-session.js first`);
  }
});

test('JS consumers bootstrap protected media and use the shared URL builder', () => {
  const directConsumers = [
    'js/video-reader/main.js',
    'video-reader-desktop.html',
    'practice-session.html',
    'practice-session-desktop.html',
    'js/practice-session/main.js',
    'js/practice-session/audio-manager.js',
    'pdf-reader.html',
  ];
  for (const relativePath of directConsumers) {
    assert.match(
      read(relativePath),
      /LinglishMediaSession|setProtectedMediaSource/,
      `${relativePath} must use the shared client or its protected-source adapter`,
    );
  }
});

test('purpose-scoped practice share URLs remain supported without becoming media auth', () => {
  const desktop = read('practice-session-desktop.html');
  assert.match(desktop, /\/api\/practice-shares\/\$\{encodeURIComponent\(token\)\}/);
  assert.match(desktop, /\.get\(['"]share['"]\)/);
  assert.match(
    desktop,
    /getToken:\s*\(\)\s*=>\s*isShareMode\(\)\s*\?\s*null\s*:\s*refreshAuthToken\(\)/,
    'share lifecycle events must not supply an account token to media-session bootstrap',
  );
});

test('the refactored practice adapter leaves YouTube external and never bootstraps account media auth', async () => {
  const moduleSource = read('js/practice-session/api-client.js');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}#external-media-test`;
  const previous = {
    window: global.window,
    localStorage: global.localStorage,
    sessionStorage: global.sessionStorage,
  };
  let bootstrapCalls = 0;
  const storage = { getItem: () => 'account-secret' };
  const window = {
    LinglishMediaSession: {
      async ensure() {
        bootstrapCalls += 1;
        return { mode: 'legacy' };
      },
      setElementSource(element, source) {
        element.src = `${source}&token=account-secret`;
        return element.src;
      },
    },
  };
  global.window = window;
  global.localStorage = storage;
  global.sessionStorage = storage;

  try {
    const api = await import(moduleUrl);
    const element = {};
    const youtube = 'https://www.youtube.com/watch?v=abcdefghijk';
    const assigned = await api.setProtectedMediaSource(element, youtube);
    assert.equal(assigned, youtube);
    assert.equal(element.src, youtube);
    assert.equal(bootstrapCalls, 0);
  } finally {
    global.window = previous.window;
    global.localStorage = previous.localStorage;
    global.sessionStorage = previous.sessionStorage;
  }
});

function loadServiceWorker(cacheKeys = []) {
  const listeners = new Map();
  const calls = { cacheMatch: [], cacheOpen: [], cachePut: [], deleted: [], network: [] };
  const response = { status: 200, clone() { return this; } };
  const caches = {
    async keys() { return cacheKeys; },
    async delete(key) { calls.deleted.push(key); return true; },
    async match(request) { calls.cacheMatch.push(request.url); return null; },
    async open(name) {
      calls.cacheOpen.push(name);
      return {
        async addAll() {},
        async match(request) { calls.cacheMatch.push(request.url); return null; },
        async put(request) { calls.cachePut.push(request.url); },
      };
    },
  };
  const self = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(read('sw.js'), {
    self,
    caches,
    location: { origin: 'https://app.example.test' },
    URL,
    fetch: async request => {
      calls.network.push(request.url);
      return response;
    },
    Promise,
  });
  return { listeners, calls };
}

test('the service worker routes every protected path directly to network without cache access', async () => {
  const { listeners, calls } = loadServiceWorker();
  for (const pathname of [
    '/pdfs/a.pdf?token=account-secret',
    '/videos/a.mp4?token=account-secret',
    '/recordings/a.webm?token=account-secret',
    '/static/legacy.css?token=account-secret',
  ]) {
    let responsePromise;
    listeners.get('fetch')({
      request: {
        method: 'GET',
        url: `https://app.example.test${pathname}`,
        destination: '',
        headers: { get: () => null },
      },
      respondWith(value) { responsePromise = Promise.resolve(value); },
    });
    await responsePromise;
  }

  assert.equal(calls.network.length, 4);
  assert.deepEqual(calls.cacheMatch, []);
  assert.deepEqual(calls.cacheOpen, []);
  assert.deepEqual(calls.cachePut, []);
});

test('service worker activation purges the previously affected protected-media runtime cache', async () => {
  const previousRuntime = 'rt-v1.0.5-20260822001';
  const { listeners, calls } = loadServiceWorker([previousRuntime]);
  let activation;
  listeners.get('activate')({ waitUntil(value) { activation = Promise.resolve(value); } });
  await activation;
  assert.deepEqual(calls.deleted, [previousRuntime]);
});

test('both readers guard source assignment and follow-up effects with the current selection generation', () => {
  const mobile = read('js/video-reader/main.js');
  assert.match(mobile, /const selectionGeneration = \+\+videoSelectionGeneration/);
  assert.match(mobile, /authorizeElementSource\([\s\S]{0,220}\bisCurrent,\s*\n/);
  assert.match(
    mobile,
    /await setProtectedMediaSource\(videoPlayer,\s*baseUrl,\s*isCurrentSelection\)[\s\S]{0,160}!isCurrentSelection\(\)[\s\S]{0,160}videoPlayer\.load\(\)/,
  );

  const desktop = read('video-reader-desktop.html');
  assert.match(desktop, /authorizeElementSource\([\s\S]{0,220}\bisCurrent,\s*\n/);
  assert.match(
    desktop,
    /await setProtectedMediaSource\(playerEl,\s*localUrl,\s*isCurrentSelection\)[\s\S]{0,160}!isCurrentSelection\(\)[\s\S]{0,800}loadCurrentTranscript/,
  );
  assert.match(
    desktop,
    /await setProtectedMediaSource\(playerEl,\s*url,\s*isCurrentSelection\)[\s\S]{0,160}!isCurrentSelection\(\)[\s\S]{0,1800}loadCurrentTranscript/,
  );
  assert.match(
    desktop,
    /await setProtectedMediaSource\(playerEl,\s*url,\s*isCurrentSelection\)[\s\S]{0,300}catch \(_\) \{\s*if \(!isCurrentSelection\(\)\) return;/,
  );
});

test('the service worker source keeps protected routes ahead of every cache branch', () => {
  const source = read('sw.js');
  assert.match(source, /\[['"]\/pdfs\/['"],\s*['"]\/videos\/['"],\s*['"]\/recordings\/['"],\s*['"]\/note-images\/['"]\]/);
  const fetchHandler = source.indexOf("self.addEventListener('fetch'");
  const protectedBranch = source.indexOf('PROTECTED_PATH_PREFIXES.some', fetchHandler);
  const firstCacheBranch = source.indexOf('caches.open', fetchHandler);
  assert.ok(fetchHandler >= 0 && protectedBranch > fetchHandler);
  assert.ok(firstCacheBranch === -1 || protectedBranch < firstCacheBranch);
  assert.match(source.slice(protectedBranch, protectedBranch + 220), /event\.respondWith\(fetch\(req\)\)/);
  assert.doesNotMatch(source, /tts\/generate[^\n]*\|\|[^\n]*\/recordings\//);
  assert.doesNotMatch(source, /const VERSION = ['"]v1\.0\.5-20260822001['"]/);
  assert.match(source, /caches\.delete/);
  assert.match(source, /LEGACY_PROTECTED_MEDIA_CACHES[\s\S]*rt-v1\.0\.5-20260822001/);
});

test('a stale desktop media authorization failure cannot clear or retry the newly selected video session', async () => {
  const { createVideoSelectionGuard } = require('../../frontend/js/video-reader/video-selection-guard');
  const source = read('video-reader-desktop.html').match(/    async function selectVideo\(v\) \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(source, 'the real desktop selection function must be exercised');
  let rejectOld;
  const oldAuthorization = new Promise((_resolve, reject) => { rejectOld = reject; });
  const authorizations = [];
  const transcripts = [];
  let clears = 0;
  const noop = () => {};
  const sandbox = {
    URL, Promise,
    window: { LinglishMediaSession: { async clear() { clears += 1; sandbox.window.LinglishStudyMedia = null; } } },
    location: { href: 'https://app.example.test/video-reader-desktop.html' },
    state: { currentVideo: null, currentSegments: [] },
    videoSelectionGuard: createVideoSelectionGuard(),
    leaveForCoach: () => false,
    teardownFirstLessonRecording: noop, firstLessonGoal: null, firstLessonGoalCard: { hide: noop },
    currentDesktopSelectionToken: null, pendingSeek: null,
    renderVideoList: noop, setPlayerOverlay: noop, tOverlay: (_key, fallback) => fallback,
    document: { querySelector: () => null, getElementById: () => null },
    playerEl: { style: {}, load: noop }, youtubePlayerEl: { style: {} }, youtubePlayer: null,
    fetch: async () => ({ ok: true }), API_BASE: '', headers: () => ({}),
    _lastActiveIdx: -1, _lastActiveElement: null, localStorage: { setItem: noop },
    currentTitleEl: {}, renderVideoIntro: noop, updateVideoMeta: noop, updateVideoProgress: noop,
    progressSaveState: {}, setExtractButtonState: noop, stopWatchTimer: noop,
    currentPlayerType: null, activeLocalSelectionToken: null,
    async setProtectedMediaSource(_element, url, isCurrent) {
      authorizations.push(url);
      if (url === '/videos/1.mp4') return oldAuthorization;
      if (!isCurrent()) return null;
      sandbox.window.LinglishStudyMedia = { videoId: 2 };
      return url;
    },
    getToken: () => 'account-token', playerOverlayRetryBtn: {},
    applyPendingSeekToLocal: noop, openSourceBtn: {}, importWordsBtn: {},
    loadCurrentTranscript(video) { transcripts.push(video.id); },
    autoImportVocabulary: async () => {}, updateNextVideoCard: noop,
    debugLog: noop, console: { log: noop, error: noop },
  };
  vm.runInNewContext(`${source}; this.selectVideo = selectVideo;`, sandbox);
  const oldSelection = sandbox.selectVideo({ id: 1, video_path: '/videos/1.mp4' });
  await sandbox.selectVideo({ id: 2, video_path: '/videos/2.mp4' });
  rejectOld(new Error('old session rejected late'));
  await oldSelection;
  assert.equal(clears, 0, 'a stale failure must not revoke the current media session');
  assert.equal(sandbox.window.LinglishStudyMedia.videoId, 2);
  assert.deepEqual(authorizations, ['/videos/1.mp4', '/videos/2.mp4']);
  assert.deepEqual(transcripts, [2]);
});
