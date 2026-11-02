const test = require('node:test');
const assert = require('node:assert/strict');
const center = require('../../frontend/js/pages/creator-center');

const ready = () => ({ id: 42, status: 'ready', is_public: false, video_path: '/videos/draft.mp4', mime_type: 'video/mp4', transcript_segments: [{ text: 'A useful conversation.', start: 0, end: 3 }] });
const application = () => ({ display_name: ' A creator ', bio: ' Useful short lessons. ', topic: ' Daily English ', sample_url: '', rights_confirmed: true });
const token = id => `header.${Buffer.from(JSON.stringify({ sub: id })).toString('base64url')}.signature`;

test('application validation sends only normalized application fields and exact rights consent', () => {
  assert.deepEqual(center.applicationPayload(application()), { display_name: 'A creator', bio: 'Useful short lessons.', topic: 'Daily English', sample_url: null, rights_confirmed: true });
  for (const patch of [{ rights_confirmed: false }, { rights_confirmed: 'true' }, { display_name: 'a'.repeat(81) }, { bio: 'a'.repeat(1201) }, { topic: 'a'.repeat(81) }]) {
    assert.throws(() => center.applicationPayload({ ...application(), ...patch }));
  }
});

test('sample links reject script, credentials, private addresses and local names', () => {
  assert.equal(center.publicHttpUrl('https://example.com/lesson'), 'https://example.com/lesson');
  for (const value of ['javascript:alert(1)', 'file:///tmp/video', 'https://u:p@example.com', 'http://localhost', 'http://127.1', 'http://2130706433', 'http://10.1.2.3', 'http://192.168.1.1', 'http://[::1]', 'https://printer.local.', 'https://printer/', 'http://[::ffff:127.0.0.1]']) {
    assert.throws(() => center.publicHttpUrl(value), value);
  }
});

test('publication requires actual ready video and usable timed transcript rather than a lite subtitle flag', () => {
  assert.equal(center.isPublishReady(ready()), true);
  for (const patch of [{ status: 'processing' }, { _detailFailed: true }, { mime_type: 'audio/mpeg' }, { video_path: '/recordings/audio.mp3' }, { transcript_segments: [] }, { transcript_segments: [{ text: '', start: 0, end: 2 }] }, { transcript_segments: [{ text: 'Hello', start: 3, end: 2 }] }, { transcript_segments: null, has_subtitles: true }]) {
    assert.equal(center.isPublishReady({ ...ready(), ...patch }), false, JSON.stringify(patch));
  }
});

test('resource state truthfully prioritizes public, pending, processing and missing subtitles', () => {
  assert.equal(center.resourceState({ ...ready(), is_public: true }, []).key, 'published');
  assert.equal(center.resourceState(ready(), [{ video_id: 42, request_type: 'public', status: 'pending' }]).key, 'pending');
  assert.equal(center.resourceState({ ...ready(), status: 'processing' }, []).key, 'processing');
  assert.equal(center.resourceState({ ...ready(), transcript_segments: [] }, []).key, 'needs-transcript');
  assert.equal(center.resourceState(ready(), [{ video_id: 42, request_type: 'public', status: 'rejected' }]).key, 'rejected');
  assert.equal(center.resourceState(ready(), []).key, 'draft');
});

test('any pending review locks a draft while only public history determines rejection', () => {
  const publicRejection = { id: 10, video_id: 42, request_type: 'public', status: 'rejected', review_note: 'Please revise the transcript.' };
  const featured = { id: 12, video_id: 42, request_type: 'featured', status: 'pending' };
  const pending = center.resourceState(ready(), [publicRejection, featured]);
  assert.equal(pending.key, 'pending');
  assert.equal(pending.locked, true);
  assert.match(pending.label, /精选/);
  const rejected = center.resourceState(ready(), [publicRejection, { ...featured, status: 'rejected' }]);
  assert.equal(rejected.key, 'rejected');
  assert.equal(rejected.note, publicRejection.review_note);
  assert.equal(center.resourceState(ready(), [{ ...featured, status: 'rejected' }]).key, 'draft');
});

const pendingRequests = count => Array.from({ length: count }, (_, index) => ({ id: 1000 - index, video_id: index + 1, request_type: index % 2 ? 'featured' : 'public', status: 'pending' }));

