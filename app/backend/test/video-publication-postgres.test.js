const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { createFixtureAuth } = require('./helpers/fixture-auth');

// Optional embedded PostgreSQL in a disposable runtime. Never reads DATABASE_URL.
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

test('publication SQL is atomic and retry-safe on disposable PostgreSQL', { skip: !PGlite && 'Optional @electric-sql/pglite is unavailable' }, async t => {
  const db = new PGlite();
  const statements = [];
  const query = (sql, values) => { statements.push(sql); return db.query(sql, values); };
  // PGlite exposes one connection: queue pool leases so competing callers cannot
  // interleave transactions on that connection. Production pg uses real row locks.
  let nextLease = Promise.resolve();
  const pool = { query, async connect() {
    const previous = nextLease;
    let release;
    nextLease = new Promise(resolve => { release = resolve; });
    await previous;
    return { query, release };
  } };
  const filename = path.resolve(__dirname, '../data-store/queries/videos.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), console,
    require: name => name === '../core' ? { pool, init: async () => {}, dbUnavailable: () => false } : localRequire(name),
  }, { filename });
  const store = module.exports;
  const segments = [{ text: 'Hello there.', start: 0, end: 2, speaker: 'Alice' }];
  const owner = { id: 7 };
  const admin = { id: 9, is_admin: true };
  function pendingTranscription(resource, editingUser = owner) {
    let finish;
    const transcript = new Promise(resolve => { finish = resolve; });
    const transcriptionFile = path.resolve(__dirname, '../services/video-transcription.js');
    const source = fs.readFileSync(transcriptionFile, 'utf8').match(/^async function transcribeAndStore\(resource, options = \{\}\) \{[^]*?^\}/m)?.[0];
    assert.ok(source, 'exercise the production transcription persistence function');
    const context = { dataStore: store, path, __dirname: path.dirname(transcriptionFile),
      console: { log() {} }, transcribeVideoFile: async () => transcript,
      ensureEnglishTranscript: async value => value, getPrimaryProvider: () => 'fixture',
      buildUserMessage: error => error.message };
    vm.runInNewContext(`${source}\nthis.run = transcribeAndStore;`, context);
    return { finish, result: context.run(resource, { language: 'en', editingUser }) };
  }
  async function draft() {
    return (await query(`INSERT INTO video_resources
      (uploader_id, title, video_path, status, transcript_segments)
      VALUES (7, 'Lesson', '/videos/fixture.mp4', 'ready', $1) RETURNING *`, [JSON.stringify(segments)])).rows[0];
  }
  async function submit(video) { return store.createVideoShareRequest({ requesterId: 7, videoResourceId: video.id, note: 'Original review note' }); }
  async function review(request, status = 'approved', reviewNote = null) {
    return store.reviewVideoShareRequest(request.id, { status, reviewerId: 9, reviewNote });
  }
  async function setTags(video, body, user = admin) {
    const filename = path.resolve(__dirname, '../routes/tags.js');
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, __dirname: path.dirname(filename), console: { log() {}, error() {} },
      require: name => name === '../data-store' ? { ...store, pool }
        : name === '../middleware/auth' ? createFixtureAuth(() => user) : localRequire(name),
    }, { filename });
    const pathname = `/videos/${video.id}/tags`;
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', headers: { authorization: 'Bearer fixture' } });
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await module.exports.registerTagRoutes(pathname, req, res, new URL(pathname, 'http://localhost'));
    assert.equal(res.status, 200, res.body?.message);
  }
  try {
    await db.exec(`
      CREATE TABLE users (id BIGINT PRIMARY KEY, is_admin BOOLEAN NOT NULL DEFAULT FALSE);
      INSERT INTO users VALUES (7,FALSE),(8,FALSE),(9,TRUE);
      CREATE TABLE creator_applications (user_id BIGINT PRIMARY KEY, status TEXT);
      INSERT INTO creator_applications VALUES (7,'approved'),(8,'pending');
      CREATE TABLE video_resources (
        id SERIAL PRIMARY KEY, uploader_id BIGINT REFERENCES users(id), title TEXT, description TEXT,
        video_path TEXT, local_video_path TEXT, thumbnail_path TEXT, youtube_video_id TEXT, video_type TEXT DEFAULT 'local', mime_type TEXT DEFAULT 'video/mp4',
        status TEXT, language TEXT, failure_reason TEXT, transcript TEXT, transcript_segments JSONB, tags JSONB, is_public BOOLEAN DEFAULT FALSE,
        has_subtitles BOOLEAN DEFAULT FALSE, word_count INTEGER DEFAULT 0, unique_word_count INTEGER DEFAULT 0,
        is_featured BOOLEAN DEFAULT FALSE, is_vip_only BOOLEAN DEFAULT FALSE, view_count INTEGER DEFAULT 0,
        practice_count INTEGER DEFAULT 0, manual_order INTEGER, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
      CREATE TABLE video_share_requests (
        id BIGSERIAL PRIMARY KEY, requester_id BIGINT REFERENCES users(id), video_resource_id INTEGER REFERENCES video_resources(id),
        request_type TEXT DEFAULT 'public', note TEXT, status TEXT DEFAULT 'pending', reviewer_id BIGINT,
        review_note TEXT, reviewed_at TIMESTAMP, video_updated_at TIMESTAMPTZ, resource_revision TEXT,
        created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
      CREATE UNIQUE INDEX pending_request ON video_share_requests (requester_id,video_resource_id,request_type) WHERE status='pending';
      CREATE TABLE video_sentences (id SERIAL PRIMARY KEY, video_id INTEGER REFERENCES video_resources(id),
        sentence_index INTEGER, text TEXT, start_time_sec DOUBLE PRECISION, end_time_sec DOUBLE PRECISION, speaker TEXT);
      CREATE TABLE tags (id BIGINT PRIMARY KEY, name TEXT, icon TEXT, color TEXT, scope TEXT DEFAULT 'global',
        created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW());
      INSERT INTO tags(id,name,icon,color) VALUES (1,'Original','one','#111'),(2,'Other','two','#222');
      CREATE TABLE video_tags (video_id BIGINT REFERENCES video_resources(id), tag_id BIGINT REFERENCES tags(id),
        user_id BIGINT REFERENCES users(id), created_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY(video_id,tag_id));
      CREATE TABLE user_tags (id BIGINT PRIMARY KEY, user_id BIGINT REFERENCES users(id), name TEXT, icon TEXT, color TEXT,
        updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(user_id,name));
      INSERT INTO user_tags(id,user_id,name) VALUES(11,7,'Personal');
      CREATE TABLE video_user_tags (video_id BIGINT REFERENCES video_resources(id), user_tag_id BIGINT REFERENCES user_tags(id),
        user_id BIGINT REFERENCES users(id), PRIMARY KEY(video_id,user_tag_id));
      CREATE FUNCTION fail_review_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.review_note = 'fail-write' THEN RAISE EXCEPTION 'fixture review write failure'; END IF;
        RETURN NEW; END $$;
      CREATE TRIGGER fail_review_write BEFORE UPDATE ON video_share_requests FOR EACH ROW EXECUTE FUNCTION fail_review_write();
    `);

    await t.test('competing submissions return one pending request without overwriting its note', async () => {
      const video = await draft();
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => submit(video)));
      assert.equal(new Set(outcomes.map(result => String(result.id))).size, 1);
      assert.equal(outcomes.filter(result => result.already_pending === false).length, 1);
      assert.equal(outcomes.filter(result => result.already_pending === true).length, 4);
      assert.ok(outcomes[0].resource_revision);
      const repeat = await store.createVideoShareRequest({ requesterId: 7, videoResourceId: video.id, note: 'Replacement attempt' });
      assert.equal(repeat.note, 'Original review note');
    });

    await t.test('competing reviews commit one decision and reject the other as stale', async () => {
      const video = await draft();
      const request = await submit(video);
      const outcomes = await Promise.allSettled([review(request), review(request, 'rejected')]);
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(outcomes.find(result => result.status === 'rejected').reason.status, 409);
      assert.equal((await store.getVideoResourceById(video.id)).is_public, true);
      assert.equal((await query('SELECT status FROM video_share_requests WHERE id=$1', [request.id])).rows[0].status, 'approved');
    });

    await t.test('a failed request write rolls back the preceding publication write', async () => {
      const video = await draft();
      const request = await submit(video);
      await assert.rejects(review(request, 'approved', 'fail-write'), /fixture review write failure/);
      assert.equal((await store.getVideoResourceById(video.id)).is_public, false);
      assert.equal((await query('SELECT status FROM video_share_requests WHERE id=$1', [request.id])).rows[0].status, 'pending');
    });

    await t.test('preview counters do not stale a request while substantive admin edits do', async () => {
      const preview = await draft();
      const previewRequest = await submit(preview);
      await query('UPDATE video_resources SET view_count=10, manual_order=4, updated_at=NOW() WHERE id=$1', [preview.id]);
      await review(previewRequest);
      const edited = await draft();
      const editedRequest = await submit(edited);
      await store.updateVideoResourceForOwner(edited.id, { title: 'Changed after submission' }, admin);
      await assert.rejects(review(editedRequest), error => error.status === 409);
      assert.equal((await store.getVideoResourceById(edited.id)).is_public, false);
    });

    for (const [name, initial, changed] of [['addition', [], [1]], ['replacement', [1], [2]], ['removal', [1], []]]) {
      await t.test(`admin global tag ${name} invalidates a pending publication revision`, async () => {
        const video = await draft();
        if (initial.length) await setTags(video, { global_tag_ids: initial }, owner);
        const request = await submit(video);
        await setTags(video, { global_tag_ids: changed });
        await assert.rejects(review(request), error => error.status === 409);
        assert.equal((await store.getVideoResourceById(video.id)).is_public, false);
      });
    }

    await t.test('admin global tag metadata changes invalidate a pending publication revision', async () => {
      const video = await draft();
      await setTags(video, { global_tag_ids: [1] }, owner);
      const request = await submit(video);
      await query("UPDATE tags SET name='Edited global metadata' WHERE id=1");
      await assert.rejects(review(request), error => error.status === 409);
      assert.equal((await store.getVideoResourceById(video.id)).is_public, false);
    });

    await t.test('global tag order, assignment actor and timestamps do not change reviewed content', async () => {
      const video = await draft();
      await setTags(video, { global_tag_ids: [2,1] }, owner);
      const request = await submit(video);
      await query('DELETE FROM video_tags WHERE video_id=$1', [video.id]);
      await query('INSERT INTO video_tags(video_id,tag_id,user_id) VALUES ($1,1,9),($1,2,9)', [video.id]);
      await query("UPDATE video_tags SET created_at='2020-01-01' WHERE video_id=$1", [video.id]);
      await query("UPDATE tags SET updated_at='2020-01-01',created_at='2020-01-01'");
      await review(request);
      assert.equal((await store.getVideoResourceById(video.id)).is_public, true);
    });

    await t.test('personal tag edits with no global tags leave a pending publication revision stable', async () => {
      const video = await draft();
      const request = await submit(video);
      await setTags(video, { user_tag_ids: [11] }, owner);
      await query("UPDATE user_tags SET name='Changed personal tag' WHERE id=11");
      await review(request);
      assert.equal((await store.getVideoResourceById(video.id)).is_public, true);
    });

    await t.test('legacy pending requests without a revision cannot publish', async () => {
      const video = await draft();
      const request = await submit(video);
      await query('UPDATE video_share_requests SET resource_revision=NULL WHERE id=$1', [request.id]);
      await assert.rejects(review(request), error => error.status === 409);
      assert.equal((await store.getVideoResourceById(video.id)).is_public, false);
    });

    await t.test('pending and public content reject owner edits before changing sentence rows', async () => {
      const video = await draft();
      await submit(video);
      await assert.rejects(store.updateVideoResourceForOwner(video.id, { title: 'Unreviewed' }, owner, { sentences: segments }), error => error.status === 409);
      assert.equal((await query('SELECT count(*)::int AS n FROM video_sentences WHERE video_id=$1', [video.id])).rows[0].n, 0);
      assert.equal((await store.getVideoResourceById(video.id)).title, 'Lesson');
      const published = await draft();
      await review(await submit(published));
      await assert.rejects(store.updateVideoResourceForOwner(published.id, { transcript: 'Unreviewed' }, owner), error => error.status === 409);
    });

    await t.test('private owner imports update transcript and sentence rows atomically', async () => {
      const video = await draft();
      await store.updateVideoResourceForOwner(video.id, { transcript: 'Updated.', transcript_segments: segments }, owner, { sentences: segments });
      assert.equal((await query('SELECT text FROM video_sentences WHERE video_id=$1', [video.id])).rows[0].text, 'Hello there.');
      assert.equal((await store.getVideoResourceById(video.id)).transcript, 'Updated.');
      await assert.rejects(store.updateVideoResourceForOwner(video.id, { title: 'Must roll back' }, owner, { sentences: [{ text: 'Bad', start: 'not-a-number' }] }));
      assert.equal((await store.getVideoResourceById(video.id)).title, 'Lesson');
      assert.equal((await query('SELECT count(*)::int AS n FROM video_sentences WHERE video_id=$1', [video.id])).rows[0].n, 1);
    });

    await t.test('subtitle replacement batches segment inserts while holding the video lock', async () => {
      const video = await draft();
      const before = statements.length;
      const many = Array.from({ length: 100 }, (_, index) => ({ text: `Line ${index}`, start: index, end: index + 1 }));
      await store.updateVideoResourceForOwner(video.id, { transcript_segments: many }, owner, { sentences: many });
      assert.equal(statements.slice(before).filter(sql => /INSERT INTO video_sentences/.test(sql)).length, 1);
      assert.equal((await query('SELECT count(*)::int AS n FROM video_sentences WHERE video_id=$1', [video.id])).rows[0].n, 100);
    });

    for (const state of ['pending', 'approved']) await t.test(`a late owner transcription cannot overwrite ${state} content`, async () => {
      const video = await draft();
      const job = pendingTranscription(video);
      const request = await submit(video);
      if (state === 'approved') await review(request);
      job.finish({ text: 'Late unreviewed result.', segments: [{ text: 'Late unreviewed result.', start: 0, end: 3 }], language: 'en', provider: 'fixture' });
      await assert.rejects(job.result, error => error.status === 409);
      const saved = await store.getVideoResourceById(video.id);
      assert.equal(saved.transcript_segments[0].text, 'Hello there.');
      assert.equal(saved.status, 'ready');
      assert.equal(saved.is_public, state === 'approved');
    });

    for (const [name, actor, isPublic] of [['owner draft', owner, false], ['explicit admin public moderation', admin, true]]) {
      await t.test(`${name} transcription can finish its active job`, async () => {
        const video = await draft();
        await store.updateVideoResource(video.id, { status: 'processing', is_public: isPublic });
        const job = pendingTranscription(video, actor);
        job.finish({ text: 'Completed.', segments: [{ text: 'Completed.', start: 0, end: 1 }], language: 'en', provider: 'fixture' });
        await job.result;
        const saved = await store.getVideoResourceById(video.id);
        assert.equal(saved.status, 'ready');
        assert.equal(saved.transcript, 'Completed.');
        assert.equal(saved.is_public, isPublic);
      });
    }

    await t.test('an active transcription blocks imports that could prematurely mark the draft ready', async () => {
      const video = await draft();
      await query("UPDATE video_resources SET status='processing' WHERE id=$1", [video.id]);
      await assert.rejects(store.updateVideoResourceForOwner(video.id, { status: 'ready', transcript: 'Premature content' }, owner, { sentences: segments }), error => error.status === 409 && /processing/i.test(error.message));
      assert.equal((await store.getVideoResourceById(video.id)).status, 'processing');
      await assert.rejects(submit(video), error => error.status === 409);
      assert.equal((await query('SELECT count(*)::int AS n FROM video_sentences WHERE video_id=$1', [video.id])).rows[0].n, 0);
    });

    await t.test('competing retries can start only one background transcription job', async () => {
      const video = await draft();
      const outcomes = await Promise.allSettled([
        store.updateVideoResourceForOwner(video.id, { status: 'processing', transcript: null }, owner),
        store.updateVideoResourceForOwner(video.id, { status: 'processing', transcript: null }, owner),
      ]);
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(outcomes.find(result => result.status === 'rejected').reason.status, 409);
      assert.equal((await store.getVideoResourceById(video.id)).status, 'processing');
      // Internal progress/final transcription writes retain the existing updater.
      await store.updateVideoResource(video.id, { status: 'ready', transcript: 'Completed transcription.' });
      assert.equal((await store.getVideoResourceById(video.id)).status, 'ready');
    });

    await t.test('creator approval and readiness are rechecked at submission and approval', async () => {
      const video = await draft();
      await store.updateVideoResourceForOwner(video.id, { status: 'processing' }, owner);
      await assert.rejects(submit(video), error => error.status === 409);
      await store.updateVideoResource(video.id, { status: 'ready' });
      const request = await submit(video);
      await query("UPDATE creator_applications SET status='rejected' WHERE user_id=7");
      await assert.rejects(review(request), error => error.status === 403);
      await assert.rejects(submit(await draft()), error => error.status === 403);
      assert.equal((await store.getVideoResourceById(video.id)).is_public, false);
      await query("UPDATE creator_applications SET status='approved' WHERE user_id=7");
    });

    await t.test('media binding includes exact original and local paths with no orphan fallback', async () => {
      const video = await draft();
      await store.updateVideoResourceForOwner(video.id, { video_path: '/videos/original.mp4', local_video_path: '/videos/local.mp4' }, owner);
      assert.equal((await store.getVideoResourcesForMediaPath('/videos/original.mp4')).length, 1);
      assert.equal((await store.getVideoResourcesForMediaPath('/videos/local.mp4')).length, 1);
      assert.equal((await store.getVideoResourcesForMediaPath('/videos/original-transcoded.mp4')).length, 0);
    });

    await t.test('media lookups cannot borrow ownership from a row that mentions a video only as its thumbnail', async () => {
      const victim = await draft();
      await query("UPDATE video_resources SET uploader_id=8,video_path='/videos/private-fixture.mp4' WHERE id=$1", [victim.id]);
      const unrelated = await draft();
      await query("UPDATE video_resources SET thumbnail_path='/videos/private-fixture.mp4' WHERE id=$1", [unrelated.id]);
      const bound = await store.getVideoResourcesForMediaPath('/videos/private-fixture.mp4', 'video');
      assert.deepEqual(bound.map(row => String(row.id)), [String(victim.id)]);
      await query("UPDATE video_resources SET thumbnail_path='/static/thumbnails/server-fixture.jpg' WHERE id=$1", [unrelated.id]);
      assert.equal((await store.getVideoResourcesForMediaPath('/static/thumbnails/server-fixture.jpg', 'video')).length, 0);
      assert.equal((await store.getVideoResourcesForMediaPath('/static/thumbnails/server-fixture.jpg', 'thumbnail')).length, 1);
    });

    await t.test('the real YouTube background completion leaves an ordinary private import ready and submittable', async () => {
      const jobs = [];
      const routeFile = path.resolve(__dirname, '../routes/youtube.js');
      const routeModule = { exports: {} };
      const routeRequire = createRequire(routeFile);
      const deps = {
        '../services/auth': { requireUser: async () => owner },
        '../services/video-transcription': {},
        '../services/youtube': { isValidYouTubeUrl: () => true, extractVideoId: () => 'fixture1234',
          getVideoInfo: async () => ({ title: 'Lesson', duration: 2 }),
          getTranscript: async () => ({ transcript: 'Hello there.', segments }),
          extractWords: text => text.split(/\s+/) },
        '../services/vocabulary-v2': { calculateVideoDifficulty: async () => ({}) },
        '../services/cache': { del: async () => {} },
        '../data-store': { ...store, pool: { query }, createVideoResource: async payload =>
          (await query(`INSERT INTO video_resources (uploader_id,title,video_path,youtube_video_id,status,is_public)
            VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [payload.uploader_id, payload.title, payload.video_path,
            payload.youtube_video_id, payload.status, payload.is_public])).rows[0] },
      };
      vm.runInNewContext(fs.readFileSync(routeFile, 'utf8'), { module: routeModule, exports: routeModule.exports,
        __dirname: path.dirname(routeFile), process, Buffer, setImmediate: job => jobs.push(job),
        console: { log() {}, warn() {}, error() {} },
        require: name => Object.hasOwn(deps, name) ? deps[name] : routeRequire(name) }, { filename: routeFile });
      const req = Readable.from([Buffer.from(JSON.stringify({ url: 'https://www.youtube.com/watch?v=fixture1234' }))]);
      Object.assign(req, { method: 'POST', headers: { authorization: 'Bearer fixture' } });
      const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
      await routeModule.exports.importVideo(req, res);
      assert.equal(res.status, 200, res.body.error);
      await jobs[0]();
      const video = await store.getVideoResourceById(res.body.video.id);
      assert.equal(video.is_public, false);
      assert.equal(video.status, 'ready');
      const request = await submit(video);
      assert.equal(request.status, 'pending');
    });
  } finally { await db.close(); }
});
