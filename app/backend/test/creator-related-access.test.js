const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { createFixtureAuth } = require('./helpers/fixture-auth');

function loadRoute(name, stubs) {
  const filename = path.resolve(__dirname, `../routes/${name}.js`);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), Buffer, process,
    console: { log() {}, warn() {}, error() {} },
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : localRequire(name),
  }, { filename });
  return module.exports;
}

function response() {
  return {
    headersSent: false, writableEnded: false, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; this.headersSent = true; Object.assign(this.headers, headers); },
    end(body) { this.body = JSON.parse(body); this.writableEnded = true; },
  };
}

const owner = { id: 7 };
const other = { id: 8 };
const paid = { id: 8, membership_type: 'vip', subscription_status: 'active' };
const admin = { id: 9, is_admin: true };
const segment = { index: 0, text: 'A private fixture sentence.', start: 0, end: 2, speaker: 'Fixture speaker' };

for (const [pathname, method, body] of [
  ['/tags', 'POST', { name: 'Fixture' }],
  ['/tags/1', 'PATCH', { name: 'Fixture' }],
  ['/tags/1', 'DELETE', {}],
  ['/tags/cleanup-duplicates', 'GET', {}],
  ['/user-tags', 'POST', { name: 'Fixture' }],
  ['/user-tags/1', 'PATCH', { name: 'Fixture' }],
  ['/user-tags/1', 'DELETE', {}],
  ['/tag-preferences', 'POST', { preferences: [{ tag_id: 1, pinned: true }] }],
  ['/videos/10/tags', 'POST', { global_tag_ids: [1], user_tag_ids: [] }],
]) test(`tag mutation ${method} ${pathname} rejects cookies and malformed Bearer before datastore work`, async () => {
  let queries = 0;
  const route = loadRoute('tags', {
    '../middleware/auth': createFixtureAuth(() => admin),
    '../data-store': { pool: {
      query: async () => { queries += 1; return { rows: [], rowCount: 0 }; },
      connect: async () => { queries += 1; throw new Error('Datastore work before authorization'); },
    } },
  });
  for (const authorization of [undefined, 'Basic fixture', 'fixture', 'Bearer fixture extra', 'Bearer']) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, headers: { cookie: 'linglish_token=fixture', ...(authorization ? { authorization } : {}) } });
    const res = response();
    await route.registerTagRoutes(pathname, req, res, new URL(pathname, 'http://localhost'));
    assert.equal(res.status, 401);
    assert.equal(queries, 0);
  }
});

for (const [pathname, method, body] of [['/tags', 'GET'], ['/videos/10/tags', 'GET'], ['/videos/tags/batch', 'POST', { video_ids: [] }]]) {
  test(`tag read ${method} ${pathname} retains legacy cookie authentication`, async () => {
    const route = loadRoute('tags', {
      '../middleware/auth': createFixtureAuth(() => owner),
      '../data-store': { getVideoResourceById: async () => ({ id: 10, uploader_id: 7, is_public: false }),
        pool: { query: async () => ({ rows: [] }) } },
    });
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, headers: { cookie: 'linglish_token=fixture' } });
    const res = response();
    await route.registerTagRoutes(pathname, req, res, new URL(pathname, 'http://localhost'));
    assert.equal(res.status, 200);
  });
}

for (const [label, user, expected] of [['anonymous', null, 404], ['free', other, 404], ['owner', owner, 200], ['paid', paid, 200], ['admin', admin, 200]]) {
  test(`public VIP transcript projection enforces ${label} access before cached content`, async () => {
    const resource = { id: 10, uploader_id: 7, is_public: true, is_vip_only: true,
      transcript: 'VIP fixture transcript.', transcript_segments: [segment], language: 'en' };
    let cacheReads = 0;
    const route = loadRoute('videos', {
      '../data-store': { isDatabaseAvailable: () => true },
      '../data-store/core': { pool: { query: async sql => {
        // Model a real SELECT projection; omitted access fields cannot silently appear.
        const columns = sql.match(/SELECT\s+([^]*?)\s+FROM video_resources/i)[1].split(',').map(value => value.trim());
        return { rows: [Object.fromEntries(columns.map(column => [column, resource[column]]))] };
      } } },
      '../services/auth': { requireUser: async () => user },
      '../services/video-transcription': {},
      '../services/cache': { get: async () => { cacheReads += 1; return { videoId: 10, transcript: resource.transcript, segments: [segment] }; } },
      '../upload-handler': {}, '../services/yt-dlp-downloader': {}, '../services/geo-ip': {},
      '../services/vocabulary-v2': {}, '../utils/audio-utils': {}, '../services/youtube': {},
      '../config/ai-config': { features: { videoTranscription: false } }, 'fluent-ffmpeg': null,
    });
    const pathname = '/video-resources/10/transcript';
    const req = { url: pathname, method: 'GET', headers: { host: 'localhost', ...(user ? { authorization: 'Bearer fixture' } : {}) } };
    const res = response();
    await route.registerVideoRoutes(pathname, req, res);
    assert.equal(res.status, expected);
    assert.equal(cacheReads, expected === 200 ? 1 : 0);
    if (expected === 404) assert.equal(JSON.stringify(res.body).includes(resource.transcript), false);
    else assert.equal(res.body.transcript, resource.transcript);
  });
}

