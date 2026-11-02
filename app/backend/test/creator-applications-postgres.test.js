const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Optional embedded PostgreSQL: installed only in a disposable test runtime.
// This suite never connects to DATABASE_URL or any external database.
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function load(relative, core) {
  const filename = path.resolve(__dirname, relative);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require(name) {
      if (name === '../core' || name === './core') return core;
      throw new Error(`Unexpected dependency ${name}`);
    },
  }, { filename });
  return module.exports;
}

test('creator lifecycle, ownership, review races and migrations on disposable PostgreSQL', { skip: !PGlite && 'Optional @electric-sql/pglite is unavailable' }, async t => {
  const db = new PGlite();
  const query = db.query.bind(db);
  const core = { pool: { query }, init: async () => {}, dbUnavailable: () => false };
  try {
    await db.exec(`CREATE TABLE users (id BIGINT PRIMARY KEY, is_admin BOOLEAN DEFAULT FALSE, membership_type TEXT DEFAULT 'free');
      INSERT INTO users (id, is_admin) VALUES (7,FALSE),(8,FALSE),(9,TRUE),(10,FALSE),(11,FALSE);`);
    const { ensureCreatorApplicationSchema } = load('../data-store/schema-creators.js', core);
    const store = load('../data-store/queries/creators.js', core);
    const payload = { display_name: 'Member', bio: 'Short English lessons.', topic: 'Daily English', sample_url: null, rights_confirmed: true };

    await t.test('runtime schema and V35 are idempotent and preserve existing users and applications', async () => {
      await ensureCreatorApplicationSchema(query);
      await ensureCreatorApplicationSchema(query);
      const created = await store.submitCreatorApplication('7', payload);
      assert.equal(created.created, true);
      assert.equal(created.application.status, 'pending');
      const migration = fs.readFileSync(path.resolve(__dirname, '../../../docs/db/migrations/V35__creator_applications.sql'), 'utf8');
      await db.exec(migration); await db.exec(migration);
      assert.equal((await store.getCreatorApplication('7')).id, created.application.id);
      assert.equal((await query('SELECT count(*)::int AS n FROM users')).rows[0].n, 5);
      await assert.rejects(ensureCreatorApplicationSchema(async () => { throw new Error('permission denied'); }), /permission denied/);
    });

    await t.test('pending submissions are idempotent under retries and cannot overwrite the pending form', async () => {
      const before = await store.getCreatorApplication('7');
      const results = await Promise.all(Array.from({ length: 5 }, () => store.submitCreatorApplication('7', { ...payload, display_name: 'Overwrite attempt' })));
      assert.equal(results.every(result => result.created === false), true);
      const after = await store.getCreatorApplication('7');
      assert.equal(after.display_name, 'Member');
      assert.equal(after.revision, before.revision);
      assert.equal((await query('SELECT count(*)::int AS n FROM creator_applications WHERE user_id=7')).rows[0].n, 1);
      assert.equal(await store.getCreatorApplication('8'), null);
    });

    await t.test('review is compare-and-set and does not change membership or admin privileges', async () => {
      const application = await store.getCreatorApplication('7');
      const outcomes = await Promise.allSettled([
        store.reviewCreatorApplication(application.id, { decision: 'approved', reviewer_id: '9', expected_revision: 1 }),
        store.reviewCreatorApplication(application.id, { decision: 'rejected', reviewer_id: '9', expected_revision: 1 }),
      ]);
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(outcomes.find(result => result.status === 'rejected').reason.status, 409);
      const saved = await store.getCreatorApplication('7');
      assert.equal(saved.status, 'approved');
      assert.equal(String(saved.reviewed_by), '9');
      assert.equal(saved.revision, 2);
      const user = (await query('SELECT * FROM users WHERE id=7')).rows[0];
      assert.equal(user.is_admin, false); assert.equal(user.membership_type, 'free');
      await assert.rejects(store.submitCreatorApplication('7', payload), error => error.status === 409);
    });

    await t.test('rejected resubmission clears review and stale previous-round decisions are rejected', async () => {
      const initial = await store.submitCreatorApplication('8', payload);
      await store.reviewCreatorApplication(initial.application.id, { decision: 'rejected', review_note: 'Please provide a sample.', reviewer_id: '9', expected_revision: 1 });
      const resubmitted = await store.submitCreatorApplication('8', { ...payload, sample_url: 'https://example.com/sample' });
      assert.equal(resubmitted.application.status, 'pending');
      assert.equal(resubmitted.application.review_note, null);
      assert.equal(resubmitted.application.reviewed_by, null);
      assert.equal(resubmitted.application.reviewed_at, null);
      assert.equal(resubmitted.application.revision, 3);
      await assert.rejects(store.reviewCreatorApplication(initial.application.id, { decision: 'approved', reviewer_id: '9', expected_revision: 1 }), error => error.status === 409);
      await assert.rejects(store.reviewCreatorApplication(initial.application.id, { decision: 'approved', reviewer_id: '8', expected_revision: 3 }), error => error.status === 403);
      await store.reviewCreatorApplication(initial.application.id, { decision: 'approved', reviewer_id: '9', expected_revision: 3 });
    });

    await t.test('admin listing defaults pending, bounds pagination, and rejects invalid statuses', async () => {
      await store.submitCreatorApplication('10', payload);
      const result = await store.listCreatorApplications({ limit: 100000, offset: -5 });
      assert.equal(result.items.length, 1);
      assert.equal(String(result.items[0].user_id), '10');
      assert.equal(result.limit, 100); assert.equal(result.offset, 0);
      assert.equal(result.summary.pending, 1); assert.equal(result.summary.approved, 2);
      assert.equal((await store.listCreatorApplications({ status: 'all' })).items.length, 3);
      await assert.rejects(store.listCreatorApplications({ status: "pending' OR TRUE--" }), error => error.status === 400);
    });

    await t.test('database constraints reject missing rights confirmation, invalid status, oversize text and duplicate ownership', async () => {
      for (const [name, rights, status, errorCode] of [
        ['Member', false, 'pending', '23514'],
        ['Member', true, 'admin', '23514'],
        ['x'.repeat(81), true, 'pending', '22001'],
      ]) {
        await assert.rejects(query('INSERT INTO creator_applications (user_id,display_name,bio,topic,rights_confirmed,status) VALUES ($1,$2,$3,$4,$5,$6)', [11, name, 'English lessons.', 'Daily English', rights, status]), error => error.code === errorCode);
      }
      await assert.rejects(query("INSERT INTO creator_applications (user_id,display_name,bio,topic,rights_confirmed) VALUES (7,'Duplicate','English lessons.','Daily English',true)"), error => error.code === '23505');
    });

    await t.test('migration grants the deployment application role table access and sequence usage', async () => {
      await db.exec('CREATE ROLE linklish');
      const migration = fs.readFileSync(path.resolve(__dirname, '../../../docs/db/migrations/V35__creator_applications.sql'), 'utf8');
      await db.exec(migration);
      await db.exec('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await db.exec('SET ROLE linklish');
      try {
        await db.exec('BEGIN READ ONLY');
        try { await ensureCreatorApplicationSchema(query); }
        finally { await db.exec('ROLLBACK'); }
        assert.equal((await query("SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS allowed")).rows[0].allowed, false);
        assert.equal((await query("SELECT has_table_privilege(current_user, 'creator_applications', 'DELETE') AS allowed")).rows[0].allowed, false);
        const inserted = await query("INSERT INTO creator_applications (user_id,display_name,bio,topic,rights_confirmed) VALUES (11,'Member','English lessons.','Daily English',true) RETURNING id");
        const updated = await query("UPDATE creator_applications SET display_name='Updated member' WHERE id=$1 RETURNING display_name", [inserted.rows[0].id]);
        assert.equal(updated.rows[0].display_name, 'Updated member');
      } finally { await db.exec('RESET ROLE'); }
    });
  } finally { await db.close(); }
});

test('runtime and migration creator schemas index reviewer foreign-key lookups', { skip: !PGlite && 'Optional @electric-sql/pglite is unavailable' }, async t => {
  for (const source of ['runtime', 'migration']) {
    await t.test(source, async () => {
      const db = new PGlite();
      const query = db.query.bind(db);
      try {
        await db.exec('CREATE TABLE users (id BIGINT PRIMARY KEY)');
        if (source === 'runtime') {
          const { ensureCreatorApplicationSchema } = load('../data-store/schema-creators.js', { pool: { query } });
          await ensureCreatorApplicationSchema(query);
        } else {
          await db.exec(fs.readFileSync(path.resolve(__dirname, '../../../docs/db/migrations/V35__creator_applications.sql'), 'utf8'));
        }
        const { rows } = await query(`SELECT EXISTS (
          SELECT 1 FROM pg_index i JOIN pg_attribute a
            ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
          WHERE i.indrelid = 'creator_applications'::regclass
            AND a.attname = 'reviewed_by' AND i.indisvalid
        ) AS indexed`);
        assert.equal(rows[0].indexed, true);
      } finally { await db.close(); }
    });
  }
});

test('runtime creator schema fails closed on inaccessible, incompatible, or uncreatable tables', { skip: !PGlite && 'Optional @electric-sql/pglite is unavailable' }, async () => {
  const db = new PGlite();
  const query = db.query.bind(db);
  const { ensureCreatorApplicationSchema } = load('../data-store/schema-creators.js', { pool: { query } });
  try {
    await db.exec('CREATE TABLE users (id BIGINT PRIMARY KEY); CREATE ROLE linklish; REVOKE CREATE ON SCHEMA public FROM PUBLIC;');
    await db.exec(fs.readFileSync(path.resolve(__dirname, '../../../docs/db/migrations/V35__creator_applications.sql'), 'utf8'));
    await db.exec('REVOKE SELECT ON creator_applications FROM linklish; SET ROLE linklish;');
    try {
      await assert.rejects(ensureCreatorApplicationSchema(query), error => error.code === '42501');
    } finally { await db.exec('RESET ROLE'); }
    await db.exec('GRANT SELECT ON creator_applications TO linklish; ALTER TABLE creator_applications DROP COLUMN revision; SET ROLE linklish;');
    try {
      await assert.rejects(ensureCreatorApplicationSchema(query), error => error.code === '42703');
    } finally { await db.exec('RESET ROLE'); }
    await db.exec('DROP TABLE creator_applications; SET ROLE linklish;');
    try {
      await assert.rejects(ensureCreatorApplicationSchema(query), error => error.code === '42501');
      assert.equal((await query("SELECT to_regclass('creator_applications') AS relation")).rows[0].relation, null);
    } finally { await db.exec('RESET ROLE'); }
  } finally { await db.close(); }
});
