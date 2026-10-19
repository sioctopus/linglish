const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { Pool } = require('pg');

let containerName;
let pool;
let store;
let sessions;
let available = false;
const deviceId = 'session-device-000001';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test.before(async () => {
  if (spawnSync('docker', ['info'], { encoding: 'utf8' }).status !== 0) return;
  available = true;
  containerName = `linglish-session-persistence-${process.pid}-${Date.now()}`;
  docker('run', '--detach', '--rm', '--name', containerName, '-e', 'POSTGRES_PASSWORD=test', '-p', '127.0.0.1::5432', 'postgres:16-alpine');
  let ready = false;
  for (let i = 0; i < 80; i += 1) {
    if (spawnSync('docker', ['exec', containerName, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { encoding: 'utf8' }).status === 0) {
      ready = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(ready, true);
  const port = Number(docker('port', containerName, '5432/tcp').trim().split(':').pop());
  pool = new Pool({ connectionString: `postgres://postgres:test@127.0.0.1:${port}/postgres` });
  await pool.query('CREATE TABLE users (id BIGINT PRIMARY KEY)');
  await pool.query('INSERT INTO users (id) VALUES (41), (42), (43), (44), (45), (46)');
  const schema = await fs.readFile(path.resolve(__dirname, '../data-store/schema.js'), 'utf8');
  const sessionTable = schema.match(/CREATE TABLE IF NOT EXISTS auth_device_sessions \([\s\S]*?\n    \)/)[0];
  await pool.query(sessionTable);
  store = require('../data-store');
  test.mock.method(store, 'query', (sql, params) => pool.query(sql, params));
  sessions = require('../services/login-session');
});

test.after(async () => {
  if (sessions) sessions.resetForTests();
  if (pool) await pool.end();
  if (containerName) spawnSync('docker', ['rm', '-f', containerName], { encoding: 'utf8' });
});

test('login sessions survive a process cache reset and persist logout across another reset', async t => {
  if (!available) return t.skip('Docker is unavailable');
  const opened = await sessions.openSession({ userId: 41, deviceId, provider: 'password' });
  const stored = (await pool.query('SELECT * FROM auth_device_sessions WHERE id = $1', [opened.id])).rows[0];
  assert.equal(stored.user_id, '41');
  assert.equal(stored.revoked_at, null);
  sessions.resetForTests();
  assert.equal(await sessions.assertActive(opened.id), true);
  const touched = await sessions.touch(opened.id, deviceId);
  assert.equal(touched.id, opened.id);
  assert.equal(touched.userId, '41');
  await sessions.revoke(opened.id);
  sessions.resetForTests();
  assert.equal(await sessions.assertActive(opened.id), false);
  assert.equal(await sessions.touch(opened.id, deviceId), null);
  assert.ok((await pool.query('SELECT revoked_at FROM auth_device_sessions WHERE id = $1', [opened.id])).rows[0].revoked_at);
});

test('a touch already in flight cannot clear a concurrent logout in PostgreSQL', async t => {
  if (!available) return t.skip('Docker is unavailable');
  const opened = await sessions.openSession({ userId: 42, deviceId });
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const beforeInsert = new Promise(resolve => { entered = resolve; });
  t.mock.method(store, 'query', async (sql, params) => {
    if (/^\s*(?:INSERT INTO|UPDATE) auth_device_sessions/.test(sql) && /RETURNING id/.test(sql) && params[0] === opened.id) {
      entered();
      await gate;
    }
    return pool.query(sql, params);
  });
  const pending = sessions.touch(opened.id, deviceId);
  try {
    await beforeInsert;
    await sessions.revoke(opened.id);
    assert.ok((await pool.query('SELECT revoked_at FROM auth_device_sessions WHERE id = $1', [opened.id])).rows[0].revoked_at);
  } finally {
    release();
  }
  const result = await pending;
  const persisted = (await pool.query('SELECT revoked_at FROM auth_device_sessions WHERE id = $1', [opened.id])).rows[0];
  assert.ok(persisted.revoked_at, 'a stale refresh must never erase the persisted logout');
  assert.equal(result, null, 'a rejected refresh must not issue new credentials');
  sessions.resetForTests();
  assert.equal(await sessions.assertActive(opened.id), false);
});

test('another process logout also defeats an in-flight touch with no local revocation cache', async t => {
  if (!available) return t.skip('Docker is unavailable');
  const opened = await sessions.openSession({ userId: 43, deviceId });
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const beforeInsert = new Promise(resolve => { entered = resolve; });
  t.mock.method(store, 'query', async (sql, params) => {
    if (/^\s*(?:INSERT INTO|UPDATE) auth_device_sessions/.test(sql) && /RETURNING id/.test(sql) && params[0] === opened.id) {
      entered();
      await gate;
    }
    return pool.query(sql, params);
  });
  const pending = sessions.touch(opened.id, deviceId);
  try {
    await beforeInsert;
    await pool.query('UPDATE auth_device_sessions SET revoked_at = NOW() WHERE id = $1', [opened.id]);
  } finally {
    release();
  }
  const result = await pending;
  assert.ok((await pool.query('SELECT revoked_at FROM auth_device_sessions WHERE id = $1', [opened.id])).rows[0].revoked_at);
  assert.equal(result, null);
  sessions.resetForTests();
  assert.equal(await sessions.assertActive(opened.id), false);
});

test('a short database outage keeps a known live session usable but refuses an unknown session', async t => {
  if (!available) return t.skip('Docker is unavailable');
  const opened = await sessions.openSession({ userId: 44, deviceId });
  t.mock.method(store, 'query', async () => { throw new Error('FIXTURE_DATABASE_OUTAGE'); });
  assert.equal(await sessions.assertActive(opened.id), true);
  assert.equal((await sessions.touch(opened.id, deviceId)).id, opened.id);
  sessions.resetForTests();
  assert.equal(await sessions.assertActive('unrecognized-session'), false);
  assert.equal(await sessions.touch('unrecognized-session', deviceId, { absoluteExp: Math.floor(Date.now() / 1000) + 3600 }), null);
});

test('a database-confirmed missing session cannot be resurrected from its old cache', async t => {
  if (!available) return t.skip('Docker is unavailable');
  const opened = await sessions.openSession({ userId: 45, deviceId });
  await pool.query('DELETE FROM auth_device_sessions WHERE id = $1', [opened.id]);
  assert.equal(await sessions.assertActive(opened.id), false);
  assert.equal(await sessions.touch(opened.id, deviceId), null);
  assert.equal((await pool.query('SELECT id FROM auth_device_sessions WHERE id = $1', [opened.id])).rows.length, 0);
});

test('an in-flight touch cannot recreate a session deleted and confirmed missing by another request', async t => {
  if (!available) return t.skip('Docker is unavailable');
  const opened = await sessions.openSession({ userId: 46, deviceId });
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const beforeWrite = new Promise(resolve => { entered = resolve; });
  t.mock.method(store, 'query', async (sql, params) => {
    if (/^\s*(?:INSERT INTO|UPDATE) auth_device_sessions/.test(sql) && /RETURNING id/.test(sql) && params[0] === opened.id) {
      entered();
      await gate;
    }
    return pool.query(sql, params);
  });
  const pending = sessions.touch(opened.id, deviceId);
  try {
    await beforeWrite;
    await pool.query('DELETE FROM auth_device_sessions WHERE id = $1', [opened.id]);
    assert.equal(await sessions.assertActive(opened.id), false);
  } finally {
    release();
  }
  const result = await pending;
  assert.equal((await pool.query('SELECT id FROM auth_device_sessions WHERE id = $1', [opened.id])).rows.length, 0,
    'a stale refresh must not insert a previously deleted session');
  assert.equal(result, null);
  assert.equal(sessions._memory.has(opened.id), false);
  sessions.resetForTests();
  assert.equal(await sessions.assertActive(opened.id), false);
});