test('shared video access policy fails closed and uses current paid entitlement', () => {
  const { canAccessVideoResource: access, isSameUserId } = require('../services/video-access-policy');
  assert.equal(isSameUserId(7, '7'), true);
  assert.equal(isSameUserId(null, null), false);
  for (const user of [null, owner, admin, paid]) assert.equal(access(null, user), false);
  for (const is_public of [false, undefined, null, 'true']) {
    const video = { uploader_id: 7, is_public, is_vip_only: true };
    assert.equal(access(video, other), false);
    assert.equal(access(video, paid), false);
    assert.equal(access(video, owner), true);
    assert.equal(access(video, admin), true);
  }
  assert.equal(access({ is_public: true }, null), true);
  assert.equal(access({ is_public: true, is_vip_only: true }, null), false);
  assert.equal(access({ is_public: true, is_vip_only: true }, paid), true);
  assert.equal(access({ is_public: true, is_vip_only: true }, { ...paid, subscription_status: 'expired' }), false);
  assert.equal(access({ is_public: true, is_vip_only: true }, { ...paid, membership_expires_at: '2001-01-01' }), false);
});

test('database-unavailable filesystem fallback explicitly remains private', async () => {
  const filename = path.resolve(__dirname, '../data-store/queries/videos.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), console: { warn() {} },
    require: name => name === '../core' ? { init: async () => {}, dbUnavailable: () => true }
      : name === 'fs/promises' ? { readdir: async () => ['fixture.mp4'], stat: async () => ({ isFile: () => true }) }
        : localRequire(name),
  }, { filename });
  const videos = await module.exports.listVideoResources();
  assert.equal(videos.length, 1);
  assert.equal(videos[0].is_public, false);
  const { canAccessVideoResource } = require('../services/video-access-policy');
  assert.equal(canAccessVideoResource(videos[0], other), false);
  assert.equal(canAccessVideoResource(videos[0], admin), true);
});

for (const endpoint of ['speakers', 'evaluate']) {
  for (const [label, user, visibility, expected] of [
    ['private outsider', other, { is_public: false }, 403],
    ['private paid outsider', paid, { is_public: false }, 403],
    ['missing visibility', other, {}, 403],
    ['public VIP free outsider', other, { is_public: true, is_vip_only: true }, 403],
    ['private owner', owner, { is_public: false, is_vip_only: true }, 200],
    ['private admin', admin, { is_public: false }, 200],
    ['ordinary public', other, { is_public: true }, 200],
    ['paid public VIP', paid, { is_public: true, is_vip_only: true }, 200],
  ]) test(`practice ${endpoint} respects ${label} before reading or assessing transcript`, async () => {
    let transcriptReads = 0;
    let conversions = 0;
    let transcriptions = 0;
    let cleaned = 0;
    const resource = { id: 10, uploader_id: 7, ...visibility };
    Object.defineProperty(resource, 'transcript_segments', { get() { transcriptReads += 1; return [segment]; } });
    const route = loadRoute('content', {
      '../data-store': { getVideoResourceById: async () => resource },
      '../services/dictionary': {},
      '../services/video-transcription': { transcribeVideoFile: async () => { transcriptions += 1; return { text: segment.text }; } },
      '../middleware/auth': { authenticate: async () => user },
      '../upload-handler': {
        handleFileUpload: async () => ({ files: { audio: { path: '/fixture/audio.webm' } }, fields: { videoId: '10', segmentIndex: '0' } }),
        cleanupFile: async () => { cleaned += 1; },
      },
      '../utils/audio-utils': { convertAudioToWav: async () => { conversions += 1; return '/fixture/audio.wav'; } },
    });
    const res = response();
    const req = { method: endpoint === 'speakers' ? 'GET' : 'POST', url: `/practice/${endpoint}?videoId=10`, headers: { host: 'localhost' } };
    await route.registerContentRoutes(`/practice/${endpoint}`, req, res);
    assert.equal(res.status, expected);
    if (expected === 403) {
      assert.equal(transcriptReads, 0);
      assert.equal(conversions, 0);
      assert.equal(transcriptions, 0);
      assert.equal(JSON.stringify(res.body).includes(segment.text), false);
      if (endpoint === 'evaluate') assert.equal(cleaned, 1);
    } else {
      assert.ok(transcriptReads > 0);
      if (endpoint === 'evaluate') assert.equal(transcriptions, 1);
    }
  });
}

