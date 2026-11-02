const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');

const backend = path.resolve(__dirname, '..');
const readyVideo = () => ({ id: 42, uploader_id: 7, is_public: false, status: 'ready',
  title: 'Lesson', video_path: '/videos/lesson.mp4', updated_at: new Date('2026-10-01T00:00:00Z'),
  transcript_segments: [{ text: 'Hello there.', start: 0, end: 2, speaker: 'Alice' }] });

function load(relative, overrides, runtime = {}) {
  const filename = path.join(backend, relative);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), process,
    Buffer, URL, console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setImmediate() {},
    ...runtime,
    require(name) { return Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name); },
  }, { filename });
  return module.exports;
}

function routeHarness({ user = { id: 7 }, video = readyVideo(), pending = [], creator = { status: 'approved' } } = {}) {
  const writes = [];
  const background = [];
  const transcriber = {};
  const uploads = {};
  const store = {
    getVideoResourceById: async () => video,
    getCreatorApplication: async () => creator,
    listVideoShareRequests: async () => pending,
    createVideoShareRequest: async payload => { writes.push(payload); return { id: 1, status: 'pending' }; },
    updateVideoResource: async (...args) => { writes.push(args); return video; },
    updateVideoResourceForOwner: async (...args) => { writes.push(args); return video; },
    deleteVideoSentences: async (...args) => writes.push(args),
    createVideoSentence: async (...args) => writes.push(args),
    logAdminAction: async () => {},
    countVideoResourcesByUploader: async () => 0,
  };
  const routes = load('routes/videos.js', {
    '../data-store': store,
    '../services/auth': { requireUser: async () => user },
    '../services/video-transcription': transcriber, '../services/cache': { del: async () => {} },
    '../upload-handler': { handleFileUpload: (...args) => uploads.handleFileUpload(...args), cleanupFile: (...args) => uploads.cleanupFile(...args) },
    '../services/yt-dlp-downloader': {}, '../services/geo-ip': {},
    '../services/vocabulary-v2': { calculateVideoDifficulty: async () => ({}) },
    '../utils/audio-utils': {}, '../services/youtube': {},
    '../config/ai-config': { features: { videoTranscription: false } },
    'fluent-ffmpeg': null,
  }, { setImmediate: callback => background.push(callback) });
  return { store, writes, uploads, background, transcriber, async request(url, method, body, headers = { authorization: 'Bearer fixture' }) {
    const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
    Object.assign(req, { url, method, headers: { ...headers, host: 'local.test' } });
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); }, setHeader() {} };
    await routes.registerVideoRoutes(url, req, res);
    return res;
  } };
}

for (const [url, method, body] of [
  ['/video-resources/42/transcript/0', 'PUT', { text: 'Changed' }],
  ['/video-resources/42/speakers', 'PATCH', { from: 'Alice', to: 'Bob' }],
]) {
  test(`${method} ${url} rejects a different owner before touching transcript content`, async () => {
    const video = readyVideo();
    Object.defineProperty(video, 'transcript_segments', { get() { assert.fail('private transcript read'); } });
    const h = routeHarness({ user: { id: 8 }, video });
    assert.equal((await h.request(url, method, body)).status, 403);
    assert.equal(h.writes.length, 0);
  });
}

for (const [url, method, body] of [
  ['/video-resources/42', 'PATCH', { title: 'Changed' }],
  ['/video-resources/42/transcript/0', 'PUT', { text: 'Changed' }],
  ['/video-resources/42/speakers', 'PATCH', { from: 'Alice', to: 'Bob' }],
  ['/video-resources/42/retranscribe', 'POST', {}],
  ['/video-resources/42/reprocess-segments', 'POST', {}],
  ['/video-resources/42/import-transcript', 'POST', { transcript: 'Changed.' }],
]) {
  for (const state of ['public', 'pending']) test(`${method} ${url} locks ${state} content against owner edits`, async () => {
    const video = readyVideo();
    video.is_public = state === 'public';
    const h = routeHarness({ video, pending: state === 'pending' ? [{ id: 2 }] : [] });
    const response = await h.request(url, method, body);
    assert.equal(response.status, 409);
    assert.match(response.body.message, /审核|review/i);
    assert.equal(h.writes.length, 0);
  });
}

