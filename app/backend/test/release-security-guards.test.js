const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const dataStore = require('../data-store');
const sessions = require('../services/login-session');
const cors = require('../utils/cors');

test('an uncached session cannot renew during a database outage', async t => {
  sessions.resetForTests();
  t.after(() => sessions.resetForTests());
  t.mock.method(dataStore, 'query', async () => { throw new Error('FIXTURE_DATABASE_OUTAGE'); });
  assert.equal(await sessions.touch('unknown-session', 'fixture-device-000001', {
    absoluteExp: Math.floor(Date.now() / 1000) + 3600,
  }), null);
});

test('a session confirmed absent in the database is removed from the process cache', async t => {
  sessions.resetForTests();
  t.after(() => sessions.resetForTests());
  t.mock.method(dataStore, 'query', async sql => ({ rows: /^\s*SELECT/.test(sql) ? [] : [{ id: 'fixture' }] }));
  const opened = await sessions.openSession({ userId: 7, deviceId: 'fixture-device-000001' });
  assert.equal(await sessions.assertActive(opened.id), false);
  assert.equal(await sessions.touch(opened.id, opened.deviceId), null);
  assert.equal(sessions._memory.has(opened.id), false);
});

test('production CORS requires exact configured origins for tunnels and extensions', t => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  for (const origin of [
    'https://untrusted.trycloudflare.com', 'https://untrusted.loca.lt',
    'https://untrusted.lhr.life', 'https://untrusted.pinggy.io',
    `chrome-extension://${'a'.repeat(32)}`,
  ]) {
    assert.equal(cors.getCorsHeaders(origin, { logUnknown: false })['Access-Control-Allow-Origin'], undefined);
  }
  const configured = `chrome-extension://${'b'.repeat(32)}`;
  cors.ALLOWED_ORIGINS.push(configured);
  t.after(() => cors.ALLOWED_ORIGINS.splice(cors.ALLOWED_ORIGINS.indexOf(configured), 1));
  assert.equal(cors.getCorsHeaders(configured)['Access-Control-Allow-Origin'], configured);
});

test('anonymous static aliases cannot serve private videos or recordings', async t => {
  const { registerStaticRoutes } = require('../routes/static');
  const names = [
    `/videos/release-guard-${process.pid}.mp4`,
    `/recordings/video-55/user-7/release-guard-${process.pid}.mp3`,
  ];
  const files = names.map(name => path.join(__dirname, '../public', name));
  t.after(async () => { await Promise.all(files.map(file => fs.rm(file, { force: true }))); });
  for (const file of files) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'private fixture media');
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    registerStaticRoutes(url.pathname, req, res, url).catch(error => res.destroy(error));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  for (const name of names) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/static${name}`);
    assert.ok([401, 403, 404].includes(response.status), `${name} must remain protected`);
    await response.arrayBuffer();
  }
});
