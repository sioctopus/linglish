const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fsp = require('node:fs/promises');

process.env.AUTH_TOKEN_SECRET = 'static-account-secret-0123456789abcdef0123456789abcdef';
process.env.MEDIA_TOKEN_SECRET = 'static-media-secret-0123456789abcdef0123456789abcdef';
process.env.MEDIA_ALLOW_LEGACY_QUERY_TOKEN = 'true';

const dataStore = require('../data-store');
const authService = require('../services/auth');
const mediaSession = require('../services/media-session');
const cacheHeadersMiddleware = require('../middleware/cache-headers');
const { getCorsHeaders } = require('../utils/cors');
const { registerStaticRoutes } = require('../routes/static');

const VIDEO_ID = 424_242;
const OWNER_ID = 7;
const VIDEO_NAME = 'task-1-media-auth.mp4';
const EMPTY_VIDEO_NAME = 'task-1-empty-media-auth.mp4';
const VIDEO_PATH = `/videos/${VIDEO_NAME}`;
const EMPTY_VIDEO_PATH = `/videos/${EMPTY_VIDEO_NAME}`;
const RECORDING_REL = `video-${VIDEO_ID}/user-${OWNER_ID}/seg-1-task-1.mp3`;
const EMPTY_RECORDING_REL = `video-${VIDEO_ID}/user-${OWNER_ID}/seg-empty-task-1.mp3`;
const RECORDING_PATH = `/recordings/${RECORDING_REL}`;
const EMPTY_RECORDING_PATH = `/recordings/${EMPTY_RECORDING_REL}`;
const PDF_NAME = 'task-2-media-auth.pdf';
const PDF_PATH = `/pdfs/${PDF_NAME}`;
const VIDEO_BODY = Buffer.from('0123456789abcdef');
const RECORDING_BODY = Buffer.from('abcdefghijklmnop');
const PDF_BODY = Buffer.from('%PDF-1.4 task-2 clean auth');
const PUBLIC_DIR = path.join(__dirname, '../public');
const VIDEO_FILE = path.join(PUBLIC_DIR, 'videos', VIDEO_NAME);
const EMPTY_VIDEO_FILE = path.join(PUBLIC_DIR, 'videos', EMPTY_VIDEO_NAME);
const RECORDING_FILE = path.join(PUBLIC_DIR, 'recordings', RECORDING_REL);
const EMPTY_RECORDING_FILE = path.join(PUBLIC_DIR, 'recordings', EMPTY_RECORDING_REL);
const PDF_FILE = path.join(__dirname, '../pdfs', PDF_NAME);

let server;
let baseUrl;

function request(pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(1_000, () => req.destroy(new Error(`Request timed out: ${method} ${pathname}`)));
    req.end();
  });
}