test('an approved creator is required for public submission', async () => {
  const h = routeHarness({ creator: { status: 'pending' } });
  const response = await h.request('/api/video-share-requests', 'POST', { video_id: 42 });
  assert.equal(response.status, 403);
  assert.match(response.body.message, /创作者|creator/i);
  assert.equal(h.writes.length, 0);
});

test('background retry actor comes from authentication and cannot be supplied in the request body', async () => {
  const h = routeHarness();
  let actor;
  h.transcriber.transcribeAndStore = async (video, options) => { actor = options.editingUser; return {}; };
  assert.equal((await h.request('/video-resources/42/retranscribe', 'POST', { editingUser: { id: 9, is_admin: true } })).status, 202);
  await h.background[0]();
  assert.equal(actor.id, 7);
  assert.equal(actor.is_admin, false);
});

function youtubeHarness(user = { id: 7 }) {
  const writes = [];
  const store = { pool: { query: async () => ({ rows: [] }) },
    createVideoResource: async payload => { writes.push(payload); return { id: 42, ...payload }; } };
  const routes = load('routes/youtube.js', {
    '../data-store': store, '../services/auth': { requireUser: async () => user },
    '../services/video-transcription': {},
    '../services/youtube': { isValidYouTubeUrl: () => true, extractVideoId: () => 'fixture',
      getVideoInfo: async () => ({ title: 'Lesson', duration: 3 }) },
  });
  return { writes, async request(body, headers = { authorization: 'Bearer fixture' }) {
    const req = Readable.from([Buffer.from(JSON.stringify({ url: 'https://www.youtube.com/watch?v=fixture', ...body }))]);
    Object.assign(req, { method: 'POST', headers });
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await routes.importVideo(req, res);
    return res;
  } };
}

for (const [name, user, mode, isPublic] of [
  ['ordinary default permanent import', { id: 7 }, undefined, false],
  ['ordinary explicit permanent import', { id: 7 }, 'permanent', false],
  ['ordinary temporary import', { id: 7 }, 'temporary', false],
  ['admin permanent import', { id: 9, is_admin: true }, 'permanent', true],
  ['admin temporary import', { id: 9, is_admin: true }, 'temporary', false],
]) test(`${name} obeys the publication boundary`, async () => {
  const h = youtubeHarness(user);
  assert.equal((await h.request(mode === undefined ? {} : { mode })).status, 200);
  assert.equal(h.writes[0].is_public, isPublic);
});

test('client YouTube metadata cannot assign local media or thumbnail paths', async () => {
  const h = routeHarness();
  let created;
  h.store.getVideoResourceByPath = async () => null;
  h.store.createVideoResource = async payload => { created = payload; return { id: 42, ...payload }; };
  const response = await h.request('/video-resources/youtube', 'POST', {
    youtube_video_id: 'fixture1234', thumbnail_path: '/videos/private-fixture.mp4',
    video_path: '/videos/private-fixture.mp4', local_video_path: '/videos/private-fixture.mp4',
  });
  assert.equal(response.status, 201);
  assert.equal(created.thumbnail_path, 'https://img.youtube.com/vi/fixture1234/hqdefault.jpg');
  assert.equal(created.video_path, 'https://www.youtube.com/watch?v=fixture1234');
  assert.equal(created.local_video_path, undefined);
});

