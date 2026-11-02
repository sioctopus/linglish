const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// This suite uses only disposable embedded PostgreSQL, never DATABASE_URL.
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

function loadSchema(query) {
  const filename = path.resolve(__dirname, '../data-store/schema-video-publication.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require(name) {
      if (name === './core') return { pool: { query } };
      throw new Error(`Unexpected dependency ${name}`);
    },
  }, { filename });
  return module.exports.ensureVideoPublicationSchema;
}

async function fixture(db) {
  await db.exec(`CREATE TABLE video_resources (
      id BIGINT PRIMARY KEY, video_path TEXT UNIQUE,
      local_video_path VARCHAR(1000), thumbnail_path TEXT
    );
    CREATE TABLE video_share_requests (
      id BIGINT PRIMARY KEY, video_resource_id BIGINT REFERENCES video_resources(id),
      status TEXT, note TEXT
    );
    INSERT INTO video_resources VALUES (1, '/videos/lesson.mp4', NULL, '/videos/lesson.jpg');
    INSERT INTO video_share_requests VALUES (1, 1, 'pending', 'Keep this request');`);
}

async function assertSchema(db) {
  const { rows } = await db.query(`SELECT DISTINCT a.attname AS column_name
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_am am ON am.oid = c.relam
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = 'video_resources'::regclass AND i.indisvalid AND i.indisready
      AND i.indpred IS NULL AND am.amname = 'btree'
      AND a.attname IN ('local_video_path', 'thumbnail_path') ORDER BY a.attname`);
  assert.deepEqual(rows.map(row => row.column_name), ['local_video_path', 'thumbnail_path']);
  const request = (await db.query('SELECT * FROM video_share_requests WHERE id = 1')).rows[0];
  assert.equal(request.status, 'pending');
  assert.equal(request.note, 'Keep this request');
  assert.equal(request.video_updated_at, null);
  assert.equal(request.resource_revision, null);
}

const options = { skip: !PGlite && 'Optional @electric-sql/pglite is unavailable' };

test('runtime publication schema adds only missing support and is idempotent', options, async () => {
  const db = new PGlite();
  const query = db.query.bind(db);
  try {
    await fixture(db);
    const ensureSchema = loadSchema(query);
    await ensureSchema(query);
    await ensureSchema(query);
    await assertSchema(db);
  } finally { await db.close(); }
});

test('owner-run V36 supports startup with a read-only runtime role', options, async () => {
  const db = new PGlite();
  const query = db.query.bind(db);
  try {
    await fixture(db);
    await db.exec('CREATE ROLE linklish; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT SELECT ON video_resources, video_share_requests TO linklish;');
    const migration = fs.readFileSync(path.resolve(__dirname, '../../../docs/db/migrations/V36__video_publication_access.sql'), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    await assertSchema(db);
    await db.exec('SET ROLE linklish; BEGIN READ ONLY;');
    try {
      await loadSchema(query)(query);
      assert.equal((await query("SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS allowed")).rows[0].allowed, false);
      assert.equal((await query("SELECT has_table_privilege(current_user, 'video_share_requests', 'UPDATE') AS allowed")).rows[0].allowed, false);
    } finally { await db.exec('ROLLBACK; RESET ROLE;'); }
  } finally { await db.close(); }
});

test('publication schema rejects incompatible types before applying DDL', options, async () => {
  const db = new PGlite();
  const query = db.query.bind(db);
  try {
    await fixture(db);
    await db.exec('ALTER TABLE video_share_requests ADD COLUMN video_updated_at TEXT');
    await assert.rejects(loadSchema(query)(query), /VIDEO_PUBLICATION_SCHEMA_INCOMPATIBLE/);
    assert.equal((await query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'video_share_requests' AND column_name = 'resource_revision'")).rows[0].n, 0);
  } finally { await db.close(); }
});

test('publication schema fails closed when required base tables or runtime permissions are missing', options, async () => {
  const db = new PGlite();
  const query = db.query.bind(db);
  try {
    await fixture(db);
    const ensureSchema = loadSchema(query);
    await ensureSchema(query);
    await db.exec('CREATE ROLE linklish; REVOKE CREATE ON SCHEMA public FROM PUBLIC; SET ROLE linklish;');
    try {
      await assert.rejects(ensureSchema(query), error => error.code === '42501');
    } finally { await db.exec('RESET ROLE'); }
    await db.exec('GRANT SELECT ON video_resources, video_share_requests TO linklish; DROP INDEX idx_video_resources_local_video_path; SET ROLE linklish;');
    try {
      await assert.rejects(ensureSchema(query), error => error.code === '42501');
    } finally { await db.exec('RESET ROLE'); }
    await db.exec('DROP TABLE video_share_requests');
    await assert.rejects(ensureSchema(query), error => error.code === '42P01');
    assert.equal((await query("SELECT to_regclass('video_share_requests') AS relation")).rows[0].relation, null);
  } finally { await db.close(); }
});