test.before(async () => {
  await fsp.mkdir(path.dirname(VIDEO_FILE), { recursive: true });
  await fsp.mkdir(path.dirname(RECORDING_FILE), { recursive: true });
  await fsp.mkdir(path.dirname(PDF_FILE), { recursive: true });
  await fsp.writeFile(VIDEO_FILE, VIDEO_BODY);
  await fsp.writeFile(EMPTY_VIDEO_FILE, Buffer.alloc(0));
  await fsp.writeFile(RECORDING_FILE, RECORDING_BODY);
  await fsp.writeFile(EMPTY_RECORDING_FILE, Buffer.alloc(0));
  await fsp.writeFile(PDF_FILE, PDF_BODY);
  await fsp.writeFile(path.join(__dirname, '../pdfs', '试卷-auth.pdf'), PDF_BODY);

  dataStore.findUserById = async id => [OWNER_ID, 8].includes(Number(id))
    ? { id: Number(id), email: 'owner@example.test', status: 'active', password_hash: 'hidden' }
    : null;
  dataStore.getVideoResourceById = async id => Number(id) === VIDEO_ID
    ? { id: VIDEO_ID, video_path: VIDEO_PATH, local_video_path: null }
    : null;
  dataStore.getPracticeRecordingShareByToken = async token => {
    const common = {
      token,
      user_id: OWNER_ID,
      video_resource_id: VIDEO_ID,
      speaker: 'Alice',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    if (token === 'valid-share') return common;
    if (token === 'expired-share') return { ...common, expires_at: new Date(Date.now() - 60_000).toISOString() };
    if (token === 'wrong-video') return { ...common, video_resource_id: VIDEO_ID + 1 };
    if (token === 'wrong-owner') return { ...common, user_id: 8 };
    if (token === 'wrong-speaker') return { ...common, speaker: 'Bob' };
    return null;
  };
  dataStore.listPracticeRecordingsForUser = async (videoId, userId, speaker) => {
    if (Number(videoId) === VIDEO_ID && Number(userId) === OWNER_ID && speaker === 'Alice') {
      return [{ audio_path: RECORDING_PATH, speaker: 'Alice' }];
    }
    if (Number(videoId) === VIDEO_ID && Number(userId) === 8 && speaker === 'Alice') {
      return [{ audio_path: RECORDING_PATH, speaker: 'Alice' }];
    }
    return [];
  };
  dataStore.getArticles = async () => [
    { pdf_path: PDF_PATH },
    { pdf_path: '/pdfs/试卷-auth.pdf' },
  ];

  server = http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(getCorsHeaders(req.headers.origin, { logUnknown: false }))) {
      res.setHeader(name, value);
    }
    cacheHeadersMiddleware(req, res, () => {});
    const url = new URL(req.url, `http://${req.headers.host}`);
    const handled = await registerStaticRoutes(url.pathname, req, res, url);
    if (!handled && !res.writableEnded) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await Promise.allSettled([
    fsp.unlink(VIDEO_FILE),
    fsp.unlink(EMPTY_VIDEO_FILE),
    fsp.unlink(RECORDING_FILE),
    fsp.unlink(EMPTY_RECORDING_FILE),
    fsp.unlink(PDF_FILE),
    fsp.unlink(path.join(__dirname, '../pdfs', '试卷-auth.pdf')),
  ]);
  try { await dataStore.pool.end(); } catch (_) { /* already closed */ }
});

function mediaCookie() {
  const token = mediaSession.createMediaSessionToken({ id: OWNER_ID });
  return mediaSession.serializeMediaSessionCookie(token, { production: false }).split(';')[0];
}

function accountToken(userId = OWNER_ID) {
  return authService.createAccessTokenForUser({ id: userId, email: 'owner@example.test' });
}

test('protected media rejects requests without a valid share or credential', async () => {
  const video = await request(VIDEO_PATH);
  assert.equal(video.status, 401);
  assert.equal(video.headers['cache-control'], 'private, no-store');

  const recording = await request(RECORDING_PATH, { method: 'HEAD' });
  assert.equal(recording.status, 401);
  assert.equal(recording.headers['cache-control'], 'private, no-store');
});

test('clean media URLs accept the short-lived cookie but media Bearer tokens do not', async () => {
  const cookie = mediaCookie();
  const video = await request(VIDEO_PATH, {
    headers: { cookie, origin: 'http://localhost:4000' },
  });
  assert.equal(video.status, 200);
  assert.deepEqual(video.body, VIDEO_BODY);
  assert.equal(video.headers['cache-control'], 'private, max-age=300');
  assert.equal(video.headers['access-control-allow-credentials'], 'true');
  assert.match(video.headers['access-control-allow-headers'], /(?:^|, )Range(?:,|$)/);
  assert.match(video.headers['access-control-allow-headers'], /(?:^|, )If-Range(?:,|$)/);
  assert.match(video.headers.vary, /(?:^|, )Origin(?:,|$)/);
  assert.match(video.headers.vary, /(?:^|, )Accept-Encoding(?:,|$)/);

  const mediaToken = mediaSession.createMediaSessionToken({ id: OWNER_ID });
  const deniedBearer = await request(VIDEO_PATH, {
    headers: { authorization: `Bearer ${mediaToken}` },
  });
  assert.equal(deniedBearer.status, 401);
  assert.equal(deniedBearer.headers['cache-control'], 'private, no-store');
});