test('a new YouTube save stays processing until transcript, sentence rows and readiness are saved together', async () => {
  const h = routeHarness();
  let saved;
  h.store.getVideoResourceByPath = async () => null;
  h.store.createVideoResource = async payload => {
    assert.equal(payload.status, 'processing');
    saved = { id: 42, ...payload };
    return saved;
  };
  h.store.getVideoResourceById = async () => saved;
  h.store.createVideoSentence = async () => assert.fail('sentence rows must be written in the final transaction');
  h.store.updateVideoResource = async () => assert.fail('user content must use the owner-bound transaction');
  h.store.updateVideoResourceForOwner = async (id, updates, user, options) => {
    assert.equal(saved.status, 'processing');
    assert.equal(user.id, 7);
    assert.equal(options.allowProcessingCompletion, true);
    assert.equal(options.sentences.length, 1);
    assert.equal(updates.status, 'ready');
    saved = { ...saved, ...updates };
    return saved;
  };
  const response = await h.request('/video-resources/youtube', 'POST', {
    youtube_video_id: 'fixture1234', segments: [{ text: 'Hello there.', start: 0, end: 2 }],
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.video.status, 'ready');
  assert.equal(response.body.video.transcript_segments[0].text, 'Hello there.');
});

test('a new YouTube save whose final authorization changes cannot fall back to raw content writes', async () => {
  const h = routeHarness();
  h.store.getVideoResourceByPath = async () => null;
  h.store.createVideoResource = async payload => ({ id: 42, ...payload });
  h.store.createVideoSentence = async () => assert.fail('must not write sentence rows outside the guarded transaction');
  h.store.updateVideoResource = async () => assert.fail('must not overwrite a changed resource');
  h.store.updateVideoResourceForOwner = async () => { throw Object.assign(new Error('Content is now pending review'), { status: 409 }); };
  const response = await h.request('/video-resources/youtube', 'POST', {
    youtube_video_id: 'fixture1234', segments: [{ text: 'Hello there.', start: 0, end: 2 }],
  });
  assert.equal(response.status, 409);
});

test('a YouTube save without subtitles remains editable and cannot enter publication review', async () => {
  const h = routeHarness();
  let saved;
  h.store.getVideoResourceByPath = async () => null;
  h.store.createVideoResource = async payload => { saved = { id: 42, ...payload }; return saved; };
  h.store.getVideoResourceById = async () => saved;
  h.store.updateVideoResourceForOwner = async (id, updates) => { saved = { ...saved, ...updates }; return saved; };
  const response = await h.request('/video-resources/youtube', 'POST', { youtube_video_id: 'fixture1234' });
  assert.equal(response.status, 201);
  assert.equal(response.body.video.status, 'skipped');
  assert.equal(response.body.video.is_public, false);
  assert.equal((await h.request('/api/video-share-requests', 'POST', { video_id: 42 })).status, 409);
});

for (const id of ['../private-media', 'fixture1234?path=/videos/private.mp4', { path: '/videos/private.mp4' }]) {
  test(`client YouTube ID must be a valid identifier: ${String(id)}`, async () => {
    const h = routeHarness();
    h.store.getVideoResourceByPath = async () => { assert.fail('invalid source must fail before any lookup'); };
    assert.equal((await h.request('/video-resources/youtube', 'POST', { youtube_video_id: id })).status, 400);
    assert.equal(h.writes.length, 0);
  });
}

for (const headers of [{ cookie: 'linglish_token=fixture' }, { authorization: 'Basic fixture' }, { authorization: 'Bearer fixture trailing' }]) {
  test(`YouTube import requires a strict bearer credential: ${headers.authorization || 'cookie'}`, async () => {
    const h = youtubeHarness();
    assert.equal((await h.request({}, headers)).status, 401);
    assert.equal(h.writes.length, 0);
  });
}

for (const headers of [{ cookie: 'linglish_token=fixture' }, { authorization: 'Bearer', cookie: 'linglish_token=fixture' }, { authorization: 'fixture', cookie: 'linglish_token=fixture' }]) {
  test(`resource writes reject cookie-only or malformed bearer credentials: ${headers.authorization || 'cookie'}`, async () => {
    const h = routeHarness();
    const response = await h.request('/video-resources/42/transcript/0', 'PUT', { text: 'Changed' }, headers);
    assert.equal(response.status, 401);
    assert.equal(h.writes.length, 0);
  });
}

test('an admin can submit ready content without a creator application', async () => {
  const h = routeHarness({ user: { id: 7, is_admin: true }, creator: null });
  assert.equal((await h.request('/api/video-share-requests', 'POST', { video_id: 42 })).status, 201);
});

test('unready content cannot enter the moderation queue', async () => {
  const h = routeHarness({ video: { ...readyVideo(), status: 'processing' } });
  const response = await h.request('/api/video-share-requests', 'POST', { video_id: 42 });
  assert.equal(response.status, 409);
  assert.equal(h.writes.length, 0);
});

test('the speaker read endpoint hides another owner’s private transcript', async () => {
  const h = routeHarness({ user: { id: 8 } });
  assert.equal((await h.request('/video-resources/42/speakers', 'GET')).status, 404);
});

test('new recording shares require access to the underlying video', async () => {
  const h = routeHarness({ user: { id: 8 } });
  h.store.listPracticeRecordingsForUser = async () => { assert.fail('must check private resource first'); };
  assert.equal((await h.request('/api/practice-shares', 'POST', { video_id: 42, speaker: 'Alice' })).status, 404);
});

for (const endpoint of ['retranscribe', 'reprocess-segments', 'import-transcript']) test(`uploader_id owner can ${endpoint} a private draft`, async () => {
  const h = routeHarness();
  const response = await h.request(`/video-resources/42/${endpoint}`, 'POST', { transcript: 'Hello there.' });
  assert.equal(response.status, endpoint === 'retranscribe' ? 202 : 200);
  assert.ok(h.writes.length > 0);
});

for (const [url, method, body] of [
  ['/video-resources/42/transcript/0', 'PUT', { text: 'Replace active transcription' }],
  ['/video-resources/42/speakers', 'PATCH', { from: 'Alice', to: 'Bob' }],
  ['/video-resources/42/import-transcript', 'POST', { transcript: 'Replace active transcription.' }],
  ['/video-resources/42/retranscribe', 'POST', {}],
]) test(`active transcription blocks ${method} ${url} with a processing conflict`, async () => {
  const h = routeHarness({ video: { ...readyVideo(), status: 'processing' } });
  const response = await h.request(url, method, body);
  assert.equal(response.status, 409);
  assert.match(response.body.message, /处理|processing/i);
  assert.equal(h.writes.length, 0);
});

test('admin moderation can edit a public transcript explicitly', async () => {
  const h = routeHarness({ user: { id: 1, is_admin: true }, video: { ...readyVideo(), is_public: true } });
  assert.equal((await h.request('/video-resources/42/transcript/0', 'PUT', { text: 'Reviewed correction.' })).status, 200);
});

test('moderation uses the atomic review result before clearing publication caches', async () => {
  const h = routeHarness({ user: { id: 1, is_admin: true } });
  h.store.reviewVideoShareRequest = async (id, payload) => {
    assert.equal(id, 2); assert.equal(payload.status, 'approved');
    return { request: { id: 2, status: 'approved' }, video: { ...readyVideo(), is_public: true } };
  };
  const response = await h.request('/admin/video-share-requests/2/review', 'POST', { status: 'approved' });
  assert.equal(response.status, 200);
  assert.equal(response.body.video.is_public, true);
  assert.equal(h.writes.length, 0, 'route must never split publication and review into independent writes');
});

function queryHarness({ video = readyVideo(), request, creator = { status: 'approved' }, failReviewWrite = false } = {}) {
  const calls = [];
  const review = request || { id: 3, requester_id: 7, video_resource_id: 42, request_type: 'public', status: 'pending', video_updated_at: video.updated_at };
  let committed = false;
  const client = { release() {}, async query(sql, params) {
    calls.push({ sql, params });
    if (sql === 'COMMIT') committed = true;
    if (/SELECT .*FROM users/s.test(sql)) return { rows: [{ id: 7, is_admin: false }] };
    if (/SELECT .*FROM creator_applications/s.test(sql)) return { rows: creator ? [creator] : [] };
    if (/^SELECT .*FROM video_resources/s.test(sql)) return { rows: video ? [video] : [] };
    if (/SELECT .*FROM video_share_requests/s.test(sql)) return { rows: review ? [{ ...review,
      revision_matches: Boolean(video && review.video_updated_at && +new Date(review.video_updated_at) === +new Date(video.updated_at)),
    }] : [] };
    if (/INSERT INTO video_share_requests/.test(sql)) return { rows: [{ ...review, already_pending: true }] };
    if (/UPDATE video_share_requests/.test(sql)) {
      if (failReviewWrite) throw new Error('fixture review write failure');
      return { rows: [{ ...review, status: params[1] }] };
    }
    if (/UPDATE video_resources/.test(sql)) return { rows: [{ ...video, is_public: true }] };
    return { rows: [] };
  } };
  const pool = { connect: async () => client, query: client.query.bind(client) };
  return { calls, get committed() { return committed; }, queries: load('data-store/queries/videos.js', {
    '../core': { pool, init: async () => {}, dbUnavailable: () => false },
  }) };
}

test('share submission inserts idempotently under the video row lock', async () => {
  const h = queryHarness();
  const result = await h.queries.createVideoShareRequest({ requesterId: 7, videoResourceId: 42 });
  assert.equal(result.already_pending, true);
  assert.ok(h.calls.some(c => /FROM video_resources[^]*FOR UPDATE/.test(c.sql)));
  const insert = h.calls.find(c => /INSERT INTO video_share_requests/.test(c.sql));
  assert.match(insert.sql, /ON CONFLICT[^]*WHERE status = 'pending'[^]*DO UPDATE/);
  assert.match(insert.sql, /resource_revision/);
  assert.match(insert.sql, /md5\(/);
  assert.match(insert.sql, /view_count/);
  assert.equal(h.committed, true);
});

for (const scope of ['private-other-owner', 'private-owner', 'public']) test(`duplicate upload exposes metadata only for accessible ${scope} resource`, async t => {
  const temporary = path.join(require('node:os').tmpdir(), `video-security-${process.pid}-${scope}.mp4`);
  await fs.promises.writeFile(temporary, 'fixture media bytes');
  t.after(() => fs.promises.rm(temporary, { force: true }));
  const h = routeHarness();
  h.uploads.handleFileUpload = async () => ({ fields: {}, files: { video: { path: temporary, mimetype: 'video/mp4' } } });
  h.uploads.cleanupFile = async () => {};
  h.store.getVideoResourceByFileHash = async () => ({ id: 99, title: 'Secret title', uploader_id: scope === 'private-owner' ? 7 : 8, is_public: scope === 'public' });
  const response = await h.request('/video-resources/upload', 'POST', {});
  assert.equal(response.status, 409);
  if (scope === 'private-other-owner') {
    assert.equal(response.body.existing_video_id, undefined);
    assert.equal(response.body.existing_title, undefined);
    assert.doesNotMatch(JSON.stringify(response.body), /Secret title|99/);
  } else assert.equal(response.body.existing_video_id, 99);
});

test('publication and review roll back together if the final write fails', async () => {
  const h = queryHarness({ failReviewWrite: true });
  assert.equal(typeof h.queries.reviewVideoShareRequest, 'function');
  await assert.rejects(h.queries.reviewVideoShareRequest(3, { status: 'approved', reviewerId: 1 }), /fixture/);
  assert.equal(h.committed, false);
  assert.ok(h.calls.some(c => c.sql === 'ROLLBACK'));
});

for (const [name, options, status] of [
  ['already reviewed', { request: { id: 3, video_resource_id: 42, status: 'approved' } }, 409],
  ['stale content', { request: { id: 3, requester_id: 7, video_resource_id: 42, status: 'pending', video_updated_at: new Date('2020-01-01') } }, 409],
  ['changed owner', { video: { ...readyVideo(), uploader_id: 8 } }, 409],
  ['not ready', { video: { ...readyVideo(), status: 'failed' } }, 409],
  ['creator no longer approved', { creator: { status: 'rejected' } }, 403],
]) test(`approval rejects ${name} without publishing`, async () => {
  const h = queryHarness(options);
  assert.equal(typeof h.queries.reviewVideoShareRequest, 'function');
  await assert.rejects(h.queries.reviewVideoShareRequest(3, { status: 'approved', reviewerId: 1 }), error => error.status === status);
  assert.equal(h.calls.some(c => /UPDATE video_resources/.test(c.sql)), false);
  assert.equal(h.committed, false);
});