test('review loading pages through every pending type and bounds recent public history', async () => {
  const rows = pendingRequests(205); const calls = []; const options = { accountId: 7 };
  const recent = [{ id: 2, video_id: 42, request_type: 'public', status: 'rejected' }];
  const requests = await center.loadShareRequests(async (path, actualOptions) => {
    assert.equal(actualOptions, options); const url = new URL(path, 'https://example.com'); calls.push(url);
    assert.equal(url.searchParams.get('limit'), '100');
    if (url.searchParams.get('status') === 'all') { assert.equal(url.searchParams.get('request_type'), 'public'); return { items: recent }; }
    assert.equal(url.searchParams.has('request_type'), false);
    const offset = Number(url.searchParams.get('offset')); return { items: rows.slice(offset, offset + 100) };
  }, options);
  assert.deepEqual(calls.filter(url => url.searchParams.get('status') === 'pending').map(url => url.searchParams.get('offset')), ['0', '100', '200']);
  assert.equal(calls.filter(url => url.searchParams.get('status') === 'all').length, 1);
  assert.equal(requests.length, 206);
  assert.equal(center.resourceState({ ...ready(), id: 205 }, requests).locked, true);
});

test('review loading fails closed when a full pending page repeats instead of advancing', async () => {
  let pendingCalls = 0;
  await assert.rejects(center.loadShareRequests(async path => {
    if (new URL(path, 'https://example.com').searchParams.get('status') === 'all') return { items: [] };
    pendingCalls++; return { items: pendingRequests(100) };
  }), /审核状态未完整返回/);
  assert.equal(pendingCalls, 2);
});

test('review loading stops after an account generation changes or its signal aborts', async () => {
  let current = true; let pendingCalls = 0;
  await assert.rejects(center.loadShareRequests(async path => {
    if (new URL(path, 'https://example.com').searchParams.get('status') === 'all') return { items: [] };
    pendingCalls++; current = false; return { items: pendingRequests(100) };
  }, { accountId: 7 }, () => current), error => error.name === 'AbortError');
  assert.equal(pendingCalls, 1);
  const controller = new AbortController(); controller.abort(); let fetched = false;
  await assert.rejects(center.loadShareRequests(async () => { fetched = true; return { items: [] }; }, { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(fetched, false);
});

test('upload accepts video MIME only and learning links use the matching device route', () => {
  assert.equal(center.videoFile({ type: 'video/mp4', size: 12 }), true);
  for (const file of [null, { type: 'audio/mpeg', size: 12 }, { type: '', size: 12 }, { type: 'video/mp4', size: 0 }]) assert.equal(center.videoFile(file), false);
  assert.equal(center.learningHref(42, 390), './video-reader.html?videoId=42');
  assert.equal(center.learningHref(42, 820), './video-reader.html?videoId=42');
  assert.equal(center.learningHref(42, 1280), './video-reader-desktop.html?videoId=42');
  assert.throws(() => center.learningHref('42&from=other', 1280));
});

test('every request awaits session refresh and uses current Bearer credentials including multipart', async () => {
  let current = token(7); let refreshes = 0; const calls = [];
  const auth = { ready: Promise.resolve(), ensureSession: async () => { refreshes++; }, getToken: () => current };
  const request = center.createRequest(auth, async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ application: null }) }; });
  await request('/api/creator/application');
  current = token(8);
  const body = new FormData(); body.append('video', new Blob(['fixture'], { type: 'video/mp4' }), 'fixture.mp4');
  await request('/video-resources/upload', { method: 'POST', body, multipart: true });
  assert.equal(refreshes, 2);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token(7)}`);
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${token(8)}`);
  assert.equal(calls[1].options.headers['Content-Type'], undefined);
  assert.equal(calls[1].options.body, body);
});

test('requests refuse missing auth and discard a response after the account changes', async () => {
  let current = null; let resolve; let fetched = 0;
  const auth = { ready: Promise.resolve(), ensureSession: async () => {}, getToken: () => current };
  const request = center.createRequest(auth, () => { fetched++; return new Promise(done => { resolve = done; }); });
  await assert.rejects(request('/api/creator/application'), error => error.status === 401);
  assert.equal(fetched, 0);
  current = token(7);
  const pending = request('/api/creator/application', { accountId: '7' });
  await new Promise(done => setImmediate(done));
  current = token(8);
  resolve({ ok: true, json: async () => ({ application: { display_name: 'Private old account' } }) });
  await assert.rejects(pending, error => error.code === 'ACCOUNT_CHANGED');
});

test('request errors retain HTTP status so conflict recovery never reports false success', async () => {
  const auth = { ready: Promise.resolve(), ensureSession: async () => {}, getToken: () => token(7) };
  const request = center.createRequest(auth, async () => ({ ok: false, status: 409, json: async () => ({ message: 'CREATOR_APPLICATION_CONFLICT' }) }));
  await assert.rejects(request('/admin/creator-applications/2/review', { method: 'POST', body: { decision: 'approved', expected_revision: 1 } }), error => error.status === 409 && error.message === 'CREATOR_APPLICATION_CONFLICT');
});
