const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { createFixtureAuth } = require('./helpers/fixture-auth');

let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

test('video tag assignments enforce publication locks using disposable PostgreSQL', { skip: !PGlite && 'Optional @electric-sql/pglite unavailable' }, async t => {
  const db = new PGlite();
  const statements = [];
  const query = async (sql, values) => { statements.push(sql); return db.query(sql, values); };
  let nextLease = Promise.resolve();
  const pool = { query, async connect() {
    const previous = nextLease;
    let release;
    nextLease = new Promise(resolve => { release = resolve; });
    await previous;
    return { query, release };
  } };
  let user = { id: 7 };
  const filename = path.resolve(__dirname, '../routes/tags.js');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), console: { log() {}, error() {} },
    require: name => name === '../data-store' ? { pool, getVideoResourceById: async id => (await query('SELECT * FROM video_resources WHERE id=$1', [id])).rows[0] }
      : name === '../middleware/auth' ? createFixtureAuth(() => user) : localRequire(name),
  }, { filename });
  async function request(body, pathname = '/videos/10/tags', method = 'POST') {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, headers: { authorization: 'Bearer fixture' } });
    const res = { headersSent: false, writableEnded: false, headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      writeHead(status, headers) { this.status = status; this.headersSent = true; Object.assign(this.headers, headers); },
      end(body) { this.body = JSON.parse(body); this.writableEnded = true; } };
    await module.exports.registerTagRoutes(pathname, req, res, new URL(pathname, 'http://localhost'));
    return res;
  }
  async function reset({ isPublic = false, status = 'ready', pending = false } = {}) {
    user = { id: '7' };
    await db.exec('DELETE FROM video_user_tags; DELETE FROM video_tags; DELETE FROM video_share_requests; DELETE FROM video_resources;');
    await query('INSERT INTO video_resources(id,uploader_id,is_public,status) VALUES (10,7,$1,$2)', [isPublic, status]);
    await query('INSERT INTO video_tags(video_id,tag_id,user_id) VALUES (10,1,7)');
    if (pending) await query("INSERT INTO video_share_requests(video_resource_id,status) VALUES (10,'pending')");
    statements.length = 0;
  }
  const globalIds = async () => (await query('SELECT tag_id FROM video_tags WHERE video_id=10 ORDER BY tag_id')).rows.map(row => Number(row.tag_id));
  const personalIds = async () => (await query('SELECT user_tag_id FROM video_user_tags WHERE video_id=10 AND user_id=$1 ORDER BY user_tag_id', [user.id])).rows.map(row => Number(row.user_tag_id));
  try {
    await db.exec(`
      CREATE TABLE video_resources (id BIGINT PRIMARY KEY, uploader_id BIGINT, is_public BOOLEAN, is_vip_only BOOLEAN DEFAULT FALSE, status TEXT);
      CREATE TABLE video_share_requests (id SERIAL PRIMARY KEY, video_resource_id BIGINT, status TEXT);
      CREATE TABLE tags (id BIGINT PRIMARY KEY, name TEXT, icon TEXT, color TEXT, scope TEXT);
      INSERT INTO tags VALUES (1,'Original','1','#111','global'),(2,'Changed','2','#222','global'),(3,'Fail fixture','3','#333','global');
      CREATE TABLE user_tags (id BIGSERIAL PRIMARY KEY, user_id BIGINT, name TEXT, icon TEXT, color TEXT, updated_at TIMESTAMP, UNIQUE(user_id,name));
      INSERT INTO user_tags(id,user_id,name) VALUES (11,7,'Personal'),(12,8,'Other personal');
      CREATE TABLE video_tags (video_id BIGINT REFERENCES video_resources(id), tag_id BIGINT REFERENCES tags(id), user_id BIGINT, PRIMARY KEY(video_id,tag_id));
      CREATE TABLE video_user_tags (video_id BIGINT REFERENCES video_resources(id), user_tag_id BIGINT REFERENCES user_tags(id), user_id BIGINT, PRIMARY KEY(video_id,user_tag_id,user_id));
      CREATE FUNCTION fail_tag_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.tag_id=3 THEN RAISE EXCEPTION 'fixture tag write failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_tag_write BEFORE INSERT ON video_tags FOR EACH ROW EXECUTE FUNCTION fail_tag_write();
    `);

    await t.test('private owner may replace globals after acquiring the video row lock', async () => {
      await reset();
      const res = await request({ global_tag_ids: [2], user_tag_ids: [11] });
      assert.equal(res.status, 200);
      assert.deepEqual(await globalIds(), [2]);
      assert.deepEqual(await personalIds(), [11]);
      const lock = statements.findIndex(sql => /video_resources.*FOR UPDATE/i.test(sql));
      const mutation = statements.findIndex(sql => /DELETE FROM video_tags/.test(sql));
      assert.equal(statements[0], 'BEGIN');
      assert.ok(lock > 0 && mutation > lock);
      assert.ok(statements.some(sql => sql === 'COMMIT'));
    });
    for (const [name, state] of [['pending', { pending: true }], ['public', { isPublic: true }], ['processing', { status: 'processing' }]]) {
      await t.test(`${name} owner cannot replace or clear global tags`, async () => {
        for (const ids of [[2], []]) {
          await reset(state);
          const res = await request({ global_tag_ids: ids, user_tag_ids: [11] });
          assert.equal(res.status, 409);
          assert.deepEqual(await globalIds(), [1]);
          assert.deepEqual(await personalIds(), []);
          assert.ok(statements.some(sql => sql === 'ROLLBACK'));
        }
      });
    }
    await t.test('personal-only edits preserve global tags on a locked public video', async () => {
      await reset({ isPublic: true, pending: true });
      const res = await request({ user_tag_ids: [11] });
      assert.equal(res.status, 200);
      assert.deepEqual(await globalIds(), [1]);
      assert.deepEqual(await personalIds(), [11]);
    });
    await t.test('unchanged globals allow a personal edit without rewriting moderated global assignments', async () => {
      await reset({ isPublic: true, pending: true });
      const res = await request({ global_tag_ids: [1], user_tag_ids: [11] });
      assert.equal(res.status, 200);
      assert.deepEqual(await globalIds(), [1]);
      assert.deepEqual(await personalIds(), [11]);
      assert.equal(statements.some(sql => /DELETE FROM video_tags/.test(sql)), false);
    });
    await t.test('explicit admin may moderate pending globals under the same video lock', async () => {
      await reset({ pending: true });
      user = { id: 9, is_admin: true };
      assert.equal((await request({ global_tag_ids: [2] })).status, 200);
      assert.deepEqual(await globalIds(), [2]);
    });
    await t.test('admin still cannot change globals while transcription is processing', async () => {
      await reset({ status: 'processing' });
      user = { id: 9, is_admin: true };
      assert.equal((await request({ global_tag_ids: [2] })).status, 409);
      assert.deepEqual(await globalIds(), [1]);
    });
    await t.test('private outsiders cannot read or attach tags, including paid users', async () => {
      await reset();
      user = { id: 8, membership_type: 'vip', subscription_status: 'active' };
      assert.equal((await request({ global_tag_ids: [2], user_tag_ids: [12] })).status, 403);
      assert.equal((await request(null, '/videos/10/tags', 'GET')).status, 403);
      assert.deepEqual(await globalIds(), [1]);
      assert.deepEqual(await personalIds(), []);
    });
    await t.test('batch tag reads omit inaccessible videos', async () => {
      await reset();
      user = { id: 8 };
      const res = await request({ video_ids: [10] }, '/videos/tags/batch');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.items, []);
    });
    await t.test('other viewers keep selected global tags personal on an accessible public video', async () => {
      await reset({ isPublic: true });
      user = { id: 8 };
      const res = await request({ global_tag_ids: [2], user_tag_ids: [12] });
      assert.equal(res.status, 200);
      assert.equal(res.body.converted_to_user_tags.length, 1);
      assert.deepEqual(await globalIds(), [1]);
      assert.equal((await personalIds()).length, 2);
    });
    await t.test('failed tag replacement rolls back its preceding delete', async () => {
      await reset();
      assert.equal((await request({ global_tag_ids: [3] })).status, 400);
      assert.deepEqual(await globalIds(), [1]);
      assert.ok(statements.some(sql => sql === 'ROLLBACK'));
    });
  } finally { await db.close(); }
});