test('clean PDF URLs accept only a valid media cookie or compatible account Bearer token', async () => {
  const unauthenticated = await request(PDF_PATH);
  assert.equal(unauthenticated.status, 401);

  const cleanCookie = await request(PDF_PATH, { headers: { cookie: mediaCookie() } });
  assert.equal(cleanCookie.status, 200);
  assert.deepEqual(cleanCookie.body, PDF_BODY);
  assert.equal(unauthenticated.headers['cache-control'], 'private, no-store');
  assert.equal(cleanCookie.headers['cache-control'], 'private, no-store');

  const accountBearer = await request(PDF_PATH, {
    headers: { authorization: `Bearer ${accountToken()}` },
  });
  assert.equal(accountBearer.status, 200);

  const mediaBearer = mediaSession.createMediaSessionToken({ id: OWNER_ID });
  const deniedMediaBearer = await request(PDF_PATH, {
    headers: { authorization: `Bearer ${mediaBearer}` },
  });
  assert.equal(deniedMediaBearer.status, 401);

  const encodedExam = await request(`/pdfs/${encodeURIComponent('试卷-auth.pdf')}`, {
    headers: { authorization: `Bearer ${accountToken()}` },
  });
  assert.equal(encodedExam.status, 200);
  assert.deepEqual(encodedExam.body, PDF_BODY);

  const traversal = await request(`/pdfs/${encodeURIComponent('../package.json')}`, {
    headers: { authorization: `Bearer ${accountToken()}` },
  });
  assert.equal(traversal.status, 403);

  const unknownDocument = await request('/pdfs/not-authorized.pdf', {
    headers: { cookie: mediaCookie() },
  });
  assert.equal(unknownDocument.status, 403);
  assert.equal(unknownDocument.headers['cache-control'], 'private, no-store');
});

test('missing media secret during cookie authorization returns a generic 503', async () => {
  const cookie = mediaCookie();
  const previousSecret = process.env.MEDIA_TOKEN_SECRET;
  delete process.env.MEDIA_TOKEN_SECRET;

  try {
    const response = await request(VIDEO_PATH, { headers: { cookie } });
    assert.equal(response.status, 503);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.deepEqual(JSON.parse(response.body.toString('utf8')), {
      code: 503,
      message: 'Service unavailable',
    });
    assert.doesNotMatch(response.body.toString('utf8'), /MEDIA_TOKEN_SECRET/i);
  } finally {
    process.env.MEDIA_TOKEN_SECRET = previousSecret;
  }
});

test('Bearer account tokens remain compatible and recordings enforce owner binding', async () => {
  const video = await request(VIDEO_PATH, {
    headers: { authorization: `Bearer ${accountToken()}` },
  });
  assert.equal(video.status, 200);
  assert.equal(video.headers['cache-control'], 'private, max-age=300');
  assert.equal((await request(RECORDING_PATH, {
    headers: { authorization: `Bearer ${accountToken()}` },
  })).status, 200);
  assert.equal((await request(RECORDING_PATH, {
    headers: { authorization: `Bearer ${accountToken(8)}` },
  })).status, 403);
});

test('legacy query account tokens are controlled by MEDIA_ALLOW_LEGACY_QUERY_TOKEN', async () => {
  const token = encodeURIComponent(accountToken());
  assert.equal((await request(`${VIDEO_PATH}?token=${token}`)).status, 200);
  assert.equal((await request(`${PDF_PATH}?token=${token}`)).status, 200);
  process.env.MEDIA_ALLOW_LEGACY_QUERY_TOKEN = 'false';
  try {
    assert.equal((await request(`${VIDEO_PATH}?token=${token}`)).status, 401);
    assert.equal((await request(`${PDF_PATH}?token=${token}`)).status, 401);
  } finally {
    process.env.MEDIA_ALLOW_LEGACY_QUERY_TOKEN = 'true';
  }
});

test('share access rejects expiry and video, owner, or speaker binding mismatches', async () => {
  assert.equal((await request(`${VIDEO_PATH}?share=valid-share`)).status, 200);
  for (const token of ['expired-share', 'wrong-video']) {
    const denied = await request(`${VIDEO_PATH}?share=${token}`);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['cache-control'], 'private, no-store');
  }

  const recording = await request(`${RECORDING_PATH}?share=valid-share`);
  assert.equal(recording.status, 200);
  assert.equal(recording.headers['cache-control'], 'private, no-store');
  for (const token of ['wrong-owner', 'wrong-speaker']) {
    const denied = await request(`${RECORDING_PATH}?share=${token}`);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['cache-control'], 'private, no-store');
  }

  const invalidVideoShare = await request(`${VIDEO_PATH}?share=missing-share`);
  assert.equal(invalidVideoShare.status, 403);
  assert.equal(invalidVideoShare.headers['cache-control'], 'private, no-store');
});