function vocabularyHarness({ videos = [], stored = [], cache = new Map(), initialUser = other } = {}) {
  let user = initialUser;
  const saved = [];
  const store = {
    listVideoResources: async () => videos,
    getVideoResourceById: async id => videos.find(video => String(video.id) === String(id)) || null,
    getVocabItem: async () => ({ id: 1, lemma: 'fixture', translation: 'example' }),
    listRecentContexts: async () => stored,
    saveVocabContext: async context => { saved.push(context); },
    upsertVocabItem: async () => ({ id: 1, lemma: 'fixture' }),
  };
  const route = loadRoute('vocabulary', {
    '../data-store': store,
    '../services/translation': {},
    '../services/auth': { requireUser: async () => user },
    '../services/cache': { get: async key => cache.get(key), set: async (key, value) => cache.set(key, value), invalidate: async () => {} },
    '../services/srs-bridge': {},
    '../services/spaced-repetition': { addToSchedule: async () => {} },
  });
  return {
    saved, cache, setUser(value) { user = value; },
    async request(endpoint = '/vocab/item?lemma=fixture', body) {
      const url = new URL(endpoint, 'http://localhost');
      const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
      Object.assign(req, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer fixture' } });
      const res = response();
      await route.registerVocabularyRoutes(url.pathname, req, res, url);
      assert.equal(res.status, 200);
      return res;
    },
  };
}

test('vocabulary fallback ignores inaccessible videos before reading transcript and persisting contexts', async () => {
  let privateReads = 0;
  const privateVideo = { id: 10, uploader_id: 7, is_public: false };
  Object.defineProperty(privateVideo, 'transcript_segments', { get() { privateReads += 1; return [segment]; } });
  const publicVideo = { id: 11, uploader_id: 7, is_public: true, transcript_segments: [{ ...segment, text: 'A public fixture sentence.' }] };
  const harness = vocabularyHarness({ videos: [privateVideo, publicVideo] });
  const res = await harness.request();
  assert.equal(privateReads, 0);
  assert.deepEqual(res.body.contexts.map(context => context.video_resource_id), [11]);
  assert.deepEqual(harness.saved.map(context => context.videoResourceId), [11]);
});

test('vocabulary stored and cached contexts recheck current video visibility, ownership and entitlement', async () => {
  const videos = [
    { id: 10, uploader_id: 8, is_public: false },
    { id: 11, uploader_id: 7, is_public: true, is_vip_only: true },
  ];
  const stored = [
    { video_resource_id: 10, sentence: 'Owner fixture context.' },
    { video_resource_id: 11, sentence: 'VIP fixture context.' },
    { video_resource_id: null, sentence: 'My own unlinked fixture sentence.' },
    { video_resource_id: 99, sentence: 'Deleted fixture context.' },
  ];
  const harness = vocabularyHarness({ videos, stored, initialUser: paid });
  const first = await harness.request();
  assert.equal(first.body.contexts.length, 3);
  videos[0].uploader_id = 7;
  harness.setUser({ ...paid, subscription_status: 'expired' });
  const second = await harness.request();
  assert.deepEqual(second.body.contexts.map(context => context.video_resource_id), [null]);
  assert.equal(second.headers['Cache-Control'], 'private, no-store');
});

test('vocabulary cache never crosses account boundaries and stops showing newly private contexts', async () => {
  const video = { id: 10, uploader_id: 7, is_public: true };
  const stored = [{ video_resource_id: 10, sentence: 'Visible fixture context.' }];
  const harness = vocabularyHarness({ videos: [video], stored });
  assert.equal((await harness.request()).body.contexts.length, 1);
  video.is_public = false;
  assert.equal((await harness.request()).body.contexts.length, 0);
  harness.setUser(owner);
  assert.equal((await harness.request()).body.contexts.length, 1);
});

test('mark vocabulary returns only currently accessible contexts while preserving unlinked personal sentences', async () => {
  const harness = vocabularyHarness({
    videos: [{ id: 10, uploader_id: 7, is_public: false }],
    stored: [{ video_resource_id: 10, sentence: 'Private fixture context.' }, { video_resource_id: null, sentence: 'Personal fixture context.' }],
  });
  const res = await harness.request('/vocab/mark', { lemma: 'fixture', state: 'new', sentence: 'My fixture sentence.' });
  assert.deepEqual(res.body.contexts.map(context => context.video_resource_id), [null]);
  assert.equal(harness.saved[0].videoResourceId, null);
});