test('video and recording GET/HEAD support one byte range and reject invalid ranges', async () => {
  const headers = { cookie: mediaCookie(), range: 'bytes=2-5' };
  const video = await request(VIDEO_PATH, { headers });
  assert.equal(video.status, 206);
  assert.equal(video.headers['content-range'], `bytes 2-5/${VIDEO_BODY.length}`);
  assert.deepEqual(video.body, VIDEO_BODY.subarray(2, 6));

  const recording = await request(RECORDING_PATH, { headers });
  assert.equal(recording.status, 206);
  assert.equal(recording.headers['content-range'], `bytes 2-5/${RECORDING_BODY.length}`);
  assert.deepEqual(recording.body, RECORDING_BODY.subarray(2, 6));

  const head = await request(RECORDING_PATH, { method: 'HEAD', headers });
  assert.equal(head.status, 206);
  assert.equal(head.headers['content-length'], '4');
  assert.equal(head.body.length, 0);

  for (const range of ['bytes=0-1,3-4', 'items=0-1', 'bytes=99-100']) {
    const invalid = await request(VIDEO_PATH, { headers: { cookie: mediaCookie(), range } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers['content-range'], `bytes */${VIDEO_BODY.length}`);
  }
});

test('open-ended and suffix ranges support GET and HEAD for both media types', async () => {
  const media = [
    { pathname: VIDEO_PATH, body: VIDEO_BODY },
    { pathname: RECORDING_PATH, body: RECORDING_BODY },
  ];
  const ranges = [
    { value: 'bytes=4-', contentRange: 'bytes 4-15/16', bodyStart: 4, bodyEnd: 16 },
    { value: 'bytes=-4', contentRange: 'bytes 12-15/16', bodyStart: 12, bodyEnd: 16 },
  ];

  for (const { pathname, body } of media) {
    for (const range of ranges) {
      const headers = { cookie: mediaCookie(), range: range.value };
      const get = await request(pathname, { headers });
      assert.equal(get.status, 206);
      assert.equal(get.headers['content-range'], range.contentRange);
      assert.deepEqual(get.body, body.subarray(range.bodyStart, range.bodyEnd));

      const head = await request(pathname, { method: 'HEAD', headers });
      assert.equal(head.status, 206);
      assert.equal(head.headers['content-range'], range.contentRange);
      assert.equal(head.headers['content-length'], String(range.bodyEnd - range.bodyStart));
      assert.equal(head.body.length, 0);
    }
  }
});

test('every Range on an empty media entity returns 416 for GET and HEAD', async (t) => {
  const cases = [];
  for (const pathname of [EMPTY_VIDEO_PATH, EMPTY_RECORDING_PATH]) {
    for (const method of ['GET', 'HEAD']) {
      for (const range of ['bytes=0-0', 'bytes=0-', 'bytes=-1']) {
        cases.push({ pathname, method, range });
      }
    }
  }

  await Promise.all(cases.map(({ pathname, method, range }) => t.test(
    `${method} ${pathname} ${range}`,
    async () => {
      const response = await request(pathname, {
        method,
        headers: { cookie: mediaCookie(), range },
      });
      assert.equal(response.status, 416);
      assert.equal(response.headers['content-range'], 'bytes */0');
      assert.equal(response.headers['content-length'], '0');
      assert.equal(response.headers['cache-control'], 'private, no-store');
      assert.equal(response.body.length, 0);
    },
  )));
});

test('If-Range serves a range only when the validator matches', async () => {
  const initial = await request(VIDEO_PATH, { headers: { cookie: mediaCookie() } });
  const matching = await request(VIDEO_PATH, {
    headers: { cookie: mediaCookie(), range: 'bytes=0-3', 'if-range': initial.headers.etag },
  });
  assert.equal(matching.status, 206);
  assert.deepEqual(matching.body, VIDEO_BODY.subarray(0, 4));

  const stale = await request(VIDEO_PATH, {
    headers: { cookie: mediaCookie(), range: 'bytes=0-3', 'if-range': '"stale"' },
  });
  assert.equal(stale.status, 200);
  assert.deepEqual(stale.body, VIDEO_BODY);
});

test('share and legacy query responses are never cacheable', async () => {
  const share = await request(`${VIDEO_PATH}?share=valid-share`);
  assert.equal(share.headers['cache-control'], 'private, no-store');

  const legacy = await request(`${VIDEO_PATH}?token=${encodeURIComponent(accountToken())}`);
  assert.equal(legacy.headers['cache-control'], 'private, no-store');
});
